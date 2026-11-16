import { describe, expect, it } from "vitest";

import {
  ABSENT_GRADE,
  cellGrade,
  classMean,
  countsByDefault,
  countsInMean,
  evaluationColumnKind,
  gradebookMean,
  gradebookMeans,
  hasGrade,
  notTakenCell,
  resolveCell,
  studentCounting,
  type MeanColumn,
} from "./gradebook.js";

const grade = (g: number, weight = 100, counts = true): MeanColumn => ({ weight, counts, cell: { kind: "grade", grade: g }, componentId: null });

describe("what counts by default (D06)", () => {
  it("counts exams and projects, not exercises", () => {
    expect(countsByDefault("exam")).toBe(true);
    expect(countsByDefault("project")).toBe(true);
    expect(countsByDefault("exercise")).toBe(false);
  });

  it("reads an evaluation's mode as its column's kind", () => {
    expect(evaluationColumnKind("exam")).toBe("exam");
    expect(evaluationColumnKind("exercise")).toBe("exercise");
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

  it("reads an excused cell as named and without a grade, over a grade or an absence alike (#969)", () => {
    expect(cellGrade({ kind: "excused" })).toBeNull();
    expect(hasGrade({ kind: "excused" })).toBe(false);
    expect(resolveCell({ kind: "excused" }, { kind: "grade", grade: 5.5 })).toEqual({ kind: "excused" });
    expect(resolveCell({ kind: "excused" }, { kind: "absent" })).toEqual({ kind: "excused" });
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
    expect(gradebookMean([grade(5), { weight: 100, counts: true, cell: { kind: "absent" }, componentId: null }])).toBe(3);
    expect(gradebookMean([grade(5), { weight: 100, counts: true, cell: { kind: "empty" }, componentId: null }])).toBe(5);
    // The exam not graded yet for this student: the two quizzes alone, at their own ratio.
    expect(gradebookMean([grade(4, 10), grade(5, 30), { weight: 100, counts: true, cell: { kind: "empty" }, componentId: null }])).toBe(4.8);
  });

  it("leaves out an excused column like an empty one, renormalising the others (#969)", () => {
    expect(gradebookMean([grade(5), { weight: 100, counts: true, cell: { kind: "excused" }, componentId: null }])).toBe(5);
    expect(gradebookMean([{ weight: 100, counts: true, cell: { kind: "excused" }, componentId: null }])).toBeNull();
  });

  it("leaves out a column that does not count, and a 0 % weight", () => {
    expect(gradebookMean([grade(5), grade(2, 100, false)])).toBe(5);
    expect(gradebookMean([grade(5), grade(2, 0)])).toBe(5);
  });

  it("is null with no grade at all, or every weight at 0 %", () => {
    expect(gradebookMean([])).toBeNull();
    expect(gradebookMean([{ weight: 100, counts: true, cell: { kind: "empty" }, componentId: null }])).toBeNull();
    expect(gradebookMean([grade(5, 0), grade(3, 0)])).toBeNull();
  });
});

describe("the components of the mean (ADR-131)", () => {
  const LABO = { id: "labo", weight: 50 };
  const COURS = { id: "cours", weight: 50 };
  const inPart = (componentId: string | null, g: number, weight = 100, counts = true): MeanColumn => ({ ...grade(g, weight, counts), componentId });

  it("counts a column only when it counts and, once the course has a component, sits in one", () => {
    expect(countsInMean(true, null, false)).toBe(true);
    expect(countsInMean(true, "labo", true)).toBe(true);
    expect(countsInMean(true, null, true)).toBe(false);
    expect(countsInMean(false, "labo", true)).toBe(false);
    expect(countsInMean(false, null, false)).toBe(false);
  });

  it("names to the student the component of a column only when it counts", () => {
    expect(studentCounting(true, "labo", true)).toEqual({ counts: true, componentId: "labo" });
    expect(studentCounting(false, "labo", true)).toEqual({ counts: false, componentId: null });
    expect(studentCounting(true, null, true)).toEqual({ counts: false, componentId: null });
    expect(studentCounting(true, null, false)).toEqual({ counts: true, componentId: null });
  });

  it("is exactly the one-level mean without a component: one implicit component", () => {
    const columns = [grade(4.1, 10), grade(5.6, 100), grade(3.3, 40), { weight: 100, counts: true, cell: { kind: "absent" }, componentId: null } as const, grade(2, 100, false)];
    expect(gradebookMeans(columns, [])).toEqual({ mean: gradebookMean(columns), components: {} });
    expect(gradebookMeans([], [])).toEqual({ mean: null, components: {} });
  });

  it("takes the owner's example: labs L1 10 % and L2 100 % in Labo 50 %, TE1 and TE2 in Cours 50 %, each component rounded first", () => {
    const columns = [inPart("labo", 4, 10), inPart("labo", 5.5, 100), inPart("cours", 3.7), inPart("cours", 4.4)];
    const means = gradebookMeans(columns, [LABO, COURS]);
    // Labo: (10·4.0 + 100·5.5) / 110 = 5.36 -> 5.4; Cours: (3.7 + 4.4) / 2 = 4.05 -> 4.1 (half up, exact).
    expect(means.components).toEqual({ labo: 5.4, cours: 4.1 });
    // 0.5·5.4 + 0.5·4.1 = 4.75 -> 4.8; the unrounded means would have given 4.71 -> 4.7.
    expect(means.mean).toBe(4.8);
  });

  it("weighs the components relatively, as the columns are weighed", () => {
    const columns = [inPart("labo", 6), inPart("cours", 3)];
    expect(gradebookMeans(columns, [{ id: "labo", weight: 20 }, { id: "cours", weight: 80 }]).mean).toBe(3.6);
    expect(gradebookMeans(columns, [{ id: "labo", weight: 25 }, { id: "cours", weight: 100 }]).mean).toBe(3.6);
  });

  it("leaves a counted column in no component out of every mean", () => {
    const means = gradebookMeans([inPart("labo", 5), inPart(null, 1)], [LABO, COURS]);
    expect(means).toEqual({ mean: 5, components: { labo: 5, cours: null } });
  });

  it("skips a component with no mean for the student and renormalises the others", () => {
    const excused = { weight: 100, counts: true, cell: { kind: "excused" }, componentId: "cours" } as const;
    expect(gradebookMeans([inPart("labo", 4.5), excused, inPart("cours", 6, 100, false)], [LABO, COURS])).toEqual({
      mean: 4.5,
      components: { labo: 4.5, cours: null },
    });
  });

  it("shows a component at 0 % with its own mean and leaves it out of the overall one; all at 0 % give none", () => {
    const columns = [inPart("labo", 6), inPart("cours", 3)];
    expect(gradebookMeans(columns, [{ id: "labo", weight: 0 }, COURS])).toEqual({ mean: 3, components: { labo: 6, cours: 3 } });
    expect(gradebookMeans(columns, [{ id: "labo", weight: 0 }, { id: "cours", weight: 0 }]).mean).toBeNull();
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
    expect(classMean([5, cellGrade({ kind: "excused" })])).toBe(5);
  });

  it("is null with no grade at all", () => {
    expect(classMean([])).toBeNull();
    expect(classMean([null, null])).toBeNull();
  });
});
