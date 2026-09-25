import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";

const mockState = vi.hoisted(() => ({
  superConstructorOptions: [] as unknown[],
}));

vi.mock("./acp-agent.js", () => ({
  DEFAULT_ACP_CAPABILITIES: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
    supportsRewindConversation: false,
    supportsRewindFiles: false,
    supportsRewindBoth: false,
  },
  ACPAgentClient: class ACPAgentClient {
    readonly provider: string;

    constructor(options: unknown) {
      this.provider = "acp";
      mockState.superConstructorOptions.push(options);
    }
  },
}));

import { GenericACPAgentClient } from "./generic-acp-agent.js";

describe("GenericACPAgentClient", () => {
  test("passes the custom command only as defaultCommand", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["hermes", "acp"],
      env: {
        HERMES_LOG: "info",
      },
    });
    void _client;

    expect(mockState.superConstructorOptions).toEqual([
      {
        provider: "acp",
        logger: expect.any(Object),
        runtimeSettings: {
          env: {
            HERMES_LOG: "info",
          },
        },
        defaultCommand: ["hermes", "acp"],
        capabilities: {
          supportsStreaming: true,
          supportsSessionPersistence: true,
          supportsDynamicModes: true,
          supportsMcpServers: true,
          supportsReasoningStream: true,
          supportsToolInvocations: true,
          supportsRewindConversation: false,
          supportsRewindFiles: false,
          supportsRewindBoth: false,
        },
      },
    ]);
  });

  test("uses provider params to report MCP support", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["no-mcp-acp", "serve"],
      providerParams: {
        supportsMcpServers: false,
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      capabilities: {
        supportsMcpServers: false,
      },
    });
  });

  // SLP-PATCH(acp-provider-mcp-servers)
  test("passes provider params mcpServers through as providerMcpServers", () => {
    const _client = new GenericACPAgentClient({
      logger: createTestLogger(),
      command: ["dsh-peer", "acp"],
      providerParams: {
        supportsMcpServers: true,
        mcpServers: {
          serena: {
            type: "stdio",
            command: "/usr/local/bin/serena",
            args: ["start-mcp-server"],
            env: { FOO: "bar" },
          },
          paseo: {
            type: "http",
            url: "http://127.0.0.1:6767/mcp",
            headers: { Authorization: "Bearer token" },
          },
        },
      },
    });
    void _client;

    expect(mockState.superConstructorOptions.at(-1)).toMatchObject({
      providerMcpServers: {
        serena: {
          type: "stdio",
          command: "/usr/local/bin/serena",
          args: ["start-mcp-server"],
          env: { FOO: "bar" },
        },
        paseo: {
          type: "http",
          url: "http://127.0.0.1:6767/mcp",
          headers: { Authorization: "Bearer token" },
        },
      },
    });
  });

  // SLP-PATCH(acp-provider-mcp-servers)
  test("refuses a provider mcpServers stdio entry with a relative command at params parse", () => {
    expect(
      () =>
        new GenericACPAgentClient({
          logger: createTestLogger(),
          command: ["dsh-peer", "acp"],
          providerParams: {
            mcpServers: {
              serena: {
                type: "stdio",
                command: "serena",
              },
            },
          },
        }),
    ).toThrow();
  });

  // SLP-PATCH(acp-provider-mcp-servers)
  test("refuses a provider mcpServers http entry without a url at params parse", () => {
    expect(
      () =>
        new GenericACPAgentClient({
          logger: createTestLogger(),
          command: ["dsh-peer", "acp"],
          providerParams: {
            mcpServers: {
              paseo: {
                type: "http",
              },
            },
          },
        }),
    ).toThrow();
  });

  // SLP-PATCH(acp-provider-mcp-servers)
  test("refuses a provider mcpServers entry with an unknown key at params parse", () => {
    expect(
      () =>
        new GenericACPAgentClient({
          logger: createTestLogger(),
          command: ["dsh-peer", "acp"],
          providerParams: {
            mcpServers: {
              serena: {
                type: "stdio",
                command: "/usr/local/bin/serena",
                unknownField: "nope",
              },
            },
          },
        }),
    ).toThrow();
  });
});
