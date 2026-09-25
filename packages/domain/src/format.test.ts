import { describe, expect, it } from "vitest";
import { displayedRate, formatGrade, formatPoints } from "./format.js";

describe("formatPoints", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [1, "1"],
    [2.5, "2.5"],
    [2.3333333333333335, "2.33"],
    [4, "4"],
    [5.75, "5.75"],
    [10, "10"],
    [0.1 + 0.2, "0.3"],
  ];

  it("writes at most two decimals and never a trailing zero", () => {
    for (const [input, expected] of cases) expect(formatPoints(input)).toBe(expected);
  });

  it("writes a zero score as '0', never '-0'", () => {
    expect(formatPoints(-0)).toBe("0");
    expect(formatPoints(-0.001)).toBe("0");
  });

  it("rounds a penalty away from zero, like every other rounding here (D13)", () => {
    // Math.round(-0.5) is -0. A third-decimal tie never reaches the client
    // (the server rounds every sum with round2), so this only documents that
    // formatPoints follows D13 like every other rounding of the platform.
    expect(formatPoints(-0.005)).toBe("-0.01");
    expect(formatPoints(-1.25)).toBe("-1.25");
    expect(formatPoints(-2.345)).toBe("-2.35");
  });
});

describe("formatGrade", () => {
  const cases: [number, string][] = [
    [0, "0.0"],
    [1, "1.0"],
    [2.5, "2.5"],
    [4, "4.0"],
    [5.75, "5.8"],
    [6, "6.0"],
  ];

  it("always writes one decimal, the way a Swiss grade is written", () => {
    for (const [input, expected] of cases) expect(formatGrade(input)).toBe(expected);
  });
});

describe("displayedRate (ADR-026)", () => {
  it("clamps a success rate to [0, 1] for the screens", () => {
    expect(displayedRate(-0.25)).toBe(0);
    expect(displayedRate(0.42)).toBe(0.42);
    expect(displayedRate(1.2)).toBe(1);
  });
});
