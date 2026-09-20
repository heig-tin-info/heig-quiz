import { hasLlmMatcher } from "@quiz/domain";
import { describe, expect, it } from "vitest";
import {
  emptyShortDraft,
  ShortAnswerSchema,
  ShortConfigSchema,
  ShortMatcherSchema,
} from "./schema.js";

function base(): Record<string, unknown> {
  return {
    configVersion: 1,
    prompt: "Give the directive.",
    matchers: [{ kind: "exact", value: "#include <stdio.h>" }],
  };
}

describe("ShortConfigSchema", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["one exact matcher", base()],
    ["a regex matcher with allowed flags", { ...base(), matchers: [{ kind: "regex", pattern: "a+", flags: "im" }] }],
    ["a number matcher with a relative tolerance", { ...base(), kind: "number", matchers: [{ kind: "number", value: 3.14, tolerance: 0.01, toleranceMode: "rel" }] }],
    ["a date matcher", { ...base(), kind: "date", matchers: [{ kind: "date", value: "2026-09-20", toleranceDays: 1 }] }],
    ["a time matcher", { ...base(), kind: "time", matchers: [{ kind: "time", value: "14:05" }] }],
    ["an llm matcher (phase 2, stored but never published)", { ...base(), matchers: [{ kind: "llm", rubric: "Explains the tri-state." }] }],
    ["a partial-credit matcher", { ...base(), matchers: [{ kind: "exact", value: "include <stdio.h>", points: 0.5 }] }],
    ["a placeholder", { ...base(), placeholder: "#include …" }],
    ["twenty matchers", { ...base(), matchers: Array.from({ length: 20 }, (_, i) => ({ kind: "exact", value: `v${i}` })) }],
    ["a unit that is required", { ...base(), matchers: [{ kind: "number", value: 4, unit: "octets", unitRequired: true }] }],
  ];

  for (const [name, input] of accepted) {
    it(`accepts ${name}`, () => {
      expect(ShortConfigSchema.safeParse(input).success).toBe(true);
    });
  }

  const rejected: [string, Record<string, unknown>][] = [
    ["no matcher at all", { ...base(), matchers: [] }],
    ["twenty-one matchers", { ...base(), matchers: Array.from({ length: 21 }, (_, i) => ({ kind: "exact", value: `v${i}` })) }],
    ["an unknown matcher kind", { ...base(), matchers: [{ kind: "fuzzy", value: "x" }] }],
    ["a regex that cannot compile (decision D10)", { ...base(), matchers: [{ kind: "regex", pattern: "a(" }] }],
    ["a regex flag outside imsu", { ...base(), matchers: [{ kind: "regex", pattern: "a", flags: "g" }] }],
    ["a pattern longer than 300 characters", { ...base(), matchers: [{ kind: "regex", pattern: "a".repeat(301) }] }],
    ["an empty prompt", { ...base(), prompt: "" }],
    ["a date that is not ISO", { ...base(), matchers: [{ kind: "date", value: "20.09.2026" }] }],
    ["a time that is not hh:mm", { ...base(), matchers: [{ kind: "time", value: "9:05" }] }],
    ["matcher points above 1", { ...base(), matchers: [{ kind: "exact", value: "x", points: 2 }] }],
    ["a negative tolerance", { ...base(), matchers: [{ kind: "number", value: 1, tolerance: -1 }] }],
    ["an unknown answer kind", { ...base(), kind: "colour" }],
    ["a future configVersion", { ...base(), configVersion: 2 }],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(ShortConfigSchema.safeParse(input).success).toBe(false);
    });
  }

  it("reports an uncompilable pattern on the matcher that carries it", () => {
    const result = ShortConfigSchema.safeParse({
      ...base(),
      matchers: [{ kind: "exact", value: "a" }, { kind: "regex", pattern: "a(" }],
    });
    expect(result.error?.issues[0]?.path).toEqual(["matchers", 1, "pattern"]);
    expect(result.error?.issues[0]?.message).toBe("short.invalid_pattern");
  });

  it("applies the documented defaults", () => {
    const config = ShortConfigSchema.parse(base());
    expect(config.kind).toBe("text");
    expect(config.matchers[0]).toMatchObject({
      caseSensitive: false,
      trim: true,
      collapseSpaces: true,
      points: 1,
    });
  });

  it("stores an llm matcher but flags it for the publication guard", () => {
    const config = ShortConfigSchema.parse({
      ...base(),
      matchers: [{ kind: "llm", rubric: "Explains the tri-state." }],
    });
    expect(hasLlmMatcher(config.matchers)).toBe(true);
  });
});

describe("ShortMatcherSchema", () => {
  it("discriminates on kind", () => {
    expect(ShortMatcherSchema.safeParse({ kind: "exact", value: "a" }).success).toBe(true);
    expect(ShortMatcherSchema.safeParse({ kind: "exact", pattern: "a" }).success).toBe(false);
  });
});

describe("ShortAnswerSchema", () => {
  it("accepts an empty answer and refuses an oversized one", () => {
    expect(ShortAnswerSchema.safeParse({ text: "" }).success).toBe(true);
    expect(ShortAnswerSchema.safeParse({ text: "x".repeat(500) }).success).toBe(true);
    expect(ShortAnswerSchema.safeParse({ text: "x".repeat(501) }).success).toBe(false);
  });
});

describe("emptyShortDraft", () => {
  it("validates against the schema it will be stored under", () => {
    expect(ShortConfigSchema.safeParse(emptyShortDraft()).success).toBe(true);
  });
});
