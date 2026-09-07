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
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

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

// Harness mirrors upstream's own agent-prompt.test.ts: a real AgentManager
// with only the dispatch surface stubbed (getAgent/subscribe/…/streamAgent),
// because the merged notify path walks ensureAgentLoaded → startAgentRun
// across the manager's run tracker before reaching streamAgent.
function createSlpScenario(options?: SlpScenarioOptions): SlpScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
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
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? "turn done";
  });
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

  function emitLifecycle(lifecycle: "running" | "idle" | "closed" | "error"): void {
    childAgent.lifecycle = lifecycle;
    subscriber?.({
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
      return subscriber !== null;
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
