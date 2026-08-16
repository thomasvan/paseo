// SLP-PATCH coverage (native-tools-optin).
//
// The native-tools capability used to be a constant, so every omp provider
// advertised it and the only control was a daemon-wide flag named for MCP
// injection. A room needs the opposite shape: its Peer seats hold no
// orchestration tools while its Lead and Supervisor do, which is a per-provider
// decision, and turning MCP injection off must not remove native tools as a
// side effect.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonConfigStore } from "../../../daemon-config-store.js";
import { loadPersistedConfig } from "../../../persisted-config.js";
import { OmpAgentClient } from "./agent.js";
import { resolveOmpProviderParams } from "./provider-config.js";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
} as never;

function capabilitiesFor(providerParams: unknown): boolean {
  return new OmpAgentClient({ logger, providerParams }).capabilities.supportsNativePaseoTools;
}

describe("omp native Paseo tools are a per-provider decision", () => {
  it("defaults to enabled, which is the behaviour before the field existed", () => {
    expect(resolveOmpProviderParams({}).runtimeProviderParams.paseoTools).toBe(true);
    expect(capabilitiesFor(undefined)).toBe(true);
  });

  it("lets a provider opt out, so a Peer seat can hold no orchestration tools", () => {
    expect(resolveOmpProviderParams({ paseoTools: false }).runtimeProviderParams.paseoTools).toBe(
      false,
    );
    expect(capabilitiesFor({ paseoTools: false })).toBe(false);
  });

  it("keeps the opt-in explicit and independent of the other provider params", () => {
    expect(capabilitiesFor({ sessionDir: "/tmp/x", paseoTools: true })).toBe(true);
    expect(capabilitiesFor({ sessionDir: "/tmp/x" })).toBe(true);
  });

  it("rejects an unknown provider param rather than ignoring it", () => {
    expect(() => resolveOmpProviderParams({ paseoTool: true })).toThrow();
  });
});

// Static, because the live rebinding lives in bootstrap wiring that a unit test
// cannot reach without standing up a daemon. The startup path and the
// field-change path must agree: if `mcp.injectIntoAgents` still drives native
// tools at runtime, the decoupling only holds until someone toggles it.
describe("the live path matches the startup path", () => {
  const bootstrap = readFileSync(
    fileURLToPath(new URL("../../../bootstrap.ts", import.meta.url)),
    "utf8",
  );

  function handlerBody(field: string): string {
    const start = bootstrap.indexOf(`onFieldChange("${field}"`);
    expect(start, `${field} handler is present`).toBeGreaterThan(-1);
    return bootstrap.slice(start, bootstrap.indexOf("});", start));
  }

  it("does not flip native tools when MCP injection is toggled", () => {
    expect(handlerBody("mcp.injectIntoAgents")).not.toContain("setPaseoToolsEnabled");
  });

  it("rebinds native tools when their own field is toggled", () => {
    expect(handlerBody("mcp.nativeAgentTools")).toContain("setPaseoToolsEnabled");
  });

  // Also static: the store is constructed once, inside bootstrap. Without the
  // seed the field is absent from the config the daemon reports, so a client
  // reading it sees nothing while native tools are in fact on — the same
  // two-surfaces-disagreeing shape this patch exists to remove.
  it("seeds the field from the resolved config, so the reported value is true", () => {
    const initial = bootstrap.slice(
      bootstrap.indexOf("const initialConfig: MutableDaemonConfig"),
      bootstrap.indexOf("browserTools:", bootstrap.indexOf("const initialConfig")),
    );
    expect(initial).toContain("nativeAgentTools: config.mcpNativeAgentTools !== false");
  });
});

// The mutable schema is `.passthrough()`, so an undeclared key survives a parse
// and the field would appear to work while being invisible to every consumer of
// the schema — clients, the generated validators, and anyone reading it to learn
// what a daemon can be told. Declared, not merely tolerated.
describe("the mutable schema declares the field", () => {
  it("accepts it and keeps the value", () => {
    const parsed = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false, nativeAgentTools: false },
      providers: {},
    });
    expect(parsed.mcp.nativeAgentTools).toBe(false);
  });

  it("declares it optional, so a daemon predating the field still parses", () => {
    const parsed = MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: false },
      providers: {},
    });
    expect(parsed.mcp.nativeAgentTools).toBeUndefined();
  });

  it("rejects a non-boolean rather than passing it through", () => {
    expect(() =>
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false, nativeAgentTools: "yes" },
        providers: {},
      }),
    ).toThrow();
  });
});

// A handler is only half a switch. `mcp.nativeAgentTools` also has to exist on
// the mutable surface, be seeded from the resolved config, and survive a
// restart — otherwise the field is unreachable, the handler never fires, and an
// explicit live opt-out is silently undone the next time the daemon starts.
describe("the native-tools field is a real, durable setting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function storeWith(nativeAgentTools: boolean): {
    store: DaemonConfigStore;
    paseoHome: string;
  } {
    const paseoHome = mkdtempSync(path.join(tmpdir(), "paseo-native-tools-optin-"));
    tempDirs.push(paseoHome);
    return {
      paseoHome,
      store: new DaemonConfigStore(paseoHome, {
        relay: { enabled: false },
        mcp: { injectIntoAgents: false, nativeAgentTools },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
      }),
    };
  }

  it("carries the seeded value, so the handler has a prior value to change from", () => {
    const { store } = storeWith(true);
    expect(store.get().mcp.nativeAgentTools).toBe(true);
  });

  it("fires its field change when patched live", () => {
    const { store } = storeWith(true);
    const changes: unknown[] = [];
    store.onFieldChange("mcp.nativeAgentTools", (value) => changes.push(value));

    store.patch({ mcp: { nativeAgentTools: false } });

    expect(changes).toEqual([false]);
  });

  it("persists a live opt-out, so a restart does not undo it", () => {
    const { store, paseoHome } = storeWith(true);

    store.patch({ mcp: { nativeAgentTools: false } });

    expect(loadPersistedConfig(paseoHome).daemon?.mcp?.nativeAgentTools).toBe(false);
  });

  it("leaves native tools alone when only MCP injection is patched", () => {
    const { store, paseoHome } = storeWith(true);
    const changes: unknown[] = [];
    store.onFieldChange("mcp.nativeAgentTools", (value) => changes.push(value));

    store.patch({ mcp: { injectIntoAgents: true } });

    expect(changes).toEqual([]);
    expect(store.get().mcp.nativeAgentTools).toBe(true);
    expect(loadPersistedConfig(paseoHome).daemon?.mcp?.nativeAgentTools).toBe(true);
  });
});
