import { AsyncLocalStorage } from "node:async_hooks";

import type { Logger } from "pino";

import type { AgentProvider } from "./agent-sdk-types.js";
import type {
  AgentLoadPurpose,
  AgentLoadRequest,
  AgentManager,
  HistoryRuntimeLease,
  ManagedAgent,
  PendingAgentLoad,
} from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
  | "planAgentLoad"
  | "publishAgentLoad"
  | "abandonAgentLoad"
> &
  Partial<Pick<AgentManager, "waitForAgentClose" | "releaseHistoryRuntime">>;

/**
 * The history leases the current async context holds, keyed by nothing: identity
 * is the lease object. A read callback that loads its own agent interactively
 * would be parked on a lease only its own return can release, and the lane it is
 * parked on cannot tell a re-entrant caller from a second client. This is how it
 * tells them apart.
 */
const heldHistoryLeases = new AsyncLocalStorage<ReadonlySet<HistoryRuntimeLease>>();

/**
 * Thrown when a history read tries to load the agent it is reading as a live
 * agent. The alternative is a permanent park, which looks like a hung request.
 */
export class HistoryReadReentrancyError extends Error {
  public readonly agentId: string;

  constructor(agentId: string) {
    super(`Agent ${agentId} cannot be loaded interactively from inside a history read of itself`);
    this.name = "HistoryReadReentrancyError";
    this.agentId = agentId;
  }
}

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
  agentManager: AgentLoaderManager & Pick<AgentManager, "releaseHistoryRuntime">;
}

/**
 * Run `read` against a loaded agent, releasing the provider runtime afterwards when
 * the load was a history read of an archived agent.
 *
 * The scope is a lease the manager takes in the same lane operation that decides
 * how this load will be served. Everything that decides the fate of the runtime —
 * the resident session, the readers on it, the load in flight, the close — is read
 * and written inside the manager's per-agent lifecycle lane, so no archive,
 * unarchive, close or second loader can interleave with the decision. This module
 * deliberately never reads `archivedAt` to decide ownership: that field is one the
 * manager edits on its own schedule, and a reader that consults it is asking a
 * question whose answer can change under it.
 *
 * The shape is a callback rather than a disposer handed back to the caller because
 * every call site is a request handler with an error path that emits a failure
 * response; a disposer has to be released on both paths and one missed `catch`
 * re-opens the leak. Inside the callback the agent is resident and stays resident:
 * a live caller arriving mid-read waits for the lease instead of taking the runtime
 * away, so the manager's `requireAgent`-backed reads (`getTimeline`,
 * `getTimelineRows`, `fetchTimeline`) still work after an await.
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

  const loaded = await loadAgent(agentId, deps, "history");
  const lease = loaded.lease;
  if (!lease) {
    return await read(loaded.agent);
  }
  try {
    const held = new Set(heldHistoryLeases.getStore() ?? []);
    held.add(lease);
    return await heldHistoryLeases.run(held, async () => await read(loaded.agent));
  } finally {
    await deps.agentManager.releaseHistoryRuntime(lease);
  }
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  return (await loadAgent(agentId, deps, "interactive")).agent;
}

/**
 * Plan, then load, then publish. The plan and the publish are lane operations with
 * synchronous bodies; the load between them is the provider I/O, and it holds no
 * lane. A plan that parks this caller returns a barrier instead, and the loop
 * re-plans when it is signalled — the state it decided against may have changed,
 * so nothing is carried across the park except the request.
 */
async function loadAgent(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  purpose: AgentLoadPurpose,
): Promise<{ agent: ManagedAgent; lease: HistoryRuntimeLease | null }> {
  const request: AgentLoadRequest = {
    agentId,
    purpose,
    broadcastTimeline: deps.broadcastTimeline === true,
    reentrant: holdsLeaseOn(agentId),
    token: {},
  };
  let lease: HistoryRuntimeLease | null = null;
  let parked = false;
  try {
    for (;;) {
      // Orders this load behind a close that started before it. The lane covers
      // closes taken through `closeAgent`; this also covers the window where the
      // close has been registered and its lane operation has not yet run.
      await deps.agentManager.waitForAgentClose?.(agentId);

      const plan = await deps.agentManager.planAgentLoad(request);
      if (plan.kind === "wait") {
        assertNotSelfBlocked(agentId, plan.blockedBy);
        parked = true;
        await plan.until;
        continue;
      }

      lease = plan.lease;
      if (plan.kind === "resident") {
        return { agent: plan.agent, lease };
      }
      if (plan.kind === "adopt") {
        return { agent: await plan.pending.promise, lease };
      }
      return { agent: await runAgentLoad(agentId, deps, plan.pending), lease };
    }
  } catch (error) {
    // The lease is claimed inside the lane, before the load it names runs, so a
    // load that throws can still have left a runtime behind. Release it here:
    // the caller never received the lease and cannot.
    if (lease) {
      await deps.agentManager.releaseHistoryRuntime?.(lease);
    }
    throw error;
  } finally {
    if (parked) {
      await deps.agentManager.abandonAgentLoad(request);
    }
  }
}

function holdsLeaseOn(agentId: string): boolean {
  for (const lease of heldHistoryLeases.getStore() ?? []) {
    if (lease.agentId === agentId) {
      return true;
    }
  }
  return false;
}

function assertNotSelfBlocked(agentId: string, blockedBy: readonly HistoryRuntimeLease[]): void {
  const held = heldHistoryLeases.getStore();
  if (!held) {
    return;
  }
  for (const lease of blockedBy) {
    if (held.has(lease)) {
      throw new HistoryReadReentrancyError(agentId);
    }
  }
}

/**
 * Run the load this caller was told to start, then publish its outcome. Publishing
 * is what settles the promise every adopting caller is waiting on, and it binds
 * their leases first, so none of them can see the agent before its lease names the
 * session it is holding.
 */
async function runAgentLoad(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  pending: PendingAgentLoad,
): Promise<ManagedAgent> {
  let agent: ManagedAgent;
  try {
    agent = await resumeOrCreateAgent(agentId, deps, pending);
  } catch (error) {
    await deps.agentManager.publishAgentLoad(pending, { ok: false, error });
    throw error;
  }
  await deps.agentManager.publishAgentLoad(pending, { ok: true, agent });
  return agent;
}

async function resumeOrCreateAgent(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
  pending: PendingAgentLoad,
): Promise<ManagedAgent> {
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
    broadcast: () => pending.options.broadcastTimeline,
  });
  return deps.agentManager.getAgent(agentId) ?? snapshot;
}
