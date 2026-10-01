import { describe, expect, it } from "vitest";

import { projectGrade } from "./projectGrade.js";

describe("projectGrade", () => {
  it("converts linearly by default: 1 + 5 × points / max, to the tenth", () => {
    expect(projectGrade(15, 20, { kind: "linear" })).toEqual({ grade: 4.8, fellBack: false });
    expect(projectGrade(0, 20, { kind: "linear" })).toEqual({ grade: 1, fellBack: false });
    expect(projectGrade(20, 20, { kind: "linear" })).toEqual({ grade: 6, fellBack: false });
  });

  it("honours the rounding of the scale", () => {
    // 1 + 5 × 7 / 9 = 4.888…
    expect(projectGrade(7, 9, { kind: "linear", rounding: "down" }).grade).toBe(4.8);
    expect(projectGrade(7, 9, { kind: "linear", rounding: "up" }).grade).toBe(4.9);
  });

  it("reads a score out of 6 as the grade under score_is_grade", () => {
    expect(projectGrade(4.5, 6, { kind: "score_is_grade" })).toEqual({ grade: 4.5, fellBack: false });
    expect(projectGrade(4.86, 6, { kind: "score_is_grade" }).grade).toBe(4.9);
    expect(projectGrade(4.86, 6, { kind: "score_is_grade", rounding: "down" }).grade).toBe(4.8);
  });

  it("clamps a score_is_grade grade to 1 … 6", () => {
    expect(projectGrade(0, 6, { kind: "score_is_grade" }).grade).toBe(1);
    expect(projectGrade(7, 6, { kind: "score_is_grade" }).grade).toBe(6);
  });

  it("falls back to the linear scale, and says so, when the maximum is not 6", () => {
    expect(projectGrade(15, 20, { kind: "score_is_grade" })).toEqual({ grade: 4.8, fellBack: true });
  });

  it("converts each score with its own maximum", () => {
    // The same points over two maxima: no rescaling to a common one.
    expect(projectGrade(5, 6, { kind: "linear" }).grade).toBe(5.2);
    expect(projectGrade(5, 10, { kind: "linear" }).grade).toBe(3.5);
  });

  it("gives the minimum for a non-positive maximum", () => {
    expect(projectGrade(3, 0, { kind: "linear" }).grade).toBe(1);
  });
});
