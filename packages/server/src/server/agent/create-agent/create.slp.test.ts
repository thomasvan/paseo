// Fork guard of upstream behaviour (see PATCHES.md, Where the tests live): the
// create path registers its finish subscription before the first prompt is
// dispatched, holds it pending, and settles it by that prompt's outcome. No
// upstream test guards this order. Lives in its own file so create.test.ts stays
// upstream's and never conflicts on merge.
import { beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";
import type { FinishSubscriptions } from "../finish-subscriptions/index.js";

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  initialPromptError: null as Error | null,
}));

vi.mock("../agent-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-prompt.js")>();
  return {
    ...actual,
    startCreatedAgentInitialPrompt: async (params: { snapshot: ManagedAgent }) => {
      mocks.steps.push("dispatch");
      if (mocks.initialPromptError) throw mocks.initialPromptError;
      return params.snapshot;
    },
  };
});

beforeEach(() => {
  mocks.steps.length = 0;
  mocks.initialPromptError = null;
});

function agent(id: string): ManagedAgent {
  return {
    id,
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as unknown as ManagedAgent;
}

// Each call records itself in `steps`: the registration, then the prompt's
// dispatch, then the registration's settlement.
function recordingFinishSubscriptions(): FinishSubscriptions {
  return {
    start: async () => {},
    hasPendingForCaller: () => false,
    close: async () => {},
    register: async (_input, pendingDispatch) => {
      mocks.steps.push(pendingDispatch ? "register pending" : "register");
      return {
        accept: () => {
          mocks.steps.push("accept");
        },
        reject: async () => {
          mocks.steps.push("reject");
        },
      };
    },
  };
}

async function createChild(options: { detached: boolean }): Promise<void> {
  const caller = agent("caller-agent");
  const child = agent("child-agent");

  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    finishSubscriptions: recordingFinishSubscriptions(),
    agentManager: {
      createAgent: vi.fn(async () => child),
      getAgent: vi.fn((agentId: string) => (agentId === "caller-agent" ? caller : child)),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async () => ({})),
    } as unknown as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    workspaceId: "ws-test",
    title: "child",
    initialPrompt: "go",
    background: true,
    notifyOnFinish: true,
    callerAgentId: "caller-agent",
    detached: options.detached,
    promptFailure: "throw",
  });
}

test("a detached child's subscription is registered before its first prompt and rejected when that prompt fails", async () => {
  mocks.initialPromptError = new Error("provider refused the first prompt");

  await expect(createChild({ detached: true })).rejects.toThrow(
    "provider refused the first prompt",
  );

  expect(mocks.steps).toEqual(["register pending", "dispatch", "reject"]);
});

test("a detached child's subscription is accepted only after its first prompt is dispatched", async () => {
  await createChild({ detached: true });

  expect(mocks.steps).toEqual(["register pending", "dispatch", "accept"]);
});
