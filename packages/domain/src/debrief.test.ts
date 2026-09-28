import { describe, expect, it } from "vitest";

import { debrief, outcomeOf, type AttemptTally } from "./debrief.js";

const graded = (points: number, text: string, maxPoints = 1): AttemptTally => ({
  grading: { points, maxPoints },
  aggregate: { distribution: [{ key: text, count: 1 }] },
});
const blank: AttemptTally = { grading: null, aggregate: {} };

describe("outcomeOf (ADR-033)", () => {
  it("is full marks, above zero, or zero and below", () => {
    expect(outcomeOf(2, 2)).toBe("correct");
    expect(outcomeOf(0.5, 2)).toBe("partial");
    expect(outcomeOf(0, 2)).toBe("wrong");
    // Negative marking (ADR-026): a wrong answer, not a category of its own.
    expect(outcomeOf(-1, 2)).toBe("wrong");
    expect(outcomeOf(0, 0)).toBe("wrong");
  });
});

describe("debrief (F-RES-03, ADR-033)", () => {
  it("counts the outcomes and rates the same attempts, a blank at zero", () => {
    const d = debrief([graded(1, "3"), graded(0.5, "3.0"), graded(-0.5, "4"), blank]);
    expect(d.outcomes).toEqual({ correct: 1, partial: 1, wrong: 1, blank: 1 });
    expect(d.successRate).toBe(0.25);
    expect(debrief([]).successRate).toBeNull();
  });

  it("judges a group by its attempts' outcomes, and mixed ones as mixed", () => {
    const d = debrief([
      graded(1, "3"),
      graded(1, "3"),
      graded(0, "3.5"),
      graded(0, "x"),
      graded(1, "x"),
      graded(0.5, "3,0"),
    ]);
    expect(d.distribution.map((e) => [e.key, e.count, e.correct])).toEqual([
      ["3", 2, true],
      ["x", 2, null],
      ["3.5", 1, false],
      ["3,0", 1, null],
    ]);
  });

  it("prefers the type's own verdict, and keeps the label and the part", () => {
    const d = debrief([
      {
        grading: { points: 0.5, maxPoints: 1 },
        aggregate: {
          distribution: [
            { key: "0: main", label: "main", part: 0, correct: true, count: 1 },
            { key: "1: ", label: "", part: 1, correct: false, count: 1 },
          ],
        },
      },
    ]);
    expect(d.distribution).toEqual([
      { key: "0: main", label: "main", count: 1, correct: true, part: 0 },
      { key: "1: ", label: "", count: 1, correct: false, part: 1 },
    ]);
  });

  it("sums the test cases over the attempts, with the label a student reads", () => {
    const run = (ok: boolean): AttemptTally => ({
      grading: { points: ok ? 1 : 0, maxPoints: 1 },
      aggregate: { casePassRate: [{ name: "overflow", label: "#2", passed: ok ? 1 : 0, total: 1 }] },
    });
    expect(debrief([run(true), run(false)]).casePassRate).toEqual([
      { name: "overflow", label: "#2", passed: 1, total: 2 },
    ]);
  });

  it("keeps every group of a many-blank cloze, so each blank's counts add up", () => {
    // 60 students, two blanks: 55 distinct wrong spellings in blank 0, and the
    // right answer typed by the other five — far down any list capped at 50.
    const attempts: AttemptTally[] = Array.from({ length: 60 }, (_, i) => {
      const right = i >= 55;
      const text = right ? "main" : `w${i}`;
      return {
        grading: { points: right ? 1 : 0.5, maxPoints: 1 },
        aggregate: {
          distribution: [
            { key: `0: ${text}`, label: text, part: 0, correct: right, count: 1 },
            { key: "1: int", label: "int", part: 1, correct: true, count: 1 },
          ],
        },
      };
    });
    const d = debrief(attempts);
    const blank0 = d.distribution.filter((e) => e.part === 0);
    expect(blank0).toHaveLength(56);
    expect(blank0.filter((e) => e.correct).reduce((s, e) => s + e.count, 0)).toBe(5);
    expect(d.distribution.find((e) => e.part === 1)).toMatchObject({ count: 60, correct: true });
  });
});
