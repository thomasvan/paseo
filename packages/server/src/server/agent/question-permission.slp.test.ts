// SLP-PATCH(question-answer-required) — owned by the SLP fork.
import { describe, expect, test } from "vitest";

import { undeliverableQuestionAnswerMessage } from "./question-permission.slp.js";
import type { AgentPermissionRequest, AgentPermissionResponse } from "./agent-sdk-types.js";

/** True when the response would be accepted and then deliver nothing. */
const rejects = (
  request: AgentPermissionRequest | undefined,
  response: AgentPermissionResponse,
): boolean => undeliverableQuestionAnswerMessage(request, response) !== null;

/** Shaped like what `providers/claude/agent.ts` emits for AskUserQuestion. */
const claudeQuestion = (...questions: unknown[]): AgentPermissionRequest =>
  ({
    id: "p1",
    provider: "claude",
    name: "AskUserQuestion",
    kind: "question",
    input: {
      questions: questions.length
        ? questions
        : [
            {
              question: "Which colour should the banner use?",
              header: "Colour",
              options: [{ label: "Viridian" }, { label: "Ochre" }],
            },
          ],
    },
  }) as unknown as AgentPermissionRequest;

const question = claudeQuestion();

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

describe("question permissions require an answer Claude can map", () => {
  test("rejects the shape the incident used", () => {
    // `selectedActionId` validates as a string and is read only for `plan`
    // kinds, so this resolved as allow and the agent was told the user
    // declined.
    expect(
      rejects(question, {
        behavior: "allow",
        selectedActionId: "Full sweep including my worktree",
      }),
    ).toBe(true);
  });

  test("rejects an updatedInput without answers", () => {
    expect(rejects(question, { behavior: "allow", updatedInput: { choice: "Viridian" } })).toBe(
      true,
    );
  });

  test("rejects an empty answers map", () => {
    expect(rejects(question, { behavior: "allow", updatedInput: { answers: {} } })).toBe(true);
  });

  test("rejects an answers array, which is an object but not a map", () => {
    expect(rejects(question, { behavior: "allow", updatedInput: { answers: ["Viridian"] } })).toBe(
      true,
    );
  });

  test("rejects a key that matches no question", () => {
    // Non-empty and well shaped, so a shape-only check passed it; Claude's
    // normalizer keeps nothing and the answer is discarded.
    expect(
      rejects(question, { behavior: "allow", updatedInput: { answers: { Colours: "Viridian" } } }),
    ).toBe(true);
  });

  test("rejects an empty answer for a real question", () => {
    expect(
      rejects(question, { behavior: "allow", updatedInput: { answers: { Colour: "   " } } }),
    ).toBe(true);
  });

  test("rejects a non-string answer for a real question", () => {
    // `readNonEmptyString` drops it; the request would be consumed for nothing.
    expect(rejects(question, { behavior: "allow", updatedInput: { answers: { Colour: 1 } } })).toBe(
      true,
    );
  });

  test("accepts an answer keyed by header", () => {
    // Measured on a live seat: keyed by header or by the full question text.
    expect(
      rejects(question, { behavior: "allow", updatedInput: { answers: { Colour: "Viridian" } } }),
    ).toBe(false);
  });

  test("accepts an answer keyed by the full question text", () => {
    expect(
      rejects(question, {
        behavior: "allow",
        updatedInput: { answers: { "Which colour should the banner use?": "Ochre" } },
      }),
    ).toBe(false);
  });

  test("accepts a partial answer, as the normalizer does", () => {
    expect(
      rejects(claudeQuestion({ question: "Ship it?", header: "Ship" }, { question: "When?" }), {
        behavior: "allow",
        updatedInput: { answers: { Ship: "Yes" } },
      }),
    ).toBe(false);
  });
});

describe("keys are compared by their exact bytes, as Claude compares them", () => {
  // `readNonEmptyString` tests `value.trim()` for emptiness but returns the
  // ORIGINAL string, so a padded question is keyed by its padding. Trimming
  // here would diverge in both directions.
  const padded = claudeQuestion({ question: " Which colour? ", header: " Colour " });

  test("rejects the trimmed key, which Claude cannot map", () => {
    expect(
      rejects(padded, {
        behavior: "allow",
        updatedInput: { answers: { "Which colour?": "Viridian" } },
      }),
    ).toBe(true);
  });

  test("accepts the padded key, which Claude does map", () => {
    expect(
      rejects(padded, {
        behavior: "allow",
        updatedInput: { answers: { " Which colour? ": "Viridian" } },
      }),
    ).toBe(false);
  });

  test("accepts the padded header too", () => {
    expect(
      rejects(padded, { behavior: "allow", updatedInput: { answers: { " Colour ": "Ochre" } } }),
    ).toBe(false);
  });

  test("the message quotes the padding rather than hiding it", () => {
    const message = undeliverableQuestionAnswerMessage(padded, { behavior: "allow" });
    expect(message).toContain('" Which colour? "');
    expect(message).toContain('" Colour "');
  });
});

describe("the question list is taken the way the normalizer takes it", () => {
  test("reads questions the caller echoed back, which the normalizer prefers", () => {
    expect(
      rejects(question, {
        behavior: "allow",
        updatedInput: {
          questions: [{ question: "Ship it?", header: "Ship" }],
          answers: { Ship: "Yes" },
        },
      }),
    ).toBe(false);
  });

  test("an echoed list wins over the stored one, so a stored key no longer maps", () => {
    expect(
      rejects(question, {
        behavior: "allow",
        updatedInput: {
          questions: [{ question: "Ship it?", header: "Ship" }],
          answers: { Colour: "Viridian" },
        },
      }),
    ).toBe(true);
  });

  test("rejects an explicitly empty echoed list, which maps nothing", () => {
    // `Array.isArray([])` is true, so the normalizer prefers it over the stored
    // questions and keeps no answer. An empty list is a list, not an absence.
    expect(
      rejects(question, {
        behavior: "allow",
        updatedInput: { questions: [], answers: { Colour: "Viridian" } },
      }),
    ).toBe(true);
  });

  test("rejects a stored list whose entries carry no question text", () => {
    expect(
      rejects(claudeQuestion({ header: "Colour" }), {
        behavior: "allow",
        updatedInput: { answers: { Colour: "Viridian" } },
      }),
    ).toBe(true);
  });

  test("leaves a request with no question list at all to the provider", () => {
    // Neither side supplies one, so there is no key to check against and
    // blocking here would invent a rule.
    const opaque = { ...question, input: {} } as unknown as AgentPermissionRequest;
    expect(
      rejects(opaque, { behavior: "allow", updatedInput: { answers: { Colour: "Viridian" } } }),
    ).toBe(false);
  });

  test("still rejects the original defect when no question list is readable", () => {
    const opaque = { ...question, input: {} } as unknown as AgentPermissionRequest;
    expect(rejects(opaque, { behavior: "allow", selectedActionId: "Viridian" })).toBe(true);
  });
});

describe("the check stays inside its scope", () => {
  test("leaves Codex questions alone: an unmapped answer selects the first option", () => {
    // `mapCodexQuestionResponseByHeader` returns null and the provider falls
    // back to each question's first option. That is a supported path, not a
    // discard, so rejecting it would break a working caller.
    expect(rejects(codexQuestion, { behavior: "allow", selectedActionId: "Viridian" })).toBe(false);
  });

  test("leaves deny alone, which needs no answers", () => {
    expect(rejects(question, { behavior: "deny" })).toBe(false);
  });

  test("leaves non-question requests alone", () => {
    expect(rejects(toolRequest, { behavior: "allow" })).toBe(false);
  });

  test("leaves an unknown request alone rather than masking the real error", () => {
    // A missing request id is already reported by the session with its own
    // message; this check must not shadow it.
    expect(rejects(undefined, { behavior: "allow" })).toBe(false);
  });

  test("the message names the shape, the real keys, and says the request survives", () => {
    const message = undeliverableQuestionAnswerMessage(question, { behavior: "allow" });
    expect(message).toContain("updatedInput.answers");
    expect(message).toContain("Which colour should the banner use?");
    expect(message).toContain("Colour");
    expect(message).toContain("still pending");
  });

  test("the message lists the effective keys, not the stored ones", () => {
    const message = undeliverableQuestionAnswerMessage(question, {
      behavior: "allow",
      updatedInput: { questions: [{ question: "Ship it?", header: "Ship" }], answers: {} },
    });
    expect(message).toContain("Ship it?");
    expect(message).not.toContain("Which colour should the banner use?");
  });
});
