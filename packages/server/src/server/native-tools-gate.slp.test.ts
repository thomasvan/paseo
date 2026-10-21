// SLP-PATCH coverage (native-tools-injection-independent).
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";

import type { AgentClient, AgentLaunchContext } from "./agent/agent-sdk-types.js";
import { createPaseoDaemon } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { isNativePaseoToolsEnabled } from "./native-tools-gate.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
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

// MCP injection only decides whether agents get the injected MCP server; the native
// tool catalog follows mcp.enabled alone, at start and through every live change:
// injection through a config patch, mcp.enabled through a config reload. Each step
// launches a new agent and reads the launch context it got.
test("an agent gets native Paseo tools exactly while MCP is enabled, whatever injection is set to", async () => {
  const paseoHomeRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-native-tools-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  const staticDir = await mkdtemp(path.join(os.tmpdir(), "paseo-static-"));
  await mkdir(paseoHome, { recursive: true });
  const configPath = path.join(paseoHome, "config.json");
  async function writeMcp(mcp: { enabled: boolean; injectIntoAgents: boolean }): Promise<void> {
    const persisted = { version: 1, daemon: { listen: "127.0.0.1:0", mcp } };
    await writeFile(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf-8");
  }
  await writeMcp({ enabled: true, injectIntoAgents: false });

  const launches: Array<AgentLaunchContext | undefined> = [];
  const config = loadConfig(paseoHome, { env: {} });
  config.staticDir = staticDir;
  config.agentClients = { claude: createRecordingClient(launches) };
  config.agentStoragePath = path.join(paseoHome, "agents");
  const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
  let client: DaemonClient | null = null;

  async function launchHasNativeTools(): Promise<boolean> {
    await daemon.agentManager.createAgent({ provider: "claude", cwd: staticDir }, undefined, {
      workspaceId: undefined,
    });
    return launches.at(-1)?.paseoTools !== undefined;
  }

  try {
    await daemon.start();
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Expected a TCP listener");
    client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "0.12.0" });
    await client.connect();

    expect(await launchHasNativeTools()).toBe(true);
    await client.patchDaemonConfig({ mcp: { injectIntoAgents: true } });
    await client.patchDaemonConfig({ mcp: { injectIntoAgents: false } });
    expect(await launchHasNativeTools()).toBe(true);
    await writeMcp({ enabled: false, injectIntoAgents: false });
    await client.reloadDaemonConfig();
    expect(await launchHasNativeTools()).toBe(false);
    await writeMcp({ enabled: true, injectIntoAgents: false });
    await client.reloadDaemonConfig();
    expect(await launchHasNativeTools()).toBe(true);
  } finally {
    await client?.close();
    await daemon.stop();
    await rm(paseoHomeRoot, { recursive: true, force: true });
    await rm(staticDir, { recursive: true, force: true });
  }
}, 30_000);

test("an absent mcp.enabled leaves the native catalog available, as upstream defaults it", () => {
  expect(isNativePaseoToolsEnabled(undefined)).toBe(true);
});

// The plugin provider runtime's catalog switch has no observable here, so its call
// sites are read: every native-catalog switch in bootstrap.ts passes the fork gate and
// never an injection-dependent expression.
function bootstrapToolGateArguments(source: string): string[] {
  const arguments_: string[] = [];
  const pattern = /\b(setPaseoToolsEnabled|setAgentProviderToolsEnabled)\(([^;]*?)\);/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    arguments_.push(match[2]!);
  }
  return arguments_;
}

test("bootstrap gates the native catalog on mcp.enabled alone, never on MCP injection", () => {
  const bootstrap = readFileSync(fileURLToPath(new URL("./bootstrap.ts", import.meta.url)), "utf8");
  const arguments_ = bootstrapToolGateArguments(bootstrap);
  expect(arguments_.length).toBeGreaterThanOrEqual(4);
  for (const argument_ of arguments_) {
    expect(argument_).toContain("isNativePaseoToolsEnabled");
    expect(argument_).not.toContain("injectIntoAgents");
    expect(argument_).not.toContain("mcpEnabled &&");
  }
});
