// AIROOM-PATCH(wakeup-each): the creator mark. Two labels name the agent that created this one
// through `create_agent`, and its host when that is not the child's own. The create path writes
// them once; `AgentManager` drops them from every later label patch, so no send, detach, reparent
// or label edit moves them. A finish subscription reads them to decide whether its watch re-arms.

export const CREATOR_AGENT_ID_LABEL = "airoom.creator-agent-id";
export const CREATOR_SERVER_ID_LABEL = "airoom.creator-server-id";

export interface CreatorAddress {
  agentId: string;
  serverId: string;
}

/**
 * The labels a create writes: `labels` with the mark naming `creator`, or with no mark when
 * there is no creator. A mark the request itself carried is replaced, never kept.
 */
export function withCreatorMark(
  labels: Record<string, string>,
  creator: { agentId: string; serverId?: string } | null,
): Record<string, string> {
  const { [CREATOR_AGENT_ID_LABEL]: _agent, [CREATOR_SERVER_ID_LABEL]: _server, ...rest } = labels;
  if (!creator) return rest;
  return {
    ...rest,
    [CREATOR_AGENT_ID_LABEL]: creator.agentId,
    ...(creator.serverId ? { [CREATOR_SERVER_ID_LABEL]: creator.serverId } : {}),
  };
}

/** A label patch with the mark's keys removed, so applying it leaves the mark as it was. */
export function withoutCreatorMark<Value>(patch: Record<string, Value>): Record<string, Value> {
  const { [CREATOR_AGENT_ID_LABEL]: _agent, [CREATOR_SERVER_ID_LABEL]: _server, ...rest } = patch;
  return rest;
}

/** The creator the mark names. An absent server label means the child's own host, `serverId`. */
export function getCreatorAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): CreatorAddress | null {
  const agentId = labels?.[CREATOR_AGENT_ID_LABEL];
  if (typeof agentId !== "string" || !agentId) return null;
  const creatorServerId = labels?.[CREATOR_SERVER_ID_LABEL];
  return {
    agentId,
    serverId: typeof creatorServerId === "string" && creatorServerId ? creatorServerId : serverId,
  };
}
