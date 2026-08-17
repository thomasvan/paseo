// SLP-PATCH(question-answer-required) — owned by the SLP fork.
import { describe, expect, test } from "vitest";

import {
  isUndeliverableQuestionAnswer,
  questionAnswerRequiredMessage,
} from "./question-permission.slp.js";
import type { AgentPermissionRequest } from "./agent-sdk-types.js";

const question = { id: "p1", kind: "question" } as AgentPermissionRequest;
const toolRequest = { id: "p2", kind: "tool" } as AgentPermissionRequest;

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

  test("accepts the shape that reaches the agent", () => {
    // Measured on a live seat: keyed by header or by the full question text.
    expect(
      isUndeliverableQuestionAnswer(question, {
        behavior: "allow",
        updatedInput: { answers: { Colour: "Viridian" } },
      }),
    ).toBe(false);
  });

  test("leaves deny alone, which needs no answers", () => {
    expect(isUndeliverableQuestionAnswer(question, { behavior: "deny" })).toBe(false);
  });

  test("leaves non-question requests alone", () => {
    expect(
      isUndeliverableQuestionAnswer(toolRequest, { behavior: "allow" }),
    ).toBe(false);
  });

  test("leaves an unknown request alone rather than masking the real error", () => {
    // A missing request id is already reported by the session with its own
    // message; this check must not shadow it.
    expect(isUndeliverableQuestionAnswer(undefined, { behavior: "allow" })).toBe(false);
  });

  test("the message names the shape and says the request survives", () => {
    const message = questionAnswerRequiredMessage("p1");
    expect(message).toContain("updatedInput.answers");
    expect(message).toContain("still pending");
  });
});
