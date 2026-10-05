import { describe, expect, it } from "vitest";

import {
  ABSENT_GRADE,
  cellGrade,
  countsByDefault,
  gradebookMean,
  hasGrade,
  notTakenCell,
  resolveCell,
  validWeight,
  type MeanColumn,
} from "./gradebook.js";

const grade = (g: number, weight = 1, counts = true): MeanColumn => ({ weight, counts, cell: { kind: "grade", grade: g } });

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
    expect(gradebookMean([grade(4, 1), grade(5, 2)])).toBe(4.7); // 14 / 3 = 4.666…
    expect(gradebookMean([grade(6, 3), grade(3, 1)])).toBe(5.3); // 21 / 4 = 5.25, half up
  });

  it("is computed from the displayed tenths, half up and exact", () => {
    expect(gradebookMean([grade(4.1), grade(4.2)])).toBe(4.2);
    expect(gradebookMean([grade(3.3), grade(3.4)])).toBe(3.4);
    // A cell grade with more than a tenth is rounded as displayed first.
    expect(gradebookMean([grade(4.04), grade(4.04)])).toBe(4);
  });

  it("counts an absence as 1.0 and leaves an empty cell out", () => {
    expect(gradebookMean([grade(5), { weight: 1, counts: true, cell: { kind: "absent" } }])).toBe(3);
    expect(gradebookMean([grade(5), { weight: 1, counts: true, cell: { kind: "empty" } }])).toBe(5);
  });

  it("leaves out a column that does not count, and a zero weight", () => {
    expect(gradebookMean([grade(5), grade(2, 1, false)])).toBe(5);
    expect(gradebookMean([grade(5), grade(2, 0)])).toBe(5);
    expect(gradebookMean([grade(5, 0)])).toBeNull();
  });

  it("is null with no grade at all", () => {
    expect(gradebookMean([])).toBeNull();
    expect(gradebookMean([{ weight: 1, counts: true, cell: { kind: "empty" } }])).toBeNull();
  });

  it("takes a fractional weight", () => {
    expect(gradebookMean([grade(6, 0.5), grade(3, 1.5)])).toBe(3.8); // (3 + 4.5) / 2 = 3.75
  });
});

describe("a weight", () => {
  it("is 0 to 10 at the tenth", () => {
    for (const ok of [0, 1, 0.5, 10, 2.3]) expect(validWeight(ok)).toBe(true);
    for (const bad of [-1, 10.1, 0.25, Number.NaN, Number.POSITIVE_INFINITY]) expect(validWeight(bad)).toBe(false);
  });
});
