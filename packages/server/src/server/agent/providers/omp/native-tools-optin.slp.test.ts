// SLP-PATCH coverage (native-tools-optin).
//
// The native-tools capability used to be a constant, so every omp provider
// advertised it and the only control was a daemon-wide flag named for MCP
// injection. A room needs the opposite shape: its Peer seats hold no
// orchestration tools while its Lead and Supervisor do, which is a per-provider
// decision, and turning MCP injection off must not remove native tools as a
// side effect.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
});
