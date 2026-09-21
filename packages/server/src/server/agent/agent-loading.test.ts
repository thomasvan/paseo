import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import {
  ensureAgentLoaded,
  ensureUnarchivedAgentLoaded,
  withAgentHistoryRead,
} from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, { agentManager: manager, agentStorage: storage, logger });
    await ensureAgentLoaded(active.id, { agentManager: manager, agentStorage: storage, logger });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface HistoryResume {
  purpose: AgentResumeSessionOptions["purpose"];
  session: AgentSession;
}

interface HistoryReadHarness {
  manager: AgentManager;
  storage: AgentStorage;
  root: string;
  deps: {
    agentManager: AgentManager;
    agentStorage: AgentStorage;
    logger: ReturnType<typeof createTestLogger>;
  };
  closeCount: () => number;
  /** Every resumed runtime, in order, with the purpose it was launched for. */
  resumes: () => HistoryResume[];
  /**
   * One-shot hook run inside `unarchiveSnapshot`'s native-restore step: after it
   * has closed any resident runtime and before it clears `archivedAt`.
   */
  onNativeUnarchive: (hook: (() => Promise<void>) | null) => void;
  /** One-shot hook run inside the provider session's `close()`. */
  onCloseSession: (hook: (() => void) | null) => void;
  /**
   * One-shot hook run inside the client's `resumeSession`, before the session
   * exists. Awaiting inside it holds the load in flight.
   */
  onResume: (hook: ((purpose: string) => Promise<void>) | null) => void;
  cleanup: () => Promise<void>;
}

async function createHistoryReadHarness(prefix: string): Promise<HistoryReadHarness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let closes = 0;
  let nativeUnarchiveHook: (() => Promise<void>) | null = null;
  let closeSessionHook: (() => void) | null = null;
  let resumeHook: ((purpose: string) => Promise<void>) | null = null;
  const baseClient = createTestAgentClients({
    closeSession: async () => {
      closes += 1;
      const hook = closeSessionHook;
      closeSessionHook = null;
      hook?.();
    },
  }).codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }
  const resumes: HistoryResume[] = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      const hook = resumeHook;
      resumeHook = null;
      await hook?.(options?.purpose ?? "interactive");
      const session = await baseClient.resumeSession(handle, overrides, launchContext);
      // `AgentResumeSessionOptions` documents the absent purpose as interactive.
      resumes.push({ purpose: options?.purpose ?? "interactive", session });
      return session;
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
    unarchiveNativeSession: async (): Promise<void> => {
      const hook = nativeUnarchiveHook;
      nativeUnarchiveHook = null;
      await hook?.();
    },
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  return {
    manager,
    storage,
    root,
    deps: { agentManager: manager, agentStorage: storage, logger },
    closeCount: () => closes,
    resumes: () => [...resumes],
    onNativeUnarchive: (hook) => {
      nativeUnarchiveHook = hook;
    },
    onCloseSession: (hook) => {
      closeSessionHook = hook;
    },
    onResume: (hook) => {
      resumeHook = hook;
    },
    cleanup: async () => {
      await manager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a history read of an archived agent releases the provider runtime", async () => {
  const harness = await createHistoryReadHarness("agent-history-release-");
  const agentId = "00000000-0000-4000-8000-000000000401";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-archived" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    const seen = await withAgentHistoryRead(agent.id, harness.deps, (loaded) => {
      // The runtime is resident for the duration of the read, so the
      // `requireAgent`-backed reads the endpoints use do not throw.
      expect(harness.manager.getAgent(agent.id)).not.toBeNull();
      expect(harness.manager.getTimeline(agent.id)).toBeDefined();
      return loaded.id;
    });

    expect(seen).toBe(agent.id);
    expect(harness.manager.getAgent(agent.id)).toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test("a read of a live agent leaves its runtime open", async () => {
  const harness = await createHistoryReadHarness("agent-history-interactive-");
  const agentId = "00000000-0000-4000-8000-000000000402";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-live" },
    );
    const closesBefore = harness.closeCount();

    await withAgentHistoryRead(agent.id, harness.deps, (loaded) => loaded.id);

    expect(harness.manager.getAgent(agent.id)).not.toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(0);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("two overlapping history reads release the runtime once, when the last one ends", async () => {
  const harness = await createHistoryReadHarness("agent-history-concurrent-");
  const agentId = "00000000-0000-4000-8000-000000000403";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-concurrent" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    let markFirstInside = (): void => undefined;
    const firstInside = new Promise<void>((resolve) => {
      markFirstInside = resolve;
    });
    let endFirstRead = (): void => undefined;
    const firstReadGate = new Promise<void>((resolve) => {
      endFirstRead = resolve;
    });

    const firstRead = withAgentHistoryRead(agent.id, harness.deps, async () => {
      markFirstInside();
      await firstReadGate;
      return "first";
    });
    await firstInside;

    const second = await withAgentHistoryRead(agent.id, harness.deps, () => "second");

    expect(second).toBe("second");
    expect(harness.manager.getAgent(agent.id)).not.toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(0);

    endFirstRead();
    expect(await firstRead).toBe("first");
    expect(harness.manager.getAgent(agent.id)).toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test("an unarchive during a history read keeps the now-live runtime", async () => {
  const harness = await createHistoryReadHarness("agent-history-unarchive-");
  const agentId = "00000000-0000-4000-8000-000000000404";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-unarchived" },
    );
    await harness.manager.archiveAgent(agent.id);

    await withAgentHistoryRead(agent.id, harness.deps, async () => {
      // A client unarchives and takes the agent live while the read is in scope.
      // `unarchiveSnapshot` closes the history runtime itself; what follows is a
      // live agent that belongs to that client.
      await harness.manager.unarchiveSnapshot(agent.id);
      await ensureAgentLoaded(agent.id, harness.deps);
    });

    expect(await harness.storage.get(agent.id)).toMatchObject({ archivedAt: null });
    expect(harness.manager.getAgent(agent.id)).not.toBeNull();
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a reader arriving while the last reader's release is closing loads its own", async () => {
  const harness = await createHistoryReadHarness("agent-history-exit-window-");
  const agentId = "00000000-0000-4000-8000-000000000405";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-exit-window" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    // The second reader arrives at the one moment that used to strand it: the
    // release has committed and is inside `close()`, so the runtime is already
    // out of the manager's map while the provider process is still up.
    let secondRead: Promise<number> | null = null;
    harness.onCloseSession(() => {
      secondRead = withAgentHistoryRead(
        agent.id,
        harness.deps,
        () =>
          // The endpoints read through `requireAgent`; a reader that adopted a
          // half-closed runtime throws `Unknown agent` here instead.
          harness.manager.getTimeline(agent.id).length,
      );
    });

    await withAgentHistoryRead(agent.id, harness.deps, () => "first");

    expect(secondRead).not.toBeNull();
    expect(await secondRead).toBeGreaterThanOrEqual(0);

    // Two runtimes, two releases: the second reader never shared the first one's.
    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history", "history"]);
    expect(harness.manager.getAgent(agent.id)).toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(2);
  } finally {
    await harness.cleanup();
  }
});

interface TwoManagerFixture {
  storage: AgentStorage;
  root: string;
  managerA: AgentManager;
  managerB: AgentManager;
  closesA: () => number;
  closesB: () => number;
  cleanup: () => Promise<void>;
}

async function createTwoManagerFixture(prefix: string): Promise<TwoManagerFixture> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let closesA = 0;
  let closesB = 0;
  const clientA = createTestAgentClients({
    closeSession: async () => {
      closesA += 1;
    },
  }).codex;
  const clientB = createTestAgentClients({
    closeSession: async () => {
      closesB += 1;
    },
  }).codex;
  if (!clientA || !clientB) {
    throw new Error("expected Codex test clients");
  }
  return {
    storage,
    root,
    managerA: new AgentManager({ clients: { codex: clientA }, registry: storage, logger }),
    managerB: new AgentManager({ clients: { codex: clientB }, registry: storage, logger }),
    closesA: () => closesA,
    closesB: () => closesB,
    cleanup: async () => {
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a history read on one manager does not hold another manager's runtime open", async () => {
  const fixture = await createTwoManagerFixture("agent-history-two-managers-");
  const logger = createTestLogger();
  const agentId = "00000000-0000-4000-8000-000000000407";
  const depsA = { agentManager: fixture.managerA, agentStorage: fixture.storage, logger };
  const depsB = { agentManager: fixture.managerB, agentStorage: fixture.storage, logger };
  try {
    const agent = await fixture.managerA.createAgent(
      { provider: "codex", cwd: fixture.root },
      agentId,
      { workspaceId: "workspace-two-managers" },
    );
    await fixture.managerA.archiveAgent(agent.id);

    let markAInside = (): void => undefined;
    const aInside = new Promise<void>((resolve) => {
      markAInside = resolve;
    });
    let endARead = (): void => undefined;
    const aGate = new Promise<void>((resolve) => {
      endARead = resolve;
    });
    const readA = withAgentHistoryRead(agentId, depsA, async () => {
      markAInside();
      await aGate;
      return "a";
    });
    await aInside;

    // B's reader is the only reader of B's runtime. A's open read is on a different
    // manager and says nothing about whether B's process may be released.
    await withAgentHistoryRead(agentId, depsB, () => "b");
    expect(fixture.managerB.getAgent(agentId)).toBeNull();
    expect(fixture.closesB()).toBe(1);

    endARead();
    expect(await readA).toBe("a");
    expect(fixture.managerA.getAgent(agentId)).toBeNull();
  } finally {
    await fixture.managerA.closeAgent(agentId).catch(() => undefined);
    await fixture.managerB.closeAgent(agentId).catch(() => undefined);
    await fixture.managerA.flush().catch(() => undefined);
    await fixture.managerB.flush().catch(() => undefined);
    await fixture.cleanup();
  }
});

test("concurrent loads of one agent id on two managers each get their own runtime", async () => {
  const fixture = await createTwoManagerFixture("agent-loading-two-managers-");
  const logger = createTestLogger();
  const agentId = "00000000-0000-4000-8000-000000000408";
  try {
    const agent = await fixture.managerA.createAgent(
      { provider: "codex", cwd: fixture.root },
      agentId,
      { workspaceId: "workspace-two-manager-loads" },
    );
    await fixture.managerA.closeAgent(agent.id);

    const [loadedA, loadedB] = await Promise.all([
      ensureAgentLoaded(agentId, {
        agentManager: fixture.managerA,
        agentStorage: fixture.storage,
        logger,
      }),
      ensureAgentLoaded(agentId, {
        agentManager: fixture.managerB,
        agentStorage: fixture.storage,
        logger,
      }),
    ]);

    // An in-flight load is deduped per manager. Sharing the key across managers hands
    // one manager the other's runtime and leaves it with no session of its own.
    expect(loadedA.session).not.toBe(loadedB.session);
    expect(fixture.managerA.getAgent(agentId)).not.toBeNull();
    expect(fixture.managerB.getAgent(agentId)).not.toBeNull();
  } finally {
    await fixture.managerA.closeAgent(agentId).catch(() => undefined);
    await fixture.managerB.closeAgent(agentId).catch(() => undefined);
    await fixture.managerA.flush().catch(() => undefined);
    await fixture.managerB.flush().catch(() => undefined);
    await fixture.cleanup();
  }
});

interface CapturedLogRecord {
  level: number;
  msg: string;
}

/**
 * A logger whose records the test can read. Cleanup outcomes are only visible in
 * the log, so a test about what the manager claims has to assert on them.
 */
function createCapturingLogger(): { logger: pino.Logger; records: CapturedLogRecord[] } {
  const records: CapturedLogRecord[] = [];
  const logger = pino(
    { level: "trace" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as CapturedLogRecord);
      },
    },
  );
  return { logger, records };
}

test("a provider close failure during release is recorded as unresolved, not as a disposal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-history-close-failure-"));
  const { logger, records } = createCapturingLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let failCloses = false;
  let closeAttempts = 0;
  let noopCloses = 0;
  let sessionClosed = false;
  const client = createTestAgentClients({
    closeSession: async () => {
      if (!failCloses) {
        return;
      }
      closeAttempts += 1;
      // The closed-before-await shape `plugin-provider.ts:1202` and the pi agent
      // both have: the session marks itself closed, then the transport close
      // rejects. Every later `close()` resolves having done nothing, so a manager
      // that retries through `AgentSession` cannot reach the leaked process.
      if (sessionClosed) {
        noopCloses += 1;
        return;
      }
      sessionClosed = true;
      throw new Error("provider close failed");
    },
  }).codex;
  if (!client) {
    throw new Error("expected Codex test client");
  }
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  const agentId = "00000000-0000-4000-8000-000000000409";
  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: root }, agentId, {
      workspaceId: "workspace-close-failure",
    });
    await manager.archiveAgent(agent.id);
    failCloses = true;

    // The read still succeeds: the response is already built and cleanup failure is
    // not the caller's problem.
    const seen = await withAgentHistoryRead(
      agent.id,
      { agentManager: manager, agentStorage: storage, logger },
      (loaded) => loaded.id,
    );
    expect(seen).toBe(agent.id);

    // `closeAgentRuntime` removed the agent from the manager before `session.close()`
    // threw, so the manager has no handle left. The release keeps one and retries.
    expect(manager.getAgent(agent.id)).toBeNull();
    expect(closeAttempts).toBe(2);
    // The retry resolved and disposed nothing. Nothing may claim otherwise.
    expect(noopCloses).toBe(1);
    expect(records.filter((record) => /dispos/i.test(record.msg))).toEqual([]);
    const unresolved = records.filter((record) =>
      record.msg.includes("History-purpose session cleanup is unresolved"),
    );
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.level).toBe(50);
  } finally {
    failCloses = false;
    await manager.closeAgent(agentId).catch(() => undefined);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

interface OpenHistoryRead {
  /** Resolves with the read's result once `end()` has been called. */
  result: Promise<string>;
  end: () => void;
}

/**
 * Unarchive `agentId`, starting a history read inside the window between the
 * unarchive closing any resident runtime and clearing `archivedAt`. The read is
 * still open when this resolves, and the record is live.
 */
async function unarchiveWithHistoryReadInside(
  harness: HistoryReadHarness,
  agentId: string,
  afterGate?: () => void,
): Promise<OpenHistoryRead> {
  let markInside = (): void => undefined;
  const inside = new Promise<void>((resolve) => {
    markInside = resolve;
  });
  let end = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    end = resolve;
  });
  let result!: Promise<string>;

  harness.onNativeUnarchive(async () => {
    result = withAgentHistoryRead(agentId, harness.deps, async () => {
      markInside();
      await gate;
      afterGate?.();
      return "read";
    });
    await inside;
  });

  expect(await harness.manager.unarchiveSnapshot(agentId)).toBe(true);
  expect(await harness.storage.get(agentId)).toMatchObject({ archivedAt: null });
  return { result, end };
}

test("a history read that starts inside the unarchive window releases what it loaded", async () => {
  const harness = await createHistoryReadHarness("agent-history-unarchive-window-");
  const agentId = "00000000-0000-4000-8000-000000000411";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-unarchive-window" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    const read = await unarchiveWithHistoryReadInside(harness, agent.id);

    // The unarchive returned believing it had closed everything. The reader is
    // holding a `purpose: "history"` runtime that the record now says is live.
    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history"]);

    read.end();
    expect(await read.result).toBe("read");

    // Ownership is the lease the reader took, not what `archivedAt` says now.
    expect(harness.manager.getAgent(agent.id)).toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a live caller is never served the history runtime a reader is holding", async () => {
  const harness = await createHistoryReadHarness("agent-history-live-adoption-");
  const agentId = "00000000-0000-4000-8000-000000000412";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-live-adoption" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    const read = await unarchiveWithHistoryReadInside(harness, agent.id);
    const historySession = harness.manager.getAgent(agent.id)?.session ?? null;
    expect(historySession).not.toBeNull();

    // A client opens the now-live agent while the read is still in scope. The
    // read-only runtime is disowned and replaced, never handed over.
    const live = ensureUnarchivedAgentLoaded(agent.id, harness.deps);
    read.end();
    expect(await read.result).toBe("read");
    const loaded = await live;

    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history", "interactive"]);
    expect(loaded.session).not.toBe(historySession);
    expect(harness.manager.getAgent(agent.id)?.session).toBe(loaded.session);
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a read that is handed a live runtime binds nothing and closes nothing", async () => {
  const harness = await createHistoryReadHarness("agent-history-live-adopt-");
  const agentId = "00000000-0000-4000-8000-000000000414";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-live-adopt" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    // The reader samples an archived record; an interactive caller then unarchives
    // and loads before the reader's own load runs, so `ensureAgentLoaded` hands the
    // reader the client's live runtime. The lease must bind nothing: the reader
    // borrowed someone else's agent and owes no close on it.
    const realGet = harness.storage.get.bind(harness.storage);
    let onNextGet: (() => Promise<void>) | null = null;
    harness.storage.get = async (id: string) => {
      const record = await realGet(id);
      const hook = onNextGet;
      onNextGet = null;
      if (hook) {
        await hook();
      }
      return record;
    };
    onNextGet = async () => {
      await harness.manager.unarchiveSnapshot(agent.id);
      await ensureUnarchivedAgentLoaded(agent.id, harness.deps);
    };

    const seen = await withAgentHistoryRead(agent.id, harness.deps, (loaded) => loaded.session);

    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["interactive"]);
    expect(harness.manager.getAgent(agent.id)?.session).toBe(seen);
    expect(harness.closeCount() - closesBefore).toBe(0);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a reader arriving during the release of an unarchived-window runtime loads its own", async () => {
  const harness = await createHistoryReadHarness("agent-history-window-release-");
  const agentId = "00000000-0000-4000-8000-000000000413";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-window-release" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    const read = await unarchiveWithHistoryReadInside(harness, agent.id);

    // The second reader arrives while the release is inside `close()`: the
    // runtime is gone from the manager but the provider process is still there.
    let second: Promise<string> | null = null;
    harness.onCloseSession(() => {
      second = withAgentHistoryRead(agent.id, harness.deps, (loaded) => loaded.id);
    });

    read.end();
    expect(await read.result).toBe("read");
    expect(second).not.toBeNull();
    expect(await second).toBe(agent.id);

    // The record is live, so the second reader is a live caller: it gets its own
    // interactive runtime and leaves it open, and only the history one closed.
    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history", "interactive"]);
    expect(harness.closeCount() - closesBefore).toBe(1);
    expect(harness.manager.getAgent(agent.id)).not.toBeNull();
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

/**
 * Let every queued continuation and I/O completion run. Used where the point of
 * the test is that a caller has either finished or parked, and the two must not
 * be told apart by how long the test is willing to wait.
 */
async function settle(turns = 50): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

/** A history read held open at a gate, with the runtime it loaded still resident. */
interface GatedHistoryRead {
  result: Promise<string>;
  end: () => void;
}

async function openGatedHistoryRead(
  harness: HistoryReadHarness,
  agentId: string,
): Promise<GatedHistoryRead> {
  let markInside = (): void => undefined;
  const inside = new Promise<void>((resolve) => {
    markInside = resolve;
  });
  let end = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    end = resolve;
  });
  const result = withAgentHistoryRead(agentId, harness.deps, async () => {
    markInside();
    await gate;
    return "read";
  });
  await inside;
  return { result, end };
}

test("a live caller is never served an in-flight history resume", async () => {
  const harness = await createHistoryReadHarness("agent-history-inflight-adoption-");
  const agentId = "00000000-0000-4000-8000-000000000415";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-inflight" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    let markResuming = (): void => undefined;
    const resuming = new Promise<void>((resolve) => {
      markResuming = resolve;
    });
    let releaseResume = (): void => undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    harness.onResume(async (purpose) => {
      expect(purpose).toBe("history");
      markResuming();
      await resumeGate;
    });

    let endRead = (): void => undefined;
    const readGate = new Promise<void>((resolve) => {
      endRead = resolve;
    });
    const read = withAgentHistoryRead(agent.id, harness.deps, async () => {
      await readGate;
      return "read";
    });
    await resuming;

    // The record goes live while the reader's resume is still in flight. Nothing
    // is resident yet, so the only thing that records what the load in flight is
    // for is the load itself.
    expect(await harness.manager.unarchiveSnapshot(agent.id)).toBe(true);
    const live = ensureUnarchivedAgentLoaded(agent.id, harness.deps);

    releaseResume();
    await settle();
    endRead();
    expect(await read).toBe("read");
    const loaded = await live;

    // Two runtimes: the reader's read-only one and the client's own.
    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history", "interactive"]);
    expect(harness.resumes()[0]?.session).not.toBe(loaded.session);
    expect(harness.manager.getAgent(agent.id)?.session).toBe(loaded.session);
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a live caller arriving mid-read leaves the read's runtime reachable by id", async () => {
  const harness = await createHistoryReadHarness("agent-history-reentrant-read-");
  const agentId = "00000000-0000-4000-8000-000000000416";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-reentrant-read" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    // The endpoints reach back into the manager by agent id after an await:
    // `handleAgentTimelineListPromptsRequest` awaits `getTimelineRows` and then
    // calls `fetchTimeline`. Anything that removes the runtime in that gap turns
    // the second call into `Unknown agent`.
    let seenRows = -1;
    const read = await unarchiveWithHistoryReadInside(harness, agent.id, () => {
      seenRows = harness.manager.getTimeline(agent.id).length;
    });
    const historySession = harness.manager.getAgent(agent.id)?.session ?? null;
    expect(historySession).not.toBeNull();

    // Park the live caller's own resume so the window it opens for itself stays
    // open: a replacement runtime registered under the same id would hide the
    // removal rather than fix it.
    let releaseResume = (): void => undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    harness.onResume(async (purpose) => {
      expect(purpose).toBe("interactive");
      await resumeGate;
    });
    const live = ensureUnarchivedAgentLoaded(agent.id, harness.deps);
    await settle();

    read.end();
    expect(await read.result).toBe("read");
    expect(seenRows).toBeGreaterThanOrEqual(0);
    releaseResume();

    const loaded = await live;
    expect(loaded.session).not.toBe(historySession);
    expect(harness.manager.getAgent(agent.id)?.session).toBe(loaded.session);
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a reader arriving behind a waiting live caller does not starve it", async () => {
  const harness = await createHistoryReadHarness("agent-history-starvation-");
  const agentId = "00000000-0000-4000-8000-000000000417";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-starvation" },
    );
    await harness.manager.archiveAgent(agent.id);

    const first = await openGatedHistoryRead(harness, agent.id);
    // A live caller for the same archived id parks behind the reader's lease.
    const live = ensureAgentLoaded(agent.id, harness.deps);
    await settle();

    // A second reader arrives while the live caller is parked. If it were allowed
    // to join the lease set now, the set would never drain and `live` would never
    // run: this is the starvation the queue has to prevent.
    const second = await (async () => {
      let end = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        end = resolve;
      });
      const result = withAgentHistoryRead(agent.id, harness.deps, async () => {
        await gate;
        return "second";
      });
      return { result, end };
    })();
    await settle();

    first.end();
    expect(await first.result).toBe("read");
    // Hangs if the second reader was allowed in ahead of the parked live caller.
    const loaded = await live;
    expect(loaded.id).toBe(agent.id);

    second.end();
    expect(await second.result).toBe("second");
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});

test("a live load for the agent a read is holding fails instead of deadlocking", async () => {
  const harness = await createHistoryReadHarness("agent-history-self-wait-");
  const agentId = "00000000-0000-4000-8000-000000000418";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-self-wait" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    // A read callback that loads its own agent interactively would park on its
    // own lease, which only its own return can release.
    await expect(
      withAgentHistoryRead(
        agent.id,
        harness.deps,
        async () => await ensureAgentLoaded(agent.id, harness.deps),
      ),
    ).rejects.toThrow(/history read/i);

    // The failed read still releases what it loaded.
    expect(harness.manager.getAgent(agent.id)).toBeNull();
    expect(harness.closeCount() - closesBefore).toBe(1);
  } finally {
    await harness.cleanup();
  }
});

test("two readers that arrive on the same cold load share one runtime and one close", async () => {
  const harness = await createHistoryReadHarness("agent-history-shared-load-");
  const agentId = "00000000-0000-4000-8000-000000000419";
  try {
    const agent = await harness.manager.createAgent(
      { provider: "codex", cwd: harness.root },
      agentId,
      { workspaceId: "workspace-shared-load" },
    );
    await harness.manager.archiveAgent(agent.id);
    const closesBefore = harness.closeCount();

    // Park the history resume so the second reader has a load in flight to join
    // rather than a resident runtime to find.
    let releaseResume = (): void => undefined;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    let markResuming = (): void => undefined;
    const resuming = new Promise<void>((resolve) => {
      markResuming = resolve;
    });
    harness.onResume(async (purpose) => {
      expect(purpose).toBe("history");
      markResuming();
      await resumeGate;
    });

    let endFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      endFirst = resolve;
    });
    let markFirstInside = (): void => undefined;
    const firstInside = new Promise<void>((resolve) => {
      markFirstInside = resolve;
    });
    let firstSession: AgentSession | null = null;
    const first = withAgentHistoryRead(agent.id, harness.deps, async (loaded) => {
      firstSession = loaded.session;
      markFirstInside();
      await firstGate;
      return "first";
    });
    await resuming;

    let endSecond = (): void => undefined;
    const secondGate = new Promise<void>((resolve) => {
      endSecond = resolve;
    });
    let markSecondInside = (): void => undefined;
    const secondInside = new Promise<void>((resolve) => {
      markSecondInside = resolve;
    });
    let secondSession: AgentSession | null = null;
    const second = withAgentHistoryRead(agent.id, harness.deps, async (loaded) => {
      secondSession = loaded.session;
      markSecondInside();
      await secondGate;
      return "second";
    });
    // Let the joiner's plan land before the load it is joining completes, then
    // wait for both reads to be inside rather than for a number of turns.
    await settle();
    releaseResume();
    await firstInside;
    await secondInside;

    // One load, one runtime, and the joining reader holds a claim on it: the
    // lease a caller adopts is bound to what the load left resident, so ending
    // the first read cannot close the runtime the second is still using.
    expect(harness.resumes().map((resume) => resume.purpose)).toEqual(["history"]);
    expect(secondSession).not.toBeNull();
    expect(secondSession).toBe(firstSession);

    endFirst();
    expect(await first).toBe("first");
    expect(harness.closeCount() - closesBefore).toBe(0);
    expect(harness.manager.getAgent(agent.id)).not.toBeNull();

    endSecond();
    expect(await second).toBe("second");
    expect(harness.closeCount() - closesBefore).toBe(1);
    expect(harness.manager.getAgent(agent.id)).toBeNull();
  } finally {
    await harness.manager.closeAgent(agentId).catch(() => undefined);
    await harness.cleanup();
  }
});
