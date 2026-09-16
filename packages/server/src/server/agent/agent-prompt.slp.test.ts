import pino from "pino";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { setupFinishNotification } from "./agent-prompt.js";
import { AgentManager } from "./agent-manager.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type { AgentRunStartHandle } from "./agent-run-state.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

/**
 * SLP-PATCH coverage (wakeup-each, wakeup-defers).
 *
 * Lives in its own file so `agent-prompt.test.ts` stays byte-identical with
 * upstream and can never conflict on merge — see PATCHES.md. Two patches share
 * it: `wakeup-each` (the re-arming watcher, at the bottom, on a real
 * `AgentManager`) and `wakeup-defers` (§3.2, everything above it).
 *
 * closed-wakeup and response-cap used to be covered here. They landed upstream
 * as #3192; upstream's own "closing a watched child notifies the caller" and
 * "finish notifications truncate oversized child responses" own them now.
 *
 * SLP-PATCH(wakeup-defers): the §3.2 tests below drive the real
 * `setupFinishNotification` against a real dispatch path
 * (`sendPromptToAgent` -> `startAgentRun`) with a stubbed manager, so `busy` is
 * produced the way production produces it: `busyFallback: "refuse"` meeting an
 * in-flight caller run. The queue is what is under test, not the manager.
 */

const CHILD = "child-agent";
const CALLER = "caller-agent";

type SteerStatus = "busy" | "inactive" | "steered";

interface StorageRecord {
  id: string;
  title: string;
  labels?: Record<string, string | null>;
  archivedAt?: string;
}

interface Harness {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: pino.Logger;
  records: Record<string, unknown>[];
  /** Log records with this `msg`, in order. */
  logs(msg: string): Record<string, unknown>[];
  /** Dispatch attempts that reached the manager's admission surface. */
  attempts(): number;
  calls: {
    streamAgent: string[];
    replaceAgentRun: string[];
    sendPromptConcurrency: number;
  };
  state: {
    callerBusy: boolean;
    callerLifecycle: ManagedAgent["lifecycle"];
    steerScript: SteerStatus[];
    /**
     * Scripted answers for `hasInFlightRun`, one per call, before falling back
     * to `callerBusy`. The pump reads it twice per refused attempt — once in
     * the drain, once before releasing ownership — and the two reads are
     * separated by a promise resolution, so this is how a caller that settles
     * *between* them is expressed without emitting an event.
     */
    hasInFlightRunScript: boolean[];
    steerThrows: Error | null;
    runHandle: AgentRunStartHandle | null;
    /** Runs while the pump's `sendPromptToAgent` is in flight. */
    onDispatch: (() => void | Promise<void>) | null;
    /** Holds the child storage read, i.e. a body still being prepared. */
    holdChildRead: Promise<void> | null;
  };
  storage: Map<string, StorageRecord>;
  emitCaller(lifecycle: ManagedAgent["lifecycle"]): void;
  emitChild(lifecycle: ManagedAgent["lifecycle"]): void;
  emitChildPermission(requestId: string): void;
  /** True while the caller-delivery subscription is still armed. */
  callerSubscribed(): boolean;
  childAgent: ManagedAgent;
  callerAgent: ManagedAgent;
}

function createHarness(options: { childLabels?: Record<string, string | null> } = {}): Harness {
  const records: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );

  const childAgent = Object.create(null) as ManagedAgent;
  Reflect.set(childAgent, "id", CHILD);
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "pendingPermissions", new Map());
  Reflect.set(childAgent, "config", { title: "Child Agent" });

  const callerAgent = Object.create(null) as ManagedAgent;
  Reflect.set(callerAgent, "id", CALLER);
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "pendingPermissions", new Map());
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const state: Harness["state"] = {
    callerBusy: false,
    callerLifecycle: "idle",
    steerScript: [],
    hasInFlightRunScript: [],
    steerThrows: null,
    runHandle: null,
    onDispatch: null,
    holdChildRead: null,
  };

  const calls: Harness["calls"] = {
    streamAgent: [],
    replaceAgentRun: [],
    sendPromptConcurrency: 0,
  };
  let inFlightDispatches = 0;
  let attempts = 0;

  const storage = new Map<string, StorageRecord>([
    [CHILD, { id: CHILD, title: "Child Agent", labels: options.childLabels }],
    [CALLER, { id: CALLER, title: "Caller Agent" }],
  ]);

  // The scenario's `subscribe` stub keeps one subscriber per agentId, so the
  // caller subscription and the child subscription coexist.
  const subscribers = new Map<string, (event: AgentManagerEvent) => void>();

  async function admit(): Promise<{ status: SteerStatus }> {
    attempts += 1;
    inFlightDispatches += 1;
    calls.sendPromptConcurrency = Math.max(calls.sendPromptConcurrency, inFlightDispatches);
    try {
      if (state.onDispatch) {
        const hook = state.onDispatch;
        state.onDispatch = null;
        await hook();
      }
      if (state.steerThrows) throw state.steerThrows;
      const scripted = state.steerScript.shift();
      if (scripted) return { status: scripted };
      return { status: state.callerBusy ? "busy" : "inactive" };
    } finally {
      inFlightDispatches -= 1;
    }
  }

  const agentManager = Object.create(null) as AgentManager;
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === CHILD) return childAgent;
    if (agentId === CALLER) {
      Reflect.set(callerAgent, "lifecycle", state.callerLifecycle);
      return callerAgent;
    }
    return null;
  });
  Reflect.set(
    agentManager,
    "subscribe",
    (callback: (event: AgentManagerEvent) => void, subscribeOptions?: { agentId?: string }) => {
      const key = subscribeOptions?.agentId ?? "*";
      subscribers.set(key, callback);
      return () => {
        subscribers.delete(key);
      };
    },
  );
  Reflect.set(agentManager, "getLastAssistantMessage", async () => "done.");
  Reflect.set(agentManager, "hasInFlightRun", () => {
    const scripted = state.hasInFlightRunScript.shift();
    return scripted ?? state.callerBusy;
  });
  Reflect.set(agentManager, "isRunReserved", () => false);
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "getRunStartHandle", () => state.runHandle);
  Reflect.set(agentManager, "reloadAgentSessionUnlessBusy", async () => ({
    reloaded: false,
    reason: "busy" as const,
  }));
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => {
    const result = await admit();
    if (result.status === "steered") return { status: "steered" as const };
    if (result.status === "busy") return { status: "busy" as const };
    return { status: "inactive" as const };
  });
  Reflect.set(agentManager, "streamAgent", (agentId: string, prompt: string) => {
    calls.streamAgent.push(prompt);
    return (async function* () {})() as AsyncGenerator<AgentStreamEvent>;
  });
  Reflect.set(agentManager, "replaceAgentRun", async (agentId: string, prompt: string) => {
    calls.replaceAgentRun.push(prompt);
    return (async function* () {})() as AsyncGenerator<AgentStreamEvent>;
  });

  const agentStorage = Object.create(null) as AgentStorage;
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === CHILD && state.holdChildRead) await state.holdChildRead;
    return storage.get(agentId) ?? null;
  });

  return {
    agentManager,
    agentStorage,
    logger,
    records,
    logs: (msg: string) => records.filter((record) => record.msg === msg),
    attempts: () => attempts,
    calls,
    state,
    storage,
    childAgent,
    callerAgent,
    emitCaller(lifecycle) {
      state.callerLifecycle = lifecycle;
      Reflect.set(callerAgent, "lifecycle", lifecycle);
      subscribers.get(CALLER)?.({ type: "agent_state", agent: callerAgent } as AgentManagerEvent);
    },
    emitChild(lifecycle) {
      Reflect.set(childAgent, "lifecycle", lifecycle);
      subscribers.get(CHILD)?.({ type: "agent_state", agent: childAgent } as AgentManagerEvent);
    },
    emitChildPermission(requestId: string) {
      subscribers.get(CHILD)?.({
        type: "agent_stream",
        agentId: CHILD,
        event: {
          type: "permission_requested",
          provider: "claude",
          request: { id: requestId, provider: "claude", kind: "tool", name: "Run command" },
        },
      } as unknown as AgentManagerEvent);
    },
    callerSubscribed() {
      return subscribers.has(CALLER);
    },
  };
}

function watch(harness: Harness, extra: { requireParentOwnership?: boolean } = {}): void {
  setupFinishNotification({
    agentManager: harness.agentManager,
    agentStorage: harness.agentStorage,
    childAgentId: CHILD,
    callerAgentId: CALLER,
    requireParentOwnership: extra.requireParentOwnership,
    logger: harness.logger,
  });
}

/** Drain microtasks and the macrotask turn the pump's awaits land on. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Drive the child from `running` to `idle`, which is what "finished" means. */
function finishChild(harness: Harness): void {
  harness.emitChild("running");
  harness.emitChild("idle");
}

describe("wakeup-defers: the watcher defers, delivery outlives observation", () => {
  test("W1 busy caller is deferred: no replacement, no new run, one deferral log", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();

    expect(harness.calls.replaceAgentRun).toEqual([]);
    expect(harness.calls.streamAgent).toEqual([]);
    expect(harness.logs("wakeup deferred")).toHaveLength(1);
    expect(harness.logs("wakeup delivered")).toHaveLength(0);
  });

  test("W2 settled-before-subscribed: busy answer with an idle caller retries at once", async () => {
    const harness = createHarness();
    watch(harness);
    // The admission answered `busy` from a turn that had already ended: the
    // manager's next read is idle. No caller event will ever arrive for it.
    harness.state.callerBusy = false;
    harness.state.steerScript = ["busy"];

    finishChild(harness);
    await settle();

    expect(harness.logs("wakeup deferred")).toHaveLength(1);
    expect(harness.logs("wakeup delivered")).toHaveLength(1);
    expect(harness.calls.streamAgent).toHaveLength(1);
  });

  test("W3 drain on idle, and a second finish during the delivery's own run", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(1);

    // A second finish arrives while the caller is running the first wakeup.
    harness.state.callerBusy = true;
    finishChild(harness);
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(1);
    expect(harness.logs("wakeup deferred")).toHaveLength(2);

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(2);
  });

  test("W4 terminal after deferred: both delivered in order once observation stops", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    harness.emitChild("closed");
    await settle();

    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    const delivered = harness.logs("wakeup delivered");
    expect(delivered).toHaveLength(2);
    expect(delivered.map((record) => record.reason)).toEqual(["finished", "was closed"]);
  });

  test("W4b terminal `errored` after deferred is delivered the same way", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    harness.emitChild("error");
    await settle();

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    expect(harness.logs("wakeup delivered").map((record) => record.reason)).toEqual([
      "finished",
      "errored",
    ]);
  });

  test("W5 caller closed drops the queue with one warn per entry and sends nothing", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    finishChild(harness);
    await settle();
    // Logged once per entry that was actually attempted: the head. The second
    // entry never reaches an attempt while the head is deferred.
    expect(harness.logs("wakeup deferred")).toHaveLength(1);

    harness.emitCaller("closed");
    await settle();

    const dropped = harness.logs("wakeup dropped");
    expect(dropped).toHaveLength(2);
    expect(dropped.every((record) => record.cause === "caller closed")).toBe(true);
    expect(harness.calls.streamAgent).toEqual([]);

    // The subscription is released: a later idle can no longer reach the pump.
    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(0);
  });

  test("W5b caller `error` keeps the queue; a later idle delivers it", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();

    harness.emitCaller("error");
    await settle();
    expect(harness.logs("wakeup dropped")).toHaveLength(0);
    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(1);
  });

  test("W6 `was closed` collapses to one entry; `finished` never merges", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    finishChild(harness);
    await settle();
    // An archive can emit `closed` twice.
    harness.emitChild("closed");
    await settle();
    harness.emitChild("closed");
    await settle();

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    expect(harness.logs("wakeup delivered").map((record) => record.reason)).toEqual([
      "finished",
      "finished",
      "was closed",
    ]);
  });

  test("W6b an accepted reason that never becomes an entry still settles the counter", async () => {
    // Ownership is required and the child carries no parent label, so every
    // reason is accepted — and owed — and then refused while its body is being
    // prepared. Nothing is ever enqueued and nothing is ever delivered, so the
    // only observable is the counter: if `accept()` is not paired with
    // `abandon()` on this path, owed never reaches 0 and the caller
    // subscription is held for the child's whole life.
    const harness = createHarness();
    watch(harness, { requireParentOwnership: true });
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    expect(harness.callerSubscribed()).toBe(true);

    harness.emitChild("closed");
    await settle();

    expect(harness.logs("wakeup delivered")).toHaveLength(0);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);
    expect(harness.callerSubscribed()).toBe(false);
  });

  test("W7 `needs permission` is never dropped and drains before later entries", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    harness.emitChildPermission("permission-1");
    await settle();
    expect(harness.logs("wakeup deferred")).toHaveLength(1);

    finishChild(harness);
    await settle();

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    expect(harness.logs("wakeup delivered").map((record) => record.reason)).toEqual([
      "needs permission",
      "finished",
    ]);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);
  });

  test("W8 a child event during a drain rides the same pump, in queue order", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();

    // The idle starts the pump; a second finish lands while the first send is
    // in flight. Both leave through the one consumer, in order.
    harness.state.callerBusy = false;
    harness.state.onDispatch = async () => {
      finishChild(harness);
      await settle(2);
    };
    harness.emitCaller("idle");
    await settle(10);

    expect(harness.logs("wakeup delivered")).toHaveLength(2);
    expect(harness.calls.sendPromptConcurrency).toBe(1);
  });

  test("W9 an idle during the drain needs no later event: the re-check delivers", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    finishChild(harness);
    await settle();
    finishChild(harness);
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    // The caller's only idle event fires while the pump is mid-attempt; no
    // later idle will ever come.
    harness.state.steerScript = ["busy"];
    harness.state.onDispatch = () => {
      harness.state.callerBusy = false;
    };
    harness.emitCaller("idle");
    await settle(10);

    expect(harness.logs("wakeup delivered")).toHaveLength(2);
  });

  test("W9b the caller settles between the drain's read and the pump's last one", async () => {
    const harness = createHarness();
    watch(harness);

    // Two reads of `hasInFlightRun` per refused attempt: the drain's, then the
    // pump's before it releases ownership. Scripting them `true` then `false`
    // is a caller that settled in between, with **no event of any kind** — the
    // only thing that can still deliver is the pump's own last re-check. If it
    // is gone, the entry waits forever for an event that was never coming.
    harness.state.callerBusy = false;
    harness.state.steerScript = ["busy"];
    harness.state.hasInFlightRunScript = [true, false];

    finishChild(harness);
    await settle(10);

    expect(harness.logs("wakeup deferred")).toHaveLength(1);
    expect(harness.logs("wakeup delivered")).toHaveLength(1);
    expect(harness.state.hasInFlightRunScript).toEqual([]);
  });
});

describe("wakeup-defers: delivery outlives observation under failure", () => {
  test("W10 a terminal body prepared after the queue empties keeps the caller armed", async () => {
    const harness = createHarness();
    watch(harness);

    finishChild(harness);
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(1);

    // The child closes: observation stops and the reason is owed, but the body
    // is still being read while `pending` is empty.
    let release: () => void = () => {};
    harness.state.holdChildRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.state.callerBusy = true;
    harness.emitChild("closed");
    await settle();

    release();
    await settle();
    expect(harness.logs("wakeup deferred")).toHaveLength(1);

    // If the subscription had been released when observation stopped on an
    // empty queue, this idle would reach nobody.
    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    expect(harness.logs("wakeup delivered").map((record) => record.reason)).toEqual([
      "finished",
      "was closed",
    ]);
  });

  test("W11 an errored caller is held and never started", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    // (a) the admission's answer is `busy` because the caller's turn failed;
    // the re-check sees `error` and makes no second attempt.
    harness.state.onDispatch = () => {
      harness.state.callerBusy = false;
      harness.state.callerLifecycle = "error";
    };
    finishChild(harness);
    await settle();
    expect(harness.attempts()).toBe(1);
    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    // (b) a new child event during `error` enqueues and attempts nothing.
    finishChild(harness);
    await settle();
    harness.emitCaller("error");
    await settle();
    expect(harness.attempts()).toBe(1);
    expect(harness.calls.streamAgent).toHaveLength(0);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);

    // (c) the caller's next idle delivers both.
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(2);
  });

  test("W12 a caller archived between enqueue and dispatch drops the entry", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    harness.emitChild("closed");
    await settle();
    expect(harness.logs("wakeup deferred")).toHaveLength(1);

    harness.storage.set(CALLER, {
      id: CALLER,
      title: "Caller Agent",
      archivedAt: "2024-01-01T00:00:00.000Z",
    });
    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle();

    const dropped = harness.logs("wakeup dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.cause).toBe("caller archived");
    expect(harness.logs("wakeup delivered")).toHaveLength(0);

    // Owed reached zero with observation already stopped, so the caller
    // subscription is gone: a later idle reaches no pump.
    const attemptsAfterDrop = harness.attempts();
    harness.emitCaller("idle");
    await settle();
    expect(harness.attempts()).toBe(attemptsAfterDrop);
  });

  test("W13 a transient dispatch failure is retried and never drops the entry", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.steerThrows = new Error("provider exploded");

    finishChild(harness);
    await settle();

    const failures = harness.logs("wakeup dispatch failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.attempt).toBe(1);
    expect(failures[0]?.level).toBe(40);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);

    harness.state.steerThrows = null;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered")).toHaveLength(1);
  });

  test("W14 a permanently failing dispatch never drops the entry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const harness = createHarness();
      watch(harness);
      harness.state.steerThrows = new Error("provider is down");

      finishChild(harness);
      await settle();
      expect(harness.attempts()).toBe(1);

      // 5 s, doubling. Attempt 3 onwards is an `error` record.
      for (const delay of [5_000, 10_000, 20_000, 40_000]) {
        await vi.advanceTimersByTimeAsync(delay);
        await settle();
      }
      const failures = harness.logs("wakeup dispatch failed");
      expect(failures.map((record) => record.attempt)).toEqual([1, 2, 3, 4, 5]);
      expect(failures.map((record) => record.level)).toEqual([40, 40, 50, 50, 50]);

      // The backoff caps at 60 s.
      await vi.advanceTimersByTimeAsync(59_999);
      await settle();
      expect(harness.attempts()).toBe(5);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(harness.attempts()).toBe(6);

      // Nothing was ever dropped or delivered while it failed.
      expect(harness.logs("wakeup dropped")).toHaveLength(0);
      expect(harness.logs("wakeup delivered")).toHaveLength(0);

      // Archiving the caller is what finally retires it, with the archived warn.
      harness.storage.set(CALLER, {
        id: CALLER,
        title: "Caller Agent",
        archivedAt: "2024-01-01T00:00:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await settle();
      const dropped = harness.logs("wakeup dropped");
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.cause).toBe("caller archived");

      const attemptsAfterDrop = harness.attempts();
      await vi.advanceTimersByTimeAsync(600_000);
      await settle();
      expect(harness.attempts()).toBe(attemptsAfterDrop);
    } finally {
      vi.useRealTimers();
    }
  });

  test("W14b a `needs permission` entry behaves identically under failure", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.steerThrows = new Error("provider is down");

    harness.emitChildPermission("permission-1");
    await settle();
    harness.emitCaller("idle");
    await settle();
    harness.emitCaller("idle");
    await settle();

    const failures = harness.logs("wakeup dispatch failed");
    expect(failures.map((record) => record.attempt)).toEqual([1, 2, 3]);
    expect(failures.map((record) => record.level)).toEqual([40, 40, 50]);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);

    harness.state.steerThrows = null;
    harness.emitCaller("idle");
    await settle();
    expect(harness.logs("wakeup delivered").map((record) => record.reason)).toEqual([
      "needs permission",
    ]);
  });
});

/**
 * SLP-PATCH(wakeup-defers): the control for §3.2's completeness claims.
 *
 * The enqueue / decrement / drop sites were enumerated by the compiler:
 * `WakeupDeliveryQueue` keeps `#pending` and `#owed` private, so no site can
 * touch either without going through a named method, and `dropAll` is
 * unreachable without a `WakeupDropCause` — a union with no capacity member.
 * That is a static argument. These two tests do not share it: they count
 * terminal outcomes in the log and check the conservation law from outside.
 */
describe("wakeup-defers: every accepted reason reaches exactly one outcome", () => {
  test("W15 seven accepted reasons, one caller run at a time, seven deliveries", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    for (let i = 0; i < 5; i += 1) {
      finishChild(harness);
      await settle();
    }
    harness.emitChildPermission("permission-1");
    await settle();
    harness.emitChild("closed");
    await settle();

    expect(harness.logs("wakeup delivered")).toHaveLength(0);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);
    // Depth 8 is never reached: 7 entries, and the warn is not emitted.
    expect(harness.logs("wakeup queue depth")).toHaveLength(0);

    harness.state.callerBusy = false;
    harness.emitCaller("idle");
    await settle(20);

    expect(harness.logs("wakeup delivered")).toHaveLength(7);
    expect(harness.logs("wakeup dropped")).toHaveLength(0);
    expect(harness.logs("wakeup dispatch failed")).toHaveLength(0);
  });

  test("W15b an archive partway through still retires every accepted reason", async () => {
    const harness = createHarness();
    watch(harness);
    harness.state.callerBusy = true;

    for (let i = 0; i < 3; i += 1) {
      finishChild(harness);
      await settle();
    }
    // Deliver one, then archive the caller with two still owed.
    harness.state.callerBusy = false;
    harness.state.onDispatch = () => {
      harness.storage.set(CALLER, {
        id: CALLER,
        title: "Caller Agent",
        archivedAt: "2024-01-01T00:00:00.000Z",
      });
    };
    harness.emitCaller("idle");
    await settle(20);

    const delivered = harness.logs("wakeup delivered").length;
    const dropped = harness.logs("wakeup dropped").length;
    expect(delivered).toBe(1);
    expect(delivered + dropped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// SLP-PATCH(wakeup-each): the re-arming watcher. These two predate §3.2 and are
// kept on their own harness — a real `AgentManager` with only the dispatch
// surface stubbed — because what they prove is that the merged notify path
// (`ensureAgentLoaded` -> `startAgentRun` -> `streamAgent`) runs again after the
// first finish. The `wakeup-defers` harness above stubs that path out by design,
// so it cannot make this claim.
// ---------------------------------------------------------------------------

interface SlpScenarioOptions {
  childLastAssistantMessage?: string | null;
  callerArchivedAt?: string | null;
}

interface SlpScenario {
  startWatchingChild(): void;
  finishChild(): void;
  flush(parentPromptsLength: number): Promise<void>;
  parentPrompts(): string[];
  isSubscribed(): boolean;
}

function createSlpScenario(options?: SlpScenarioOptions): SlpScenario {
  let childSubscriber: ((event: AgentManagerEvent) => void) | null = null;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const agentManager = new AgentManager({ clients: {}, logger: createTestLogger() });
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  // SLP-PATCH(wakeup-defers): the watcher now subscribes twice — child
  // observation and caller delivery. Key by agentId so `isSubscribed()` still
  // means "the child is still watched", which is what `wakeup-each` asserts.
  Reflect.set(
    agentManager,
    "subscribe",
    (callback: (event: AgentManagerEvent) => void, subscribeOptions?: { agentId?: string }) => {
      if (subscribeOptions?.agentId === "caller-agent") {
        return () => {};
      }
      childSubscriber = callback;
      return () => {
        childSubscriber = null;
      };
    },
  );
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? "turn done";
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
  Reflect.set(agentManager, "isRunReserved", () => false);
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => ({ status: "inactive" }));
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompts.push(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    parentPrompts.push(prompt);
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      return {
        title: "Child Agent",
        labels: { "paseo.parent-agent-id": "caller-agent" },
      };
    }
    if (agentId === "caller-agent" && options?.callerArchivedAt) {
      return { title: "Caller Agent", archivedAt: options.callerArchivedAt, labels: {} };
    }
    return null;
  });

  function emitLifecycle(lifecycle: "running" | "idle" | "closed" | "error"): void {
    childAgent.lifecycle = lifecycle;
    childSubscriber?.({
      type: "agent_state",
      agent: childAgent,
    });
  }

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: true,
        logger: createTestLogger(),
      });
    },
    finishChild() {
      emitLifecycle("running");
      emitLifecycle("idle");
    },
    async flush(parentPromptsLength: number) {
      await vi.waitFor(() => {
        expect(parentPrompts).toHaveLength(parentPromptsLength);
      });
    },
    parentPrompts() {
      return parentPrompts;
    },
    isSubscribed() {
      return childSubscriber !== null;
    },
  };
}

// SLP-PATCH(wakeup-each)
test("the watcher re-arms: every finish of the child notifies the caller", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.finishChild();
  await scenario.flush(2);

  expect(scenario.isSubscribed()).toBe(true);
});

// SLP-PATCH(wakeup-each)
test("an archived caller disarms the watcher instead of leaking it", async () => {
  const scenario = createSlpScenario({
    callerArchivedAt: new Date().toISOString(),
  });

  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(scenario.parentPrompts()).toHaveLength(0);
  expect(scenario.isSubscribed()).toBe(false);
});
