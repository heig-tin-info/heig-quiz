import { describe, expect, it } from "vitest";
import { describe as describeSeries, histogram, mcqDistribution } from "./stats.js";

describe("describe", () => {
  it("summarises a series", () => {
    expect(describeSeries([4, 5, 6])).toEqual({
      count: 3,
      mean: 5,
      median: 5,
      stdev: 0.82,
      min: 4,
      max: 6,
    });
  });

  it("takes the average of the two middle values for an even count", () => {
    expect(describeSeries([1, 2, 3, 4]).median).toBe(2.5);
  });

  it("returns zeroes for an empty series", () => {
    expect(describeSeries([])).toEqual({ count: 0, mean: 0, median: 0, stdev: 0, min: 0, max: 0 });
  });
});

describe("histogram", () => {
  it("covers 1.0 … 6.0 with a dedicated bucket for a perfect 6", () => {
    const buckets = histogram([1, 3.7, 4, 4.4, 6]);
    expect(buckets.map((b) => b.bucket)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]);
    expect(buckets.find((b) => b.bucket === 1)?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === 3.5)?.count).toBe(1);
    expect(buckets.find((b) => b.bucket === 4)?.count).toBe(2);
    expect(buckets.find((b) => b.bucket === 6)?.count).toBe(1);
  });

  it("clamps a value outside the scale into the first or last bucket", () => {
    const buckets = histogram([0.5, 7]);
    expect(buckets[0]?.count).toBe(1);
    expect(buckets[buckets.length - 1]?.count).toBe(1);
  });

  it("accepts another step", () => {
    expect(histogram([], 1).map((b) => b.bucket)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("mcqDistribution", () => {
  it("counts the selections per canonical choice index", () => {
    expect(
      mcqDistribution([{ selected: [0, 1] }, { selected: [1] }, { selected: [] }], 3),
    ).toEqual([1, 2, 0]);
  });

  it("ignores duplicates and out-of-range indices", () => {
    expect(mcqDistribution([{ selected: [0, 0, 9, -1] }], 2)).toEqual([1, 0]);
  });
});
