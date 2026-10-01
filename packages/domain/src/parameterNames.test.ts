import { describe, expect, it } from "vitest";

import { formatStep } from "./parameterNames.js";

describe("formatStep", () => {
  it("is 1 for int and 10^-n for .n, whatever the value", () => {
    expect(formatStep("int", 123.4)).toBe(1);
    expect(formatStep(".2", 9.81)).toBeCloseTo(0.01, 12);
    expect(formatStep(".6", 0)).toBeCloseTo(1e-6, 15);
  });

  it("follows the magnitude for n significant figures", () => {
    expect(formatStep("3s", 9.81)).toBeCloseTo(0.01, 12);
    expect(formatStep("3s", 981)).toBeCloseTo(1, 12);
    expect(formatStep("3s", -0.00123)).toBeCloseTo(0.00001, 15);
    expect(formatStep("1s", 40)).toBeCloseTo(10, 12);
  });

  it("is null for the empty format, and at ns for a value without magnitude", () => {
    expect(formatStep("", 9.81)).toBeNull();
    expect(formatStep("3s", 0)).toBeNull();
    expect(formatStep("3s", Number.NaN)).toBeNull();
  });
});
