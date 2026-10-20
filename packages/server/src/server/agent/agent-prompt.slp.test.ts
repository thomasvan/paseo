// SLP-PATCH coverage (wakeup-each).
// Lives in its own file so agent-prompt.test.ts stays upstream's and never
// conflicts on merge.
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { setupFinishNotification } from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import { parseAgentMessage } from "./agent-messages/index.js";

type ChildStep = "finish" | "complete-again" | "cancel-to-idle";

// A real AgentManager with only the dispatch surface stubbed, as upstream's own
// agent-prompt.test.ts does: the notify path walks the manager's run tracker
// before reaching streamAgent. A finish is the child's idle state followed by
// its terminal stream event, the order the manager publishes them in.
function createScenario(options: { callerArchived: boolean }) {
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
  const agents: Record<string, ManagedAgent> = {
    "child-agent": childAgent,
    "caller-agent": callerAgent,
  };
  Reflect.set(agentManager, "getAgent", (agentId: string) => agents[agentId] ?? null);
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
      return { title: "Child Agent", labels: { "paseo.parent-agent-id": "caller-agent" } };
    }
    if (agentId === "caller-agent" && options.callerArchived) {
      return { title: "Caller Agent", archivedAt: new Date().toISOString(), labels: {} };
    }
    return null;
  });

  function emit(event: AgentManagerEvent): void {
    for (const subscriber of subscribers) subscriber(event);
  }
  function emitLifecycle(lifecycle: "running" | "idle"): void {
    childAgent.lifecycle = lifecycle;
    emit({ type: "agent_state", agent: childAgent });
  }
  function emitStream(
    event: { type: "turn_completed" } | { type: "turn_canceled"; reason: string },
  ): void {
    emit({ type: "agent_stream", agentId: "child-agent", event: { ...event, provider: "codex" } });
  }

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    requireParentOwnership: true,
    logger: createTestLogger(),
  });

  return {
    step(step: ChildStep) {
      if (step === "finish") emitLifecycle("running");
      emitLifecycle("idle");
      emitStream(
        step === "cancel-to-idle"
          ? { type: "turn_canceled", reason: "interrupted" }
          : { type: "turn_completed" },
      );
    },
    parentEvents: () =>
      parentPrompts.map((prompt) => parseAgentMessage(prompt)?.source?.event ?? prompt),
    subscriberCount: () => subscribers.size,
  };
}

// Each step is followed by the caller's notifications so far. A step that adds
// none is checked again after a short settle, so a late notification fails it.
test.each([
  {
    behaviour: "every finish of the child notifies the caller",
    callerArchived: false,
    steps: [
      ["finish", ["finished"]],
      ["finish", ["finished", "finished"]],
    ],
    watching: 1,
  },
  {
    behaviour: "a repeated completion with no new turn notifies nothing more",
    callerArchived: false,
    steps: [
      ["finish", ["finished"]],
      ["complete-again", ["finished"]],
    ],
    watching: 1,
  },
  {
    behaviour: "a cancellation with no new turn after a finish notifies nothing",
    callerArchived: false,
    steps: [
      ["finish", ["finished"]],
      ["cancel-to-idle", ["finished"]],
    ],
    watching: 1,
  },
  {
    behaviour: "an archived caller disarms the watcher instead of keeping it",
    callerArchived: true,
    steps: [["finish", []]],
    watching: 0,
  },
] as Array<{
  behaviour: string;
  callerArchived: boolean;
  steps: Array<[ChildStep, string[]]>;
  watching: number;
}>)("the re-armed watcher: $behaviour", async ({ callerArchived, steps, watching }) => {
  const scenario = createScenario({ callerArchived });

  for (const [step, expected] of steps) {
    scenario.step(step);
    await vi.waitFor(() => expect(scenario.parentEvents()).toEqual(expected));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(scenario.parentEvents()).toEqual(expected);
  }

  expect(scenario.subscriberCount()).toBe(watching);
});
