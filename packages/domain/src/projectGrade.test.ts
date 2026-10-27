import { describe, expect, it } from "vitest";

import { markAsPoints, projectGrade } from "./projectGrade.js";
import { clamp, roundToTenth, ROUNDINGS } from "./round.js";

describe("projectGrade", () => {
  it("converts linearly: 1 + 5 × points / max, to the tenth", () => {
    expect(projectGrade(15, 20, { kind: "linear" })).toEqual({ grade: 4.8 });
    expect(projectGrade(0, 20, { kind: "linear" })).toEqual({ grade: 1 });
    expect(projectGrade(20, 20, { kind: "linear" })).toEqual({ grade: 6 });
  });

  it("honours the rounding of the scale", () => {
    // 1 + 5 × 7 / 9 = 4.888…
    expect(projectGrade(7, 9, { kind: "linear", rounding: "down" }).grade).toBe(4.8);
    expect(projectGrade(7, 9, { kind: "linear", rounding: "up" }).grade).toBe(4.9);
  });

  it("converts each score with its own maximum", () => {
    // The same points over two maxima: no rescaling to a common one.
    expect(projectGrade(5, 6, { kind: "linear" }).grade).toBe(5.2);
    expect(projectGrade(5, 10, { kind: "linear" }).grade).toBe(3.5);
  });

  it("reads a converted mark, (g − 1) out of 5, as the removed preset read g out of 6 (ADR-119 §11)", () => {
    // What `score_is_grade` gave for g/6: the mark rounded to the tenth, clamped to 1…6.
    const preset = (g: number, rounding: (typeof ROUNDINGS)[number]) => clamp(roundToTenth(g, rounding), 1, 6);
    for (let hundredths = 0; hundredths <= 700; hundredths++) {
      const g = hundredths / 100;
      for (const rounding of ROUNDINGS) {
        expect(projectGrade(clamp(g - 1, 0, 5), 5, { kind: "linear", rounding }).grade, `${g} ${rounding}`).toBe(preset(g, rounding));
      }
    }
  });

  it("turns a mark out of 6 into points out of 5, and leaves any other score", () => {
    expect(markAsPoints({ points: 4.5, max: 6, id: "r" })).toEqual({ points: 3.5, max: 5, id: "r" });
    expect(markAsPoints({ points: 0, max: 6 })).toEqual({ points: 0, max: 5 });
    expect(markAsPoints({ points: 7, max: 6 })).toEqual({ points: 5, max: 5 });
    expect(markAsPoints({ points: 15, max: 20 })).toEqual({ points: 15, max: 20 });
    expect(markAsPoints({ points: null, max: 6 })).toEqual({ points: null, max: 6 });
  });

  it("gives the minimum for a non-positive maximum", () => {
    expect(projectGrade(3, 0, { kind: "linear" }).grade).toBe(1);
  });
});
