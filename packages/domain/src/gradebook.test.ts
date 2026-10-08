import { describe, expect, it } from "vitest";

import {
  ABSENT_GRADE,
  cellGrade,
  classMean,
  countsByDefault,
  gradebookMean,
  hasGrade,
  notTakenCell,
  resolveCell,
  type MeanColumn,
} from "./gradebook.js";

const grade = (g: number, weight = 100, counts = true): MeanColumn => ({ weight, counts, cell: { kind: "grade", grade: g } });

describe("what counts by default (D06)", () => {
  it("counts exams and projects, not exercises", () => {
    expect(countsByDefault("exam")).toBe(true);
    expect(countsByDefault("project")).toBe(true);
    expect(countsByDefault("exercise")).toBe(false);
  });
});

describe("a cell", () => {
  it("reads an absence as 1.0 and an empty cell as no grade", () => {
    expect(cellGrade({ kind: "absent" })).toBe(ABSENT_GRADE);
    expect(cellGrade({ kind: "empty" })).toBeNull();
    expect(hasGrade({ kind: "empty" })).toBe(false);
    expect(hasGrade({ kind: "absent" })).toBe(true);
    expect(cellGrade({ kind: "grade", grade: 4.3 })).toBe(4.3);
  });

  it("is an absence for an exam not taken, empty for an exercise", () => {
    expect(notTakenCell("exam")).toEqual({ kind: "absent" });
    expect(notTakenCell("exercise")).toEqual({ kind: "empty" });
  });

  it("lets a mark win over what lies beneath it, and no mark change nothing", () => {
    const beneath = { kind: "grade", grade: 5.5 } as const;
    expect(resolveCell(null, beneath)).toEqual(beneath);
    expect(resolveCell({ kind: "absent" }, beneath)).toEqual({ kind: "absent" });
    expect(resolveCell({ kind: "score", grade: 3 }, beneath)).toEqual({ kind: "grade", grade: 3 });
    // The teacher's score fills the empty cell of a project never accepted.
    expect(resolveCell({ kind: "score", grade: 4.5 }, { kind: "empty" })).toEqual({ kind: "grade", grade: 4.5 });
  });
});

describe("the mean", () => {
  it("is the weighted mean of the counted columns, to the tenth", () => {
    expect(gradebookMean([grade(4, 50), grade(5, 100)])).toBe(4.7); // 14 / 3 = 4.666…
    expect(gradebookMean([grade(6, 75), grade(3, 25)])).toBe(5.3); // 21 / 4 = 5.25, half up
  });

  it("reads the weights as relative, not as a budget (#545)", () => {
    // Ten quizzes at 10 % and one exam at 100 %: the quizzes weigh 100/200 together, the exam is half of the mean.
    const quizzes = Array.from({ length: 10 }, () => grade(4, 10));
    expect(gradebookMean([...quizzes, grade(6, 100)])).toBe(5);
    // The same weights scaled together give the same mean.
    expect(gradebookMean([grade(4, 20), grade(6, 40)])).toBe(gradebookMean([grade(4, 50), grade(6, 100)]));
  });

  it("is computed from the displayed tenths, half up and exact", () => {
    expect(gradebookMean([grade(4.1), grade(4.2)])).toBe(4.2);
    expect(gradebookMean([grade(3.3), grade(3.4)])).toBe(3.4);
    // A cell grade with more than a tenth is rounded as displayed first.
    expect(gradebookMean([grade(4.04), grade(4.04)])).toBe(4);
  });

  it("counts an absence as 1.0 and skips a column with no grade, renormalising the others", () => {
    expect(gradebookMean([grade(5), { weight: 100, counts: true, cell: { kind: "absent" } }])).toBe(3);
    expect(gradebookMean([grade(5), { weight: 100, counts: true, cell: { kind: "empty" } }])).toBe(5);
    // The exam not graded yet for this student: the two quizzes alone, at their own ratio.
    expect(gradebookMean([grade(4, 10), grade(5, 30), { weight: 100, counts: true, cell: { kind: "empty" } }])).toBe(4.8);
  });

  it("leaves out a column that does not count, and a 0 % weight", () => {
    expect(gradebookMean([grade(5), grade(2, 100, false)])).toBe(5);
    expect(gradebookMean([grade(5), grade(2, 0)])).toBe(5);
  });

  it("is null with no grade at all, or every weight at 0 %", () => {
    expect(gradebookMean([])).toBeNull();
    expect(gradebookMean([{ weight: 100, counts: true, cell: { kind: "empty" } }])).toBeNull();
    expect(gradebookMean([grade(5, 0), grade(3, 0)])).toBeNull();
  });
});

describe("the class mean", () => {
  it("is the plain mean of the grades given, to the tenth, half up", () => {
    expect(classMean([4, 5])).toBe(4.5);
    expect(classMean([4.1, 4.2])).toBe(4.2); // 4.15
    expect(classMean([5, 4, 4])).toBe(4.3); // 4.333…
  });

  it("leaves out a missing grade, and counts an absence as the 1.0 its cell counts as", () => {
    expect(classMean([5, null, 3])).toBe(4);
    expect(classMean([5, cellGrade({ kind: "absent" }), cellGrade({ kind: "empty" })])).toBe(3);
  });

  it("is null with no grade at all", () => {
    expect(classMean([])).toBeNull();
    expect(classMean([null, null])).toBeNull();
  });
});
