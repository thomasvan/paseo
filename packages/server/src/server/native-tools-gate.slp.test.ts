// SLP-PATCH coverage (native-tools-injection-independent).
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";

import type { AgentClient, AgentLaunchContext } from "./agent/agent-sdk-types.js";
import { createPaseoDaemon } from "./bootstrap.js";
import { createTestAgentClient } from "./test-utils/fake-agent-client.js";

// A Claude client that offers native Paseo tools and records each launch context.
function createRecordingClient(launches: Array<AgentLaunchContext | undefined>): AgentClient {
  const inner = createTestAgentClient("claude");
  const client: AgentClient = Object.create(inner);
  Object.defineProperty(client, "capabilities", {
    value: { ...inner.capabilities, supportsNativePaseoTools: true },
  });
  client.createSession = (config, launchContext) => {
    launches.push(launchContext);
    return inner.createSession(config, launchContext);
  };
  return client;
}

// MCP injection only decides whether agents get the injected MCP server; the
// native tool catalog follows mcp.enabled alone. The daemon is started, so the
// value an agent launches with is the one the MCP mount leaves in place.
test.each([
  { mcp: "enabled with injection off", mcpEnabled: true, inject: false, nativeTools: true },
  { mcp: "disabled with injection on", mcpEnabled: false, inject: true, nativeTools: false },
])(
  "an agent launched with MCP $mcp gets native Paseo tools: $nativeTools",
  async ({ mcpEnabled, inject, nativeTools }) => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-home-"));
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
    const launches: Array<AgentLaunchContext | undefined> = [];
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled,
        mcpInjectIntoAgents: inject,
        staticDir,
        mcpDebug: false,
        agentClients: { claude: createRecordingClient(launches) },
        agentStoragePath: path.join(paseoHome, "agents"),
      },
      pino({ level: "silent" }),
    );
    try {
      await daemon.start();
      await daemon.agentManager.createAgent({ provider: "claude", cwd: staticDir }, undefined, {
        workspaceId: undefined,
      });

      expect(launches).toHaveLength(1);
      expect(launches[0]?.paseoTools !== undefined).toBe(nativeTools);
    } finally {
      await daemon.stop();
      await rm(paseoHome, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  },
  30_000,
);
