// AIROOM-PATCH(wakeup-each): the gate's turn signal and the terminal queue, on the `Host` fake.
import { expect, test } from "vitest";
import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import type { HostObservation } from "../../host-operations/index.js";
import { buildStoredAgentPayload } from "../../agent-projections.js";
import { openFinishObservation } from "./observation-stream.js";

type Status = "idle" | "running" | "initializing" | "closed";
class Host implements HostObservation {
  handler?: Parameters<HostObservation["observe"]>[1];
  baseline = Promise.withResolvers<WaitForFinishResult>();
  async wait() {
    return this.baseline.promise;
  }
  async observe(_id: string, handler: Parameters<HostObservation["observe"]>[1]) {
    this.handler = handler;
    return async () => {};
  }
  emit(status: Status, event?: AgentStreamEvent, lastMessage = "Last response") {
    this.handler!(snapshot(status), event, lastMessage);
  }
}
function snapshot(status: Status) {
  return buildStoredAgentPayload(
    {
      id: "child",
      cwd: "/tmp",
      provider: "codex",
      labels: {},
      lastStatus: status,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
    },
    ["codex"],
  );
}
async function scenario() {
  const host = new Host();
  const observation = await openFinishObservation(
    { use: async (_server, action) => action(host) },
    { id: "watch", callerAgentId: "parent", childAgentId: "child" },
    new AbortController().signal,
  );
  const turns: number[] = [];
  observation.onTurn!(() => turns.push(turns.length));
  return { host, observation, turns };
}

test("a synthetic open on an idle child observes no turn, and the idle baseline follows none", async () => {
  const { host, observation, turns } = await scenario();
  try {
    // The local observer's open event: no turnId, the current idle snapshot.
    host.emit("idle", { type: "turn_started", provider: "codex" });
    host.baseline.resolve({
      status: "idle",
      final: snapshot("idle"),
      lastMessage: null,
      error: null,
    });
    const result = await observation.next();
    expect(result.turnObserved).toBe(false);
    expect(observation.turnPending!()).toBe(false);
    expect(turns).toEqual([]);
  } finally {
    await observation.close();
  }
});

test("a remote turn_started with a turnId opens the gate though its re-fetched snapshot reads idle", async () => {
  const { host, observation, turns } = await scenario();
  try {
    host.emit("idle", { type: "turn_started", provider: "codex", turnId: "turn-1" });
    expect(turns).toHaveLength(1);
    expect(observation.turnPending!()).toBe(true);
    host.emit("idle", { type: "turn_completed", provider: "codex" });
    expect(await observation.next()).toMatchObject({ status: "idle", turnObserved: true });
    expect(observation.turnPending!()).toBe(false);
  } finally {
    await observation.close();
  }
});

test.each(["running", "initializing"] as const)(
  "a %s snapshot is a turn, whatever event carries it",
  async (status) => {
    const { host, observation, turns } = await scenario();
    try {
      host.emit(status);
      expect(turns).toHaveLength(1);
      expect(observation.turnPending!()).toBe(true);
    } finally {
      await observation.close();
    }
  },
);

test("terminals queue in order and each says whether a turn preceded it", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", { type: "turn_started", provider: "codex", turnId: "turn-1" });
    host.emit("idle", { type: "turn_completed", provider: "codex" }, "first");
    host.emit("idle", { type: "turn_completed", provider: "codex" }, "repeat");
    host.emit("running", { type: "turn_started", provider: "codex", turnId: "turn-2" });
    host.emit("idle", { type: "turn_completed", provider: "codex" }, "second");
    const results = [await observation.next(), await observation.next(), await observation.next()];
    expect(results.map((result) => [result.lastMessage, result.turnObserved])).toEqual([
      ["first", true],
      ["repeat", false],
      ["second", true],
    ]);
  } finally {
    await observation.close();
  }
});

test("a turn observed after the last returned terminal stays pending until its own terminal returns", async () => {
  const { host, observation } = await scenario();
  try {
    host.emit("running", { type: "turn_started", provider: "codex", turnId: "turn-1" });
    host.emit("idle", { type: "turn_completed", provider: "codex" }, "first");
    host.emit("running", { type: "turn_started", provider: "codex", turnId: "turn-2" });
    await observation.next();
    expect(observation.turnPending!()).toBe(true);
    host.emit("idle", { type: "turn_completed", provider: "codex" }, "second");
    await observation.next();
    expect(observation.turnPending!()).toBe(false);
  } finally {
    await observation.close();
  }
});
