import { describe, expect, it } from "vitest";
import { gradeFromPoints, isPassing, MAX_GRADE, MIN_GRADE, type Scale } from "./grade.js";

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
