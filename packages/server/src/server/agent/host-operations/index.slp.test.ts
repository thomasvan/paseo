// SLP-PATCH coverage (agent-send-interrupt), the remote surface: a send_agent_prompt
// routed by `serverId` to another host decides its activeTurnBehavior here, before
// the local handler's default can apply. Lives in its own file so upstream's tests
// stay upstream's.
import { expect, test } from "vitest";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createHostResolver, type HostOperations, type ToolHosts } from "./index.js";
import type { PaseoToolExecutionContext } from "../tools/types.js";

const LOCAL_SERVER = "local-server";
const REMOTE_SERVER = "remote-server";

async function sendToRemote(input: {
  callerAgentId?: string;
  activeTurnBehavior?: "steer" | "interrupt";
}): Promise<unknown[]> {
  const sent: unknown[] = [];
  const client = {
    fetchAgent: async (agentId: string) => ({ agent: { id: agentId, status: "running" } }),
    setAgentMode: async () => {},
    sendMessage: async (_agentId: string, _text: string, options: unknown) => {
      sent.push(options);
      return { deliveryStatus: "queued" as const };
    },
  } as unknown as DaemonClient;
  const hosts: ToolHosts = {
    directory: async () => {
      throw new Error("not used");
    },
    use: async (serverId, action) => {
      expect(serverId).toBe(REMOTE_SERVER);
      return action(client);
    },
  };
  const resolver = createHostResolver({
    serverId: LOCAL_SERVER,
    local: {} as HostOperations,
    hosts: () => hosts,
    ...(input.callerAgentId ? { callerAgentId: input.callerAgentId } : {}),
  });
  await resolver.use(REMOTE_SERVER, (host) =>
    host.sendPrompt(
      {
        agentId: "remote-child",
        prompt: "status?",
        ...(input.activeTurnBehavior ? { activeTurnBehavior: input.activeTurnBehavior } : {}),
      },
      {} as PaseoToolExecutionContext,
    ),
  );
  return sent;
}

test.each([
  { name: "an agent caller, behaviour omitted", callerAgentId: "caller", expected: "interrupt" },
  {
    name: "an agent caller asking to steer",
    callerAgentId: "caller",
    activeTurnBehavior: "steer" as const,
    expected: "steer",
  },
  {
    name: "an agent caller asking to interrupt",
    callerAgentId: "caller",
    activeTurnBehavior: "interrupt" as const,
    expected: "interrupt",
  },
  { name: "a human caller, behaviour omitted", expected: "interrupt" },
])("a remote send from $name dispatches $expected", async (row) => {
  const sent = await sendToRemote(row);

  expect(sent).toEqual([expect.objectContaining({ activeTurnBehavior: row.expected })]);
});
