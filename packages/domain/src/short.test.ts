import { describe, expect, it } from "vitest";
import {
  ALLOWED_REGEX_FLAGS,
  applyTextOptions,
  compileFullMatch,
  describeMatcher,
  foldCase,
  hasLlmMatcher,
  InvalidMatcherPattern,
  isValidPattern,
  MAX_INPUT_LENGTH,
  MAX_PATTERN_LENGTH,
  matchDate,
  matchExact,
  matchNumber,
  matchRegex,
  matchShort,
  matchShortAnswer,
  matchTime,
  normalizeInput,
  parseDateInput,
  parseNumericInput,
  parseTimeInput,
  withinTolerance,
  type ShortMatcher,
} from "./short.js";

describe("normalisation", () => {
  it("folds CRLF, exotic spaces and composed characters", () => {
    expect(normalizeInput("a\r\nb")).toBe("a\nb");
    expect(normalizeInput("a\r b")).toBe("a\n b");
    expect(normalizeInput("a b")).toBe("a b");
    expect(normalizeInput("é")).toBe("é");
  });

  it("trims and collapses by default, and obeys an explicit false", () => {
    expect(applyTextOptions("  a   b  ")).toBe("a b");
    expect(applyTextOptions("  a   b  ", { trim: false })).toBe(" a b ");
    expect(applyTextOptions("  a   b  ", { collapseSpaces: false })).toBe("a   b");
  });

  it("folds case in French and keeps the accents (D9)", () => {
    expect(foldCase("GALILÉE")).toBe("galilée");
    expect(foldCase("galilée")).not.toBe("galilee");
  });
});

describe("exact matcher", () => {
  it("is case-insensitive by default but accent-sensitive", () => {
    expect(matchExact("newton", "Newton")).toBe(true);
    expect(matchExact("Galilee", "Galilée")).toBe(false);
    expect(matchExact("newton", "Newton", { caseSensitive: true })).toBe(false);
  });

  it("collapses whitespace unless told otherwise", () => {
    expect(matchExact("#include   <stdio.h>", "#include <stdio.h>")).toBe(true);
    expect(matchExact("#include   <stdio.h>", "#include <stdio.h>", { collapseSpaces: false })).toBe(false);
    expect(matchExact(" a ", "a", { trim: false })).toBe(false);
  });
});

describe("regex matcher (D10)", () => {
  it("anchors as a full match", () => {
    expect(matchRegex("abc", "b")).toBe(false);
    expect(matchRegex("abc", "a.c")).toBe(true);
  });

  it("rejects a pattern over 300 characters and forbidden flags", () => {
    const long = "a".repeat(MAX_PATTERN_LENGTH + 1);
    expect(() => compileFullMatch(long)).toThrow(InvalidMatcherPattern);
    expect(() => compileFullMatch("a", "g")).toThrow(/flags must match/);
    expect(ALLOWED_REGEX_FLAGS.test("imsu")).toBe(true);
    expect(isValidPattern(long)).toBe(false);
  });

  it("reports an uncompilable pattern at publication time and never matches at grading time", () => {
    expect(() => compileFullMatch("([a-")).toThrow(InvalidMatcherPattern);
    expect(isValidPattern("([a-")).toBe(false);
    expect(isValidPattern("^[0-9a-f]+$", "i")).toBe(true);
    expect(matchRegex("abc", "([a-")).toBe(false);
  });

  it("truncates the input to 500 characters before testing", () => {
    expect(matchRegex("a".repeat(MAX_INPUT_LENGTH), "a+")).toBe(true);
    expect(matchRegex(`${"a".repeat(MAX_INPUT_LENGTH)}b`, "a+b")).toBe(false);
  });
});

describe("number matcher", () => {
  it("accepts the French decimal comma and thousand separators", () => {
    expect(parseNumericInput("3,14")).toBe(3.14);
    expect(parseNumericInput("1 000")).toBe(1000);
    expect(parseNumericInput("1'000")).toBe(1000);
    expect(parseNumericInput("1’000")).toBe(1000);
  });

  it("strips the unit, and requires it when asked", () => {
    expect(parseNumericInput("4 octets", { unit: "octets" })).toBe(4);
    expect(parseNumericInput("4OCTETS", { unit: "octets" })).toBe(4);
    expect(parseNumericInput("4", { unit: "octets" })).toBe(4);
    expect(parseNumericInput("4", { unit: "octets", unitRequired: true })).toBeNull();
    expect(parseNumericInput("4 m", { unit: "" })).toBeNull();
  });

  it("returns null on anything that is not a number", () => {
    expect(parseNumericInput("")).toBeNull();
    expect(parseNumericInput("   ")).toBeNull();
    expect(parseNumericInput("quatre")).toBeNull();
    expect(parseNumericInput("Infinity")).toBeNull();
  });

  it("applies an absolute or relative tolerance", () => {
    expect(matchNumber("4", { value: 4 })).toBe(true);
    expect(matchNumber("4.1", { value: 4 })).toBe(false);
    expect(matchNumber("4.1", { value: 4, tolerance: 0.1 })).toBe(true);
    expect(matchNumber("3.14", { value: 3.1415, tolerance: 0.01, toleranceMode: "rel" })).toBe(true);
    expect(matchNumber("3", { value: 3.1415, tolerance: 0.01, toleranceMode: "rel" })).toBe(false);
    expect(matchNumber("x", { value: 4 })).toBe(false);
    expect(withinTolerance(0, 0, 0, "rel")).toBe(true);
  });
});

describe("date and time matchers", () => {
  it("normalises the three accepted date formats", () => {
    expect(parseDateInput("2026-09-20")).toBe("2026-09-20");
    expect(parseDateInput("20.09.2026")).toBe("2026-09-20");
    expect(parseDateInput("20/09/2026")).toBe("2026-09-20");
    expect(parseDateInput("2 6 . 0 9 . 2 0 2 6")).toBe("2026-09-26");
  });

  it("refuses an impossible or unreadable date", () => {
    expect(parseDateInput("2026-02-30")).toBeNull();
    expect(parseDateInput("32.01.2026")).toBeNull();
    expect(parseDateInput("hier")).toBeNull();
    expect(matchDate("hier", "2026-09-20")).toBe(false);
    expect(matchDate("2026-09-20", "hier")).toBe(false);
  });

  it("compares dates within a tolerance in days", () => {
    expect(matchDate("20.09.2026", "2026-09-20")).toBe(true);
    expect(matchDate("21.09.2026", "2026-09-20")).toBe(false);
    expect(matchDate("21.09.2026", "2026-09-20", 1)).toBe(true);
  });

  it("normalises the three accepted time formats", () => {
    expect(parseTimeInput("14:30")).toBe("14:30");
    expect(parseTimeInput("14h30")).toBe("14:30");
    expect(parseTimeInput("14 h 30")).toBe("14:30");
    expect(parseTimeInput("9h5")).toBe("09:05");
    expect(parseTimeInput("24:00")).toBeNull();
    expect(parseTimeInput("12:60")).toBeNull();
    expect(parseTimeInput("midi")).toBeNull();
  });

  it("compares times within a tolerance in minutes", () => {
    expect(matchTime("14h30", "14:30")).toBe(true);
    expect(matchTime("14h35", "14:30")).toBe(false);
    expect(matchTime("14h35", "14:30", 5)).toBe(true);
    expect(matchTime("midi", "14:30")).toBe(false);
    expect(matchTime("14:30", "midi")).toBe(false);
  });
});

describe("matchShortAnswer", () => {
  const matchers: ShortMatcher[] = [
    { kind: "exact", value: "#include <stdio.h>" },
    { kind: "regex", pattern: "#\\s*include\\s*[<\"]stdio\\.h[>\"]", flags: "i" },
    { kind: "exact", value: "include <stdio.h>", points: 0.5 },
  ];

  it("takes the first match, in order", () => {
    expect(matchShortAnswer("#include <stdio.h>", matchers)).toMatchObject({
      matchedIndex: 0,
      matchedKind: "exact",
      fraction: 1,
    });
    expect(matchShortAnswer("#include<stdio.h>", matchers)).toMatchObject({
      matchedIndex: 1,
      matchedKind: "regex",
      fraction: 1,
    });
    expect(matchShortAnswer("include <stdio.h>", matchers)).toMatchObject({
      matchedIndex: 2,
      fraction: 0.5,
    });
  });

  it("scores an absent or empty answer 0 without running a matcher", () => {
    expect(matchShortAnswer(null, matchers)).toEqual({
      matchedIndex: null,
      matchedKind: null,
      normalized: "",
      fraction: 0,
    });
    expect(matchShortAnswer("   ", matchers).fraction).toBe(0);
  });

  it("scores 0 when nothing matches", () => {
    expect(matchShortAnswer("import stdio", matchers)).toMatchObject({ matchedIndex: null, fraction: 0 });
  });
});

describe("matcher dispatch and rendering", () => {
  const all: ShortMatcher[] = [
    { kind: "exact", value: "a" },
    { kind: "regex", pattern: "a" },
    { kind: "number", value: 4, unit: "octets" },
    { kind: "number", value: 4, tolerance: 1 },
    { kind: "number", value: 3.14, tolerance: 0.01, toleranceMode: "rel" },
    { kind: "date", value: "2026-09-20" },
    { kind: "time", value: "14:30" },
    { kind: "llm", rubric: "explain" },
  ];

  it("dispatches every kind, and an llm matcher never matches in the MVP", () => {
    expect(all.map((m) => matchShort("a", m))).toEqual([true, true, false, false, false, false, false, false]);
    expect(matchShort("4 octets", all[2]!)).toBe(true);
    expect(matchShort("2026-09-20", all[5]!)).toBe(true);
    expect(matchShort("14h30", all[6]!)).toBe(true);
    expect(hasLlmMatcher(all)).toBe(true);
    expect(hasLlmMatcher(all.slice(0, 2))).toBe(false);
  });

  it("renders a matcher for the solution panel", () => {
    expect(all.map(describeMatcher)).toEqual([
      "a",
      "/a/i",
      "4 octets",
      "4 ± 1",
      "3.14 ± 1 %",
      "2026-09-20",
      "14:30",
      "explain",
    ]);
  });
});
