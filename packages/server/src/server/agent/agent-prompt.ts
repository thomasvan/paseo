import type { Logger } from "pino";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentRunStartHandle, AgentRunStartSettlement } from "./agent-run-state.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
  // SLP-PATCH(wakeup-defers)
  | "isRunReserved"
  | "getRunStartHandle"
  | "reloadAgentSessionUnlessBusy"
> & {
  reloadAgentSession(agentId: string): Promise<unknown>;
};

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
  /**
   * SLP-PATCH(wakeup-defers): what to do when the caller is already busy.
   * `"replace"` (the default, and every existing caller's behaviour) cancels the
   * caller's run and takes its place. `"refuse"` never interrupts and never
   * replaces: it answers `busy` and leaves the caller's run alone.
   */
  busyFallback?: "replace" | "refuse";
}

export type PromptDispatchDisposition =
  | "out_of_band"
  | "steered"
  | "turn_started"
  // SLP-PATCH(wakeup-defers): the caller was busy; nothing was sent, nothing
  // was interrupted, and the prompt is the caller's to retry.
  | "busy"
  // SLP-PATCH(wakeup-defers): the record is archived and the caller asked not to
  // unarchive it. Today this returns `turn_started` having sent nothing.
  | "archived";

/**
 * SLP-PATCH(wakeup-defers): `run` is present only for `turn_started`, and only
 * when the dispatch admitted a run of its own (an accepted steer rides an
 * existing turn). Await `run.startSettled` to learn whether *this* run reached
 * the provider: it always resolves and never rejects.
 */
export interface AgentRunDispatchResult {
  disposition: PromptDispatchDisposition;
  run?: AgentRunStartHandle;
}

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | { disposition: "steered" }
  | { disposition: "busy" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  // SLP-PATCH(wakeup-defers): under `refuse` the manager must never escalate a
  // refused steer into a replacement, so the policy travels with the options.
  const steerOnly = options.busyFallback === "refuse";
  const steerOptions =
    options.clearPendingPermissions || steerOnly
      ? {
          ...options.runOptions,
          ...(options.clearPendingPermissions ? { clearPendingPermissions: true } : {}),
          ...(steerOnly ? { steerOnly: true } : {}),
        }
      : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(agentId, prompt, steerOptions);
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  // SLP-PATCH(wakeup-defers)
  if (result.status === "busy") {
    return { disposition: "busy" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
): Promise<
  | {
      status: "started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
      replaced: boolean;
      run: AgentRunStartHandle | null;
    }
  | { status: "busy" }
> {
  const refuse = options?.busyFallback === "refuse";
  // SLP-PATCH(wakeup-defers): read the reservation explicitly and first, so
  // ordinary dispatch is covered whichever branch `hasInFlightRun` would pick.
  if (agentManager.isRunReserved(agentId)) {
    if (refuse) {
      return { status: "busy" };
    }
    throw new Error(`Agent ${agentId} already has an active run`);
  }
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  // SLP-PATCH(wakeup-defers): a busy caller under `refuse` is answered, never
  // replaced.
  if (replaced && refuse) {
    return { status: "busy" };
  }
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions);
  // SLP-PATCH(wakeup-defers): read the handle synchronously, before anything can
  // retire this run and admit another, so the acknowledgement belongs to the run
  // just admitted and not to whichever run is current later.
  return { status: "started", iterator, replaced, run: agentManager.getRunStartHandle(agentId) };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<AgentRunDispatchResult> {
  const snapshot = agentManager.getAgent(agentId);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
  // SLP-PATCH(wakeup-defers): the reservation is read here, before
  // `tryRunOutOfBand`, because that call reaches for `agent.session` — which a
  // guarded reload is in the middle of swapping — and so fails with whatever
  // the half-swapped agent happens to raise. Reading first makes the whole
  // reload window one answer at this layer, and makes `refuse` total: a
  // refusing caller is answered `busy` and never sees a throw.
  if (agentManager.isRunReserved(agentId)) {
    if (options?.busyFallback === "refuse") {
      return { disposition: "busy" };
    }
    throw new Error(`Agent ${agentId} already has an active run`);
  }
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { disposition: "out_of_band" };
  }
  try {
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  } catch (error) {
    if (!isStaleProviderSessionError(error)) throw error;
    logger.info({ agentId, err: error }, "Provider session went stale; reopening from persistence");
    // The live session belongs to a retired plugin runtime. Reload swaps in a
    // fresh session on the current runtime while preserving history and labels.
    // SLP-PATCH(wakeup-defers): under `refuse` the reload must not cancel a busy
    // caller, so it goes through the guarded variant. A refusal is a busy
    // answer; the caller retries. This is the only catch that reloads under
    // `refuse`, and it starts exactly one run for this attempt.
    if (options?.busyFallback === "refuse") {
      const reload = await agentManager.reloadAgentSessionUnlessBusy(agentId);
      if (!reload.reloaded) {
        logger.info(
          { agentId, reason: reload.reason },
          "Provider session went stale but the caller is busy; not reloading",
        );
        return { disposition: "busy" };
      }
    } else {
      await agentManager.reloadAgentSession(agentId);
    }
    return await startAgentRunInner(agentManager, agentId, prompt, logger, options);
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<AgentRunDispatchResult> {
  const snapshot = agentManager.getAgent(agentId);
  const refuse = options?.busyFallback === "refuse";
  const steered = await steerOrReplaceActiveRun(agentManager, agentId, prompt, options);
  if (steered?.disposition === "steered") {
    return { disposition: "steered" };
  }
  // SLP-PATCH(wakeup-defers)
  if (steered?.disposition === "busy") {
    return { disposition: "busy" };
  }
  // SLP-PATCH(wakeup-defers): the error hold lives at admission, not in the
  // pump. Read the live lifecycle *synchronously in the same tick* as the call
  // into `startOrReplaceRun` — there is no `await` between this read and the
  // admission — so a caller that failed during `sendPromptToAgent`'s earlier
  // awaits (storage, `ensureAgentLoaded`) is seen as errored at the only moment
  // that matters, and never reaches `streamAgent`, which would clear
  // `lastError`. Under `refuse` the steer branch can only answer `steered`,
  // `busy` or null, so the admission below is the only one this read must cover.
  if (refuse) {
    const live = agentManager.getAgent(agentId);
    if (live?.lifecycle === "error") {
      return { disposition: "busy" };
    }
  }
  let iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  let replaced: boolean;
  let run: AgentRunStartHandle | null;
  if (steered) {
    iterator = steered.iterator;
    replaced = true;
    run = agentManager.getRunStartHandle(agentId);
  } else {
    const started = await startOrReplaceRun(agentManager, agentId, prompt, options);
    if (started.status === "busy") {
      return { disposition: "busy" };
    }
    ({ iterator, replaced, run } = started);
  }
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        // SLP-PATCH(wakeup-defers): under `refuse` this detached catch neither
        // reloads nor starts a retry run. `startAgentRun` has already returned,
        // so a retry started here would be a second run with a second record and
        // a second delivery. Log it, let this run settle `failed`, and return —
        // the caller's next attempt goes through the synchronous catch above,
        // which reloads (or answers busy) and starts exactly one run.
        if (options?.busyFallback === "refuse") {
          logger.info(
            { agentId, err: error },
            "Provider session went stale during drain; not retrying (busyFallback=refuse)",
          );
          return;
        }
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options);
        if (retry.status === "started") {
          await drainAgentRunIterator(retry.iterator);
        }
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    }
  })();
  // SLP-PATCH(wakeup-defers): hand back the run this dispatch admitted so the
  // caller can acknowledge *its own* start.
  return run ? { disposition: "turn_started", run } : { disposition: "turn_started" };
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<paseo-system>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  /** SLP-PATCH(wakeup-defers): see {@link StartAgentRunOptions.busyFallback}. */
  busyFallback?: "replace" | "refuse";
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const startAbort = new AbortController();
  const startTimeout = setTimeout(
    () =>
      startAbort.abort(
        new Error(
          `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
        ),
      ),
    AGENT_RUN_START_TIMEOUT_MS,
  );

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, nothing is sent and the
 * call answers `archived` — SLP-PATCH(wakeup-defers) corrects the previous
 * `turn_started` answer, which claimed a turn had started when none had.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<AgentRunDispatchResult> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      // SLP-PATCH(wakeup-defers)
      return { disposition: "archived" };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    activeTurnBehavior: params.activeTurnBehavior,
    clearPendingPermissions: params.clearPendingPermissions,
    // SLP-PATCH(wakeup-defers): passed straight through; undefined keeps every
    // existing surface on the default `"replace"`.
    busyFallback: params.busyFallback,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

/**
 * SLP-PATCH(wakeup-defers): the only reasons an owed wakeup is ever discarded.
 * There is deliberately no capacity member: the queue is unbounded in memory
 * (§8 decision 2, "never drop"), and this union is what makes that checkable by
 * the compiler rather than by reading the pump.
 */
type WakeupDropCause = "caller closed" | "caller archived";

/** SLP-PATCH(wakeup-defers): one owed notification, body already prepared. */
interface PendingWakeup {
  reason: FinishNotificationReason;
  body: string;
  permissionRequest?: AgentPermissionRequest;
  enqueuedAt: number;
  /** `wakeup deferred` is logged once per entry, not once per attempt. */
  deferLogged: boolean;
  /** Consecutive dispatch failures for this entry. */
  failures: number;
}

/** SLP-PATCH(wakeup-defers): depth at which an abnormal caller becomes visible. */
const WAKEUP_QUEUE_DEPTH_WARN = 8;
/** SLP-PATCH(wakeup-defers): retry backoff for a caller that stays idle. */
const WAKEUP_RETRY_BASE_MS = 5_000;
const WAKEUP_RETRY_MAX_MS = 60_000;
/** SLP-PATCH(wakeup-defers): from this attempt a failure is an `error` record. */
const WAKEUP_FAILURE_ERROR_ATTEMPT = 3;

/**
 * SLP-PATCH(wakeup-defers): the watcher's delivery state, with the queue and the
 * owed counter private so the compiler — not a grep — enumerates every site that
 * can enqueue, retire or drop. `owed` is not the queue's length: it counts a
 * reason from the moment it is accepted, before its body has been read out of
 * storage, so a terminal body still being prepared while the queue happens to be
 * empty still holds the caller subscription open.
 */
class WakeupDeliveryQueue {
  #pending: PendingWakeup[] = [];
  #owed = 0;

  get depth(): number {
    return this.#pending.length;
  }

  get owed(): number {
    return this.#owed;
  }

  get head(): PendingWakeup | null {
    return this.#pending[0] ?? null;
  }

  /** A reason was accepted. Owed from here, whether or not a body ever exists. */
  accept(): void {
    this.#owed += 1;
  }

  /** An accepted reason that never became an entry (ownership, dedupe, failure). */
  abandon(): void {
    this.#owed -= 1;
  }

  /** An archive can emit `closed` twice; `finished` entries are never merged. */
  hasIdenticalClosure(body: string): boolean {
    return this.#pending.some((entry) => entry.reason === "was closed" && entry.body === body);
  }

  enqueue(entry: PendingWakeup): number {
    this.#pending.push(entry);
    return this.#pending.length;
  }

  /** The only single-entry removal, and it always pairs with the counter. */
  settleHead(): void {
    this.#pending.shift();
    this.#owed -= 1;
  }

  /** The only bulk removal. Reachable only with a `WakeupDropCause`. */
  dropAll(_cause: WakeupDropCause): PendingWakeup[] {
    const dropped = this.#pending;
    this.#pending = [];
    this.#owed -= dropped.length;
    return dropped;
  }
}

type WakeupDrainStatus = "empty" | "deferred" | "failed" | "held";

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();

  // SLP-PATCH(wakeup-defers): observation of the child and delivery to the
  // caller are two lifecycles. `stop()` ends observation only; everything below
  // belongs to delivery, which outlives it.
  const queue = new WakeupDeliveryQueue();
  let unsubscribeCaller: (() => void) | null = null;
  let callerReleased = false;
  let callerGone = false;
  let pumpInFlight: Promise<void> | null = null;
  let rerun = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelayMs = WAKEUP_RETRY_BASE_MS;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    // SLP-PATCH(wakeup-defers): observation stopped. The caller subscription is
    // released only if nothing is still owed.
    releaseCallerIfSettled();
  }

  // SLP-PATCH(wakeup-defers)
  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  // SLP-PATCH(wakeup-defers)
  function releaseCaller(): void {
    if (callerReleased) return;
    callerReleased = true;
    clearRetry();
    unsubscribeCaller?.();
    unsubscribeCaller = null;
  }

  // SLP-PATCH(wakeup-defers): the subscription ends when nothing is owed *and*
  // observation has stopped, or when the caller is gone. Not on an empty queue.
  function releaseCallerIfSettled(): void {
    if (callerReleased) return;
    if (callerGone) {
      releaseCaller();
      return;
    }
    if (!stopped) return;
    if (queue.owed > 0) return;
    releaseCaller();
  }

  // SLP-PATCH(wakeup-defers)
  function dropOwed(cause: WakeupDropCause): void {
    for (const entry of queue.dropAll(cause)) {
      logger.warn({ childAgentId, callerAgentId, reason: entry.reason, cause }, "wakeup dropped");
    }
  }

  // SLP-PATCH(wakeup-defers): `closed` or `archivedAt` — never `error`, whose
  // queue is kept for the idle after someone else's recovery prompt.
  function callerIsGone(cause: WakeupDropCause): void {
    if (callerGone) return;
    callerGone = true;
    dropOwed(cause);
    stop();
    releaseCaller();
  }

  // SLP-PATCH(wakeup-defers): one consumer for one queue, serialized by a single
  // in-flight promise per watcher. A call while a pump runs sets `rerun`; the
  // running pump loops again before releasing ownership.
  function pump(): void {
    if (callerGone) return;
    if (pumpInFlight) {
      rerun = true;
      return;
    }
    const running = runPump();
    pumpInFlight = running;
    void running
      .catch((error: unknown) => {
        logger.error({ err: error, childAgentId, callerAgentId }, "wakeup pump failed");
      })
      .finally(() => {
        if (pumpInFlight === running) pumpInFlight = null;
        releaseCallerIfSettled();
      });
  }

  // SLP-PATCH(wakeup-defers)
  async function runPump(): Promise<void> {
    for (;;) {
      rerun = false;
      const status = await drainOwed();
      if (callerGone) return;
      if (rerun) continue;
      // Re-check once more before releasing ownership: an idle transition can
      // never fall between the last attempt and the wait for the next event.
      if (
        status !== "failed" &&
        status !== "held" &&
        queue.depth > 0 &&
        !agentManager.hasInFlightRun(callerAgentId)
      ) {
        continue;
      }
      return;
    }
  }

  // SLP-PATCH(wakeup-defers)
  async function drainOwed(): Promise<WakeupDrainStatus> {
    while (queue.depth > 0) {
      if (callerGone) return "held";
      // Every pump entry and every retry re-reads the caller's lifecycle first.
      // `error` holds the queue exactly like `busy` does, with no attempt, so
      // neither the re-check after a failed turn nor a new child event can start
      // an errored caller through `streamAgent` — which would clear `lastError`.
      const live = agentManager.getAgent(callerAgentId);
      if (live?.lifecycle === "error") return "held";
      const entry = queue.head;
      if (!entry) return "empty";
      let result: AgentRunDispatchResult;
      try {
        result = await sendPromptToAgent({
          agentManager,
          agentStorage,
          agentId: callerAgentId,
          prompt: formatSystemNotificationPrompt(entry.body),
          activeTurnBehavior: "steer",
          unarchive: false,
          busyFallback: "refuse",
          logger,
        });
      } catch (error) {
        recordDispatchFailure(entry, error);
        return "failed";
      }
      if (result.disposition === "busy") {
        if (!entry.deferLogged) {
          entry.deferLogged = true;
          logger.info({ childAgentId, callerAgentId, reason: entry.reason }, "wakeup deferred");
        }
        // The caller may have settled between the admission's event drain and
        // this answer; if it is idle now, attempt again immediately.
        if (agentManager.hasInFlightRun(callerAgentId)) return "deferred";
        continue;
      }
      if (result.disposition === "archived") {
        const cause: WakeupDropCause = "caller archived";
        queue.settleHead();
        logger.warn({ childAgentId, callerAgentId, reason: entry.reason, cause }, "wakeup dropped");
        continue;
      }
      if (result.disposition === "turn_started" && result.run) {
        // `turn_started` is not yet delivery: the iterator exists, the
        // provider's `startTurn()` runs later and can fail there. Acknowledge
        // *this* run's start, never "whichever run is current".
        const settlement = await awaitRunStart(result.run);
        if (settlement.status !== "started") {
          recordDispatchFailure(
            entry,
            settlement.status === "failed"
              ? settlement.error
              : "notification run was cancelled before it started",
          );
          return "failed";
        }
      }
      queue.settleHead();
      retryDelayMs = WAKEUP_RETRY_BASE_MS;
      clearRetry();
      logger.info(
        {
          childAgentId,
          callerAgentId,
          reason: entry.reason,
          disposition: result.disposition,
          deferredMs: Date.now() - entry.enqueuedAt,
        },
        "wakeup delivered",
      );
    }
    return "empty";
  }

  // SLP-PATCH(wakeup-defers): failed, cancelled and timeout are one outcome.
  async function awaitRunStart(run: AgentRunStartHandle): Promise<AgentRunStartSettlement> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timedOut = new Promise<AgentRunStartSettlement>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: "failed",
            error: `notification run did not start within ${AGENT_RUN_START_TIMEOUT_MS} ms`,
          }),
        AGENT_RUN_START_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([run.startSettled, timedOut]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  // SLP-PATCH(wakeup-defers): a failure never drops an entry. It stays at the
  // head, the pump leaves the loop, and a retry is armed.
  function recordDispatchFailure(entry: PendingWakeup, error: unknown): void {
    entry.failures += 1;
    const record = {
      childAgentId,
      callerAgentId,
      reason: entry.reason,
      attempt: entry.failures,
      err: error,
    };
    if (entry.failures >= WAKEUP_FAILURE_ERROR_ATTEMPT) {
      logger.error(record, "wakeup dispatch failed");
    } else {
      logger.warn(record, "wakeup dispatch failed");
    }
    armRetry();
  }

  // SLP-PATCH(wakeup-defers): 5 s, doubling, capped at 60 s, so a caller that
  // stays idle is retried even if no event ever arrives.
  function armRetry(): void {
    if (callerGone || callerReleased) return;
    if (retryTimer !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, WAKEUP_RETRY_MAX_MS);
    const timer = setTimeout(() => {
      retryTimer = null;
      pump();
    }, delay);
    timer.unref?.();
    retryTimer = timer;
  }

  /**
   * SLP-PATCH(wakeup-defers): builds the body and appends to `pending`. It never
   * dispatches; `pump()` is the only sender. Answers whether the accepted reason
   * became an entry, so `notifySafely` can settle the owed counter for the ones
   * that did not.
   */
  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<boolean> {
    if (callerGone) return false;
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      // SLP-PATCH(wakeup-each): this watcher outlives the first finish, so an
      // archived caller would otherwise hold the subscription for the child's
      // whole life. Nobody is left to hear it; disarm for good.
      // SLP-PATCH(wakeup-defers): and whatever is still owed is dropped here,
      // with one `warn` per entry — the caller is gone, not busy.
      callerIsGone("caller archived");
      return false;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return false;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    // SLP-PATCH(wakeup-defers): the caller can have gone while the body was read.
    if (callerGone) return false;
    // Dedupe is limited to an identical `was closed` for this child (an archive
    // can emit the state twice). `finished` entries are never merged.
    if (reason === "was closed" && queue.hasIdenticalClosure(body)) return false;
    const depth = queue.enqueue({
      reason,
      body,
      permissionRequest,
      enqueuedAt: Date.now(),
      deferLogged: false,
      failures: 0,
    });
    if (depth >= WAKEUP_QUEUE_DEPTH_WARN) {
      logger.warn({ childAgentId, callerAgentId, depth }, "wakeup queue depth");
    }
    pump();
    return true;
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    // SLP-PATCH(wakeup-defers)
    if (callerGone) return;
    // SLP-PATCH(wakeup-defers): owed the moment the reason is accepted, before
    // the body is prepared and *before* a terminal reason stops observation:
    // `stop()` releases the caller subscription when nothing is owed, and this
    // reason is already owed.
    queue.accept();
    if (options.terminal ?? true) stop();
    notificationQueue = notificationQueue
      .then(async () => {
        const enqueued = await notify(reason, options.permissionRequest);
        if (!enqueued) {
          queue.abandon();
          releaseCallerIfSettled();
        }
      })
      .catch((error) => {
        queue.abandon();
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to notify caller agent",
        );
        releaseCallerIfSettled();
      });
  }

  // SLP-PATCH(wakeup-defers): armed at watcher creation, not on the first
  // `busy`, so a notification can never be owed with nobody listening for the
  // caller's next idle. `stop()` does not touch it.
  unsubscribeCaller = agentManager.subscribe(
    (event) => {
      if (callerReleased || callerGone) return;
      if (event.type !== "agent_state") return;
      if (event.agent.lifecycle === "closed") {
        callerIsGone("caller closed");
        return;
      }
      // Retry trigger: the caller's next `agent_state` event of any lifecycle.
      // `error` is held by the pump's own lifecycle read, not dropped here.
      pump();
    },
    { agentId: callerAgentId, replayState: false },
  );

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        for (const requestId of notifiedPermissionRequestIds) {
          if (!event.agent.pendingPermissions.has(requestId)) {
            notifiedPermissionRequestIds.delete(requestId);
          }
        }
        if (event.agent.lifecycle === "running") {
          if (event.agent.pendingPermissions.size === 0) {
            hasSeenRunning = true;
          }
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          // SLP-PATCH(wakeup-each): upstream stops the watcher at the first
          // finish. SLP drives one long-lived child across many prompts and the
          // caller has to hear every one, so re-arm the run gate and keep the
          // subscription: the child's next running→idle cycle notifies again.
          // Disarming is left to "was closed", "errored", and caller archival.
          hasSeenRunning = false;
          notifySafely("finished", { terminal: false });
          return;
        }
        if (event.agent.lifecycle === "closed") {
          notifySafely("was closed");
          return;
        }
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    stop();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
