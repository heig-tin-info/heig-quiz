import { describe, expect, it } from "vitest";
import {
  attemptTotal,
  bonusTotal,
  gradeBand,
  gradeFromPoints,
  gradeLetter,
  isPassing,
  evaluationTotal,
  itemPoints,
  lacksGradedPoints,
  MAX_GRADE,
  MIN_GRADE,
  overridePointsRange,
  type Scale,
} from "./grade.js";

const linear: Scale = {};

describe("gradeFromPoints", () => {
  const table: [points: number, total: number, scale: Scale, grade: number][] = [
    [0, 20, linear, 1],
    [12, 20, linear, 4],
    [20, 20, linear, 6],
    [3, 7, linear, 3.1],
    // Bonus points past the total (ADR-052): capped at 6.
    [21, 18, linear, 6],
    [9, 18, linear, 3.5],
    [-2, 20, linear, 1],
    [5, 0, linear, 1],
  ];

  it("matches the F-RES table", () => {
    for (const [points, total, scale, expected] of table) {
      expect(gradeFromPoints(points, total, scale)).toBe(expected);
    }
  });

  it("never leaves the 1 … 6 range", () => {
    expect(gradeFromPoints(-100, 20, linear)).toBe(MIN_GRADE);
    expect(gradeFromPoints(100, 20, linear)).toBe(MAX_GRADE);
    expect(gradeFromPoints(5, -1, linear)).toBe(MIN_GRADE);
    expect(gradeFromPoints(5, 0, linear)).toBe(MIN_GRADE);
  });

  it("honours the rounding mode", () => {
    expect(gradeFromPoints(3, 7, { rounding: "up" })).toBe(3.2);
    expect(gradeFromPoints(3, 7, { rounding: "down" })).toBe(3.1);
  });
});

describe("isPassing", () => {
  it("passes at 4.0", () => {
    expect(isPassing(3.9)).toBe(false);
    expect(isPassing(4)).toBe(true);
    // As written: a class mean of 3.96 prints "4.0", and is a pass.
    expect(isPassing(3.96)).toBe(true);
  });
});

describe("gradeBand", () => {
  it("is fail below 4.0, borderline below 4.5, pass from 4.5", () => {
    expect([1, 3.9, 4, 4.4, 4.5, 6].map(gradeBand)).toEqual([
      "fail",
      "fail",
      "borderline",
      "borderline",
      "pass",
      "pass",
    ]);
  });

  it("judges the grade as written, one decimal", () => {
    expect(gradeBand(3.96)).toBe("borderline");
    expect(gradeBand(4.44)).toBe("borderline");
    expect(gradeBand(4.46)).toBe("pass");
  });
});

describe("gradeLetter", () => {
  it("maps each bound, inclusive from below", () => {
    const table: [grade: number, letter: string][] = [
      [1, "F"],
      [3.4, "F"],
      [3.5, "FX"],
      [3.9, "FX"],
      [4, "E"],
      [4.2, "E"],
      [4.3, "D"],
      [4.7, "D"],
      [4.8, "C"],
      [5.2, "C"],
      [5.3, "B"],
      [5.7, "B"],
      [5.8, "A"],
      [6, "A"],
    ];
    for (const [grade, letter] of table) expect(gradeLetter(grade)).toBe(letter);
  });

  it("does not miss a bound by a float hair", () => {
    expect(gradeLetter(0.1 + 4.2)).toBe("D");
  });
});

describe("attemptTotal (ADR-026)", () => {
  it("sums the points of the items, rounded to the hundredth", () => {
    expect(attemptTotal([1, 0.5, 0.25])).toBe(1.75);
    expect(attemptTotal([0.1, 0.2])).toBe(0.3);
    expect(attemptTotal([])).toBe(0);
  });

  it("carries negative items into the sum", () => {
    expect(attemptTotal([2, -0.5, -0.33])).toBe(1.17);
  });

  it("floors a negative total at 0, never -0", () => {
    expect(attemptTotal([-1, -0.33, 0.5])).toBe(0);
    expect(Object.is(attemptTotal([-0.001]), 0)).toBe(true);
    expect(Object.is(attemptTotal([-1, 1]), 0)).toBe(true);
  });

  it("gives the grade of a floored total", () => {
    expect(gradeFromPoints(attemptTotal([-3, 1]), 10, linear)).toBe(1);
  });
});

describe("evaluationTotal (ADR-052)", () => {
  it("sums the items, bonus items left out, rounded to the hundredth", () => {
    expect(evaluationTotal([])).toBe(0);
    expect(
      evaluationTotal([
        { points: 0.1, bonus: false },
        { points: 0.2, bonus: false },
        { points: 3, bonus: true },
      ]),
    ).toBe(0.3);
  });

  it("rounds half away from zero, where Math.round went up (audit B-08)", () => {
    expect(evaluationTotal([{ points: 1.25, bonus: false }, { points: 2.5, bonus: false }, { points: 0.75, bonus: false }])).toBe(4.5);
    expect(evaluationTotal([{ points: -0.125, bonus: false }])).toBe(-0.13);
  });

  it("has its complement in bonusTotal", () => {
    const items = [
      { points: 2, bonus: false },
      { points: 0.1, bonus: true },
      { points: 0.2, bonus: true },
    ];
    expect([evaluationTotal(items), bonusTotal(items)]).toEqual([2, 0.3]);
  });
});

describe("lacksGradedPoints (ADR-052)", () => {
  it("refuses an exam or an exercise with nothing that counts", () => {
    expect(lacksGradedPoints("exam", 0)).toBe(true);
    expect(lacksGradedPoints("exercise", 0)).toBe(true);
    expect(lacksGradedPoints("exam", 0.5)).toBe(false);
  });

  it("never refuses a poll", () => {
    expect(lacksGradedPoints("poll", 0)).toBe(false);
  });
});

describe("itemPoints (ADR-052)", () => {
  it("rounds, and floors a bonus item at 0, never -0", () => {
    expect(itemPoints(-0.5, true)).toBe(0);
    expect(Object.is(itemPoints(-0.001, true), 0)).toBe(true);
    expect(itemPoints(1.005, true)).toBe(1.01);
  });

  it("leaves an ordinary item as the type scored it, rounded", () => {
    expect(itemPoints(-0.5, false)).toBe(-0.5);
    expect(itemPoints(2 / 3, false)).toBe(0.67);
  });
});

describe("overridePointsRange (F-GRADE-05, ADR-026)", () => {
  it("is [0, max] by default and [-max, max] under negative marking", () => {
    expect(overridePointsRange(2, false)).toEqual({ min: 0, max: 2 });
    expect(overridePointsRange(2, true)).toEqual({ min: -2, max: 2 });
  });
});
