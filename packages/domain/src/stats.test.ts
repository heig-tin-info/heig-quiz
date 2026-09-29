import { describe, expect, it } from "vitest";
import {
  describe as describeSeries,
  histogram,
  itemStats,
  quantile,
  QUESTION_STATS_MIN_N,
  QUESTION_TIME_MIN_N,
  shownItemStats,
  shownTimeSpread,
  spread,
} from "./stats.js";

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

describe("itemStats", () => {
  it("is empty for no answers", () => {
    expect(itemStats([])).toEqual({ n: 0, p: 0 });
  });

  it("averages the success rates, not the points", () => {
    expect(itemStats([{ points: 2, maxPoints: 4 }, { points: 1, maxPoints: 1 }])).toEqual({ n: 2, p: 0.75 });
  });

  it("keeps a negative rate signed", () => {
    expect(itemStats([{ points: -1, maxPoints: 2 }, { points: 1, maxPoints: 2 }])).toEqual({ n: 2, p: 0 });
    expect(itemStats([{ points: -2, maxPoints: 2 }])).toEqual({ n: 1, p: -1 });
  });

  it("leaves out answers without a positive maximum", () => {
    expect(itemStats([{ points: 0, maxPoints: 0 }, { points: 1, maxPoints: -1 }, { points: 1, maxPoints: 2 }])).toEqual({
      n: 1,
      p: 0.5,
    });
  });

  it("rounds the rate to two decimals", () => {
    expect(itemStats([{ points: 1, maxPoints: 3 }]).p).toBe(0.33);
  });
});

describe("shownItemStats", () => {
  it("hides the statistics below the threshold, shows them from it", () => {
    expect(QUESTION_STATS_MIN_N).toBe(10);
    expect(shownItemStats({ n: 9, p: 0.5 })).toBeNull();
    expect(shownItemStats({ n: 10, p: 0.5 })).toEqual({ n: 10, p: 0.5 });
  });
});

describe("quantile", () => {
  it("interpolates between the closest ranks (type 7)", () => {
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3.25);
  });

  it("answers the value itself for a single one, 0 for none", () => {
    expect(quantile([7], 0.25)).toBe(7);
    expect(quantile([7], 0.75)).toBe(7);
    expect(quantile([], 0.5)).toBe(0);
  });

  it("gives the known quartiles of ten values", () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(quantile(ten, 0.25)).toBe(3.25);
    expect(quantile(ten, 0.75)).toBe(7.75);
  });

  it("agrees with the median of describe", () => {
    for (const series of [[3, 1, 2], [4, 1, 3, 2], [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]]) {
      const sorted = [...series].sort((a, b) => a - b);
      expect(quantile(sorted, 0.5)).toBe(describeSeries(series).median);
    }
  });
});

describe("spread", () => {
  it("summarises the finite values only, unrounded", () => {
    expect(spread([4000, 1000, Number.NaN, Number.POSITIVE_INFINITY, 3000, 2000])).toEqual({
      n: 4,
      mean: 2500,
      median: 2500,
      p25: 1750,
      p75: 3250,
    });
    expect(spread([1, 2]).mean).toBe(1.5);
    expect(spread([1, 1, 2]).mean).toBeCloseTo(4 / 3);
  });

  it("is all zeroes on nothing", () => {
    expect(spread([])).toEqual({ n: 0, mean: 0, median: 0, p25: 0, p75: 0 });
  });
});

describe("shownTimeSpread", () => {
  it("hides the time below the threshold, shows it from it", () => {
    expect(QUESTION_TIME_MIN_N).toBe(10);
    expect(shownTimeSpread(spread([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeNull();
    expect(shownTimeSpread(spread([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))?.n).toBe(10);
  });
});
