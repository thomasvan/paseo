// SLP-PATCH coverage (agent-send-interrupt).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageOptions } from "@getpaseo/client";
import { createCli } from "../../cli.js";

const sendAgentMessage = vi.fn(
  async (_agentId: string, _text: string, _options?: SendMessageOptions) => undefined,
);

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    sendAgentMessage,
    close: vi.fn(async () => undefined),
  })),
  getDaemonHost: vi.fn(() => "ws://127.0.0.1:6767"),
}));

describe("paseo send active-turn behavior", () => {
  beforeEach(() => {
    sendAgentMessage.mockClear();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // An agent sender (PASEO_AGENT_ID set) interrupts like everyone else unless it
  // asks to steer, and the behavior is always sent, so no daemon default applies.
  it("an agent's send with no --behavior sends activeTurnBehavior interrupt", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "agent-a");
    await createCli().parseAsync(["send", "target-agent", "correction", "--no-wait"], {
      from: "user",
    });

    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "target-agent",
      "correction",
      expect.objectContaining({ sourceAgentId: "agent-a", activeTurnBehavior: "interrupt" }),
    );
  });
});
