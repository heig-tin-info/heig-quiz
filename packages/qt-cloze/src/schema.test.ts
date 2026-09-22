import { parseCloze } from "@quiz/domain/cloze";
import { describe, expect, it } from "vitest";
import {
  CLOZE_CONFIG_VERSION,
  ClozeAnswerSchema,
  ClozeConfigSchema,
  emptyClozeDraft,
} from "./schema.js";

function base(text: string): Record<string, unknown> {
  return { configVersion: CLOZE_CONFIG_VERSION, text };
}

describe("ClozeConfigSchema", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["a plain text blank", base("La loi de {{Newton}}.")],
    ["alternatives", base("{{Newton|Isaac Newton}}")],
    ["a dropdown", base("{{=newton|joule|watt}}")],
    ["a number with an absolute tolerance", base("{{#3.14:0.01}}")],
    ["a number with a relative tolerance", base("{{#3.14:1%}}")],
    ["a regex", base("{{/^[0-9a-f]+$/i}}")],
    ["a weight", base("{{2*Newton}}")],
    ["a blank inside a fenced code block", base("```c\nint x = {{42}};\n```")],
    ["an escaped brace beside a real blank", base("\\{{ is a literal, {{Newton}} is not")],
    ["case sensitivity turned on", { ...base("{{Newton}}"), caseSensitive: true }],
    ["shuffling turned off", { ...base("{{=a|b}}"), shuffleOptions: false }],
    [
      "a dropdown inside a table cell: the `|` never reaches the table parser",
      base("| a | b |\n| --- | --- |\n| x | {{=oui|non}} |"),
    ],
    [
      "a stored config still carrying `choiceSets`: zod strips the key",
      { ...base("{{Newton}}"), choiceSets: [{ key: "1", options: [] }] },
    ],
  ];

  for (const [name, input] of accepted) {
    it(`accepts ${name}`, () => {
      expect(ClozeConfigSchema.safeParse(input).success).toBe(true);
    });
  }

  const rejected: [string, Record<string, unknown>][] = [
    ["a text with no blank at all", base("Just a sentence.")],
    ["only an escaped brace", base("\\{{ Newton }}")],
    ["an empty text", base("")],
    ["an unterminated blank", base("La loi de {{Newton")],
    ["an empty blank", base("La loi de {{}}.")],
    ["a blank whose regex cannot compile", base("{{/a(/}}")],
    ["a regex flag outside imsu", base("{{/a/g}}")],
    ["a malformed number blank", base("{{#3,14:x}}")],
    ["fifty-one blanks", base("{{a}}".repeat(51))],
    ["a future configVersion", { ...base("{{a}}"), configVersion: 3 }],
    ["the v1 configVersion, which `migrate` deals with first", { ...base("{{a}}"), configVersion: 1 }],
    ["a missing configVersion", { text: "{{a}}" }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(ClozeConfigSchema.safeParse(input).success).toBe(false);
    });
  }

  it("reports the parser's own i18n key, on the text", () => {
    const result = ClozeConfigSchema.safeParse(base("La loi de {{Newton"));
    expect(result.error?.issues[0]?.path).toEqual(["text"]);
    expect(result.error?.issues[0]?.message).toBe("cloze.unterminated");
  });

  it("applies the documented defaults", () => {
    const config = ClozeConfigSchema.parse(base("{{Newton}}"));
    expect(config.caseSensitive).toBe(false);
    expect(config.shuffleOptions).toBe(true);
  });

  /*
   * The predefined choice sets are GONE (they were never shipped). A stored
   * draft that still holds the key keeps its text and loses the list, and
   * `{{1}}` goes back to being the text blank it is spelled as.
   */
  it("strips a leftover `choiceSets`, and reads `{{1}}` as a text blank again", () => {
    const config = ClozeConfigSchema.parse({
      ...base("{{1}}"),
      choiceSets: [{ key: "1", options: [{ label: "free", correct: true }] }],
    });
    expect(config).not.toHaveProperty("choiceSets");
    expect(parseCloze(config.text).blanks[0]).toMatchObject({ kind: "text", answers: ["1"] });
  });
});

describe("ClozeAnswerSchema", () => {
  it("accepts untouched blanks and refuses an oversized one", () => {
    expect(ClozeAnswerSchema.safeParse({ blanks: [null, "a"] }).success).toBe(true);
    expect(ClozeAnswerSchema.safeParse({ blanks: ["x".repeat(201)] }).success).toBe(false);
  });
});

describe("emptyClozeDraft", () => {
  it("is empty, and therefore does NOT validate (D16)", () => {
    const draft = emptyClozeDraft();
    expect(draft.text).toBe("");
    expect(parseCloze(draft.text).blanks).toHaveLength(0);
    // No blank: the schema refuses it, and the draft is stored anyway.
    expect(ClozeConfigSchema.safeParse(draft).success).toBe(false);
  });
});
