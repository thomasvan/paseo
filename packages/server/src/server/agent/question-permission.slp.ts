// SLP-PATCH(question-answer-required): owned by the SLP fork, not upstream.
//
// A Claude `question` permission answered in any shape but `updatedInput.answers`
// keyed by a question resolves as `allow` and delivers nothing, and the waiting
// agent is told "The user did not answer the questions." — an affirmative
// falsehood rather than silence, so neither side sees the failure.
// `selectedActionId` is `z.string().optional()` with no membership check and is
// read only for `plan` kinds, while a question advertises `actions: undefined`:
// the field most natural to reach for is the one that cannot work.
//
// The rule is provider-specific, so this check is too. Claude's
// `normalizeClaudeAskUserQuestionUpdatedInput`
// (`providers/claude/agent.ts`) keeps an answer only when its key is a
// question's full text or its header **and** its value is a non-empty string;
// when nothing matches it returns the merged input with the caller's answers
// map intact but unnormalized, and Claude's own AskUserQuestion tool then reads
// no answer. Codex is deliberately different: `mapCodexQuestionResponseByHeader`
// reads headers only, and an unmapped response **falls back to the first option**
// of each question (`providers/codex-app-server-agent.ts`), which is a
// supported path this check must not reject. OpenCode reads headers only as
// well. So only Claude question requests are guarded here, and only when the
// discard can be proven from the request's own questions.
//
// Keeping the rule here rather than inline keeps the upstream-owned call site
// to one line and makes the logic testable without an AgentManager.
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Every key Claude would accept for this request, in the order it asks them. */
function acceptedAnswerKeys(request: AgentPermissionRequest): string[] {
  const questions = request.input?.questions;
  if (!Array.isArray(questions)) return [];
  const keys: string[] = [];
  for (const item of questions) {
    if (!isRecord(item)) continue;
    const text = nonEmptyString(item.question);
    if (!text) continue; // Claude skips a question with no text; so do we.
    keys.push(text);
    const header = nonEmptyString(item.header);
    if (header) keys.push(header);
  }
  return keys;
}

/** The message a caller sees instead of a silently discarded answer. */
export function questionAnswerRequiredMessage(request: AgentPermissionRequest): string {
  const keys = acceptedAnswerKeys(request);
  const example = keys[0] ?? "<question text or header>";
  const accepted =
    keys.length > 0 ? ` Accepted keys: ${keys.map((key) => JSON.stringify(key)).join(", ")}.` : "";
  return (
    `Permission request '${request.id}' is a Claude question: allow requires ` +
    `updatedInput.answers keyed by a question's full text or its header, with a ` +
    `non-empty string value, e.g. {"answers":{${JSON.stringify(example)}:"<answer>"}}.` +
    `${accepted} ` +
    `selectedActionId is ignored for question requests. ` +
    `The request is still pending; answer it again with that shape.`
  );
}

/**
 * True when this response would be accepted and then deliver nothing.
 *
 * Scoped to `allow` on a Claude `question` request. `deny` needs no answers;
 * `tool` / `plan` / `mode` requests carry their decision elsewhere; and other
 * providers apply their own mapping, including Codex's deliberate first-option
 * fallback, which is not a discard.
 *
 * Conservative by construction: it reports true only when the discard is
 * provable — no usable answers map, or a questions list none of whose keys the
 * map answers. A request whose questions cannot be read is left to the provider.
 */
export function isUndeliverableQuestionAnswer(
  request: AgentPermissionRequest | undefined,
  response: AgentPermissionResponse,
): boolean {
  if (request?.kind !== "question") return false;
  if (request.provider !== "claude") return false;
  if (response.behavior !== "allow") return false;

  const answers = response.updatedInput?.answers;
  if (!isRecord(answers) || Object.keys(answers).length === 0) return true;

  // `normalizeClaudeAskUserQuestionUpdatedInput` prefers the questions the
  // caller echoed back and falls back to the ones the request carries.
  const echoed = response.updatedInput?.questions;
  const keys = acceptedAnswerKeys(
    Array.isArray(echoed)
      ? { ...request, input: { ...request.input, questions: echoed } }
      : request,
  );
  if (keys.length === 0) return false; // unreadable: not provably a discard

  return !keys.some((key) => nonEmptyString(answers[key]) !== null);
}
