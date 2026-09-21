import type {
  AgentLoadPlan,
  AgentLoadRequest,
  ManagedAgent,
  PendingAgentLoad,
} from "../agent/agent-manager.js";

/**
 * The plan/publish half of `AgentManager` for fake managers that only need the
 * loader to run. It keeps the real protocol — one starter per agent id, joiners
 * adopt its promise — but none of the lease or lifecycle-lane machinery, which a
 * fake with no runtime has nothing to say about. Use the real `AgentManager` for
 * anything that tests ownership.
 */
export function createFakeAgentLoadPlanner(getResident: (agentId: string) => ManagedAgent | null) {
  const pendings = new Map<
    string,
    {
      pending: PendingAgentLoad;
      resolve: (agent: ManagedAgent) => void;
      reject: (error: unknown) => void;
    }
  >();

  return {
    planAgentLoad: async (request: AgentLoadRequest): Promise<AgentLoadPlan> => {
      const joined = pendings.get(request.agentId);
      if (joined) {
        joined.pending.options.broadcastTimeline ||= request.broadcastTimeline;
        return { kind: "adopt", pending: joined.pending, lease: null };
      }
      const resident = getResident(request.agentId);
      if (resident) {
        return { kind: "resident", agent: resident, lease: null };
      }
      let resolve!: (agent: ManagedAgent) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ManagedAgent>((settle, fail) => {
        resolve = settle;
        reject = fail;
      });
      // The starter reports through `publishAgentLoad`, so nothing necessarily
      // awaits this promise before it settles.
      void promise.catch(() => undefined);
      const pending: PendingAgentLoad = {
        agentId: request.agentId,
        purpose: request.purpose,
        promise,
        options: { broadcastTimeline: request.broadcastTimeline },
      };
      pendings.set(request.agentId, { pending, resolve, reject });
      return { kind: "start", pending, lease: null };
    },
    publishAgentLoad: async (
      pending: PendingAgentLoad,
      outcome: { ok: true; agent: ManagedAgent } | { ok: false; error: unknown },
    ): Promise<void> => {
      const entry = pendings.get(pending.agentId);
      if (entry?.pending !== pending) {
        return;
      }
      pendings.delete(pending.agentId);
      if (outcome.ok) {
        entry.resolve(outcome.agent);
      } else {
        entry.reject(outcome.error);
      }
    },
    abandonAgentLoad: async (): Promise<void> => {},
  };
}
