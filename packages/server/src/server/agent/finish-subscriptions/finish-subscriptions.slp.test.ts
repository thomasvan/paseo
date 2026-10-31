// SLP-PATCH(wakeup-each): a caller hears every finish of a long-lived child, exactly once, across
// restarts. These rows drive `createFinishSubscriptions` on the real JSON store, observing through
// the real `openFinishObservation` over a child fake that publishes what the local observer does.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import type { AgentMessageDelivery } from "../agent-messages/index.js";
import type { HostObservation } from "../host-operations/index.js";
import { buildStoredAgentPayload } from "../agent-projections.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { openFinishObservation } from "./internal/observation-stream.js";
import {
  createFinishSubscriptions,
  createJsonFinishSubscriptionStore,
  type FinishSubscription,
  type FinishSubscriptionStore,
  type FinishSubscriptions,
} from "./index.js";

type Status = "idle" | "running" | "closed" | "error";
type Handler = Parameters<HostObservation["observe"]>[1];

/** One child as one daemon sees it: live in memory, or only its stored record after a restart. */
class Child implements HostObservation {
  handlers = new Set<Handler>();
  waiting: Array<(result: WaitForFinishResult) => void> = [];
  turns = 0;
  constructor(
    public status: Status,
    public live = true,
    public last = "stored answer",
  ) {}
  snapshot() {
    return buildStoredAgentPayload(
      {
        id: "child",
        provider: "codex",
        cwd: "/tmp",
        title: "Child",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        labels: { "paseo.parent-agent-id": "parent" },
        lastStatus: this.status,
        // Prompted only by agents: every send projects to a tool call, never a user message.
        lastUserMessageAt: null,
        // The live closed payload carries no archive stamp; storage does.
        archivedAt: null,
      },
      ["codex"],
    );
  }
  result(): WaitForFinishResult {
    return {
      status: this.status === "error" ? "error" : "idle",
      final: this.snapshot(),
      lastMessage: this.last,
      error: null,
    };
  }
  async wait() {
    if (this.status !== "running") return this.result();
    return new Promise<WaitForFinishResult>((resolve) => this.waiting.push(resolve));
  }
  async observe(_id: string, handler: Handler) {
    this.handlers.add(handler);
    // As `internal/observation.ts`: a live child opens with a synthetic `turn_started` that
    // carries no turnId; a stored one publishes its stored payload.
    if (this.live) handler(this.snapshot(), { type: "turn_started", provider: "codex" }, this.last);
    else handler(this.snapshot(), undefined, this.last);
    return async () => {
      this.handlers.delete(handler);
    };
  }
  emit(event?: AgentStreamEvent) {
    for (const handler of this.handlers) handler(this.snapshot(), event, this.last);
  }
  /** A turn, whatever started it: `agent_state` running, then `turn_started` with its id. */
  start() {
    this.live = true;
    this.status = "running";
    this.emit();
    this.emit({ type: "turn_started", provider: "codex", turnId: `turn-${++this.turns}` });
  }
  settle(event: AgentStreamEvent, message: string) {
    this.last = message;
    this.status = "idle";
    this.emit(event);
    for (const resolve of this.waiting.splice(0)) resolve(this.result());
  }
  finish(message: string) {
    this.settle({ type: "turn_completed", provider: "codex" }, message);
  }
  cancel(message: string) {
    this.settle({ type: "turn_canceled", provider: "codex", reason: "interrupted" }, message);
  }
  /** `agent_state` with a non-idle lifecycle. */
  become(status: "closed" | "error") {
    this.status = status;
    this.emit();
  }
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}
class Delivery implements AgentMessageDelivery {
  prompts: string[] = [];
  acknowledgments: Array<ReturnType<typeof deferred<"steered">>> = [];
  enqueue(message: Parameters<AgentMessageDelivery["enqueue"]>[0]) {
    this.prompts.push(String(message.prompt));
    const acknowledgment = deferred<"steered">();
    this.acknowledgments.push(acknowledgment);
    return { status: "queued" as const, messageId: "notice", dispatched: acknowledgment.promise };
  }
  ack(index: number) {
    this.acknowledgments[index]!.resolve("steered");
  }
  async close() {}
  async waitForDispatch() {}
}

const homes: string[] = [];
const services: FinishSubscriptions[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    homes.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), "finish-wakeup-each-"));
  homes.push(directory);
  return directory;
}
async function stored(directory: string): Promise<FinishSubscription[]> {
  try {
    return JSON.parse(await readFile(join(directory, "finish-subscriptions.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
/** One daemon instance on `directory`. */
async function daemon(
  directory: string,
  child: Child,
  wrap: (store: FinishSubscriptionStore) => FinishSubscriptionStore = (store) => store,
) {
  const delivery = new Delivery();
  const state = { callerActive: true, childArchived: false };
  const service = createFinishSubscriptions({
    store: wrap(createJsonFinishSubscriptionStore(directory)),
    messages: () => delivery,
    open: (record, signal) =>
      openFinishObservation({ use: async (_server, action) => action(child) }, record, signal),
    callerIsActive: async () => state.callerActive,
    childArchived: async () => state.childArchived,
    serverId: "origin",
    logger: createTestLogger(),
    retryDelayMs: 1,
  });
  services.push(service);
  await service.start();
  return { directory, child, delivery, service, state };
}
type Daemon = Awaited<ReturnType<typeof daemon>>;
const intent = { callerAgentId: "parent", childAgentId: "child" };
async function until(check: () => boolean) {
  await expect.poll(check).toBe(true);
}
async function storedAwaiting(directory: string) {
  await expect
    .poll(async () => stored(directory))
    .toEqual([expect.objectContaining({ ...intent, awaitingTurn: true })]);
}
async function storedOpen(directory: string) {
  await expect
    .poll(async () => (await stored(directory)).map((record) => "awaitingTurn" in record))
    .toEqual([false]);
}
/** Registers a watch on a running child and delivers its first finish, unacknowledged. */
async function firstFinish(d: Daemon) {
  await d.service.register(intent);
  await until(() => d.child.handlers.size === 1);
  d.child.finish("first answer");
  await until(() => d.delivery.prompts.length === 1);
  expect(d.delivery.prompts[0]).toContain("Agent child (Child) finished.");
}
/** As `firstFinish`, then acknowledged: the watch re-arms and awaits the next turn. */
async function rearmed(directory?: string) {
  const d = await daemon(directory ?? (await home()), new Child("running"));
  await firstFinish(d);
  d.delivery.ack(0);
  await storedAwaiting(d.directory);
  return d;
}
/** A new turn and its finish, after which `count` notices are expected. */
async function sentinel(d: Daemon, count: number) {
  d.child.start();
  d.child.finish("sentinel answer");
  await until(() => d.delivery.prompts.length === count);
  expect(d.delivery.prompts[count - 1]).toContain("finished.");
  expect(d.delivery.prompts[count - 1]).toContain("sentinel answer");
}

test("every finish notifies", async () => {
  const d = await rearmed();
  d.child.start();
  d.child.finish("second answer");
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("finished.");
  expect(d.delivery.prompts[1]).toContain("second answer");
  d.delivery.ack(1);
  await storedAwaiting(d.directory);
  await sentinel(d, 3);
});

test("a repeated completion sends nothing", async () => {
  const d = await rearmed();
  d.child.emit({ type: "turn_completed", provider: "codex" });
  await sentinel(d, 2);
});

test("a cancel after a finish sends nothing", async () => {
  const d = await rearmed();
  d.child.cancel("first answer");
  await sentinel(d, 2);
  expect(await stored(d.directory)).toHaveLength(1);
});

test("an archived caller disarms and empties the store", async () => {
  const d = await rearmed();
  d.state.callerActive = false;
  d.child.emit({ type: "turn_completed", provider: "codex" });
  await expect.poll(async () => stored(d.directory)).toEqual([]);
  expect(d.delivery.prompts).toHaveLength(1);
});

test.each([
  { variant: "crash", stop: async (_d: Daemon) => {} },
  { variant: "graceful stop", stop: (d: Daemon) => d.service.close() },
])(
  "the agent-prompted cut-off ($variant): a turn started after a finish recovers as one `was closed`",
  async ({ stop }) => {
    // 1. The child runs and goes idle, never stamping lastUserMessageAt; the finish re-arms.
    const first = await rearmed();
    expect(first.child.snapshot().lastUserMessageAt).toBeNull();
    // 2. An agent-sourced prompt starts a turn: the gate opens in the stored record.
    first.child.start();
    await storedOpen(first.directory);
    // 3. The daemon stops mid-turn.
    await stop(first);
    // 4. Recovery reads the stored child: closed, not archived, no user message.
    const second = await daemon(first.directory, new Child("closed", false));
    await until(() => second.delivery.prompts.length === 1);
    expect(second.delivery.prompts[0]).toContain("Agent child (Child) was closed.");
    second.delivery.ack(0);
    await storedAwaiting(second.directory);
    expect(second.delivery.prompts).toHaveLength(1);
    await second.service.close();
    // Reopening the same stored `closed` sends nothing.
    const third = await daemon(first.directory, new Child("closed", false));
    await sentinel(third, 1);
  },
);

test.each(["closed", "idle"] as const)(
  "after an acknowledged finish, a stored %s child that is not archived sends nothing and keeps one record",
  async (status) => {
    const first = await rearmed();
    await first.service.close();
    const second = await daemon(first.directory, new Child(status, false));
    await until(() => second.child.handlers.size === 1);
    expect(await stored(second.directory)).toHaveLength(1);
    await sentinel(second, 1);
  },
);

test("a group holding a re-armed record and a fresh registration delivers the stored closed", async () => {
  const first = await rearmed();
  // A follow-up registered before its prompt was queued; the daemon stops before dispatch.
  await first.service.register(intent, true);
  expect(await stored(first.directory)).toHaveLength(2);
  await first.service.close();
  const second = await daemon(first.directory, new Child("closed", false));
  await until(() => second.delivery.prompts.length === 1);
  expect(second.delivery.prompts[0]).toContain("was closed.");
  second.delivery.ack(0);
  await storedAwaiting(second.directory);
});

test("a record without the field, as upstream wrote it, delivers its first terminal", async () => {
  const directory = await home();
  await writeFile(
    join(directory, "finish-subscriptions.json"),
    JSON.stringify([{ id: "written-by-upstream", ...intent }]),
  );
  const d = await daemon(directory, new Child("closed", false));
  await until(() => d.delivery.prompts.length === 1);
  expect(d.delivery.prompts[0]).toContain("was closed.");
  d.delivery.ack(0);
  await expect
    .poll(async () => stored(directory))
    .toEqual([{ id: "written-by-upstream", ...intent, awaitingTurn: true }]);
});

test("a turn observed before the previous finish is acknowledged leaves the record open", async () => {
  const writes: FinishSubscription[] = [];
  const d = await daemon(await home(), new Child("running"), (store) => ({
    ...store,
    put(record) {
      writes.push(record);
      return store.put(record);
    },
  }));
  await firstFinish(d);
  d.child.start();
  d.delivery.ack(0);
  d.child.finish("second answer");
  // The second notice follows the re-arm, so the record below is the re-armed one.
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("second answer");
  const records = await stored(d.directory);
  expect(records).toHaveLength(1);
  expect(records[0]).not.toHaveProperty("awaitingTurn");
  // Never written as waiting, not even for a moment: the turn was known before the re-arm.
  expect(writes.map((record) => "awaitingTurn" in record)).toEqual([false, false]);
});

test("a synthetic open on an idle child sends nothing, and the gate stays waiting", async () => {
  const first = await rearmed();
  await first.service.close();
  // A reattach to a live idle child: the open event has no turnId and the wait returns idle.
  const second = await daemon(first.directory, new Child("idle", true));
  await until(() => second.child.handlers.size === 1);
  await until(() => !second.service.hasPendingForCaller("parent"));
  await storedAwaiting(second.directory);
  await sentinel(second, 1);
});

test("a remote turn_started with a turnId whose re-fetched snapshot reads idle opens the gate, and its finish is delivered", async () => {
  const d = await rearmed();
  // A remote host re-fetches the snapshot per event; a fast turn already reads idle.
  d.child.emit({ type: "turn_started", provider: "codex", turnId: "remote-turn" });
  await storedOpen(d.directory);
  d.child.last = "remote answer";
  d.child.emit({ type: "turn_completed", provider: "codex" });
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("remote answer");
});

test("a close of a child that is not archived during an observed turn sends `was closed` and stays armed", async () => {
  const d = await rearmed();
  d.child.start();
  d.child.become("closed");
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("was closed.");
  d.delivery.ack(1);
  await storedAwaiting(d.directory);
});

test.each(["while the gate waits", "mid-turn"] as const)(
  "an archived child sends `was closed` and empties the store (%s)",
  async (when) => {
    const d = await rearmed();
    if (when === "mid-turn") d.child.start();
    // Archive writes storage first, then closes the runtime, whose payload reads not archived.
    d.state.childArchived = true;
    d.child.become("closed");
    await until(() => d.delivery.prompts.length === 2);
    expect(d.delivery.prompts[1]).toContain("was closed.");
    d.delivery.ack(1);
    await expect.poll(async () => stored(d.directory)).toEqual([]);
  },
);

test.each([
  { outcome: "errored", end: (child: Child) => child.become("error") },
  { outcome: "was canceled", end: (child: Child) => child.cancel("partial answer") },
])(
  "a turn that ends $outcome after a re-arm is delivered and disarms",
  async ({ outcome, end }) => {
    const d = await rearmed();
    d.child.start();
    end(d.child);
    await until(() => d.delivery.prompts.length === 2);
    expect(d.delivery.prompts[1]).toContain(outcome);
    d.delivery.ack(1);
    await expect.poll(async () => stored(d.directory)).toEqual([]);
  },
);

test("a follow-up accepted while re-armed supersedes the re-armed watch", async () => {
  const d = await rearmed();
  const [previous] = await stored(d.directory);
  const follow = await d.service.register(intent, true);
  d.child.start(); // the follow-up's dispatch starts the turn
  follow.accept();
  d.child.finish("second answer");
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("second answer");
  d.delivery.ack(1);
  await storedAwaiting(d.directory);
  expect((await stored(d.directory))[0]!.id).not.toBe(previous!.id);
  expect(d.delivery.prompts).toHaveLength(2);
});

test("a follow-up rejected while re-armed leaves the re-armed watch reporting", async () => {
  const d = await rearmed();
  const [previous] = await stored(d.directory);
  const follow = await d.service.register(intent, true);
  await follow.reject();
  d.child.start();
  d.child.finish("second answer");
  await until(() => d.delivery.prompts.length === 2);
  d.delivery.ack(1);
  await storedAwaiting(d.directory);
  expect((await stored(d.directory))[0]!.id).toBe(previous!.id);
});

test("two finishes inside one acknowledgement window are both delivered, in order", async () => {
  const d = await daemon(await home(), new Child("running"));
  await firstFinish(d);
  d.child.start();
  d.child.finish("second answer");
  d.child.start();
  d.child.finish("third answer");
  d.delivery.ack(0);
  await until(() => d.delivery.prompts.length === 2);
  expect(d.delivery.prompts[1]).toContain("second answer");
  d.delivery.ack(1);
  await until(() => d.delivery.prompts.length === 3);
  expect(d.delivery.prompts[2]).toContain("third answer");
});

test("hasPendingForCaller is false while awaiting a turn and true while holding an outcome", async () => {
  const d = await daemon(await home(), new Child("running"));
  await firstFinish(d);
  expect(d.service.hasPendingForCaller("parent")).toBe(true);
  d.delivery.ack(0);
  await until(() => !d.service.hasPendingForCaller("parent"));
  d.child.start();
  await until(() => d.service.hasPendingForCaller("parent"));
  d.child.finish("second answer");
  await until(() => d.delivery.prompts.length === 2);
  expect(d.service.hasPendingForCaller("parent")).toBe(true);
  d.delivery.ack(1);
  await until(() => !d.service.hasPendingForCaller("parent"));
});

test("a deferred re-arm put that races accept leaves no stale record", async () => {
  const release = deferred<void>();
  const written = deferred<void>();
  let blocked = false;
  const d = await daemon(await home(), new Child("running"), (store) => ({
    ...store,
    async put(record) {
      if (!record.awaitingTurn) return store.put(record);
      blocked = true;
      await release.promise;
      await store.put(record);
      written.resolve();
    },
  }));
  await firstFinish(d);
  d.delivery.ack(0);
  await until(() => blocked);
  // The follow-up registers and is accepted while the re-arm write is still in flight.
  d.child.start();
  const registration = d.service.register(intent, true).then((follow) => {
    follow.accept();
    return follow;
  });
  // Serialized, the registration waits for the write; unserialized, it overtakes it here.
  await Promise.race([registration, pause(200)]);
  release.resolve();
  await registration;
  await written.promise;
  await expect.poll(async () => (await stored(d.directory)).length).toBe(1);
  expect((await stored(d.directory))[0]).not.toHaveProperty("awaitingTurn");
});
