/**
 * The contract surface of `mathServer` (docs/spec/04 §4.16, ADR-102). What
 * every type owes — the version stamp, the migration of its own version, the
 * empty draft, the leak test of the full fixture through `toStudent` and the
 * paper documents — is the registry's contract test; `./toStudent.test.ts`
 * holds the student view itself. This file holds the hooks that are the
 * type's own: publication, the live grid, the debrief and the feedback path.
 */
import { findStudentLeaks, testGradeContext } from "@quiz/core/testing";
import { describe, expect, it } from "vitest";

import { mathPublicationIssues, mathServer } from "./server.js";
import { config, mathLeakFixture, SECRET_CONFIG } from "./test/fixtures.js";

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

  it("indexes the prompt and the keys", () => {
    expect(mathServer.searchText(SECRET_CONFIG)).toContain("R_1+R_2");
    expect(mathServer.defaultPoints(SECRET_CONFIG)).toBe(1);
    expect(mathServer.shuffleable(SECRET_CONFIG)).toBe(false);
    expect(mathServer.hasKey!(SECRET_CONFIG)).toBe(true);
    expect(mathServer.isAnswered({ latex: " " })).toBe(false);
    expect(mathServer.isAnswered({ latex: "x" })).toBe(true);
  });
});

/*
 * Invariant 4 on the feedback path (docs/05 §5.7): the details a student
 * reads come through `studentDetails`. Under a hidden key, which accepted
 * answer matched belongs to the key: checked by key, and by searching the
 * serialized output for every value of the key.
 */
describe("the feedback path", () => {
  const forbiddenKeys = [...mathLeakFixture.forbiddenKeys, "matchedIndex"];

  // A partial answer's fraction is the student's own score, which they read anyway: a right and a wrong answer here.
  it("gives a student no key under a hidden key, for a right and a wrong answer", async () => {
    for (const latex of ["\\frac{1}{\\frac{1}{R_1}+\\frac{1}{R_2}}", "R_1 R_2"]) {
      const graded = await mathServer.grade(SECRET_CONFIG, { latex }, testGradeContext(4));
      if (graded.kind !== "graded") throw new Error("expected a graded result");
      const shown = mathServer.studentDetails!(graded.details, { showKey: false, showHiddenCaseNames: false });
      expect(findStudentLeaks(shown, { forbiddenKeys, secrets: mathLeakFixture.secrets }), latex).toEqual([]);
    }
  });

  it("names the matched answer once the key is shown (the positive control)", async () => {
    const graded = await mathServer.grade(SECRET_CONFIG, { latex: "R_2+R_1" }, testGradeContext(4));
    if (graded.kind !== "graded") throw new Error("expected a graded result");
    const shown = mathServer.studentDetails!(graded.details, { showKey: true, showHiddenCaseNames: false });
    expect(findStudentLeaks(shown, { forbiddenKeys })).toEqual(['forbidden key "matchedIndex"']);
  });
});
