// SLP-PATCH coverage (wakeup-each).
// Lives in its own file so agent-prompt.test.ts stays byte-identical with
// upstream and can never conflict on merge — see PATCHES.md.
//
// closed-wakeup and response-cap used to be covered here. They landed upstream
// as #3192; upstream's own "closing a watched child notifies the caller" and
// "finish notifications truncate oversized child responses" own them now.
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { setupFinishNotification } from "./agent-prompt.js";
import type { PromptDispatchDisposition } from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import { parseAgentMessage } from "./agent-messages/index.js";

interface SlpScenarioOptions {
  callerArchivedAt?: string | null;
}

interface WatchOptions {
  dispatchResult?: Promise<PromptDispatchDisposition | false>;
}

interface SlpScenario {
  startWatchingChild(options?: WatchOptions): () => void;
  startChildTurn(): void;
  completeChildTurn(): void;
  finishChild(): void;
  idleWithoutCompletion(): void;
  cancelWhileRunning(): void;
  cancelToIdle(): void;
  replaceTimeline(): void;
  flush(parentPromptsLength: number): Promise<void>;
  settle(): Promise<void>;
  parentEvents(): string[];
  parentTexts(): string[];
  subscriberCount(): number;
}

// Harness mirrors upstream's own agent-prompt.test.ts: a real AgentManager
// with only the dispatch surface stubbed (getAgent/subscribe/…/streamAgent),
// because the notify path walks ensureAgentLoaded → startAgentRun across the
// manager's run tracker before reaching streamAgent. Like upstream's harness,
// a finish is the child's idle state followed by its terminal stream event,
// the order the manager publishes them in. Subscribers are a set, so
// overlapping observations of one child are visible.
function createSlpScenario(options?: SlpScenarioOptions): SlpScenario {
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
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
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => "turn done");
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
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

  function emit(event: AgentManagerEvent): void {
    for (const subscriber of subscribers) subscriber(event);
  }

  function emitLifecycle(lifecycle: "running" | "idle" | "closed" | "error"): void {
    childAgent.lifecycle = lifecycle;
    emit({ type: "agent_state", agent: childAgent });
  }

  function emitStream(
    event: { type: "turn_completed" } | { type: "turn_canceled"; reason: string },
  ): void {
    emit({
      type: "agent_stream",
      agentId: "child-agent",
      event: { ...event, provider: "codex" },
    });
  }

  return {
    startWatchingChild(watch?: WatchOptions) {
      return setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: true,
        ...(watch?.dispatchResult ? { dispatchResult: watch.dispatchResult } : {}),
        logger: createTestLogger(),
      });
    },
    startChildTurn() {
      emitLifecycle("running");
    },
    completeChildTurn() {
      emitLifecycle("idle");
      emitStream({ type: "turn_completed" });
    },
    finishChild() {
      emitLifecycle("running");
      emitLifecycle("idle");
      emitStream({ type: "turn_completed" });
    },
    idleWithoutCompletion() {
      emitLifecycle("running");
      emitLifecycle("idle");
    },
    cancelWhileRunning() {
      emitStream({ type: "turn_canceled", reason: "replaced" });
    },
    cancelToIdle() {
      emitLifecycle("idle");
      emitStream({ type: "turn_canceled", reason: "interrupted" });
    },
    replaceTimeline() {
      emit({ type: "timeline_replacement", agentId: "child-agent", epoch: "epoch-2" });
    },
    async flush(parentPromptsLength: number) {
      await vi.waitFor(() => {
        expect(parentPrompts).toHaveLength(parentPromptsLength);
      });
    },
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
    parentEvents() {
      return parentPrompts.map((prompt) => parseAgentMessage(prompt)?.source?.event ?? prompt);
    },
    parentTexts() {
      return parentPrompts.map((prompt) => parseAgentMessage(prompt)?.text ?? prompt);
    },
    subscriberCount() {
      return subscribers.size;
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

  expect(scenario.parentEvents()).toEqual(["finished", "finished"]);
  expect(scenario.subscriberCount()).toBe(1);
});

test("a repeated completion with no new turn observed notifies nothing more", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.completeChildTurn();
  await scenario.settle();

  expect(scenario.parentEvents()).toEqual(["finished"]);
  expect(scenario.subscriberCount()).toBe(1);
});

test("an idle state without a terminal completion notifies nothing", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.idleWithoutCompletion();
  await scenario.settle();

  expect(scenario.parentEvents()).toEqual([]);
  expect(scenario.subscriberCount()).toBe(1);
});

test("a cancellation while the child keeps running notifies nothing and keeps watching", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.startChildTurn();
  scenario.cancelWhileRunning();
  await scenario.settle();
  expect(scenario.parentEvents()).toEqual([]);

  scenario.completeChildTurn();
  await scenario.flush(1);
  expect(scenario.parentEvents()).toEqual(["finished"]);
  expect(scenario.subscriberCount()).toBe(1);
});

test("a cancellation that leaves the child idle notifies once and stops watching", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.startChildTurn();
  scenario.cancelToIdle();
  await scenario.flush(2);

  // "was canceled" travels on the errored event; the body names the outcome.
  expect(scenario.parentEvents()).toEqual(["finished", "errored"]);
  expect(scenario.parentTexts()[1]).toContain("Agent child-agent (Child Agent) was canceled.");
  expect(scenario.subscriberCount()).toBe(0);
});

test("a cancellation with no new turn after a finish notifies nothing", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.cancelToIdle();
  await scenario.settle();

  expect(scenario.parentEvents()).toEqual(["finished"]);
  expect(scenario.subscriberCount()).toBe(1);
});

test("a timeline replacement passes through a re-armed watcher without throwing", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  expect(() => scenario.replaceTimeline()).not.toThrow();
  scenario.finishChild();
  await scenario.flush(2);

  expect(scenario.parentEvents()).toEqual(["finished", "finished"]);
});

test("a rejected follow-up leaves the re-armed watcher as the one that notifies", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.startWatchingChild({ dispatchResult: Promise.resolve(false) });
  await scenario.settle();
  expect(scenario.subscriberCount()).toBe(1);

  scenario.finishChild();
  await scenario.flush(2);
  await scenario.settle();
  expect(scenario.parentEvents()).toEqual(["finished", "finished"]);
});

test("an accepted follow-up supersedes the re-armed watcher, so each finish notifies once", async () => {
  const scenario = createSlpScenario();

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.flush(1);
  scenario.startWatchingChild({ dispatchResult: Promise.resolve("steered") });
  await scenario.settle();
  expect(scenario.subscriberCount()).toBe(1);

  scenario.finishChild();
  await scenario.flush(2);
  scenario.finishChild();
  await scenario.flush(3);
  await scenario.settle();
  expect(scenario.parentEvents()).toEqual(["finished", "finished", "finished"]);
});

// SLP-PATCH(wakeup-each)
test("an archived caller disarms the watcher instead of leaking it", async () => {
  const scenario = createSlpScenario({
    callerArchivedAt: new Date().toISOString(),
  });

  scenario.startWatchingChild();
  scenario.finishChild();
  await scenario.settle();

  expect(scenario.parentEvents()).toEqual([]);
  expect(scenario.subscriberCount()).toBe(0);
});
