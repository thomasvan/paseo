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

  // The daemon gets an explicit behavior every time: an agent sender
  // (PASEO_AGENT_ID set) interrupts like everyone else unless it asks to steer.
  it.each([
    { path: ["send"], caller: "agent-a", flag: [], sent: "interrupt" },
    { path: ["agent", "send"], caller: "agent-a", flag: [], sent: "interrupt" },
    { path: ["send"], caller: "agent-a", flag: ["--behavior", "steer"], sent: "steer" },
    { path: ["send"], caller: "agent-a", flag: ["--behavior", "interrupt"], sent: "interrupt" },
    { path: ["send"], caller: undefined, flag: [], sent: "interrupt" },
    { path: ["agent", "send"], caller: undefined, flag: [], sent: "interrupt" },
    { path: ["send"], caller: undefined, flag: ["--behavior", "steer"], sent: "steer" },
  ] as const)(
    "$path with caller $caller and flags $flag sends activeTurnBehavior $sent",
    async ({ path, caller, flag, sent }) => {
      vi.stubEnv("PASEO_AGENT_ID", caller ?? "");
      await createCli().parseAsync([...path, "target-agent", "correction", "--no-wait", ...flag], {
        from: "user",
      });

      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      expect(sendAgentMessage).toHaveBeenCalledWith(
        "target-agent",
        "correction",
        expect.objectContaining({ sourceAgentId: caller, activeTurnBehavior: sent }),
      );
    },
  );
});
