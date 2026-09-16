import { randomUUID } from "node:crypto";

import { getAgentStreamEventTurnId, type AgentStreamEvent } from "./agent-sdk-types.js";

export interface ForegroundTurnWaiter {
  turnId: string;
  callback: (event: AgentStreamEvent) => void;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

// SLP-PATCH(wakeup-defers): a caller that must know whether the run it just
// admitted actually started needs an acknowledgement keyed to *that* run, not to
// the agent — an agent-keyed wait accepts a later run started by someone else.
// This promise always resolves and never rejects, so a run nobody awaits can
// never surface as an unhandledRejection.
export type AgentRunStartSettlement =
  | { status: "started" }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

/** The slice of a tracked run a dispatcher needs to acknowledge its own start. */
export interface AgentRunStartHandle {
  readonly startSettled: Promise<AgentRunStartSettlement>;
}

export interface PendingForegroundRun {
  token: string;
  kind: "foreground";
  stagedEvents: AgentStreamEvent[];
  start:
    | { status: "pending" }
    | { status: "started"; turnId: string }
    | { status: "failed"; error: string };
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
  // SLP-PATCH(wakeup-defers): start acknowledgement, settled exactly once by the
  // registry from the same transitions that write `start` and clear the run.
  startSettled: Promise<AgentRunStartSettlement>;
  startSettlementDone: boolean;
  resolveStartSettled: (settlement: AgentRunStartSettlement) => void;
}

export interface AutonomousAgentRun {
  token: string;
  kind: "autonomous";
  turnId: string | null;
  started: true;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
}

export type TrackedAgentRun = PendingForegroundRun | AutonomousAgentRun;

export interface ForegroundRunAgentState {
  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;
  finalizedForegroundTurnIds: Set<string>;
}

export class AgentRunState {
  private readonly runs = new Map<string, TrackedAgentRun>();
  // SLP-PATCH(wakeup-defers): a reservation is NOT a run. It is a claim on the
  // agent's admission slot held while a guarded session reload swaps the
  // provider session out from under an agent that was observed idle. `hasRun`,
  // `hasInFlightRun` and the cancel path deliberately cannot see it, so the
  // reload can never mistake its own reservation for a run and nothing ever
  // tries to cancel one.
  private readonly reservations = new Set<string>();

  reserve(agentId: string): void {
    this.reservations.add(agentId);
  }

  release(agentId: string): void {
    this.reservations.delete(agentId);
  }

  isReserved(agentId: string): boolean {
    return this.reservations.has(agentId);
  }

  createPendingRun(agentId: string): PendingForegroundRun {
    const pendingRun = createPendingForegroundRun();
    this.runs.set(agentId, pendingRun);
    return pendingRun;
  }

  getPendingRun(agentId: string): PendingForegroundRun | null {
    const run = this.runs.get(agentId);
    return run?.kind === "foreground" ? run : null;
  }

  hasPendingRun(agentId: string): boolean {
    return this.getPendingRun(agentId) !== null;
  }

  getRun(agentId: string): TrackedAgentRun | null {
    return this.runs.get(agentId) ?? null;
  }

  hasRun(agentId: string): boolean {
    return this.runs.has(agentId);
  }

  getTurnId(agentId: string): string | null {
    const run = this.runs.get(agentId);
    if (!run) return null;
    if (run.kind === "autonomous") return run.turnId;
    return run.start.status === "started" ? run.start.turnId : null;
  }

  // SLP-PATCH(wakeup-defers): `start` transitions go through the registry so the
  // start acknowledgement cannot drift from the field it acknowledges.
  markRunStarted(run: PendingForegroundRun, turnId: string): void {
    run.start = { status: "started", turnId };
    settleRunStart(run, { status: "started" });
  }

  markRunStartFailed(run: PendingForegroundRun, error: string): void {
    run.start = { status: "failed", error };
    settleRunStart(run, { status: "failed", error });
  }

  trackAutonomousRun(agentId: string, turnId: string | null): TrackedAgentRun {
    const current = this.runs.get(agentId);
    if (current) {
      return current;
    }

    const run: AutonomousAgentRun = {
      ...createTrackedRunState(),
      kind: "autonomous",
      turnId,
      started: true,
    };
    this.runs.set(agentId, run);
    return run;
  }

  settleTerminalRun(agentId: string, turnId: string | undefined): void {
    const run = this.runs.get(agentId);
    if (!run) {
      return;
    }
    if (
      run.kind === "foreground" &&
      (run.start.status !== "started" || run.start.turnId !== turnId)
    ) {
      return;
    }
    if (
      run.kind === "autonomous" &&
      run.turnId !== null &&
      turnId !== undefined &&
      run.turnId !== turnId
    ) {
      return;
    }

    this.clearRun(agentId, run);
  }

  settleForegroundRun(agentId: string, token: string): void {
    const run = this.runs.get(agentId);
    if (run?.kind !== "foreground" || run.token !== token) {
      return;
    }

    this.clearRun(agentId, run);
  }

  clearAgentRun(agentId: string): void {
    const run = this.runs.get(agentId);
    if (run) {
      this.clearRun(agentId, run);
    }
  }

  createTurnStream(turnId: string): ForegroundTurnStream {
    return new ForegroundTurnStream(turnId);
  }

  addWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.add(waiter);
  }

  deleteWaiter(agent: ForegroundRunAgentState, waiter: ForegroundTurnWaiter): void {
    agent.foregroundTurnWaiters.delete(waiter);
    this.settleWaiter(waiter);
  }

  settleWaiter(waiter: ForegroundTurnWaiter): void {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    waiter.resolveSettled();
  }

  getMatchingWaiters(
    agent: ForegroundRunAgentState,
    turnId: string | undefined,
  ): ForegroundTurnWaiter[] {
    if (turnId == null) {
      return [];
    }

    return Array.from(agent.foregroundTurnWaiters).filter(
      (waiter) => waiter.turnId === turnId && !waiter.settled,
    );
  }

  notifyWaiters(
    waiters: Iterable<ForegroundTurnWaiter>,
    event: AgentStreamEvent,
    options: { terminal: boolean },
  ): void {
    for (const waiter of waiters) {
      waiter.callback(event);
      if (options.terminal) {
        this.settleWaiter(waiter);
      }
    }
  }

  notifyAgentWaiters(
    agent: ForegroundRunAgentState,
    event: AgentStreamEvent,
    options?: { terminal?: boolean },
  ): void {
    const waiters = this.getMatchingWaiters(agent, getAgentStreamEventTurnId(event));
    this.notifyWaiters(waiters, event, { terminal: options?.terminal ?? false });
  }

  cancelWaiters(
    agent: ForegroundRunAgentState,
    createEvent: (turnId: string) => AgentStreamEvent,
  ): void {
    for (const waiter of agent.foregroundTurnWaiters) {
      waiter.callback(createEvent(waiter.turnId));
      this.settleWaiter(waiter);
    }
    agent.foregroundTurnWaiters.clear();
  }

  rememberFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): void {
    agent.finalizedForegroundTurnIds.add(turnId);
    if (agent.finalizedForegroundTurnIds.size <= 50) {
      return;
    }

    const oldest = agent.finalizedForegroundTurnIds.values().next().value;
    if (oldest) {
      agent.finalizedForegroundTurnIds.delete(oldest);
    }
  }

  hasFinalizedTurn(agent: ForegroundRunAgentState, turnId: string): boolean {
    return agent.finalizedForegroundTurnIds.has(turnId);
  }

  private clearRun(agentId: string, run: TrackedAgentRun): void {
    this.runs.delete(agentId);
    // SLP-PATCH(wakeup-defers): every way a pending run can be retired before it
    // started — replacement, a direct cancel, a close, the registry clearing it —
    // lands here, so "cancelled" is the single catch-all. `settleRunStart` is
    // idempotent, so a run that already started or failed keeps that answer.
    if (run.kind === "foreground") {
      settleRunStart(run, { status: "cancelled" });
    }
    settleTrackedRun(run);
  }
}

export class ForegroundTurnStream {
  private readonly queue: AgentStreamEvent[] = [];
  private queueResolve: (() => void) | null = null;

  readonly waiter: ForegroundTurnWaiter;

  constructor(turnId: string) {
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolvePromise) => {
      resolveSettled = resolvePromise;
    });

    this.waiter = {
      turnId,
      settled: false,
      settledPromise,
      resolveSettled,
      callback: (event) => {
        this.queue.push(event);
        this.wake();
      },
    };
  }

  async *events(
    isTerminalEvent: (event: AgentStreamEvent) => boolean,
  ): AsyncGenerator<AgentStreamEvent> {
    let done = false;
    while (!done) {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        yield event;
        if (isTerminalEvent(event)) {
          done = true;
          break;
        }
      }

      if (!done && this.queue.length === 0) {
        if (this.waiter.settled) {
          break;
        }
        await new Promise<void>((resolvePromise) => {
          this.queueResolve = resolvePromise;
        });
      }
    }
  }

  private wake(): void {
    if (!this.queueResolve) {
      return;
    }

    this.queueResolve();
    this.queueResolve = null;
  }
}

function createPendingForegroundRun(): PendingForegroundRun {
  // SLP-PATCH(wakeup-defers): every pending run gets a start acknowledgement,
  // ordinary `streamAgent` starts included.
  let resolveStartSettled!: (settlement: AgentRunStartSettlement) => void;
  const startSettled = new Promise<AgentRunStartSettlement>((resolve) => {
    resolveStartSettled = resolve;
  });
  return {
    ...createTrackedRunState(),
    kind: "foreground",
    start: { status: "pending" },
    stagedEvents: [],
    startSettled,
    startSettlementDone: false,
    resolveStartSettled,
  };
}

// SLP-PATCH(wakeup-defers)
function settleRunStart(run: PendingForegroundRun, settlement: AgentRunStartSettlement): void {
  if (run.startSettlementDone) {
    return;
  }
  run.startSettlementDone = true;
  run.resolveStartSettled(settlement);
}

function createTrackedRunState(): {
  token: string;
  settled: boolean;
  settledPromise: Promise<void>;
  resolveSettled: () => void;
} {
  let resolveSettled!: () => void;
  const settledPromise = new Promise<void>((resolvePromise) => {
    resolveSettled = resolvePromise;
  });
  return {
    token: randomUUID(),
    settled: false,
    settledPromise,
    resolveSettled,
  };
}

function settleTrackedRun(run: TrackedAgentRun): void {
  if (run.settled) {
    return;
  }

  run.settled = true;
  run.resolveSettled();
}
