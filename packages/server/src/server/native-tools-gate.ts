// SLP-PATCH(native-tools-injection-independent): fork-owned gate module.
//
// Upstream gates the native Paseo tool catalog on daemon MCP injection
// (`mcpEnabled && mcp.injectIntoAgents !== false`). A deployment can serve MCP
// to each agent through its own caller-scoped servers and run injection off,
// because an injected daemon-wide server would be scoped to the wrong caller,
// while still wanting native tools for the providers whose `paseoTools` policy
// enables them. So the catalog's master switch follows the MCP stack being
// enabled, and injection controls only the injected MCP server.

/**
 * Whether the native Paseo tool catalog is available at all, independent of
 * whether the daemon injects its MCP server into agents. The per-provider policy
 * (`ProviderPaseoToolsPolicy`) remains the gate on top of this.
 */
export function isNativePaseoToolsEnabled(mcpEnabled: boolean | undefined): boolean {
  return (mcpEnabled ?? true) !== false;
}
