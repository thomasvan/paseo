import type { Logger } from "pino";

import type { AgentProvider, AgentSession } from "./agent-sdk-types.js";
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
 * One live history-read scope for one agent on one manager. An archived agent is
 * resumed into a live provider process to serve a read (`ensureAgentLoaded` passes
 * `{ purpose: "history" }`), and nothing else will ever close it — no client owns it,
 * no archive runs again. The last reader out releases it.
 */
interface HistoryReadScope {
  /** Readers currently inside the scope. Zero means a release may run. */
  readers: number;
  /**
   * The in-flight release, if one is running. Set for the whole release, including
   * the awaits inside it, so an arriving reader can see that a release is underway
   * rather than finding the scope already gone.
   */
  releasing: Promise<void> | null;
  /**
   * Set once the release has invoked `closeAgent`. Past that point the runtime is
   * committed to closing, so a reader cannot adopt it and must wait and load its own.
   */
  closing: boolean;
  /**
   * The provider session the scope's readers hold, or null when no runtime was ever
   * resident. This is the scope's ownership token: `getAgent` returns a fresh shallow
   * copy each call, but the `session` reference inside it is the runtime's identity
   * and survives exactly as long as the runtime does.
   */
  session: AgentSession | null;
}

const historyReadScopes = new WeakMap<AgentLoaderManager, Map<string, HistoryReadScope>>();

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

  const scope = await claimHistoryRead(agentId, deps.agentManager);
  try {
    let agent: ManagedAgent;
    try {
      agent = await ensureAgentLoaded(agentId, deps);
    } finally {
      // Capture the runtime this scope holds even when the load threw partway:
      // `ensureAgentLoaded` can resume a session and then fail hydrating it, and
      // that session still has to be released. Keep the previous token when nothing
      // is resident — a token that matches nothing makes the release stand down,
      // which is the safe direction.
      scope.session = deps.agentManager.getAgent(agentId)?.session ?? scope.session;
    }
    return await read(agent);
  } finally {
    scope.readers -= 1;
    await settleHistoryReadScope(agentId, deps, scope);
  }
}

/**
 * Join the agent's current scope, or open one. A reader arriving while a release is
 * in flight adopts the scope when the runtime is still resident, and otherwise waits
 * for the release to finish and opens a fresh scope over its own load.
 */
async function claimHistoryRead(
  agentId: string,
  manager: AgentHistoryReadDeps["agentManager"],
): Promise<HistoryReadScope> {
  const scopes = perManager(historyReadScopes, manager);
  for (;;) {
    const scope = scopes.get(agentId);
    if (!scope) {
      const opened: HistoryReadScope = {
        readers: 1,
        releasing: null,
        closing: false,
        session: null,
      };
      scopes.set(agentId, opened);
      return opened;
    }
    if (!scope.closing) {
      // The runtime is still resident, so adopt it. A release suspended mid-flight
      // sees `readers > 0` at its commit check and stands down without closing.
      scope.readers += 1;
      return scope;
    }
    // `closeAgent` is already invoked; this runtime is spoken for. Wait the release
    // out, then loop: the scope it leaves behind is gone and a fresh one is opened.
    await scope.releasing;
  }
}

/**
 * Drive the scope to rest after a reader leaves. Loops because a release can stand
 * down for a reader that then finishes while the release is still unwinding, which
 * leaves the scope at zero readers with nobody holding the duty to release it.
 */
async function settleHistoryReadScope(
  agentId: string,
  deps: AgentHistoryReadDeps,
  scope: HistoryReadScope,
): Promise<void> {
  const scopes = perManager(historyReadScopes, deps.agentManager);
  while (scopes.get(agentId) === scope && scope.readers === 0) {
    const inFlight = scope.releasing;
    if (inFlight) {
      await inFlight;
      continue;
    }
    let settle = (): void => undefined;
    // Published before the first await inside the release, so no arriving reader can
    // observe a zero-reader scope with no release attached to it.
    scope.releasing = new Promise<void>((resolve) => {
      settle = resolve;
    });
    try {
      await releaseHistoryRuntime(agentId, deps, scope);
    } finally {
      if (scope.readers === 0 && scopes.get(agentId) === scope) {
        scopes.delete(agentId);
      }
      scope.releasing = null;
      settle();
    }
  }
}

async function releaseHistoryRuntime(
  agentId: string,
  deps: AgentHistoryReadDeps,
  scope: HistoryReadScope,
): Promise<void> {
  // Hoisted so the failure path disposes the runtime this release committed to
  // closing, not whatever `scope.session` has since been repointed at.
  let held: AgentSession | null = null;
  try {
    // Re-read: an unarchive during the read hands the runtime to a live client, and
    // closing it then would kill an agent someone is talking to.
    const latest = await deps.agentStorage.get(agentId);

    // Everything from here to `closeAgent` is one synchronous turn. Nothing can be
    // interleaved between the last check and the close, so the checks describe the
    // state the close acts on — except `latest`, which was sampled before the await
    // resolved and is the reason the token check below exists.
    if (scope.readers > 0) {
      return;
    }
    if (!latest?.archivedAt) {
      return;
    }
    held = scope.session;
    if (!held) {
      return;
    }
    if (deps.agentManager.getAgent(agentId)?.session !== held) {
      // A different runtime is resident, or none is. An unarchive closes the history
      // runtime before it clears `archivedAt` (`agent-manager.ts` `unarchiveSnapshot`),
      // so a record that still reads archived can describe a world where ours is
      // already gone and a live one has taken its place. The token says which runtime
      // this scope actually held; the record cannot.
      return;
    }
    scope.closing = true;
    await deps.agentManager.closeAgent(agentId);
    deps.logger.debug({ agentId }, "Released history-purpose runtime after read");
  } catch (error) {
    // The response is already built. Failing the read because cleanup failed would
    // turn a leak into a user-visible error.
    deps.logger.warn({ err: error, agentId }, "Failed to release history-purpose runtime");

    // `closeAgentRuntime` drops the agent from the manager's map before calling
    // `session.close()` and rethrows the failure, so swallowing it here strands the
    // provider process with no handle left to retry through — the exact leak this
    // scope exists to prevent, and silent. We still hold the session, so dispose it
    // directly. Only after we committed to closing: before that the runtime is still
    // the manager's and closing it behind the manager's back would leave a zombie
    // entry. A close that already succeeded (the throw came from the snapshot persist
    // that follows it) gets a second `close()`; sessions are never reused across
    // runtimes, so the worst case is a no-op or one more logged error.
    if (scope.closing && held) {
      try {
        await held.close();
        deps.logger.warn({ agentId }, "Disposed history-purpose session after a failed release");
      } catch (disposeError) {
        deps.logger.error(
          { err: disposeError, agentId },
          "History-purpose provider session could not be disposed; the process may be leaked",
        );
      }
    }
  }
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
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
