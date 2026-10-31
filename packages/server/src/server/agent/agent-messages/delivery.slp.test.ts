// SLP-PATCH coverage (agent-send-interrupt), its batching effect. An agent's send
// now defaults to interrupt, and a finish notice enqueues as steer, so the two no
// longer share one provider dispatch when they land in one quiet window: delivery
// splits them into ordered groups, in arrival order, each dispatched after the
// previous one is acknowledged and neither waiting for the recipient's turn to end.
// Lives in its own file so delivery.test.ts stays upstream's.
import { expect, test } from "vitest";
import { createAgentMessageDelivery } from "./index.js";
import type { PromptDispatchDisposition } from "../agent-prompt.js";

const finishNotice = {
  source: { kind: "agent-notification" as const, agentId: "child", event: "finished" as const },
  prompt: "Child finished",
  messageId: "finished",
  activeTurnBehavior: "steer" as const,
};
const interruptingReport = {
  source: { kind: "agent-message" as const, agentId: "peer" },
  prompt: "Stop: the premise is wrong",
  messageId: "report",
  activeTurnBehavior: "interrupt" as const,
};

function recordingDelivery(acknowledge: () => Promise<PromptDispatchDisposition>) {
  const sent: Array<{ activeTurnBehavior: string; messageIds: readonly string[] }> = [];
  const delivery = createAgentMessageDelivery({
    dispatch: async ({ activeTurnBehavior, messageIds }) => {
      sent.push({ activeTurnBehavior, messageIds });
      return acknowledge();
    },
    onError: (error) => {
      throw error;
    },
  });
  return { sent, delivery };
}

test.each([
  {
    order: "a finish notice, then an agent's interrupt",
    messages: [finishNotice, interruptingReport],
    expected: [
      { activeTurnBehavior: "steer", messageIds: ["finished"] },
      { activeTurnBehavior: "interrupt", messageIds: ["report"] },
    ],
  },
  {
    order: "an agent's interrupt, then a finish notice",
    messages: [interruptingReport, finishNotice],
    expected: [
      { activeTurnBehavior: "interrupt", messageIds: ["report"] },
      { activeTurnBehavior: "steer", messageIds: ["finished"] },
    ],
  },
])("$order inside one window dispatch as two groups, in arrival order", async (row) => {
  const { sent, delivery } = recordingDelivery(async () => "steered");
  for (const message of row.messages) delivery.enqueue({ recipientId: "lead", ...message });
  await delivery.close();

  expect(sent).toEqual(row.expected);
});

test("the second group waits for the first group's acknowledgement, not for a turn to end", async () => {
  let acknowledgeFirst!: (disposition: PromptDispatchDisposition) => void;
  const acknowledgements = [
    new Promise<PromptDispatchDisposition>((resolve) => {
      acknowledgeFirst = resolve;
    }),
    Promise.resolve<PromptDispatchDisposition>("turn_started"),
  ];
  const { sent, delivery } = recordingDelivery(() => acknowledgements.shift()!);
  delivery.enqueue({ recipientId: "lead", ...finishNotice });
  const report = delivery.enqueue({ recipientId: "lead", ...interruptingReport });
  const closed = delivery.close();
  await new Promise((resolve) => setImmediate(resolve));

  expect(sent.map((request) => request.messageIds)).toEqual([["finished"]]);

  acknowledgeFirst("steered");
  await expect(report.dispatched).resolves.toBe("turn_started");
  await closed;
  expect(sent.map((request) => request.messageIds)).toEqual([["finished"], ["report"]]);
});
