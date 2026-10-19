// SLP-PATCH coverage (detached-wakeup).
// Lives in its own file so create.test.ts stays byte-identical with upstream
// and can never conflict on merge — see PATCHES.md.
import { beforeEach, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";

const mocks = vi.hoisted(() => ({
  steps: [] as string[],
  initialPromptError: null as Error | null,
  setupFinishNotification: vi.fn(),
}));

// The watcher itself is upstream's and is covered by agent-prompt.test.ts. What
// this file pins down is the registration the create path makes: its argument,
// and that it is armed before the initial prompt is dispatched, so a child that
// finishes fast still reaches its caller. Both modules are stubbed so each call
// records its place in `steps`; the stub watcher returns a stop function so the
// create path's cleanup on a failed first prompt is observable.
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

function createCallerAgent(): ManagedAgent {
  return {
    id: "caller-agent",
    provider: "claude",
    cwd: "/tmp/paseo-slp-create-test",
    workspaceId: "ws-slp",
    runtimeInfo: null,
  } as unknown as ManagedAgent;
}

async function createChild(options: { detached: boolean; promptFailure?: "throw" }): Promise<void> {
  const caller = createCallerAgent();
  const child = {
    id: "child-agent",
    provider: "claude",
    cwd: "/tmp/paseo-slp-create-test",
    workspaceId: "ws-slp",
    runtimeInfo: null,
  } as unknown as ManagedAgent;

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
    cwd: "/tmp/paseo-slp-create-test",
    workspaceId: "ws-slp",
    title: "child",
    initialPrompt: "go",
    background: true,
    notifyOnFinish: true,
    callerAgentId: "caller-agent",
    detached: options.detached,
    ...(options.promptFailure ? { promptFailure: options.promptFailure } : {}),
  });
}

// SLP-PATCH(detached-wakeup)
test("a deliberately detached child does not have its wakeup gated on parent ownership", async () => {
  // resolveCreateAgentIntent strips the parent label for a detached child, so
  // asking the watcher to verify parent ownership at fire time guarantees the
  // caller is never notified. SLP Leads are spawned detached, which is how a
  // Supervisor ended up waiting 23m46s on a Lead that had already finished.
  await createChild({ detached: true });

  expect(mocks.setupFinishNotification).toHaveBeenCalledTimes(1);
  expect(mocks.setupFinishNotification.mock.calls[0]?.[0]).toMatchObject({
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    requireParentOwnership: false,
  });
});

// SLP-PATCH(detached-wakeup)
test("an ordinary parented child still has its wakeup gated on parent ownership", async () => {
  // Upstream's guard, untouched: a child that carries a parent label must stop
  // notifying this caller once that label points elsewhere.
  await createChild({ detached: false });

  expect(mocks.setupFinishNotification).toHaveBeenCalledTimes(1);
  expect(mocks.setupFinishNotification.mock.calls[0]?.[0]).toMatchObject({
    requireParentOwnership: true,
  });
});

test("a detached child's watcher is armed once, before its first prompt is dispatched", async () => {
  await createChild({ detached: true });

  expect(mocks.steps).toEqual(["arm", "dispatch"]);
});

test("a detached child whose first prompt fails disarms the watcher it armed", async () => {
  mocks.initialPromptError = new Error("provider refused the first prompt");

  await expect(createChild({ detached: true, promptFailure: "throw" })).rejects.toThrow(
    "provider refused the first prompt",
  );

  expect(mocks.steps).toEqual(["arm", "dispatch", "disarm"]);
  expect(mocks.setupFinishNotification.mock.calls[0]?.[0]).toMatchObject({
    requireParentOwnership: false,
  });
});
