import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { getCreatorAddressFromLabels } from "../creator-mark.js"; // AIROOM-PATCH(wakeup-each)
import {
  endsSubscription,
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
import {
  createFollowing,
  FOLLOW_LIMIT,
  type FollowOutcome,
  type Notice,
} from "./internal/following.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
  /**
   * Set once the child ended a turn while it was still working and the caller was told so.
   * The subscription then follows the child until it settles or the follow limit passes.
   */
  followingSince?: string;
  /**
   * AIROOM-PATCH(wakeup-each): the watch re-armed after it settled and waits for the child's next
   * turn. Absent means the gate is open, as for a fresh registration or a record upstream wrote.
   */
  awaitingTurn?: true;
}
/**
 * Work that will start the child's next turn without a new prompt from the caller.
 * Recurring triggers such as heartbeats are not pending work: they never settle.
 */
export type PendingWork = "turn" | "background work" | "queued messages" | "delegated agents";
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
  /** AIROOM-PATCH(wakeup-each): a turn was observed after the last terminal `next()` returned. */
  turnPending?(): boolean;
  /** AIROOM-PATCH(wakeup-each): calls `listener` on each observed turn, and now if one is pending. */
  onTurn?(listener: () => void): void;
  /**
   * AIROOM-PATCH(wakeup-each): the child's latest state the observation saw, once it saw one.
   * Read where no terminal carries it, as at the follow limit.
   */
  state?(): Promise<WaitForFinishResult["final"]>;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
  /** The child's own pending work. Empty when its host cannot tell, as for remote children. */
  pendingWork(subscription: FinishSubscription): readonly PendingWork[];
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  callerIsActive(agentId: string): Promise<boolean>;
  /**
   * AIROOM-PATCH(wakeup-each): archive state from agent storage, because the live closed payload
   * carries `archivedAt: null`. Read for a local child only.
   */
  childArchived?(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
  /** How long a child that is still working is followed before the subscription gives up. */
  followLimitMs?: number;
}
export interface FinishRegistration {
  /** The prompt was accepted. Replaces preceding registrations for this pair. */
  accept(): void;
  /** Rejected dispatch preserves preceding registrations. */
  reject(): Promise<void>;
}
export interface FinishSubscriptions {
  start(): Promise<void>;
  /** Pending notification intent, including registration, recovery and unacknowledged delivery. */
  hasPendingForCaller(agentId: string): boolean;
  register(
    input: Omit<FinishSubscription, "id">,
    pendingDispatch?: boolean,
  ): Promise<FinishRegistration>;
  /**
   * AIROOM-PATCH(wakeup-each): ends every watch of this caller on this child, pending, following
   * or waiting, and removes its stored records. Serialized with registration, so it ends the
   * registrations made before it and none made after. A notice already enqueued stays enqueued.
   */
  cancel(input: FinishSubscriptionPair): Promise<void>;
  close(): Promise<void>;
}
export type FinishSubscriptionPair = Pick<
  FinishSubscription,
  "callerAgentId" | "childAgentId" | "serverId"
>;
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  /**
   * AIROOM-PATCH(wakeup-each): waiting for a turn and holding no outcome. Such a watch brings its
   * caller nothing until the child runs again, so it counts as no delegation and pins nothing.
   */
  awaiting: boolean;
  /** AIROOM-PATCH(wakeup-each): one last attempt at a gate-open write still owed, before close. */
  flushGate?(): Promise<void>;
  task?: Promise<void>;
  /** Decides a followed child's state again; see `createFollowing`. */
  recheck?(): void;
}
/** AIROOM-PATCH(wakeup-each): one read of the observation, and its value once it settled. */
interface HeldRead {
  promise: Promise<FinishObservationResult>;
  value?: FinishObservationResult;
}
function key(record: FinishSubscriptionPair): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}
/** AIROOM-PATCH(wakeup-each): the record as stored with the gate waiting or open. */
function gated(record: FinishSubscription, awaitingTurn: boolean): FinishSubscription {
  const { awaitingTurn: _previous, ...rest } = record;
  return awaitingTurn ? { ...rest, awaitingTurn: true } : rest;
}
const DEFAULT_FOLLOW_LIMIT_MS = 24 * 60 * 60_000;

/** Owns durable intent, live observation, supersession, and dispatch acknowledgment. */
export function createFinishSubscriptions(deps: Dependencies): FinishSubscriptions {
  const tasks = new Set<Promise<void>>();
  const watches = new Map<string, Set<Watch>>();
  let closed = false;
  let recovering = true;
  const registering = new Map<string, number>();
  let mutations = Promise.resolve();
  function serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = mutations.then(action);
    mutations = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  function attach(records: FinishSubscription[], pending: boolean): Watch {
    let decide!: Watch["decide"];
    const decision = new Promise<boolean>((resolve) => {
      decide = resolve;
    });
    const watch: Watch = {
      records,
      controller: new AbortController(),
      pending,
      decision,
      decide,
      // AIROOM-PATCH(wakeup-each): the gate starts waiting only if every record in the group awaits.
      awaiting: !pending && records.every((record) => record.awaitingTurn === true),
    };
    const group = watches.get(key(records[0]!)) ?? new Set<Watch>();
    group.add(watch);
    watches.set(key(records[0]!), group);
    if (!pending) decide(true);
    watch.task = run(watch, group).catch((error) =>
      deps.logger.error({ err: error }, "Finish subscription failed"),
    );
    tasks.add(watch.task);
    void watch.task.then(() => tasks.delete(watch.task!));
    return watch;
  }
  function stop(watch: Watch, group: Set<Watch>): void {
    watch.controller.abort();
    watch.decide(false);
    group.delete(watch);
    if (!group.size && watches.get(key(watch.records[0]!)) === group)
      watches.delete(key(watch.records[0]!));
  }
  /**
   * A watch that ends without telling its caller leaves that caller's own watchers with no event:
   * the caller may have no work left now.
   */
  function recheckCallerOf(watch: Watch): void {
    const { callerAgentId } = watch.records[0]!;
    for (const group of watches.values())
      for (const watcher of group) {
        const record = watcher.records[0]!;
        if (record.childAgentId === callerAgentId && !record.serverId) watcher.recheck?.();
      }
  }
  async function remove(watch: Watch): Promise<void> {
    // Only IDs captured by this observer are eligible; newer registrations survive.
    for (const record of watch.records) await deps.store.remove(record.id);
  }
  async function delay(signal: AbortSignal, attempt: number): Promise<void> {
    try {
      await pause(
        Math.min((deps.retryDelayMs ?? 1000) * 2 ** Math.min(attempt, 3), 5000),
        undefined,
        { signal },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([operation, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  async function decisions(group: Set<Watch>): Promise<void> {
    // New candidates may arrive while an older dispatch decision is pending.
    while (true) {
      if (closed) return;
      const pending = [...group].filter((watch) => watch.pending);
      if (!pending.length) return;
      await Promise.all(pending.map((watch) => watch.decision));
    }
  }
  async function suppressed(
    record: FinishSubscription,
    result?: WaitForFinishResult,
  ): Promise<boolean> {
    if (!(await deps.callerIsActive(record.callerAgentId))) return true;
    if (!record.requireParentOwnership || !result?.final) return false;
    return !parented(record, result);
  }
  /**
   * AIROOM-PATCH(wakeup-each): the child's parent label names the caller on this server. Upstream's
   * `suppressed` reads it for a create watch; `owned` reads it for a re-arm.
   */
  function parented(record: FinishSubscription, result: WaitForFinishResult): boolean {
    if (!result.final) return false;
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return parent?.agentId === record.callerAgentId && parent.serverId === deps.serverId;
  }
  /**
   * AIROOM-PATCH(wakeup-each): the child is the caller's own: its parent, or the agent that created
   * it, is the caller on this server. The creator mark names the direct creator only.
   */
  function owned(record: FinishSubscription, result: WaitForFinishResult | null): boolean {
    if (!result?.final) return false;
    if (parented(record, result)) return true;
    const creator = getCreatorAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return creator?.agentId === record.callerAgentId && creator.serverId === deps.serverId;
  }
  /** AIROOM-PATCH(wakeup-each) */
  async function childIsArchived(
    record: FinishSubscription,
    result: FinishObservationResult,
  ): Promise<boolean> {
    if (!result.final) return false;
    if (result.final.archivedAt) return true;
    return !record.serverId && ((await deps.childArchived?.(record.childAgentId)) ?? false);
  }
  function reasonFor(result: FinishObservationResult): FinishNotificationReason {
    if (result.reason === "host unreachable" || result.reason === "host removed")
      return result.reason;
    if (!result.final) return "is unavailable";
    if (result.final.status === "closed") return "was closed";
    if (result.status === "error") return "errored";
    if (result.status === "permission") return "needs permission";
    return result.reason ?? "finished";
  }
  async function deliver(
    record: FinishSubscription,
    notice: Notice,
    permissions: Set<string>,
    signal: AbortSignal,
    continues = false, // AIROOM-PATCH(wakeup-each): the watch re-arms after this notice.
  ): Promise<void> {
    const { reason, result } = notice;
    const requests = result?.final?.pendingPermissions ?? [];
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return;
      if (request && permissions.has(request.id)) continue;
      const title = result?.final?.title ?? record.childAgentId;
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: formatFinishNotificationBody({
          childAgentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          reason,
          lastAssistantMessage: result?.lastMessage ?? null,
          permissionRequest: request,
          pendingWork: notice.work,
          continues, // AIROOM-PATCH(wakeup-each)
        }),
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        // A finish report never enters a running turn.
        activeTurnBehavior: "queue",
        unarchive: false,
      });
      acknowledgments.push(
        receipt.dispatched.then(() => {
          if (request) permissions.add(request.id);
          return undefined;
        }),
      );
    }
    await abortable(Promise.all(acknowledgments), signal);
  }
  function delegations(agentId: string): FinishSubscription[] {
    const records: FinishSubscription[] = [];
    for (const group of watches.values())
      for (const watch of group)
        // AIROOM-PATCH(wakeup-each): a watch waiting for a turn will bring its caller nothing.
        if (watch.records[0]!.callerAgentId === agentId && !watch.awaiting)
          records.push(watch.records[0]!);
    return records;
  }
  function delegates(agentId: string): boolean {
    return registering.has(agentId) || delegations(agentId).length > 0;
  }
  /**
   * Whether one of the agent's delegations can still bring it a notice. A delegate that has settled
   * is about to report; a delegate that only waits on agents in `chain` never will, so agents that
   * wait on each other settle together.
   */
  function awaitsDelegates(agentId: string, chain: Set<string>): boolean {
    if (registering.has(agentId)) return true;
    chain.add(agentId);
    return delegations(agentId).some((delegation) => {
      // A remote delegate's work is known only to its host.
      if (delegation.serverId) return true;
      const delegate = delegation.childAgentId;
      if (chain.has(delegate)) return false;
      if (deps.pendingWork(delegation).length > 0 || delegations(delegate).length === 0)
        return true;
      return awaitsDelegates(delegate, chain);
    });
  }
  /** Everything that will start the child's next turn by itself. */
  function pendingWork(record: FinishSubscription): PendingWork[] {
    const work = [...deps.pendingWork(record)];
    // A remote child's own subscriptions live on its host.
    if (!record.serverId && awaitsDelegates(record.childAgentId, new Set()))
      work.push("delegated agents");
    return work;
  }
  async function run(watch: Watch, group: Set<Watch>): Promise<void> {
    const signal = watch.controller.signal;
    if (!(await watch.decision) || signal.aborted) return;
    const record = {
      ...watch.records[0]!,
      requireParentOwnership: watch.records.every(
        (intent) => intent.requireParentOwnership === true,
      ),
    };
    // AIROOM-PATCH(wakeup-each): the gate. Open delivers the cycle's first terminal, as upstream's
    // watch does; waiting delivers only a terminal that follows an observed turn. The stored
    // records hold the waiting state, so a restart cannot read an idle child as a finish.
    let open = !watch.records.every((intent) => intent.awaitingTurn === true);
    let storedAwaiting = !open;
    // AIROOM-PATCH(wakeup-each): a followed cycle saw its turn end, so its gate is open whatever
    // the stamps say: upstream's follow reads a work change as the child settling.
    let followed = watch.records.some((intent) => intent.followingSince !== undefined);
    // AIROOM-PATCH(wakeup-each): a turn observed while the stored records await one owes a write
    // of the records without the field, so a stop mid-turn recovers a gate that delivers. The
    // obligation holds until a write lands or a re-arm settles the records itself: a failed
    // write is retried, and a graceful close makes one last attempt.
    let gateOwed = false;
    let opening: Promise<void> | undefined;
    /** AIROOM-PATCH(wakeup-each): in place, so `following` always holds the current records. */
    function replaceRecords(next: FinishSubscription[]): void {
      watch.records.splice(0, watch.records.length, ...next);
    }
    async function writeGateOpen(): Promise<void> {
      await serialize(async () => {
        if (signal.aborted || !gateOwed) return;
        const opened = watch.records.map((intent) => gated(intent, false));
        for (const intent of opened) await deps.store.put(intent);
        replaceRecords(opened);
        storedAwaiting = false;
        gateOwed = false;
      });
    }
    async function openGate(): Promise<void> {
      for (let attempt = 0; gateOwed && !signal.aborted; attempt++) {
        try {
          await writeGateOpen();
        } catch (error) {
          if (attempt === 0)
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Failed to open finish gate; retrying",
            );
          await delay(signal, attempt);
        }
      }
    }
    function turnObserved(): void {
      watch.awaiting = false;
      if (!storedAwaiting) return;
      gateOwed = true;
      opening ??= openGate().finally(() => {
        opening = undefined;
      });
    }
    /** AIROOM-PATCH(wakeup-each): a watch that starts waiting may have been its caller's last work. */
    function setAwaiting(awaiting: boolean): void {
      const started = awaiting && !watch.awaiting;
      watch.awaiting = awaiting;
      if (started) recheckCallerOf(watch);
    }
    watch.flushGate = async () => {
      if (!gateOwed) return;
      await writeGateOpen().catch((error) =>
        deps.logger.warn({ err: error, subscription: record.id }, "Failed to open finish gate"),
      );
    };
    /**
     * AIROOM-PATCH(wakeup-each): the follow's own write, serialized and abort-checked like every
     * other write of this watch, so a cancel or a supersession is never undone by it. A followed
     * child has ended a turn, so the write also opens the gate.
     */
    const followStore: Pick<FinishSubscriptionStore, "put"> = {
      put: (intent) =>
        serialize(async () => {
          signal.throwIfAborted();
          const next = gated(intent, false);
          await deps.store.put(next);
          const index = watch.records.findIndex((kept) => kept.id === next.id);
          if (index >= 0) watch.records[index] = next;
          if (watch.records.every((kept) => kept.awaitingTurn !== true)) {
            storedAwaiting = false;
            gateOwed = false;
          }
          followed = true;
        }),
    };
    function createCycle() {
      return createFollowing({
        records: watch.records,
        store: followStore,
        limitMs: deps.followLimitMs ?? DEFAULT_FOLLOW_LIMIT_MS,
        pendingWork: () => pendingWork(record),
        reasonFor,
      });
    }
    let following = createCycle();
    watch.recheck = () => following.recheck();
    /**
     * AIROOM-PATCH(wakeup-each): a settled watch of a child the caller owns waits for the child's
     * next turn instead of ending. Serialized behind registration and supersession, and
     * abort-checked, so a superseded or cancelled watch's late write cannot bring back a record
     * that `accept` or `cancel` removed. The re-armed record carries no `followingSince`, so the
     * follow limit never runs on a watch that is only idle.
     */
    async function rearm(): Promise<void> {
      await serialize(async () => {
        if (signal.aborted) return;
        // A kept read that already took a terminal after a turn holds that turn: the record stays
        // open, so a restart before its delivery still reads it.
        const awaitingTurn =
          !(observation?.turnPending?.() ?? false) && reading?.value?.turnObserved !== true;
        const {
          requireParentOwnership: _captured,
          followingSince: _followed,
          ...kept
        } = watch.records[0]!;
        const next = gated(
          record.requireParentOwnership ? { ...kept, requireParentOwnership: true } : kept,
          awaitingTurn,
        );
        await deps.store.put(next);
        for (const other of watch.records.slice(1)) await deps.store.remove(other.id);
        replaceRecords([next]);
        // After a re-arm each queued terminal is judged by its own turn stamp, never by a turn
        // that is merely pending: a repeat of the settled turn can still be queued ahead of a
        // later turn's finish.
        open = false;
        followed = false;
        storedAwaiting = awaitingTurn;
        gateOwed = false;
        following = createCycle();
        setAwaiting(awaitingTurn);
        // A turn observed while the write was in flight opens the gate again.
        if (awaitingTurn && observation?.turnPending?.()) turnObserved();
      });
    }
    /** AIROOM-PATCH(wakeup-each): a terminal the waiting gate drops: silent, and the watch stays armed. */
    function gatedOut(result: FinishObservationResult): boolean {
      if (!result.final || result.status === "permission" || open || followed) return false;
      // The buffer never stamps a work change as following a turn: it is no turn end.
      return !result.turnObserved;
    }
    /**
     * AIROOM-PATCH(wakeup-each): a delivered `finished`, follow-limit notice or `was closed` of a
     * child that is not archived re-arms when the child is the caller's own, read from `child`:
     * the delivered terminal, or the child's state at the follow limit. Every other outcome keeps
     * upstream's remove-and-stop. Decided before delivery, so the notice can say which.
     */
    function rearms(
      notice: Notice | undefined,
      archived: boolean,
      child = notice?.result ?? null,
    ): boolean {
      if (!notice || archived) return false;
      if (
        notice.reason !== "finished" &&
        notice.reason !== "was closed" &&
        notice.reason !== "is still working"
      )
        return false;
      return owned(record, child);
    }
    /**
     * AIROOM-PATCH(wakeup-each): the child as it is at the follow limit. The follow holds the last
     * terminal it decided, which a watch recovered while following never saw, so the observation's
     * latest state comes first; it waits for the observation's first state, if none came yet.
     */
    async function childAtLimit(notice: Notice): Promise<FinishObservationResult | null> {
      const final = observation?.state ? await abortable(observation.state(), signal) : null;
      if (!final) return notice.result;
      return { status: "idle", final, lastMessage: null, error: null };
    }
    const permissions = new Set<string>();
    let observation: FinishObservationSession | undefined;
    /**
     * AIROOM-PATCH(wakeup-each): a read of the observation that lost `following.next`'s race to
     * the follow limit or a recheck. It is kept for the next outcome: a fresh read beside it would
     * leave it to take the child's next terminal unseen, once the watch re-arms.
     */
    let reading: HeldRead | undefined;
    /** One outcome and how far it got. Retries resume it: nothing is lost or sent twice. */
    let current:
      | {
          outcome: FollowOutcome;
          decided: boolean;
          notice?: Notice;
          sent: boolean;
          rearms?: boolean; // AIROOM-PATCH(wakeup-each)
        }
      | undefined;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    async function observeNext(): Promise<FollowOutcome | undefined> {
      try {
        if (!observation) {
          observation = await deps.open(record, signal);
          observation.onTurn?.(turnObserved); // AIROOM-PATCH(wakeup-each)
        }
        // AIROOM-PATCH(wakeup-each): the read a limit or a recheck won over stays the next one.
        if (!reading) {
          const read: HeldRead = {
            promise: abortable(observation.next(), signal).then((value) => {
              read.value = value;
              return value;
            }),
          };
          read.promise.catch(() => undefined);
          reading = read;
        }
        const read = reading;
        const result = await following.next(read.promise, signal);
        if (result === read.value) reading = undefined;
        remoteFailures = 0;
        return result;
      } catch (error) {
        // AIROOM-PATCH(wakeup-each): a turn the closing observation saw stays observed.
        if (observation?.turnPending?.()) open = true;
        await observation?.close();
        observation = undefined;
        reading = undefined; // AIROOM-PATCH(wakeup-each)
        signal.throwIfAborted();
        if (!(error instanceof HostObservationError) || !record.serverId) throw error;
        if (error.reason === "connecting") return undefined;
        if (error.reason === "unreachable" && ++remoteFailures < 3) return undefined;
        // Host visibility ends this subscription; it says nothing about child completion.
        return {
          status: "error",
          final: null,
          lastMessage: null,
          error: null,
          reason: error.reason === "removed" ? "host removed" : "host unreachable",
        };
      }
    }
    async function end(notified: boolean): Promise<true> {
      await remove(watch);
      stop(watch, group);
      if (!notified) recheckCallerOf(watch);
      return true;
    }
    async function decide(
      outcome: FollowOutcome,
    ): Promise<{ notice?: Notice; rearms: boolean } | "suppressed" | "gated"> {
      // A queued follow-up cannot start until the current permission is answered.
      // Its pending registration must not hold the running turn's checkpoint.
      if (outcome === FOLLOW_LIMIT || outcome.status !== "permission" || watch.pending)
        await decisions(group);
      signal.throwIfAborted();
      if (await suppressed(record, outcome === FOLLOW_LIMIT ? undefined : outcome))
        return "suppressed";
      // AIROOM-PATCH(wakeup-each): at the limit, ownership and archive state are the child's own.
      if (outcome === FOLLOW_LIMIT) {
        const notice = await following.decide(outcome);
        if (!notice) return { rearms: false };
        const child = await childAtLimit(notice);
        const archived = !!child && (await childIsArchived(record, child));
        return { notice, rearms: rearms(notice, archived, child) };
      }
      // AIROOM-PATCH(wakeup-each): an archived child needs no turn: it reads `was closed` and
      // disarms. Any other terminal the waiting gate drops is silent.
      if (await childIsArchived(record, outcome))
        return { notice: { reason: "was closed", result: outcome, work: [] }, rearms: false };
      if (gatedOut(outcome)) return "gated";
      const notice = await following.decide(outcome);
      return { notice, rearms: rearms(notice, false) };
    }
    /** Handles one outcome. Returns true once the subscription has ended. */
    async function step(): Promise<boolean> {
      if (await suppressed(record)) return end(false);
      if (!current) {
        const outcome = await observeNext();
        if (!outcome) {
          await delay(signal, retries++);
          return false;
        }
        current = { outcome, decided: false, sent: false };
      }
      signal.throwIfAborted();
      if (!current.decided) {
        const decision = await decide(current.outcome);
        if (decision === "suppressed") return end(false);
        if (decision === "gated") {
          // AIROOM-PATCH(wakeup-each): still waiting, unless a turn came after this terminal.
          setAwaiting(!(observation?.turnPending?.() ?? false));
          current = undefined;
          return false;
        }
        watch.awaiting = false; // AIROOM-PATCH(wakeup-each): an outcome is held
        current = { ...current, decided: true, ...decision };
      }
      const { notice } = current;
      if (notice && !current.sent) {
        // AIROOM-PATCH(wakeup-each): the notice says whether the watch re-arms after it.
        await deliver(record, notice, permissions, signal, current.rearms === true);
        signal.throwIfAborted();
        current.sent = true;
      }
      // A removal failure retries only the commit, never the already accepted callback.
      if (notice && endsSubscription(notice.reason)) {
        // AIROOM-PATCH(wakeup-each): a storage failure retries only the re-arm, as above.
        if (!current.rearms) return end(true);
        await rearm();
      }
      current = undefined;
      retries = 0;
      warned = false;
      return false;
    }
    try {
      while (!signal.aborted) {
        try {
          if (await step()) return;
        } catch (error) {
          if (signal.aborted) return;
          // Delivery and storage failures retain the captured outcome and durable intent.
          // They do not spend the remote-observation budget or change the child's outcome.
          if (!warned) {
            deps.logger.warn(
              { err: error, subscription: record.id },
              "Retrying finish subscription",
            );
            warned = true;
          }
          await delay(signal, retries++);
        }
      }
    } finally {
      await observation?.close();
    }
  }

  return {
    hasPendingForCaller(agentId) {
      return recovering || delegates(agentId);
    },
    start: () =>
      serialize(async () => {
        const groups = new Map<string, FinishSubscription[]>();
        for (const record of await deps.store.list()) {
          const records = groups.get(key(record)) ?? [];
          records.push(record);
          groups.set(key(record), records);
        }
        for (const records of groups.values()) attach(records, false);
        recovering = false;
      }),
    register: (input, pendingDispatch = false) => {
      registering.set(input.callerAgentId, (registering.get(input.callerAgentId) ?? 0) + 1);
      return serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const record: FinishSubscription = {
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
          id: randomUUID(),
        };
        await deps.store.put(record);
        const group = watches.get(key(record)) ?? new Set<Watch>();
        const predecessors = [...group];
        const watch = attach([record], true);
        const actualGroup = watches.get(key(record))!;
        const registration: FinishRegistration = {
          accept() {
            if (!watch.pending || closed) return;
            watch.pending = false;
            for (const prior of predecessors) stop(prior, actualGroup);
            watch.decide(true);
            void serialize(async () => {
              for (const prior of predecessors) await remove(prior);
            }).catch((error) =>
              deps.logger.error({ err: error }, "Failed to remove superseded finish subscriptions"),
            );
          },
          reject: () =>
            serialize(async () => {
              await remove(watch);
              stop(watch, actualGroup);
            }),
        };
        if (!pendingDispatch) registration.accept();
        return registration;
      }).finally(() => {
        const remaining = registering.get(input.callerAgentId)! - 1;
        if (remaining) registering.set(input.callerAgentId, remaining);
        else registering.delete(input.callerAgentId);
      });
    },
    // AIROOM-PATCH(wakeup-each): behind every registration made before it, so a pending one ends
    // too and its later `accept` finds nothing to revive; an in-flight re-arm, follow or gate
    // write checks the abort inside `serialize` and writes nothing after this.
    cancel: (input) =>
      serialize(async () => {
        if (closed) throw new Error("Finish subscriptions are closed");
        const pair = key({
          ...input,
          serverId: input.serverId === deps.serverId ? undefined : input.serverId,
        });
        const group = watches.get(pair);
        for (const watch of group ?? []) stop(watch, group!);
        for (const record of await deps.store.list())
          if (key(record) === pair) await deps.store.remove(record.id);
      }),
    async close() {
      closed = true;
      await mutations;
      // AIROOM-PATCH(wakeup-each): a gate-open write still owed gets one last attempt first.
      for (const group of watches.values()) for (const watch of group) await watch.flushGate?.();
      for (const group of watches.values())
        for (const watch of group) {
          watch.controller.abort();
          watch.decide(false);
        }
      await mutations;
      await Promise.all(tasks);
      await deps.store.list();
      // Dispatch may still be pending. The delivery owner drains it after observers stop.
    },
  };
}

export { createFinishObservation } from "./internal/observation.js";
