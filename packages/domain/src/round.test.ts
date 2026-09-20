import { describe, expect, it } from "vitest";
import { clamp, round2, roundToTenth } from "./round.js";

describe("roundToTenth", () => {
  const nearest: [number, number][] = [
    [0, 0],
    [0.04, 0],
    [0.05, 0.1],
    [0.25, 0.3],
    [3.142857142857143, 3.1],
    [3.95, 4],
    [-0.05, -0.1],
    [-0.25, -0.3],
    [5.999, 6],
  ];

  it("rounds half AWAY FROM ZERO, not toward +Infinity", () => {
    for (const [input, expected] of nearest) expect(roundToTenth(input)).toBe(expected);
    // The trap: Math.round(-2.5) is -2, which would silently favour the student.
    expect(Math.round(-2.5)).toBe(-2);
    expect(roundToTenth(-0.25)).toBe(-0.3);
  });

  it("rounds up and down without drifting on exact tenths", () => {
    expect(roundToTenth(0.21, "up")).toBe(0.3);
    expect(roundToTenth(0.2, "up")).toBe(0.2);
    expect(roundToTenth(0.29, "down")).toBe(0.2);
    expect(roundToTenth(0.3, "down")).toBe(0.3);
    expect(roundToTenth(-0.21, "down")).toBe(-0.3);
  });
});

describe("round2", () => {
  it("gives two decimals, half away from zero", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1 / 3)).toBe(0.33);
  });
});

describe("clamp", () => {
  it("keeps the value inside the bounds", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
