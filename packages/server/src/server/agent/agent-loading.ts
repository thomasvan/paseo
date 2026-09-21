import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export interface AgentHistoryReadDeps extends EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
}

/**
 * Number of in-scope history reads per agent. An archived agent is resumed into a
 * live provider process to serve a read (`ensureAgentLoaded` passes
 * `{ purpose: "history" }`), and nothing else will ever close it — no client owns
 * it, no archive runs again. The last reader out closes it.
 */
const openHistoryReads = new Map<string, number>();

/**
 * Run `read` against a loaded agent, releasing the provider runtime afterwards when
 * the load was a history read of an archived agent.
 *
 * The scope is a callback rather than a disposer handed back to the caller because
 * every call site is a request handler with an error path that emits a failure
 * response; a disposer has to be released on both paths and one missed `catch`
 * re-opens the leak. Inside the callback the agent is resident, so the manager's
 * `requireAgent`-backed reads (`getTimeline`, `getTimelineRows`, `fetchTimeline`)
 * all work — releasing inside the loader instead makes them throw `Unknown agent`.
 *
 * Interactive (non-archived) agents are loaded and left alone: they belong to
 * whoever opened them.
 */
export async function withAgentHistoryRead<T>(
  agentId: string,
  deps: AgentHistoryReadDeps,
  read: (agent: ManagedAgent) => Promise<T> | T,
): Promise<T> {
  const record = await deps.agentStorage.get(agentId);
  if (!record?.archivedAt) {
    return await read(await ensureAgentLoaded(agentId, deps));
  }

  // Claimed before the load so a second reader arriving mid-resume is counted and
  // the first one out does not close the runtime under it.
  openHistoryReads.set(agentId, (openHistoryReads.get(agentId) ?? 0) + 1);
  try {
    return await read(await ensureAgentLoaded(agentId, deps));
  } finally {
    const remaining = (openHistoryReads.get(agentId) ?? 1) - 1;
    if (remaining > 0) {
      openHistoryReads.set(agentId, remaining);
    } else {
      openHistoryReads.delete(agentId);
      await releaseHistoryRuntime(agentId, deps);
    }
  }
}

async function releaseHistoryRuntime(agentId: string, deps: AgentHistoryReadDeps): Promise<void> {
  try {
    // Re-read: an unarchive during the read hands the runtime to a live client, and
    // closing it then would kill an agent someone is talking to.
    const latest = await deps.agentStorage.get(agentId);
    if (!latest?.archivedAt) {
      return;
    }
    await deps.agentManager.closeAgent(agentId);
    deps.logger.debug({ agentId }, "Released history-purpose runtime after read");
  } catch (error) {
    // The response is already built. Failing the read because cleanup failed would
    // turn a leak into a user-visible error.
    deps.logger.warn({ err: error, agentId }, "Failed to release history-purpose runtime");
  }
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return inflight.promise;
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    return existing;
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return laterInflight.promise;
  }

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
  };
  const initPromise = (async () => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        extractTimestamps(record),
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, {
        labels: record.labels,
        workspaceId: record.workspaceId,
        owner: record.owner,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await initPromise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}
