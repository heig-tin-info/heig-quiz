import { describe, expect, it } from "vitest";
import {
  discrimination,
  discriminationBand,
  DISCRIMINATION_MIN_ITEMS,
  DISCRIMINATION_MIN_N,
  evaluationDiscrimination,
  fisherCombine,
  pearson,
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

describe("pearson", () => {
  it("matches a known value", () => {
    expect(pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(6 / Math.sqrt(60), 12);
  });

  it("is 1, -1 on a perfect line, whatever its scale", () => {
    expect(pearson([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 12);
  });

  it("does not exist without variance, or with fewer than two pairs", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2, 3], [0.1, 0.1, 0.1])).toBeNull();
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([], [])).toBeNull();
  });
});

describe("evaluationDiscrimination", () => {
  /** Attempts earning `items[i]` out of 1 on the question, `rests[i]` out of 10 on the rest. */
  const sat = (items: readonly number[], rests: readonly number[]) =>
    items.map((p, i) => ({ item: { points: p, maxPoints: 1 }, rest: { points: rests[i]!, maxPoints: 10 } }));
  const rests = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const good = [0, 0, 0, 0, 1, 0, 1, 1, 1, 1];

  it("correlates the item's ratio with the rest-of-test ratio", () => {
    const sample = evaluationDiscrimination(sat(good, rests), 5)!;
    expect(sample.n).toBe(10);
    expect(sample.r).toBeCloseTo(pearson(good, rests)!, 12);
    expect(sample.r).toBeGreaterThan(0.7);
  });

  it("keeps a negative correlation signed", () => {
    const inverse = good.map((x) => 1 - x);
    expect(evaluationDiscrimination(sat(inverse, rests), 5)!.r).toBeLessThan(-0.7);
  });

  it("takes a penalised item ratio as it is, unclamped", () => {
    const penalised = good.map((x) => (x === 0 ? -0.5 : 1));
    // A linear map of the same pattern: the same r, which a clamp at 0 would also give,
    // but a mix of -0.5 and 0 would not collapse.
    expect(evaluationDiscrimination(sat(penalised, rests), 5)!.r).toBeCloseTo(pearson(good, rests)!, 12);
    const mixed = good.map((x, i) => (x === 1 ? 1 : i < 2 ? -0.5 : 0));
    expect(evaluationDiscrimination(sat(mixed, rests), 5)!.r).toBeCloseTo(pearson(mixed, rests)!, 12);
  });

  it("needs five other items and ten attempts", () => {
    expect(DISCRIMINATION_MIN_ITEMS).toBe(5);
    expect(DISCRIMINATION_MIN_N).toBe(10);
    expect(evaluationDiscrimination(sat(good, rests), 4)).toBeNull();
    expect(evaluationDiscrimination(sat(good.slice(1), rests.slice(1)), 5)).toBeNull();
  });

  it("leaves out an attempt with no maximum on either side, before counting", () => {
    const attempts = sat(good, rests);
    attempts[0] = { item: { points: 0, maxPoints: 0 }, rest: attempts[0]!.rest };
    expect(evaluationDiscrimination(attempts, 5)).toBeNull();
  });

  it("does not exist when everybody earned the same on the item", () => {
    expect(evaluationDiscrimination(sat(rests.map(() => 1), rests), 5)).toBeNull();
  });
});

describe("fisherCombine and discrimination", () => {
  it("weights each exam by n - 3 in z", () => {
    const expected = Math.tanh((10 * Math.atanh(0.5) + 20 * Math.atanh(0.3)) / 30);
    expect(fisherCombine([{ r: 0.5, n: 13 }, { r: 0.3, n: 23 }])).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.3709, 4);
  });

  it("returns one exam's r unchanged, and stays finite on a perfect one", () => {
    expect(fisherCombine([{ r: 0.42, n: 10 }])).toBeCloseTo(0.42, 12);
    const perfect = fisherCombine([{ r: 1, n: 10 }, { r: 0.2, n: 10 }])!;
    expect(Number.isFinite(perfect)).toBe(true);
    expect(perfect).toBeLessThan(1);
    expect(fisherCombine([])).toBeNull();
  });

  it("gives no weight to a sample of three or fewer", () => {
    expect(fisherCombine([{ r: 0.9, n: 3 }])).toBeNull();
    expect(fisherCombine([{ r: 0.9, n: 3 }, { r: 0.2, n: 10 }])).toBeCloseTo(0.2, 12);
  });

  it("rounds, counts the exams and the attempts, and skips those that did not qualify", () => {
    expect(discrimination([{ r: 0.5, n: 13 }, null, { r: 0.3, n: 23 }])).toEqual({
      r: 0.37,
      evaluations: 2,
      n: 36,
    });
    expect(discrimination([{ r: -0.25, n: 12 }])).toEqual({ r: -0.25, evaluations: 1, n: 12 });
  });

  it("is null when no exam qualifies", () => {
    expect(discrimination([null, null])).toBeNull();
    expect(discrimination([])).toBeNull();
  });
});

describe("discriminationBand", () => {
  it("reads weak, fair, good, and flags a negative index", () => {
    expect(discriminationBand(-0.01)).toBe("inverse");
    expect(discriminationBand(0)).toBe("weak");
    expect(discriminationBand(0.19)).toBe("weak");
    expect(discriminationBand(0.2)).toBe("fair");
    expect(discriminationBand(0.29)).toBe("fair");
    expect(discriminationBand(0.3)).toBe("good");
  });
});
