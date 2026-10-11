/**
 * The type-specific half of the leak test (docs/05 §5.7, N-SEC-04). The
 * generic half — the full fixture of `./testing.ts` searched for every
 * forbidden key and secret value — is the registry's contract test, run
 * here too on the fixture and on the plotted variants.
 */
import { findStudentLeaks } from "@quiz/core/testing";
import { describe, expect, it } from "vitest";

import { mathServer } from "./server.js";
import { config, mathLeakFixture, SECRET_CONFIG } from "./test/fixtures.js";

const view = { seed: 7, itemId: "i", shuffle: true };

describe("toStudent", () => {
  it("keeps exactly what the player needs: the names and the field's rules", () => {
    const student = mathServer.toStudent(SECRET_CONFIG, view);
    expect(student).toEqual({
      prompt: SECRET_CONFIG.prompt,
      symbols: ["R_1", "R_2"],
      forbidden: ["sin"],
      maxLength: 120,
      plot: "none",
    });
    expect(findStudentLeaks(student, mathLeakFixture)).toEqual([]);
  });

  it("does not depend on the seed: there is nothing to shuffle", () => {
    expect(mathServer.toStudent(SECRET_CONFIG, { ...view, seed: 1 })).toEqual(mathServer.toStudent(SECRET_CONFIG, { ...view, seed: 2 }));
  });

  it("with a plot, adds the window of the one symbol and nothing of the key", () => {
    const student = mathServer.toStudent(config({ plot: "answer" }), view);
    expect(student.axis).toEqual({ from: -3, to: 3 });
    expect(student.target).toBeUndefined();
    expect(findStudentLeaks(student, { forbiddenKeys: mathLeakFixture.forbiddenKeys, secrets: ["2x^2-3"] })).toEqual([]);
  });

  it("with the target, adds the first key's curve as values — never its text", () => {
    const student = mathServer.toStudent(config({ plot: "target", answers: [{ value: "2x^2-3", points: 1 }, { value: "x", points: 0.37 }] }), view);
    expect(student.target).toHaveLength(64);
    expect(student.target?.[0]).toBe(15);
    expect(findStudentLeaks(student, { forbiddenKeys: mathLeakFixture.forbiddenKeys, secrets: ["2x^2-3", "0.37"] })).toEqual([]);
    expect(mathServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("leaves the target out when the key does not read, rather than failing the view", () => {
    const student = mathServer.toStudent(config({ plot: "target", answers: [{ value: "x+y", points: 1 }] }), view);
    expect(student.axis).toBeDefined();
    expect(student.target).toBeUndefined();
  });
});

describe("the solution", () => {
  it("is the accepted answers with their points, the same for the teacher and a student shown the key", () => {
    const solution = mathServer.toSolution(SECRET_CONFIG, view);
    expect(solution).toEqual({
      answers: [
        { value: "\\frac{R_1 R_2}{R_1+R_2}", points: 1 },
        { value: "R_1+R_2", points: 0.25 },
      ],
    });
    expect(mathServer.studentSolution).toBeUndefined();
  });

  it("drops which key matched while the key is hidden; the reason and the echo stay", () => {
    const details = { status: "graded" as const, matchedIndex: 1, fraction: 0.25, latex: "x" };
    expect(mathServer.studentDetails!(details, { showKey: false, showHiddenCaseNames: false })).toEqual({ status: "graded", fraction: 0.25, latex: "x" });
    expect(mathServer.studentDetails!(details, { showKey: true, showHiddenCaseNames: false })).toEqual(details);
  });
});
