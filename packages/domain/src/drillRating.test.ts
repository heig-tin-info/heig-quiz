import { describe, expect, it } from "vitest";

import {
  DRILL_REFERENCE_MIN_N,
  DRILL_TYPES,
  isDrillType,
  drillCorrectness,
  drillRating,
  drillReferenceMs,
  type DrillCorrectness,
} from "./drillRating.js";

describe("the drill types of v1", () => {
  it("are the four immediately graded ones", () => {
    expect(DRILL_TYPES).toEqual(["mcq", "short", "cloze", "categorize"]);
    expect(["mcq", "categorize", "rich", "circuit", "code"].map(isDrillType)).toEqual([true, true, false, false, false]);
  });
});

describe("drillCorrectness", () => {
  it.each([
    [2, 2, "right"],
    [2.5, 2, "right"],
    [1, 2, "partial"],
    [0.01, 2, "partial"],
    [0, 2, "wrong"],
    [-0.5, 2, "wrong"],
    [0, 0, "wrong"],
    [1, 0, "wrong"],
  ] as const)("%s / %s points is %s", (points, max, expected) => {
    expect(drillCorrectness(points, max)).toBe(expected);
  });
});

describe("drillReferenceMs", () => {
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => s * 1000);

  it("takes the median of the correct times once there are enough", () => {
    const ten = [...nine, 100_000];
    expect(DRILL_REFERENCE_MIN_N).toBe(10);
    expect(drillReferenceMs({ correctTimesMs: ten.reverse(), previousOwnMs: 1, typeDefaultMs: 2 })).toBe(5500);
    expect(drillReferenceMs({ correctTimesMs: [...nine, 10_000, 11_000], previousOwnMs: null, typeDefaultMs: null })).toBe(6000);
  });

  it("falls back to the student's own previous time below the threshold", () => {
    expect(drillReferenceMs({ correctTimesMs: nine, previousOwnMs: 42_000, typeDefaultMs: 30_000 })).toBe(42_000);
  });

  it("then to the type's estimate, then to none", () => {
    expect(drillReferenceMs({ correctTimesMs: [], previousOwnMs: null, typeDefaultMs: 30_000 })).toBe(30_000);
    expect(drillReferenceMs({ correctTimesMs: [], previousOwnMs: null, typeDefaultMs: null })).toBeNull();
  });
});

describe("drillRating (strategy A)", () => {
  const rate = (correctness: DrillCorrectness, activeMs: number, referenceMs: number | null = 10_000) =>
    drillRating({ correctness, activeMs, referenceMs });

  it("rates a wrong or empty answer Again, whatever the time", () => {
    expect(rate("wrong", 1)).toBe(1);
    expect(rate("wrong", 99_000)).toBe(1);
  });

  it("rates a partly right answer Hard, whatever the time", () => {
    expect(rate("partial", 1)).toBe(2);
    expect(rate("partial", 99_000, null)).toBe(2);
  });

  it("rates a right answer on the thresholds 0.6 × and 1.5 × the reference", () => {
    expect(rate("right", 15_001)).toBe(2);
    expect(rate("right", 15_000)).toBe(3);
    expect(rate("right", 6_001)).toBe(3);
    expect(rate("right", 6_000)).toBe(4);
    expect(rate("right", 0)).toBe(4);
  });

  it("does not judge time without a usable reference: right is Good", () => {
    expect(rate("right", 1, null)).toBe(3);
    expect(rate("right", 99_000, null)).toBe(3);
    expect(rate("right", 1, 0)).toBe(3);
  });
});
