import { expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  setupFinishNotification,
  startAgentRun,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import { StaleProviderSessionError } from "./stale-provider-session-error.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  /** Fail the notification while its body is being prepared. */
  notifyError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  requestChildPermission(requestId?: string): void;
  resolveChildPermission(requestId?: string): void;
  resolveChildPermissionFromState(requestId?: string): void;
  resolveChildPermissionWhileIdle(requestId?: string): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  closeChildAndReadParentPrompt(): Promise<string>;
  parentPrompts(): string[];
  steerAttemptCount(): number;
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;
  let steerAttemptCount = 0;
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
  // The watcher subscribes twice now (child observation and caller delivery), so
  // the stub keys by agentId instead of keeping one subscriber; `subscriber`
  // stays the child's callback, which is what every test below drives.
  Reflect.set(
    agentManager,
    "subscribe",
    (callback: (event: AgentManagerEvent) => void, options?: { agentId?: string }) => {
      if (options?.agentId === "caller-agent") {
        return () => {};
      }
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    },
  );
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    if (options?.notifyError) throw options.notifyError;
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasInFlightRun", () => false);
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => {
    steerAttemptCount += 1;
    return { status: "inactive" };
  });
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    parentPrompts.push(prompt);
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw new Error("replaceAgentRun must never be reached for a system notification");
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    requestChildPermission(requestId = "permission-1") {
      childAgent.lifecycle = "running";
      childAgent.pendingPermissions.set(requestId, {
        id: requestId,
        provider: "claude",
        kind: "tool",
        name: "Run command",
        description: "Write the QA sentinel",
        input: {
          file_path: "/tmp/permission-qa.txt",
          content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
        },
      });
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: childAgent.pendingPermissions.get(requestId)!,
        },
      });
    },
    resolveChildPermission(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    resolveChildPermissionFromState(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({ type: "agent_state", agent: childAgent });
    },
    resolveChildPermissionWhileIdle(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      childAgent.lifecycle = "idle";
      subscriber?.({ type: "agent_state", agent: childAgent });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    async closeChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });

      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "closed";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      return parentPrompt;
    },
    parentPrompts() {
      return parentPrompts;
    },
    steerAttemptCount() {
      return steerAttemptCount;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
  expect(scenario.steerAttemptCount()).toBe(1);
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: included + omitted,
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain(included);
  expect(parentPrompt).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(parentPrompt).not.toContain("TAIL-MARKER");
});

test("closing a watched child notifies the caller", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  const parentPrompt = await scenario.closeChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) was closed."),
  );
});

test("finish notifications survive permission responses", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
  expect(scenario.parentPrompts()[0]).toContain("needs permission.");
  const permissionPayload = scenario
    .parentPrompts()[0]
    .match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child-agent",
    requestId: "permission-1",
    request: {
      id: "permission-1",
      provider: "claude",
      kind: "tool",
      name: "Run command",
      description: "Write the QA sentinel",
      input: {
        file_path: "/tmp/permission-qa.txt",
        content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
      },
    },
  });

  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(2);
  });
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("an idle permission resolution waits for the resumed run to finish", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.resolveChildPermissionWhileIdle();
  scenario.requestChildPermission("permission-2");
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts().every((prompt) => prompt.includes("needs permission."))).toBe(
    true,
  );

  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications report every concurrently pending permission", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission("permission-1");
  scenario.requestChildPermission("permission-2");

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(
    scenario.parentPrompts().map((prompt) => {
      const payload = prompt.match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
      return JSON.parse(payload!).requestId;
    }),
  ).toEqual(["permission-1", "permission-2"]);

  scenario.resolveChildPermission("permission-1");
  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications survive repeated permission cycles", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.resolveChildPermissionFromState();

  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(
    scenario.parentPrompts().map((prompt) => prompt.match(/(needs permission|finished)\./)?.[1]),
  ).toEqual(["needs permission", "needs permission", "finished"]);
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({ childParentAgentId: "another-agent" });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a failed notification without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    notifyError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  scenario.finishChild();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Failed to notify caller agent",
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      reason: "finished",
      err: expect.objectContaining({ message: "parent provider rejected replacement" }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager = new AgentManager({ clients: {}, logger: createTestLogger() });
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void, options?: { agentId?: string }) => {
      if (options?.agentId === "caller-agent") {
        return () => {};
      }
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});

// Deliberately independent literals rather than the production constants these tests
// guard: deriving the boundaries from AGENT_RUN_START_TIMEOUT_MS would keep the tests
// green if that constant were shortened back under a provider's startup budget.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

// SLP-PATCH(wakeup-defers): §3.1 — a busy caller is answered, never replaced.
// These drive `startAgentRun` against an explicit controller stub so the
// dispatch surface is exercised on its own, independent of AgentManager.

interface BusyFallbackStubOptions {
  hasInFlightRun?: boolean;
  isRunReserved?: boolean;
  lifecycle?: ManagedAgent["lifecycle"];
  /** Flip the agent's lifecycle to "error" the moment `getAgent` is read again. */
  lifecycleAfterDispatchAwaits?: ManagedAgent["lifecycle"];
  steerStatus?: "inactive" | "steered" | "busy" | "replaced";
  /** Throw a stale-session error from the synchronous admission. */
  staleAtStart?: boolean;
  /** Throw a stale-session error from the detached drain instead. */
  staleDuringDrain?: boolean;
  guardedReloadBusy?: boolean;
}

interface BusyFallbackStub {
  controller: StartAgentRunController;
  calls: {
    streamAgent: string[];
    replaceAgentRun: string[];
    reloadAgentSession: number;
    reloadAgentSessionUnlessBusy: number;
    steer: Array<Record<string, unknown> | undefined>;
  };
  drained: Promise<void>;
}

type StartAgentRunController = Parameters<typeof startAgentRun>[0];

function createBusyFallbackStub(options: BusyFallbackStubOptions = {}): BusyFallbackStub {
  const calls: BusyFallbackStub["calls"] = {
    streamAgent: [],
    replaceAgentRun: [],
    reloadAgentSession: 0,
    reloadAgentSessionUnlessBusy: 0,
    steer: [],
  };
  let staleRemaining = options.staleAtStart ? 1 : 0;
  let staleDrainRemaining = options.staleDuringDrain ? 1 : 0;
  let reads = 0;
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  const snapshot = {
    id: "agent-1",
    provider: "codex",
    lifecycle: options.lifecycle ?? "idle",
  } as unknown as ManagedAgent;

  function makeStream(): AsyncGenerator<AgentStreamEvent> {
    return (async function* run() {
      if (staleDrainRemaining > 0) {
        staleDrainRemaining -= 1;
        resolveDrained();
        throw new StaleProviderSessionError("codex", "session gone");
      }
      resolveDrained();
      yield* [] as AgentStreamEvent[];
    })();
  }

  const controller = {
    getAgent: () => {
      reads += 1;
      if (reads > 1 && options.lifecycleAfterDispatchAwaits) {
        Reflect.set(snapshot, "lifecycle", options.lifecycleAfterDispatchAwaits);
      }
      return snapshot;
    },
    tryRunOutOfBand: () => false,
    hasInFlightRun: () => Boolean(options.hasInFlightRun),
    isRunReserved: () => Boolean(options.isRunReserved),
    getRunStartHandle: () => ({ startSettled: Promise.resolve({ status: "started" as const }) }),
    steerOrReplaceActiveTurn: async (
      _agentId: string,
      _prompt: unknown,
      steerOptions?: Record<string, unknown>,
    ) => {
      calls.steer.push(steerOptions);
      const status = options.steerStatus ?? "inactive";
      if (status === "replaced") {
        return { status: "replaced" as const, iterator: makeStream() };
      }
      return { status } as { status: "inactive" | "steered" | "busy" };
    },
    streamAgent: (_agentId: string, prompt: string) => {
      if (staleRemaining > 0) {
        staleRemaining -= 1;
        throw new StaleProviderSessionError("codex", "session gone");
      }
      calls.streamAgent.push(prompt);
      return makeStream();
    },
    replaceAgentRun: async (_agentId: string, prompt: string) => {
      calls.replaceAgentRun.push(prompt);
      return makeStream();
    },
    reloadAgentSession: async () => {
      calls.reloadAgentSession += 1;
      return snapshot;
    },
    reloadAgentSessionUnlessBusy: async () => {
      calls.reloadAgentSessionUnlessBusy += 1;
      return options.guardedReloadBusy
        ? ({ reloaded: false, reason: "busy" } as const)
        : ({ reloaded: true, agent: snapshot } as const);
    },
  } as unknown as StartAgentRunController;

  return { controller, calls, drained };
}

test("P1: without busyFallback a busy caller is replaced (upstream default)", async () => {
  const stub = createBusyFallbackStub({ hasInFlightRun: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
  });
  expect(result.disposition).toBe("turn_started");
  expect(stub.calls.replaceAgentRun).toEqual(["hello"]);
  expect(stub.calls.streamAgent).toEqual([]);
});

test("P1: busyFallback refuse answers busy and never replaces the caller's run", async () => {
  const stub = createBusyFallbackStub({ hasInFlightRun: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("busy");
  expect(result.run).toBeUndefined();
  expect(stub.calls.replaceAgentRun).toEqual([]);
  expect(stub.calls.streamAgent).toEqual([]);
});

test("an idle caller under refuse starts one run and hands back its start handle", async () => {
  const stub = createBusyFallbackStub();
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("turn_started");
  await expect(result.run?.startSettled).resolves.toEqual({ status: "started" });
  expect(stub.calls.streamAgent).toEqual(["hello"]);
});

test("refuse carries steerOnly to the manager; replace does not", async () => {
  const refusing = createBusyFallbackStub({ steerStatus: "busy" });
  const refused = await startAgentRun(refusing.controller, "agent-1", "hi", createTestLogger(), {
    activeTurnBehavior: "steer",
    busyFallback: "refuse",
  });
  expect(refused.disposition).toBe("busy");
  expect(refusing.calls.steer[0]).toMatchObject({ steerOnly: true });
  expect(refusing.calls.streamAgent).toEqual([]);

  const replacing = createBusyFallbackStub({ steerStatus: "replaced" });
  const replaced = await startAgentRun(replacing.controller, "agent-1", "hi", createTestLogger(), {
    activeTurnBehavior: "steer",
  });
  expect(replaced.disposition).toBe("turn_started");
  expect(replacing.calls.steer[0] ?? {}).not.toHaveProperty("steerOnly");
});

test("M6: a caller that failed during dispatch's awaits is refused at admission", async () => {
  const stub = createBusyFallbackStub({ lifecycleAfterDispatchAwaits: "error" });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("busy");
  expect(stub.calls.streamAgent).toEqual([]);
  expect(stub.calls.replaceAgentRun).toEqual([]);
});

test("M6: the same sequence without busyFallback still starts a run", async () => {
  const stub = createBusyFallbackStub({ lifecycleAfterDispatchAwaits: "error" });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
  });
  expect(result.disposition).toBe("turn_started");
  expect(stub.calls.streamAgent).toEqual(["hello"]);
});

test("M14: a stale session at startup under refuse maps to one guarded reload and one run", async () => {
  const stub = createBusyFallbackStub({ staleAtStart: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("turn_started");
  expect(stub.calls.reloadAgentSessionUnlessBusy).toBe(1);
  expect(stub.calls.reloadAgentSession).toBe(0);
  expect(stub.calls.streamAgent).toEqual(["hello"]);
});

test("a stale session at startup is answered busy when the guarded reload refuses", async () => {
  const stub = createBusyFallbackStub({ staleAtStart: true, guardedReloadBusy: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("busy");
  expect(stub.calls.streamAgent).toEqual([]);
  expect(stub.calls.reloadAgentSession).toBe(0);
});

test("a stale session at startup without busyFallback keeps the unconditional reload", async () => {
  const stub = createBusyFallbackStub({ staleAtStart: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
  });
  expect(result.disposition).toBe("turn_started");
  expect(stub.calls.reloadAgentSession).toBe(1);
  expect(stub.calls.reloadAgentSessionUnlessBusy).toBe(0);
});

test("M9: a stale session during the drain under refuse neither reloads nor retries", async () => {
  const stub = createBusyFallbackStub({ staleDuringDrain: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
    busyFallback: "refuse",
  });
  expect(result.disposition).toBe("turn_started");
  await stub.drained;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stub.calls.reloadAgentSession).toBe(0);
  expect(stub.calls.reloadAgentSessionUnlessBusy).toBe(0);
  expect(stub.calls.streamAgent).toEqual(["hello"]);
});

test("M9: a stale session during the drain without busyFallback still reloads and retries", async () => {
  const stub = createBusyFallbackStub({ staleDuringDrain: true });
  const result = await startAgentRun(stub.controller, "agent-1", "hello", createTestLogger(), {
    replaceRunning: true,
  });
  expect(result.disposition).toBe("turn_started");
  await stub.drained;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stub.calls.reloadAgentSession).toBe(1);
  expect(stub.calls.streamAgent).toEqual(["hello", "hello"]);
});

test("a reserved agent is refused at the prompt layer before hasInFlightRun is consulted", async () => {
  const refused = createBusyFallbackStub({ isRunReserved: true });
  await expect(
    startAgentRun(refused.controller, "agent-1", "hello", createTestLogger(), {
      replaceRunning: true,
      busyFallback: "refuse",
    }),
  ).resolves.toEqual({ disposition: "busy" });
  expect(refused.calls.streamAgent).toEqual([]);

  const thrown = createBusyFallbackStub({ isRunReserved: true });
  await expect(
    startAgentRun(thrown.controller, "agent-1", "hello", createTestLogger(), {
      replaceRunning: true,
    }),
  ).rejects.toThrow("already has an active run");
  expect(thrown.calls.streamAgent).toEqual([]);
});
