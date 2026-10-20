// SLP-PATCH coverage (detached-wakeup).
// Lives in its own file so create.test.ts stays upstream's and never conflicts
// on merge.
import { beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  initialPromptError: null as Error | null,
  setupFinishNotification: vi.fn(),
}));

// The create path's watcher registration: its argument, and its place around the
// first prompt. Each stubbed call records itself in `steps`, and the stub
// watcher returns a stop function so the cleanup of a failed prompt shows.
vi.mock("../agent-prompt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-prompt.js")>();
  return {
    ...actual,
    setupFinishNotification: mocks.setupFinishNotification,
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
  mocks.setupFinishNotification.mockReset();
  mocks.setupFinishNotification.mockImplementation(() => {
    mocks.steps.push("arm");
    return () => mocks.steps.push("disarm");
  });
});

function agent(id: string): ManagedAgent {
  return {
    id,
    provider: "claude",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as unknown as ManagedAgent;
}

async function createChild(options: { detached: boolean; promptFailure?: "throw" }): Promise<void> {
  const caller = agent("caller-agent");
  const child = agent("child-agent");

  const dependencies: Parameters<typeof createAgentCommand>[0] = {
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
    ...(options.promptFailure ? { promptFailure: options.promptFailure } : {}),
  });
}

// A child created detached has no parent label to check at fire time, so its
// caller is notified without the ownership guard; a parented child keeps it.
test.each([
  { child: "a detached child", detached: true, requireParentOwnership: false },
  { child: "a parented child", detached: false, requireParentOwnership: true },
])(
  "$child is watched with requireParentOwnership $requireParentOwnership",
  async ({ detached, requireParentOwnership }) => {
    await createChild({ detached });

    expect(mocks.setupFinishNotification).toHaveBeenCalledTimes(1);
    expect(mocks.setupFinishNotification.mock.calls[0]?.[0]).toMatchObject({
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      requireParentOwnership,
    });
  },
);

test("a detached child's watcher is armed before its first prompt and disarmed when that prompt fails", async () => {
  mocks.initialPromptError = new Error("provider refused the first prompt");

  await expect(createChild({ detached: true, promptFailure: "throw" })).rejects.toThrow(
    "provider refused the first prompt",
  );

  expect(mocks.steps).toEqual(["arm", "dispatch", "disarm"]);
});
