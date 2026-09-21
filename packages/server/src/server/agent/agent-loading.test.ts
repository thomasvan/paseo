import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
  cleanup: () => Promise<void>;
}

async function createHistoryReadHarness(prefix: string): Promise<HistoryReadHarness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let closes = 0;
  let nativeUnarchiveHook: (() => Promise<void>) | null = null;
  let closeSessionHook: (() => void) | null = null;
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

test("a provider close failure during release disposes the held session directly", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-history-close-failure-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let failCloses = false;
  let closeAttempts = 0;
  const client = createTestAgentClients({
    closeSession: async () => {
      if (!failCloses) {
        return;
      }
      closeAttempts += 1;
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
