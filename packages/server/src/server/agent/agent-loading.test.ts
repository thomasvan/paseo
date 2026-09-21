import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded, withAgentHistoryRead } from "./agent-loading.js";
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
  cleanup: () => Promise<void>;
}

async function createHistoryReadHarness(prefix: string): Promise<HistoryReadHarness> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  let closes = 0;
  const client = createTestAgentClients({
    closeSession: async () => {
      closes += 1;
    },
  }).codex;
  if (!client) {
    throw new Error("expected Codex test client");
  }
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  return {
    manager,
    storage,
    root,
    deps: { agentManager: manager, agentStorage: storage, logger },
    closeCount: () => closes,
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
