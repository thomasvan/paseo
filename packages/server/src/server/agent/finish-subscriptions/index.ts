import { setTimeout as pause } from "node:timers/promises";
import { HostObservationError } from "../host-operations/index.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { FinishObservationResult } from "./internal/observation-buffer.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  formatFinishNotificationBody,
  finishNotificationEvents,
  type FinishNotificationReason,
} from "./internal/notification.js";
export { createJsonFinishSubscriptionStore } from "./internal/json-store.js";

export interface FinishSubscription {
  id: string;
  callerAgentId: string;
  childAgentId: string;
  serverId?: string;
  /** Creation subscriptions stop reporting after the child is detached. */
  requireParentOwnership?: boolean;
  /**
   * SLP-PATCH(wakeup-each): the watch re-armed after a finish and waits for the child's next
   * turn. Absent means the gate is open, as for a fresh registration or a record upstream wrote.
   */
  awaitingTurn?: true;
}
export interface FinishSubscriptionStore {
  list(): Promise<FinishSubscription[]>;
  put(subscription: FinishSubscription): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface FinishObservationSession {
  next(): Promise<FinishObservationResult>;
  close(): Promise<void>;
  /** SLP-PATCH(wakeup-each): a turn was observed after the last terminal `next()` returned. */
  turnPending?(): boolean;
  /** SLP-PATCH(wakeup-each): calls `listener` on each observed turn, and now if one is pending. */
  onTurn?(listener: () => void): void;
}
export interface FinishObservation {
  open(subscription: FinishSubscription, signal: AbortSignal): Promise<FinishObservationSession>;
}
interface Dependencies extends FinishObservation {
  store: FinishSubscriptionStore;
  messages(): AgentMessageDelivery;
  callerIsActive(agentId: string): Promise<boolean>;
  /**
   * SLP-PATCH(wakeup-each): archive state from agent storage, because the live closed payload
   * carries `archivedAt: null`. Read for a local child only.
   */
  childArchived?(agentId: string): Promise<boolean>;
  serverId: string;
  logger: Logger;
  retryDelayMs?: number;
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
  close(): Promise<void>;
}
interface Watch {
  records: FinishSubscription[];
  controller: AbortController;
  decision: Promise<boolean>;
  decide(accepted: boolean): void;
  pending: boolean;
  /** SLP-PATCH(wakeup-each): waiting for a turn and holding no outcome, so the caller is free. */
  awaiting: boolean;
  task?: Promise<void>;
}
function key(record: FinishSubscription): string {
  return JSON.stringify([record.callerAgentId, record.childAgentId, record.serverId]);
}
/** SLP-PATCH(wakeup-each): the record as stored with the gate waiting or open. */
function gated(record: FinishSubscription, awaitingTurn: boolean): FinishSubscription {
  const { awaitingTurn: _previous, ...rest } = record;
  return awaitingTurn ? { ...rest, awaitingTurn: true } : rest;
}

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
      // SLP-PATCH(wakeup-each): the gate starts waiting only if every record in the group awaits.
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
    const parent = getParentAddressFromLabels(
      result.final.labels,
      record.serverId ?? deps.serverId,
    );
    return parent?.agentId !== record.callerAgentId || parent.serverId !== deps.serverId;
  }
  /** SLP-PATCH(wakeup-each) */
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
    result: FinishObservationResult,
    reason: FinishNotificationReason, // SLP-PATCH(wakeup-each): an archived child reads `was closed`
    permissions: Set<string>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const requests = result.final?.pendingPermissions ?? [];
    for (const id of permissions)
      if (!requests.some((request) => request.id === id)) permissions.delete(id);
    const acknowledgments: Promise<unknown>[] = [];
    for (const request of reason === "needs permission" ? requests : [undefined]) {
      if (signal.aborted) return false;
      if (request && permissions.has(request.id)) continue;
      const title = result.final?.title ?? record.childAgentId;
      const receipt = deps.messages().enqueue({
        recipientId: record.callerAgentId,
        prompt: formatFinishNotificationBody({
          childAgentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          reason,
          lastAssistantMessage: result.lastMessage,
          permissionRequest: request,
        }),
        source: {
          kind: "agent-notification",
          agentId: record.childAgentId,
          serverId: record.serverId ?? deps.serverId,
          title,
          event: finishNotificationEvents[reason],
        },
        activeTurnBehavior: "steer",
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
    if (signal.aborted) return false;
    if (reason !== "needs permission") return true;
    return false;
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
    const permissions = new Set<string>();
    let observation: FinishObservationSession | undefined;
    let pending: FinishObservationResult | undefined;
    let acknowledged = false;
    let remoteFailures = 0;
    let retries = 0;
    let warned = false;
    // SLP-PATCH(wakeup-each): the gate. Open delivers the cycle's first terminal, as upstream's
    // one-shot watch does; waiting delivers only a terminal that follows an observed turn. The
    // stored records hold the waiting state, so a restart cannot read an idle child as a finish.
    let open = !watch.records.every((intent) => intent.awaitingTurn === true);
    let storedAwaiting = !open;
    function turnObserved(): void {
      watch.awaiting = false;
      if (!storedAwaiting) return;
      // Once per waiting-to-open change, so a stop mid-turn recovers a gate that delivers.
      storedAwaiting = false;
      void serialize(async () => {
        if (signal.aborted) return;
        const opened = watch.records.map((intent) => gated(intent, false));
        for (const intent of opened) await deps.store.put(intent);
        watch.records = opened;
      }).catch((error) =>
        deps.logger.warn({ err: error, subscription: record.id }, "Failed to open finish gate"),
      );
    }
    async function rearm(): Promise<void> {
      // Serialized behind registration and supersession, and abort-checked, so a superseded
      // watch's late write cannot bring back a record that `accept` removed.
      await serialize(async () => {
        if (signal.aborted) return;
        const awaitingTurn = !(observation?.turnPending?.() ?? false);
        const { requireParentOwnership: _captured, ...kept } = watch.records[0]!;
        const next = gated(
          record.requireParentOwnership ? { ...kept, requireParentOwnership: true } : kept,
          awaitingTurn,
        );
        await deps.store.put(next);
        for (const other of watch.records.slice(1)) await deps.store.remove(other.id);
        watch.records = [next];
        // SLP-PATCH(wakeup-each): after a re-arm each queued terminal is judged by its own turn
        // boundary (`turnObserved`), never by a turn that is merely pending: a repeat of the
        // acknowledged turn can still be queued ahead of a later turn's finish.
        open = false;
        storedAwaiting = awaitingTurn;
        watch.awaiting = awaitingTurn;
        // A turn observed while the write was in flight opens the gate again.
        if (awaitingTurn && observation?.turnPending?.()) turnObserved();
      });
    }
    /** SLP-PATCH(wakeup-each): a terminal the waiting gate drops: silent, and the watch stays armed. */
    function gatedOut(result: FinishObservationResult, archived: boolean): boolean {
      return (
        Boolean(result.final) &&
        result.status !== "permission" &&
        !archived &&
        !open &&
        !result.turnObserved
      );
    }
    /**
     * SLP-PATCH(wakeup-each): D-Q2. An archived child sends `was closed` and disarms. While the
     * gate waits, any other terminal of a child that is not archived is silent and the watch
     * stays armed. Once open, `finished` and a mid-turn `was closed` re-arm; every other outcome
     * keeps upstream's remove-and-stop.
     */
    async function settle(result: FinishObservationResult): Promise<"done" | "next"> {
      const archived = await childIsArchived(record, result);
      const reason: FinishNotificationReason = archived ? "was closed" : reasonFor(result);
      if (gatedOut(result, archived)) {
        watch.awaiting = !(observation?.turnPending?.() ?? false);
        return "next";
      }
      const rearms = !archived && (reason === "finished" || reason === "was closed");
      if (!acknowledged) acknowledged = await deliver(record, result, reason, permissions, signal);
      if (!acknowledged) return "next";
      if (!rearms) {
        // A removal failure retries only the commit, never the already accepted callback.
        await remove(watch);
        stop(watch, group);
        return "done";
      }
      // A storage failure retries only the re-arm, as above.
      await rearm();
      acknowledged = false;
      return signal.aborted ? "done" : "next";
    }
    async function observeNext(): Promise<FinishObservationResult | undefined> {
      try {
        if (!observation) {
          observation = await deps.open(record, signal);
          observation.onTurn?.(turnObserved); // SLP-PATCH(wakeup-each)
        }
        const result = await abortable(observation.next(), signal);
        remoteFailures = 0;
        return result;
      } catch (error) {
        // SLP-PATCH(wakeup-each): a turn the closing observation saw stays observed.
        if (observation?.turnPending?.()) open = true;
        await observation?.close();
        observation = undefined;
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
    try {
      while (!signal.aborted) {
        try {
          if (await suppressed(record)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if (!pending) pending = await observeNext();
          if (!pending) {
            await delay(signal, retries++);
            continue;
          }
          watch.awaiting = false; // SLP-PATCH(wakeup-each): an outcome is held
          if (signal.aborted) return;
          await decisions(group);
          if (signal.aborted) return;
          if (await suppressed(record, pending)) {
            await remove(watch);
            stop(watch, group);
            return;
          }
          if ((await settle(pending)) === "done") return;
          pending = undefined;
          retries = 0;
          warned = false;
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
      if (recovering || registering.has(agentId)) return true;
      for (const group of watches.values()) {
        for (const watch of group)
          // SLP-PATCH(wakeup-each): a watch awaiting a turn holds no outcome and pins nothing.
          if (watch.records[0]!.callerAgentId === agentId && !watch.awaiting) return true;
      }
      return false;
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
    async close() {
      closed = true;
      await mutations;
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
