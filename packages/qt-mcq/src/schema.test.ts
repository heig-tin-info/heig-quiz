import { describe, expect, it } from "vitest";
import {
  correctIndices,
  emptyMcqDraft,
  MCQ_CONFIG_VERSION,
  McqAnswerSchema,
  McqConfigSchema,
  McqDefaultsSchema,
  type McqConfig,
} from "./schema.js";

/** A valid config, with the field under test overridden by each row. */
function base(): Record<string, unknown> {
  return {
    configVersion: MCQ_CONFIG_VERSION,
    prompt: "Which one?",
    choices: [
      { text: "a", correct: true },
      { text: "b", correct: false },
    ],
  };
}

const twoKeys = [
  { text: "a", correct: true },
  { text: "b", correct: true },
];

describe("McqConfigSchema", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["the minimum: two choices and one key", base()],
    ...(["all_or_nothing", "true_false", "discordance", "symmetric", "ripkey", "inherit"] as const).map(
      (policy): [string, Record<string, unknown>] => [
        `a multiple scored ${policy}`,
        { ...base(), mode: "multiple", policy },
      ],
    ),
    // The `mcq.single_policy` refinement is gone: a `single` question is all
    // or nothing at GRADING time, whatever the stored policy says.
    ["a policy other than all_or_nothing in single mode", { ...base(), policy: "ripkey" }],
    ["several keys in multiple mode", { ...base(), mode: "multiple", choices: twoKeys }],
    ["an explicit maxSelections", { ...base(), mode: "multiple", maxSelections: 2 }],
    [
      "a maxSelections equal to the key size",
      { ...base(), mode: "multiple", choices: twoKeys, maxSelections: 2 },
    ],
    ["shuffling turned off", { ...base(), shuffleChoices: false }],
    ["twelve choices", { ...base(), choices: Array.from({ length: 12 }, (_, i) => ({ text: `c${i}`, correct: i === 0 })) }],
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
    ["two keys in single mode", { ...base(), choices: twoKeys }],
    ["an unknown policy", { ...base(), mode: "multiple", policy: "curve" }],
    ["a v1 policy the migration should have rewritten", { ...base(), mode: "multiple", policy: "partial" }],
    ["the dropped penalty field is no longer a policy", { ...base(), mode: "multiple", policy: "penalized" }],
    ["an empty prompt", { ...base(), prompt: "" }],
    ["an empty choice text", { ...base(), choices: [
      { text: "", correct: true },
      { text: "b", correct: false },
    ] }],
    ["a missing configVersion", { prompt: "x", choices: base().choices }],
    ["a v1 configVersion", { ...base(), configVersion: 1 }],
    ["a future configVersion", { ...base(), configVersion: MCQ_CONFIG_VERSION + 1 }],
    ["maxSelections of 0", { ...base(), mode: "multiple", maxSelections: 0 }],
    [
      "maxSelections below the number of correct choices",
      { ...base(), mode: "multiple", choices: twoKeys, maxSelections: 1 },
    ],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(McqConfigSchema.safeParse(input).success).toBe(false);
    });
  }

  it("applies the documented defaults", () => {
    const config: McqConfig = McqConfigSchema.parse(base());
    expect(config.mode).toBe("single");
    expect(config.policy).toBe("inherit");
    expect(config.shuffleChoices).toBe(true);
    expect(config.maxSelections).toBeUndefined();
  });

  it("no longer carries a penalty or a negative floor", () => {
    const config = McqConfigSchema.parse({ ...base(), penalty: 0.5, allowNegative: true });
    expect(config).not.toHaveProperty("penalty");
    expect(config).not.toHaveProperty("allowNegative");
  });

  it("reports the failing refinement by its i18n key", () => {
    const noKey = McqConfigSchema.safeParse({
      ...base(),
      choices: [
        { text: "a", correct: false },
        { text: "b", correct: false },
      ],
    });
    expect(noKey.error?.issues.map((i) => i.message)).toContain("mcq.no_correct_choice");

    const capped = McqConfigSchema.safeParse({
      ...base(),
      mode: "multiple",
      choices: twoKeys,
      maxSelections: 1,
    });
    const issue = capped.error?.issues.find((i) => i.message === "mcq.max_below_correct");
    expect(issue?.path).toEqual(["maxSelections"]);
  });
});

describe("McqDefaultsSchema", () => {
  it("reads the evaluation's policy out of GradeContext.defaults", () => {
    expect(McqDefaultsSchema.parse({ policy: "discordance" })).toEqual({ policy: "discordance" });
  });

  it("refuses anything that is not one of the five", () => {
    expect(McqDefaultsSchema.safeParse({ policy: "inherit" }).success).toBe(false);
    expect(McqDefaultsSchema.safeParse({ policy: "partial" }).success).toBe(false);
    expect(McqDefaultsSchema.safeParse({}).success).toBe(false);
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
    expect(draft.configVersion).toBe(MCQ_CONFIG_VERSION);
    expect(draft.mode).toBe("single");
    expect(draft.policy).toBe("inherit");
    expect(correctIndices(draft)).toEqual([0]);
  });
});
