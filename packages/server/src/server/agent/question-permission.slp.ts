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
// `normalizeClaudeAskUserQuestionUpdatedInput` (`providers/claude/agent.ts`)
// keeps an answer only when its key is a question's full text or its header
// **and** its value is a non-empty string; when nothing matches it returns the
// merged input with the caller's answers map intact but unnormalized, and
// Claude's own AskUserQuestion tool then reads no answer. Codex is deliberately
// different: `mapCodexQuestionResponseByHeader` reads headers only, and an
// unmapped response **falls back to the first option** of each question
// (`providers/codex-app-server-agent.ts`), which is a supported path this check
// must not reject. OpenCode reads headers only as well. So only Claude question
// requests are guarded here.
//
// This mirrors Claude's rule down to the bytes, which is load-bearing twice
// over: `readNonEmptyString` tests `value.trim()` for emptiness but returns the
// **original** string, so a question whose text carries surrounding whitespace
// is keyed by that whitespace; and the question list is taken from the response
// when it supplies one at all — including an empty array, which Claude prefers
// over the stored list and which therefore maps nothing.
//
// Keeping the rule here rather than inline keeps the upstream-owned call site
// to one line and makes the logic testable without an AgentManager.
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Claude's `readNonEmptyString`, byte for byte: emptiness is tested on the
 * trimmed value, but the **original** string is what it returns and therefore
 * what it keys by. Trimming here would both accept keys Claude cannot map and
 * reject keys Claude accepts.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The question list Claude will normalize against, or null when neither side
 * supplies one.
 *
 * `normalizeClaudeAskUserQuestionUpdatedInput` reads `updatedInput.questions`
 * first and falls back to the stored request input, and it tests each for
 * `Array.isArray`. An empty array is therefore a list, not an absence: it wins
 * over the stored questions and maps nothing.
 */
function effectiveQuestions(
  request: AgentPermissionRequest,
  response: Extract<AgentPermissionResponse, { behavior: "allow" }>,
): unknown[] | null {
  const echoed = response.updatedInput?.questions;
  if (Array.isArray(echoed)) return echoed;
  const stored = request.input?.questions;
  if (Array.isArray(stored)) return stored;
  return null;
}

/** Every key Claude would accept for these questions, in the order it asks them. */
function acceptedAnswerKeys(questions: readonly unknown[]): string[] {
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
function requiredShapeMessage(requestId: string, acceptedKeys: readonly string[]): string {
  const example = acceptedKeys[0] ?? "<question text or header>";
  const accepted =
    acceptedKeys.length > 0
      ? ` Accepted keys: ${acceptedKeys.map((key) => JSON.stringify(key)).join(", ")}.`
      : "";
  return (
    `Permission request '${requestId}' is a Claude question: allow requires ` +
    `updatedInput.answers keyed by a question's full text or its header, with a ` +
    `non-empty string value, e.g. {"answers":{${JSON.stringify(example)}:"<answer>"}}.` +
    `${accepted} ` +
    `selectedActionId is ignored for question requests. ` +
    `The request is still pending; answer it again with that shape.`
  );
}

/**
 * The caller-facing rejection for a response that would be accepted and then
 * deliver nothing, or null when the response is fine to pass on.
 *
 * Scoped to `allow` on a Claude `question` request. `deny` needs no answers;
 * `tool` / `plan` / `mode` requests carry their decision elsewhere; and other
 * providers apply their own mapping, including Codex's deliberate first-option
 * fallback, which is not a discard.
 *
 * Conservative at exactly one point: when neither the response nor the request
 * carries a question list there is nothing to key against, so the response goes
 * to the provider rather than being blocked on a rule this module cannot prove.
 * A list that is present but yields no usable key — empty, or entries Claude
 * would skip — is a provable discard and is rejected.
 */
export function undeliverableQuestionAnswerMessage(
  request: AgentPermissionRequest | undefined,
  response: AgentPermissionResponse,
): string | null {
  if (request?.kind !== "question") return null;
  if (request.provider !== "claude") return null;
  if (response.behavior !== "allow") return null;

  const questions = effectiveQuestions(request, response);
  if (questions === null) {
    // Unreadable: only the original defect's shape is provable here.
    const answers = response.updatedInput?.answers;
    return isRecord(answers) && Object.keys(answers).length > 0
      ? null
      : requiredShapeMessage(request.id, []);
  }

  const keys = acceptedAnswerKeys(questions);
  const answers = response.updatedInput?.answers;
  if (isRecord(answers) && keys.some((key) => nonEmptyString(answers[key]) !== null)) {
    return null;
  }
  return requiredShapeMessage(request.id, keys);
}
