// SLP-PATCH(question-answer-required): owned by the SLP fork, not upstream.
//
// A `question` permission answered in any shape but `updatedInput.answers`
// resolves as `allow` and delivers nothing, and the waiting agent is told
// "The user did not answer the questions." — an affirmative falsehood rather
// than silence, so neither side sees the failure. `selectedActionId` is
// `z.string().optional()` with no membership check and is read only for `plan`
// kinds, while a question advertises `actions: undefined`: the field most
// natural to reach for is the one that cannot work.
//
// Keeping the rule here rather than inline keeps the upstream-owned call site
// to one line and makes the logic testable without an AgentManager.
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

/** The message a caller sees instead of a silently discarded answer. */
export function questionAnswerRequiredMessage(requestId: string): string {
  return (
    `Permission request '${requestId}' is a question: allow requires ` +
    `updatedInput.answers keyed by each question's text or header, ` +
    `e.g. {"answers":{"<question or header>":"<answer>"}}. ` +
    `selectedActionId is ignored for question requests. ` +
    `The request is still pending; answer it again with that shape.`
  );
}

/**
 * True when this response would be accepted and then deliver nothing.
 *
 * Only `allow` on a `question` request is checked. `deny` needs no answers, and
 * `tool` / `plan` / `mode` requests carry their decision elsewhere.
 */
export function isUndeliverableQuestionAnswer(
  request: AgentPermissionRequest | undefined,
  response: AgentPermissionResponse,
): boolean {
  if (request?.kind !== "question") return false;
  if (response.behavior !== "allow") return false;
  const answers = response.updatedInput?.answers;
  return !(
    typeof answers === "object" &&
    answers !== null &&
    !Array.isArray(answers) &&
    Object.keys(answers).length > 0
  );
}
