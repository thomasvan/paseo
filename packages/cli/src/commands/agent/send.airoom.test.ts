// AIROOM-PATCH coverage (agent-send-interrupt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageOptions } from "@getpaseo/client";
import { createCli } from "../../cli.js";

// The client acknowledges an agent's send with a queued receipt, which the CLI
// reads under --no-wait.
const sendAgentMessage = vi.fn(
  async (_agentId: string, _text: string, _options?: SendMessageOptions) => ({
    deliveryStatus: "queued" as const,
  }),
);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    close: vi.fn(async () => undefined),
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

async function send(args: string[]): Promise<SendMessageOptions | undefined> {
  await createCli().parseAsync(["send", "target-agent", "correction", "--no-wait", ...args], {
    from: "user",
  });
  expect(sendAgentMessage).toHaveBeenCalledTimes(1);
  expect(sendAgentMessage.mock.calls[0]![0]).toBe("target-agent");
  expect(sendAgentMessage.mock.calls[0]![1]).toBe("correction");
  return sendAgentMessage.mock.calls[0]![2];
}

describe("paseo send active-turn behavior", () => {
  beforeEach(() => {
    sendAgentMessage.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // An agent sender (PASEO_AGENT_ID set) interrupts unless it asks for queue or steer, and the
  // behavior goes out explicitly, so the receiving daemon's agent default (queue) never applies.
  it("an agent's send with no --behavior sends activeTurnBehavior interrupt", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "agent-a");

    expect(await send([])).toMatchObject({
      sourceAgentId: "agent-a",
      activeTurnBehavior: "interrupt",
    });
  });

  it.each(["queue", "steer", "interrupt"] as const)(
    "an agent's send with --behavior %s sends it as given",
    async (behavior) => {
      vi.stubEnv("PASEO_AGENT_ID", "agent-a");

      expect(await send(["--behavior", behavior])).toMatchObject({
        sourceAgentId: "agent-a",
        activeTurnBehavior: behavior,
      });
    },
  );

  // A person's omitted send leaves the field unset; the daemon interrupts it (upstream's).
  it("a send without PASEO_AGENT_ID and no --behavior leaves activeTurnBehavior unset", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");

    const options = await send([]);
    expect(options?.sourceAgentId).toBeUndefined();
    expect(options?.activeTurnBehavior).toBeUndefined();
  });
});
