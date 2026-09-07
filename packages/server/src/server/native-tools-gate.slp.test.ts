// SLP-PATCH coverage (native-tools-injection-independent).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { isNativePaseoToolsEnabled } from "./native-tools-gate.js";

// The room's live shape: daemon MCP injection off, MCP enabled. Upstream's
// bootstrap would answer false here (it ANDs `mcp.injectIntoAgents`); the fork
// gate must answer true so the omp Supervisor/Lead keep native tools and the
// per-provider policy (not the injection flag) decides which seats get them.
test("mcp enabled + injection off keeps the native catalog available", () => {
  expect(isNativePaseoToolsEnabled(true)).toBe(true);
});

test("absent mcp.enabled defaults to enabled (upstream default)", () => {
  expect(isNativePaseoToolsEnabled(undefined)).toBe(true);
});

test("mcp disabled disables the native catalog regardless of injection", () => {
  expect(isNativePaseoToolsEnabled(false)).toBe(false);
});

// The helper truth-table above would stay green if someone restored the
// injection gate at a bootstrap call site, so pin the wiring itself: every
// native-tool master switch in bootstrap.ts must pass only the fork gate and
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
