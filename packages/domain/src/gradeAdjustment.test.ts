import { describe, expect, it } from "vitest";

import { adjustGrade, validGradeAdjustment, type GradeAdjustment } from "./gradeAdjustment.js";
import { projectGrade } from "./projectGrade.js";

const relative = (value: number): GradeAdjustment => ({ kind: "relative", value, baseAtWrite: null });
const absolute = (value: number, baseAtWrite: number | null): GradeAdjustment => ({ kind: "absolute", value, baseAtWrite });

describe("validGradeAdjustment (ADR-135)", () => {
  it("takes a relative delta, a multiple of 0.1 within ±5, never 0", () => {
    for (const value of [0.1, -0.1, 0.3, 1.5, -2.7, 5, -5]) expect(validGradeAdjustment({ kind: "relative", value })).toBe(true);
    for (const value of [0, 0.05, 0.15, 5.1, -5.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validGradeAdjustment({ kind: "relative", value })).toBe(false);
    }
  });

  it("takes an absolute grade within 1 … 6 at the tenth", () => {
    for (const value of [1, 3.5, 4, 5.9, 6]) expect(validGradeAdjustment({ kind: "absolute", value })).toBe(true);
    for (const value of [0.9, 6.1, 3.55, 0, -1]) expect(validGradeAdjustment({ kind: "absolute", value })).toBe(false);
  });

  it("reads a float hair as its tenth (0.1 × 3)", () => {
    expect(validGradeAdjustment({ kind: "relative", value: 0.1 * 3 })).toBe(true);
    expect(validGradeAdjustment({ kind: "absolute", value: 4.3 + 0.2 })).toBe(true);
  });
});

describe("adjustGrade (ADR-135)", () => {
  it("leaves the grade as it is without an adjustment", () => {
    expect(adjustGrade(4.3, null)).toEqual({ base: 4.3, grade: 4.3, moved: null });
  });

  it("makes no grade out of none: an adjustment moves a grade", () => {
    expect(adjustGrade(null, relative(0.5))).toBeNull();
    expect(adjustGrade(null, absolute(5, 4))).toBeNull();
    expect(adjustGrade(null, null)).toBeNull();
  });

  it("adds a relative delta, rounded to the tenth whatever the float hair", () => {
    expect(adjustGrade(4.3, relative(0.2))).toEqual({ base: 4.3, grade: 4.5, moved: null });
    expect(adjustGrade(4.3, relative(-0.4))).toEqual({ base: 4.3, grade: 3.9, moved: null });
    expect(adjustGrade(0.1 * 3 + 4, relative(0.1))?.grade).toBe(4.4);
  });

  it("clamps a relative result to 1 … 6", () => {
    expect(adjustGrade(5.6, relative(1))?.grade).toBe(6);
    expect(adjustGrade(1.4, relative(-2))?.grade).toBe(1);
  });

  it("rounds the result to the nearest tenth, whatever the project's rounding made the base", () => {
    // 1 + 5 × 6.66 / 10 = 4.33: `up` gives 4.4, `down` 4.3; the delta keeps that base's tenth.
    const up = projectGrade(6.66, 10, { kind: "linear", rounding: "up" }).grade;
    const down = projectGrade(6.66, 10, { kind: "linear", rounding: "down" }).grade;
    expect(up).toBe(4.4);
    expect(down).toBe(4.3);
    expect(adjustGrade(up, relative(0.3))?.grade).toBe(4.7);
    expect(adjustGrade(down, relative(0.3))?.grade).toBe(4.6);
  });

  it("keeps a relative delta when the base moves: the regrade moves the base, the delta stays", () => {
    const delta = relative(0.3);
    expect(adjustGrade(4, delta)?.grade).toBe(4.3);
    expect(adjustGrade(4.8, delta)).toEqual({ base: 4.8, grade: 5.1, moved: null });
  });

  it("pins an absolute grade, and says when its base moved since the write", () => {
    expect(adjustGrade(4.3, absolute(5, 4.3))).toEqual({ base: 4.3, grade: 5, moved: null });
    expect(adjustGrade(4.6, absolute(5, 4.3))).toEqual({ base: 4.6, grade: 5, moved: { from: 4.3, to: 4.6 } });
    // A float hair of the stored base is no move.
    expect(adjustGrade(4.3, absolute(5, 4.299999999))?.moved).toBeNull();
    // No stored base: nothing to compare with.
    expect(adjustGrade(4.6, absolute(5, null))?.moved).toBeNull();
  });

  it("never flags a relative adjustment's base", () => {
    expect(adjustGrade(4.6, { kind: "relative", value: 0.2, baseAtWrite: 4.3 })?.moved).toBeNull();
  });
});
