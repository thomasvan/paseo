// SLP-PATCH(native-tools-injection-independent): fork-owned gate module.
//
// Upstream (#4277, "Control Paseo tools per provider") delivers a per-provider
// `paseoTools` policy but still gates the native Paseo tool catalog on daemon
// MCP injection (`mcpEnabled && mcp.injectIntoAgents !== false`, see
// bootstrap.ts). This room runs MCP injection off — its launchers give each
// seat caller-scoped servers, so an injected daemon-wide server would be scoped
// to the wrong caller — while its omp Supervisor and Lead seats must still
// receive the native catalog (policy-enabled) and its omp Peer seats none
// (policy-disabled). So the catalog's master enable follows the MCP stack being
// enabled, and injection controls only the injected MCP server, never the
// native catalog. See PATCHES.md.

/**
 * Whether the native Paseo tool catalog is available at all, independent of
 * whether the daemon injects its MCP server into agents.
 *
 * Upstream reads `mcp.enabled` and `mcp.injectIntoAgents` here and demands
 * both; this fork drops the injection term so a deployment that serves MCP
 * caller-scoped (injection off) keeps native tools. The per-provider policy
 * (`ProviderPaseoToolsPolicy`) remains the seat-level gate on top of this.
 */
export function isNativePaseoToolsEnabled(mcpEnabled: boolean | undefined): boolean {
  return (mcpEnabled ?? true) !== false;
}
