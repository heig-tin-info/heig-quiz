import { describe, expect, it } from "vitest";
import {
  attemptTotal,
  gradeFromPoints,
  isPassing,
  MAX_GRADE,
  MIN_GRADE,
  overridePointsRange,
  type Scale,
} from "./grade.js";

const linear: Scale = { kind: "linear" };
const threshold18: Scale = { kind: "threshold", threshold: 18 };

describe("gradeFromPoints", () => {
  const table: [points: number, total: number, scale: Scale, grade: number][] = [
    [0, 20, linear, 1],
    [12, 20, linear, 4],
    [20, 20, linear, 6],
    [3, 7, linear, 3.1],
    [18, 20, threshold18, 6],
    [19, 20, threshold18, 6],
    [9, 20, threshold18, 3.5],
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
    expect(gradeFromPoints(5, 20, { kind: "threshold", threshold: 0 })).toBe(MIN_GRADE);
  });

  it("honours the rounding mode", () => {
    expect(gradeFromPoints(3, 7, { kind: "linear", rounding: "up" })).toBe(3.2);
    expect(gradeFromPoints(3, 7, { kind: "linear", rounding: "down" })).toBe(3.1);
  });
});

describe("isPassing", () => {
  it("passes at 4.0", () => {
    expect(isPassing(3.9)).toBe(false);
    expect(isPassing(4)).toBe(true);
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

describe("overridePointsRange (F-GRADE-05, ADR-026)", () => {
  it("is [0, max] by default and [-max, max] under negative marking", () => {
    expect(overridePointsRange(2, false)).toEqual({ min: 0, max: 2 });
    expect(overridePointsRange(2, true)).toEqual({ min: -2, max: 2 });
  });
});
