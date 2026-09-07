// SLP-PATCH coverage (native-tools-injection-independent).
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
