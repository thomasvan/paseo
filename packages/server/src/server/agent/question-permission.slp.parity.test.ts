// SLP-PATCH(question-answer-required) — owned by the SLP fork.
//
// The guard is a mirror of `normalizeClaudeAskUserQuestionUpdatedInput`, and a
// mirror drifts silently: two rounds of review found the guard trimming a key
// the normalizer does not trim, and treating an empty question list as an
// absent one. Unit tests state the rule as understood, which is exactly the
// thing that was wrong. This runs both against the same inputs and requires
// them to agree, so the next divergence fails here rather than in a seat.
import { describe, expect, test } from "vitest";

import { normalizeClaudeAskUserQuestionUpdatedInput } from "./providers/claude/agent.js";
import { undeliverableQuestionAnswerMessage } from "./question-permission.slp.js";
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

const PLAIN = { question: "Which colour should the banner use?", header: "Colour" };
const PADDED = { question: " Which colour? ", header: " Colour " };
const HEADER_ONLY = { header: "NoText" };
const OTHER = { question: "Ship it?", header: "Ship" };

const CASES: Array<{ label: string; questions: unknown[]; updatedInput: Record<string, unknown> }> =
  [
    { label: "keyed by header", questions: [PLAIN], updatedInput: { answers: { Colour: "V" } } },
    {
      label: "keyed by full text",
      questions: [PLAIN],
      updatedInput: { answers: { "Which colour should the banner use?": "V" } },
    },
    {
      label: "key matches nothing",
      questions: [PLAIN],
      updatedInput: { answers: { Colours: "V" } },
    },
    { label: "blank value", questions: [PLAIN], updatedInput: { answers: { Colour: "  " } } },
    { label: "non-string value", questions: [PLAIN], updatedInput: { answers: { Colour: 1 } } },
    { label: "no answers map", questions: [PLAIN], updatedInput: { choice: "V" } },
    { label: "empty answers map", questions: [PLAIN], updatedInput: { answers: {} } },
    // `readNonEmptyString` returns the original string, so padding is part of
    // the key. Both directions are load-bearing.
    {
      label: "padded question, trimmed key",
      questions: [PADDED],
      updatedInput: { answers: { "Which colour?": "V" } },
    },
    {
      label: "padded question, padded key",
      questions: [PADDED],
      updatedInput: { answers: { " Which colour? ": "V" } },
    },
    {
      label: "padded question, padded header",
      questions: [PADDED],
      updatedInput: { answers: { " Colour ": "V" } },
    },
    {
      label: "padded question, trimmed header",
      questions: [PADDED],
      updatedInput: { answers: { Colour: "V" } },
    },
    {
      label: "question with no text",
      questions: [HEADER_ONLY],
      updatedInput: { answers: { NoText: "V" } },
    },
    // An echoed list wins over the stored one — including an empty one.
    {
      label: "echoed empty list",
      questions: [PLAIN],
      updatedInput: { questions: [], answers: { Colour: "V" } },
    },
    {
      label: "echoed list, matching key",
      questions: [PLAIN],
      updatedInput: { questions: [OTHER], answers: { Ship: "Y" } },
    },
    {
      label: "echoed list, stale key",
      questions: [PLAIN],
      updatedInput: { questions: [OTHER], answers: { Colour: "V" } },
    },
  ];

/**
 * True when the normalizer produced the question-text-keyed form: non-empty,
 * every key one of the effective questions' full texts, every value a non-empty
 * string. When it gives up it returns the merged input untouched, whose keys
 * are whatever the caller sent — and a caller whose keys happen to satisfy this
 * has by definition supplied the deliverable form.
 */
function deliversAnAnswer(
  normalized: Record<string, unknown>,
  effectiveQuestions: unknown[],
): boolean {
  const texts = new Set(
    effectiveQuestions
      .map((item) =>
        typeof item === "object" && item !== null
          ? (item as Record<string, unknown>).question
          : null,
      )
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0),
  );
  const answers = normalized.answers;
  const entries =
    typeof answers === "object" && answers !== null && !Array.isArray(answers)
      ? Object.entries(answers as Record<string, unknown>)
      : [];
  return (
    entries.length > 0 &&
    entries.every(
      ([key, value]) => texts.has(key) && typeof value === "string" && value.trim().length > 0,
    )
  );
}

describe("the guard rejects exactly what the normalizer discards", () => {
  for (const testCase of CASES) {
    test(testCase.label, () => {
      const request = {
        id: "p1",
        provider: "claude",
        name: "AskUserQuestion",
        kind: "question",
        input: { questions: testCase.questions },
      } as unknown as AgentPermissionRequest;
      const response = {
        behavior: "allow",
        updatedInput: testCase.updatedInput,
      } as AgentPermissionResponse;

      const echoed = testCase.updatedInput.questions;
      const effective = Array.isArray(echoed) ? echoed : testCase.questions;
      const normalized = normalizeClaudeAskUserQuestionUpdatedInput(
        testCase.updatedInput as never,
        request.input as never,
      ) as Record<string, unknown>;

      const rejected = undeliverableQuestionAnswerMessage(request, response) !== null;
      // Compared as objects so a failure names the case rather than printing
      // `expected false to be true` fifteen times over.
      expect({ case: testCase.label, rejected }).toEqual({
        case: testCase.label,
        rejected: !deliversAnAnswer(normalized, effective),
      });
    });
  }
});
