// SLP-PATCH(question-answer-required) — owned by the SLP fork.
import { describe, expect, test } from "vitest";

import {
  isUndeliverableQuestionAnswer,
  questionAnswerRequiredMessage,
} from "./question-permission.slp.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";

/** Shaped like what `providers/claude/agent.ts` emits for AskUserQuestion. */
const question = {
  id: "p1",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: {
    questions: [
      {
        question: "Which colour should the banner use?",
        header: "Colour",
        options: [{ label: "Viridian" }, { label: "Ochre" }],
      },
    ],
  },
} as unknown as AgentPermissionRequest;

const toolRequest = {
  id: "p2",
  provider: "claude",
  kind: "tool",
} as unknown as AgentPermissionRequest;

const codexQuestion = {
  ...question,
  id: "p3",
  provider: "codex",
} as unknown as AgentPermissionRequest;

describe("question permissions require a usable answers map", () => {
  test("rejects the shape the incident used", () => {
    // `selectedActionId` validates as a string and is read only for `plan`
    // kinds, so this resolved as allow and the agent was told the user
    // declined.
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        selectedActionId: "Full sweep including my worktree",
      }),
    ).toBe(true);
  });

  test("rejects an updatedInput without answers", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { choice: "Viridian" },
      }),
    ).toBe(true);
  });

  test("rejects an empty answers map", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: {} },
      }),
    ).toBe(true);
  });

  test("rejects an answers array, which is an object but not a map", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: ["Viridian"] },
      }),
    ).toBe(true);
  });

  test("rejects a key that matches no question", () => {
    // Non-empty and well shaped, so the old check passed it; Claude's
    // normalizer keeps nothing and the answer is discarded.
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { Colours: "Viridian" } },
      }),
    ).toBe(true);
  });

  test("rejects an empty answer for a real question", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { Colour: "   " } },
      }),
    ).toBe(true);
  });

  test("rejects a non-string answer for a real question", () => {
    // `readNonEmptyString` drops it; the request would be consumed for nothing.
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { Colour: 1 } },
      }),
    ).toBe(true);
  });

  test("accepts an answer keyed by header", () => {
    // Measured on a live seat: keyed by header or by the full question text.
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { Colour: "Viridian" } },
      }),
    ).toBe(false);
  });

  test("accepts an answer keyed by the full question text", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { "Which colour should the banner use?": "Ochre" } },
      }),
    ).toBe(false);
  });

  test("accepts a partial answer, as the normalizer does", () => {
    const twoQuestions = {
      ...question,
      input: {
        questions: [
          ...(question.input!.questions as unknown[]),
          { question: "Ship it?", header: "Ship" },
        ],
      },
    } as unknown as AgentPermissionRequest;
    expect(
      isUndeliverableQuestionAnswer(twoQuestions, {
        behavior: "allow",
        updatedInput: { answers: { Colour: "Viridian" } },
      }),
    ).toBe(false);
  });

  test("reads questions the caller echoed back, as the normalizer prefers them", () => {
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: {
          questions: [{ question: "Ship it?", header: "Ship" }],
          answers: { Ship: "Yes" },
        },
      }),
    ).toBe(false);
  });

  test("leaves a request whose questions cannot be read to the provider", () => {
    // Not provably a discard: without a questions list there is no key to
    // check against, and blocking here would invent a rule.
    const opaque = { ...question, input: {} } as unknown as AgentPermissionRequest;
    expect(
      isUndeliverableQuestionAnswer(opaque, {
        behavior: "allow",
        updatedInput: { answers: { Colour: "Viridian" } },
      }),
    ).toBe(false);
  });

  test("leaves Codex questions alone: an unmapped answer selects the first option", () => {
    // `mapCodexQuestionResponseByHeader` returns null and the provider falls
    // back to each question's first option. That is a supported path, not a
    // discard, so rejecting it would break a working caller.
    expect(
      isUndeliverableQuestionAnswer(codexQuestion, {
        behavior: "allow",
        selectedActionId: "Viridian",
      }),
    ).toBe(false);
  });

  test("leaves deny alone, which needs no answers", () => {
    expect(isUndeliverableQuestionAnswer(question, { behavior: "deny" })).toBe(false);
  });

  test("leaves non-question requests alone", () => {
    expect(isUndeliverableQuestionAnswer(toolRequest, { behavior: "allow" })).toBe(false);
  });

  test("leaves an unknown request alone rather than masking the real error", () => {
    // A missing request id is already reported by the session with its own
    // message; this check must not shadow it.
    expect(isUndeliverableQuestionAnswer(undefined, { behavior: "allow" })).toBe(false);
  });

  test("the message names the shape, the real keys, and says the request survives", () => {
    const message = questionAnswerRequiredMessage(question);
    expect(message).toContain("updatedInput.answers");
    expect(message).toContain("Which colour should the banner use?");
    expect(message).toContain("Colour");
    expect(message).toContain("still pending");
  });
});
