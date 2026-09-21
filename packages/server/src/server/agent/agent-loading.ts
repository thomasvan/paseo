import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, HistoryRuntimeLease, ManagedAgent } from "./agent-manager.js";
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

/**
 * Per-manager, not process-wide. Both of this module's caches key work by agent id,
 * and an agent id is only unique within one `AgentManager`: production bootstraps a
 * single manager, but tests construct several over the same storage, and a shared
 * key makes two managers dedupe each other's loads and count each other's readers.
 * The manager instance is the scope, so it is the outer key.
 */
function perManager<V>(
  cache: WeakMap<AgentLoaderManager, Map<string, V>>,
  manager: AgentLoaderManager,
): Map<string, V> {
  let entries = cache.get(manager);
  if (!entries) {
    entries = new Map<string, V>();
    cache.set(manager, entries);
  }
  return entries;
}

const pendingAgentInitializations = new WeakMap<
  AgentLoaderManager,
  Map<string, PendingAgentInitialization>
>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose" | "disownHistoryRuntime">>;

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
  agentManager: AgentLoaderManager &
    Pick<
      AgentManager,
      "closeAgent" | "claimHistoryRuntime" | "bindHistoryRuntime" | "releaseHistoryRuntime"
    >;
}

/**
 * Run `read` against a loaded agent, releasing the provider runtime afterwards when
 * the load was a history read of an archived agent.
 *
 * The scope is a lease taken from `AgentManager` before the load and released after
 * it. Everything that decides the fate of the runtime — the resident session, the
 * count of readers on it, the close — happens inside the manager's per-agent
 * lifecycle lane, so no archive, unarchive or close can interleave with it. This
 * module deliberately never reads `archivedAt` to decide ownership: that field is
 * one the manager edits on its own schedule, and a reader that consults it is
 * asking a question whose answer can change under it.
 *
 * The shape is a callback rather than a disposer handed back to the caller because
 * every call site is a request handler with an error path that emits a failure
 * response; a disposer has to be released on both paths and one missed `catch`
 * re-opens the leak. Inside the callback the agent is resident, so the manager's
 * `requireAgent`-backed reads (`getTimeline`, `getTimelineRows`, `fetchTimeline`)
 * all work — releasing inside the loader instead makes them throw `Unknown agent`.
 *
 * Interactive (non-archived) agents are loaded and left alone: they belong to
 * whoever opened them, the lease binds nothing, and the release does nothing.
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

  // Claimed before the load, so a release already running for another reader sees
  // this one arrive and stands down instead of closing the runtime it is about to
  // adopt.
  const lease = deps.agentManager.claimHistoryRuntime(agentId);
  try {
    const agent = await ensureAgentLoaded(agentId, deps, { heldLease: lease });
    // Bind after the load: the lease names the runtime that load left resident, and
    // only when that runtime is one the manager launched for history. A load that
    // adopted someone's live agent binds nothing and owes no close.
    deps.agentManager.bindHistoryRuntime(lease);
    return await read(agent);
  } finally {
    // A load that threw part-way can still have left a runtime behind, so bind on
    // the failure path too before releasing.
    if (!lease.session) {
      deps.agentManager.bindHistoryRuntime(lease);
    }
    await deps.agentManager.releaseHistoryRuntime(lease);
  }
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  options?: {
    /**
     * Set by `withAgentHistoryRead` when this load is the reader's own. Every
     * other caller is an interactive one and must not be served a runtime some
     * reader is holding.
     */
    heldLease?: HistoryRuntimeLease;
  },
): Promise<ManagedAgent> {
  if (!options?.heldLease) {
    // Take the agent id back from any history reader before the adoption checks
    // below can hand its read-only runtime to a live client. A no-op — one map
    // lookup — unless a read is actually in flight for this agent.
    await deps.agentManager.disownHistoryRuntime?.(agentId);
  }
  await deps.agentManager.waitForAgentClose?.(agentId);

  const pendingLoads = perManager(pendingAgentInitializations, deps.agentManager);
  const inflight = pendingLoads.get(agentId);
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

  const laterInflight = pendingLoads.get(agentId);
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
  pendingLoads.set(agentId, pending);

  try {
    return await initPromise;
  } finally {
    const current = pendingLoads.get(agentId);
    if (current === pending) {
      pendingLoads.delete(agentId);
    }
  }
}
