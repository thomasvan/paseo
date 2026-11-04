import type { WaitForFinishResult } from "@getpaseo/client/internal/daemon-client";

export type FinishObservationResult = WaitForFinishResult & {
  reason?: "was canceled" | "host unreachable" | "host removed";
  /** AIROOM-PATCH(wakeup-each): a turn was observed after the previous terminal and before this one. */
  turnObserved?: boolean;
};

/** Coalesces duplicate checkpoints and retains terminal results while delivery is pending. */
export function createObservationBuffer(signal: AbortSignal) {
  const delivered = new Set<string>();
  const permissions = new Map<string, FinishObservationResult>();
  const resolvedBeforeInitial = new Set<string>();
  let initialPending = true;
  // AIROOM-PATCH(wakeup-each): a first-in-first-out queue, not one slot, so a finish that lands
  // while an earlier one awaits acknowledgement is kept. Each entry carries the turn count at
  // its push, which places every observed turn between two terminals.
  const terminals: Array<{ result: FinishObservationResult; turns: number }> = [];
  let terminalSeen = false;
  let turns = 0;
  let pushedTurns = 0;
  let consumedTurns = 0;
  let onTurn: (() => void) | undefined;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const abort = () => {
    failure = signal.reason;
    wake?.();
  };
  signal.addEventListener("abort", abort, { once: true });
  function push(result: FinishObservationResult): void {
    if (result.status === "timeout") return;
    if (result.status === "permission") {
      for (const request of result.final?.pendingPermissions ?? [])
        if (!delivered.has(request.id)) permissions.set(request.id, result);
    } else {
      // AIROOM-PATCH(wakeup-each)
      terminals.push({ result: { ...result, turnObserved: turns > pushedTurns }, turns });
      pushedTurns = turns;
      terminalSeen = true;
    }
    wake?.();
  }
  return {
    pushInitial(result: FinishObservationResult) {
      initialPending = false;
      if (result.status === "permission" && result.final) {
        const pendingPermissions = result.final.pendingPermissions.filter(
          (request) => !resolvedBeforeInitial.has(request.id),
        );
        if (pendingPermissions.length)
          push({ ...result, final: { ...result.final, pendingPermissions } });
      } else if (
        // AIROOM-PATCH(wakeup-each): a baseline after any streamed terminal, consumed or not, repeats it.
        !terminalSeen &&
        result.final?.status !== "running" &&
        result.final?.status !== "initializing"
      )
        push(result);
      resolvedBeforeInitial.clear();
    },
    push,
    /** AIROOM-PATCH(wakeup-each): a new turn was observed. */
    turn() {
      turns++;
      onTurn?.();
    },
    /** AIROOM-PATCH(wakeup-each): a turn was observed after the last terminal `next()` returned. */
    turnPending: () => turns > consumedTurns,
    /** AIROOM-PATCH(wakeup-each): calls `listener` on each turn, and now if one is already pending. */
    onTurn(listener: () => void) {
      onTurn = listener;
      if (turns > consumedTurns) listener();
    },
    resolved(id: string) {
      if (initialPending) resolvedBeforeInitial.add(id);
      delivered.delete(id);
      permissions.delete(id);
    },
    fail(error: unknown) {
      failure = error;
      wake?.();
    },
    async next(): Promise<FinishObservationResult> {
      while (true) {
        signal.throwIfAborted();
        const first = permissions.entries().next().value;
        if (first) {
          for (const request of first[1].final?.pendingPermissions ?? []) {
            delivered.add(request.id);
            permissions.delete(request.id);
          }
          return first[1];
        }
        // AIROOM-PATCH(wakeup-each)
        const terminal = terminals.shift();
        if (terminal) {
          consumedTurns = terminal.turns;
          return terminal.result;
        }
        if (failure) throw failure;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
    dispose() {
      signal.removeEventListener("abort", abort);
    },
  };
}
