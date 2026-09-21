import { describe, expect, it } from "vitest";
import {
  correctIndices,
  emptyMcqDraft,
  McqAnswerSchema,
  McqConfigSchema,
  type McqConfig,
} from "./schema.js";

/** A valid config, with the field under test overridden by each row. */
function base(): Record<string, unknown> {
  return {
    configVersion: 1,
    prompt: "Which one?",
    choices: [
      { text: "a", correct: true },
      { text: "b", correct: false },
    ],
  };
}

describe("McqConfigSchema", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["the minimum: two choices and one key", base()],
    ["a partial multiple", { ...base(), mode: "multiple", policy: "partial" }],
    [
      "a penalized multiple with a negative floor",
      { ...base(), mode: "multiple", policy: "penalized", penalty: 0.5, allowNegative: true },
    ],
    ["several keys in multiple mode", { ...base(), mode: "multiple", choices: [
      { text: "a", correct: true },
      { text: "b", correct: true },
    ] }],
    ["an explicit maxSelections", { ...base(), mode: "multiple", maxSelections: 2 }],
    ["shuffling turned off", { ...base(), shuffleChoices: false }],
    ["twelve choices", { ...base(), choices: Array.from({ length: 12 }, (_, i) => ({ text: `c${i}`, correct: i === 0 })) }],
    ["a penalty of exactly 0", { ...base(), mode: "multiple", policy: "penalized", penalty: 0 }],
  ];

  for (const [name, input] of accepted) {
    it(`accepts ${name}`, () => {
      expect(McqConfigSchema.safeParse(input).success).toBe(true);
    });
  }

  const rejected: [string, Record<string, unknown>][] = [
    ["a single choice", { ...base(), choices: [{ text: "a", correct: true }] }],
    ["thirteen choices", { ...base(), choices: Array.from({ length: 13 }, (_, i) => ({ text: `c${i}`, correct: i === 0 })) }],
    ["no correct choice", { ...base(), choices: [
      { text: "a", correct: false },
      { text: "b", correct: false },
    ] }],
    ["two keys in single mode", { ...base(), choices: [
      { text: "a", correct: true },
      { text: "b", correct: true },
    ] }],
    ["a policy other than all_or_nothing in single mode", { ...base(), policy: "partial" }],
    ["an empty prompt", { ...base(), prompt: "" }],
    ["an empty choice text", { ...base(), choices: [
      { text: "", correct: true },
      { text: "b", correct: false },
    ] }],
    ["a penalty above 1", { ...base(), mode: "multiple", policy: "penalized", penalty: 1.5 }],
    ["an unknown policy", { ...base(), mode: "multiple", policy: "curve" }],
    ["a missing configVersion", { prompt: "x", choices: base().choices }],
    ["a future configVersion", { ...base(), configVersion: 2 }],
    ["maxSelections of 0", { ...base(), mode: "multiple", maxSelections: 0 }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(McqConfigSchema.safeParse(input).success).toBe(false);
    });
  }

  it("applies the documented defaults", () => {
    const config: McqConfig = McqConfigSchema.parse(base());
    expect(config.mode).toBe("single");
    expect(config.policy).toBe("all_or_nothing");
    expect(config.penalty).toBe(1);
    expect(config.allowNegative).toBe(false);
    expect(config.shuffleChoices).toBe(true);
    expect(config.maxSelections).toBeUndefined();
  });

  it("reports the failing refinement by its i18n key", () => {
    const result = McqConfigSchema.safeParse({
      ...base(),
      choices: [
        { text: "a", correct: false },
        { text: "b", correct: false },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message)).toContain("mcq.no_correct_choice");
  });
});

describe("McqAnswerSchema", () => {
  it("accepts an empty selection and a full one", () => {
    expect(McqAnswerSchema.safeParse({ selected: [] }).success).toBe(true);
    expect(McqAnswerSchema.safeParse({ selected: [0, 11] }).success).toBe(true);
  });

  it("rejects a negative, a fractional and an out-of-range index", () => {
    expect(McqAnswerSchema.safeParse({ selected: [-1] }).success).toBe(false);
    expect(McqAnswerSchema.safeParse({ selected: [1.5] }).success).toBe(false);
    expect(McqAnswerSchema.safeParse({ selected: [12] }).success).toBe(false);
  });
});

describe("emptyMcqDraft", () => {
  it("is empty, and therefore does NOT validate (D16)", () => {
    const draft = emptyMcqDraft();
    expect(draft.prompt).toBe("");
    expect(draft.choices.map((c) => c.text)).toEqual(["", ""]);
    expect(McqConfigSchema.safeParse(draft).success).toBe(false);
  });

  it("still carries the shape and the defaults the editor binds to", () => {
    const draft = emptyMcqDraft();
    expect(draft.configVersion).toBe(1);
    expect(draft.mode).toBe("single");
    expect(draft.policy).toBe("all_or_nothing");
    expect(correctIndices(draft)).toEqual([0]);
  });
});
