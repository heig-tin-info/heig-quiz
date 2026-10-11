import { testGradeContext } from "@quiz/core/testing";
import { describe, expect, it } from "vitest";

import { gradeMath, gradingPoints } from "./grade.js";
import { mathPublicationIssues, mathServer } from "./server.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";

const grade = (latex: string | null, over = {}) => gradeMath(config(over), latex === null ? null : { latex }, 2);

describe("gradeMath", () => {
  it("accepts the key and every equivalent form, whatever the spelling", () => {
    for (const latex of ["2x^2-3", "-3+2x^{2}", "2\\cdot x\\cdot x-3", "\\frac{4x^2-6}{2}", "2(x^2-1.5)"]) {
      const result = grade(latex);
      expect(result.points, latex).toBe(2);
      expect(result.details).toEqual({ status: "graded", matchedIndex: 0, fraction: 1, latex: expect.any(String) });
    }
  });

  it("refuses a different function", () => {
    expect(grade("2x^2-2")).toMatchObject({ points: 0, details: { status: "graded", matchedIndex: null, fraction: 0, latex: "2x^2-2" } });
  });

  it("gives an unreadable answer 0 with the reason, whole", () => {
    expect(grade("2x^2-").details).toEqual({ status: "invalid", problem: { code: "syntax" }, matchedIndex: null, fraction: 0, latex: null });
    expect(grade("2y^2-3").details.problem).toEqual({ code: "unknown_symbol", names: ["y"] });
    expect(grade("x".repeat(30), { maxLength: 20 }).details.problem).toEqual({ code: "too_long", max: 20 });
    expect(grade("x!").details.problem).toEqual({ code: "unsupported", names: ["Factorial"] });
  });

  it("grades a blank or absent answer 0 as no answer, not as unreadable", () => {
    expect(grade("")).toMatchObject({ points: 0, details: { status: "graded", matchedIndex: null, fraction: 0, latex: null } });
    expect(grade(null)).toMatchObject({ points: 0, maxPoints: 2, details: { status: "graded" } });
    expect(grade("  ").details.problem).toBeUndefined();
  });

  it("applies the field's function rule, which the student was shown", () => {
    expect(grade("2\\sin(x)^2+2\\cos(x)^2+2x^2-5", { forbidden: ["sin"] }).details.problem).toEqual({ code: "forbidden_function", names: ["sin"] });
    expect(grade("2\\sin(x)^2+2\\cos(x)^2+2x^2-5").points).toBe(2);
  });

  it("takes the first accepted answer that matches, with its points", () => {
    const over = { answers: [{ value: "2x^2-3", points: 1 }, { value: "2x^2", points: 0.5 }] };
    expect(grade("2x^2", over)).toMatchObject({ points: 1, details: { matchedIndex: 1, fraction: 0.5 } });
    expect(grade("2x^2-3", over)).toMatchObject({ points: 2, details: { matchedIndex: 0, fraction: 1 } });
  });

  it("loosens with the tolerance", () => {
    expect(grade("2.0001x^2-3").points).toBe(0);
    expect(grade("2.0001x^2-3", { tolerance: 0.001 }).points).toBe(2);
  });

  it("draws the same points for the same question, and other points for another key", () => {
    expect(gradingPoints(config())).toEqual(gradingPoints(config()));
    expect(gradingPoints(config())).not.toEqual(gradingPoints(config({ answers: [{ value: "x", points: 1 }] })));
    expect(gradingPoints(config())).toHaveLength(10);
  });

  it("grades through the server contract", () => {
    const result = mathServer.grade(SECRET_CONFIG, { latex: "\\frac{1}{\\frac{1}{R_1}+\\frac{1}{R_2}}" }, testGradeContext(4));
    expect(result).toMatchObject({ kind: "graded", points: 4, maxPoints: 4, state: "validated" });
    const series = mathServer.grade(SECRET_CONFIG, { latex: "R_1+R_2" }, testGradeContext(4));
    expect(series).toMatchObject({ points: 1, details: { matchedIndex: 1, fraction: 0.25 } });
  });

  it("never lets an answer hold the thread: a huge power is no value, read in milliseconds", () => {
    const start = performance.now();
    expect(grade("2x^2-3+10^{10^{6}}").points).toBe(0);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("publication", () => {
  it("names a key that does not read, by its problem", () => {
    expect(mathPublicationIssues(config({ answers: [{ value: "2x^2-3", points: 1 }, { value: "x+y", points: 1 }, { value: "x^{2", points: 1 }] }))).toEqual([
      { path: ["answers", 1, "value"], message: "math.key_unknown_symbol" },
      { path: ["answers", 2, "value"], message: "math.key_syntax" },
    ]);
    expect(mathPublicationIssues(config({ answers: [{ value: "\\sum_{n=0}^{9}x", points: 1 }] }))).toEqual([
      { path: ["answers", 0, "value"], message: "math.key_unsupported" },
    ]);
  });

  it("refuses a first key with no value anywhere on the domain", () => {
    expect(mathPublicationIssues(config({ symbols: [{ name: "x", min: -5, max: -1 }], answers: [{ value: "\\sqrt{x}", points: 1 }] }))).toEqual([
      { path: ["answers", 0, "value"], message: "math.key_undefined" },
    ]);
    expect(mathPublicationIssues(config({ symbols: [{ name: "x", min: 1, max: 5 }], answers: [{ value: "\\sqrt{x}", points: 1 }] }))).toEqual([]);
  });

  it("passes a sound question", () => {
    expect(mathPublicationIssues(SECRET_CONFIG)).toEqual([]);
  });
});

describe("the rest of the server contract", () => {
  it("summarises and aggregates by the text typed", () => {
    expect(mathServer.summarizeAnswer!(SECRET_CONFIG, { latex: " R_1 +\nR_2 " })).toBe("R_1 + R_2");
    const aggregate = mathServer.aggregate!({ answers: [{ latex: "x" }, { latex: "x " }, { latex: "y" }, "junk", null], details: [] });
    expect(aggregate.distribution?.map((e) => [e.key, e.count])).toEqual([
      ["x", 2],
      ["y", 1],
    ]);
  });

  it("indexes the prompt and the keys, migrates its own version only", () => {
    expect(mathServer.searchText(SECRET_CONFIG)).toContain("R_1+R_2");
    expect(mathServer.migrate(SECRET_CONFIG, 1)).toBe(SECRET_CONFIG);
    expect(() => mathServer.migrate(SECRET_CONFIG, 2)).toThrow();
    expect(mathServer.defaultPoints(SECRET_CONFIG)).toBe(1);
    expect(mathServer.shuffleable(SECRET_CONFIG)).toBe(false);
    expect(mathServer.hasKey!(SECRET_CONFIG)).toBe(true);
    expect(mathServer.isAnswered({ latex: " " })).toBe(false);
    expect(mathServer.isAnswered({ latex: "x" })).toBe(true);
  });
});
