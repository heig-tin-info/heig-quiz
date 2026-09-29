import { describe, expect, it } from "vitest";
import {
  discrimination,
  discriminationBand,
  DISCRIMINATION_FAIR,
  DISCRIMINATION_GOOD,
  DISCRIMINATION_MIN_ITEMS,
  DISCRIMINATION_MIN_N,
  evaluationDiscrimination,
  pearson,
  describe as describeSeries,
  histogram,
  itemStats,
  latestRun,
  optionShares,
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
  /** Attempts `a0`, `a1`… earning `items[i]` out of 1 on the question, `rests[i]` out of 10 on the rest. */
  const sat = (items: readonly number[], rests: readonly number[]) =>
    items.map((p, i) => ({
      attemptId: `a${i}`,
      item: { points: p, maxPoints: 1 },
      rest: { points: rests[i]!, maxPoints: 10 },
    }));
  const rests = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const good = [0, 0, 0, 0, 1, 0, 1, 1, 1, 1];

  it("correlates the item's ratio with the rest-of-test ratio, and names its attempts", () => {
    const sample = evaluationDiscrimination("e1", sat(good, rests), 5)!;
    expect(sample.evaluationId).toBe("e1");
    expect(sample.attemptIds).toEqual(["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]);
    expect(sample.r).toBeCloseTo(0.8007572, 6);
  });

  it("keeps a negative correlation signed", () => {
    const inverse = good.map((x) => 1 - x);
    expect(evaluationDiscrimination("e1", sat(inverse, rests), 5)!.r).toBeCloseTo(-0.8007572, 6);
  });

  it("takes a penalised item ratio as it is, unclamped", () => {
    // A linear map of the same pattern: the same r.
    const penalised = good.map((x) => (x === 0 ? -0.5 : 1));
    expect(evaluationDiscrimination("e1", sat(penalised, rests), 5)!.r).toBeCloseTo(0.8007572, 6);
    // Clamped at 0, -0.5 and 0 would collapse into one value and change r.
    const mixed = good.map((x, i) => (x === 1 ? 1 : i < 2 ? -0.5 : 0));
    expect(evaluationDiscrimination("e1", sat(mixed, rests), 5)!.r).toBeCloseTo(pearson(mixed, rests)!, 12);
    expect(pearson(mixed, rests)).not.toBeCloseTo(0.8007572, 3);
  });

  it("needs five other items and ten attempts", () => {
    expect(DISCRIMINATION_MIN_ITEMS).toBe(5);
    expect(DISCRIMINATION_MIN_N).toBe(10);
    expect(evaluationDiscrimination("e1", sat(good, rests), 4)).toBeNull();
    expect(evaluationDiscrimination("e1", sat(good.slice(1), rests.slice(1)), 5)).toBeNull();
  });

  it("leaves out an attempt with no maximum on either side, before counting", () => {
    const attempts = sat(good, rests);
    attempts[0] = { ...attempts[0]!, item: { points: 0, maxPoints: 0 } };
    expect(evaluationDiscrimination("e1", attempts, 5)).toBeNull();
  });

  it("does not exist when everybody earned the same on the item", () => {
    expect(evaluationDiscrimination("e1", sat(rests.map(() => 1), rests), 5)).toBeNull();
  });
});

describe("discrimination", () => {
  /** A sample of exam `evaluationId` over the attempts `ids`. */
  const sample = (evaluationId: string, r: number, ids: readonly string[]) => ({ evaluationId, r, attemptIds: ids });
  const range = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  it("combines by Fisher's z weighted by n - 3, rounds, and skips what did not qualify", () => {
    // tanh((10 atanh 0.5 + 20 atanh 0.3) / 30) = 0.3709
    expect(discrimination([sample("e1", 0.5, range("a", 13)), null, sample("e2", 0.3, range("b", 23))])).toEqual({
      r: 0.37,
      evaluations: 2,
      n: 36,
    });
    expect(discrimination([sample("e1", -0.25, range("a", 12))])).toEqual({ r: -0.25, evaluations: 1, n: 12 });
  });

  it("stays finite on a perfect correlation", () => {
    expect(discrimination([sample("e1", 1, range("a", 10))])).toEqual({ r: 1, evaluations: 1, n: 10 });
    expect(discrimination([sample("e1", -1, range("a", 10))])).toEqual({ r: -1, evaluations: 1, n: 10 });
  });

  it("counts an exam and its attempts once, when the question sits in it twice", () => {
    const ids = range("a", 10);
    expect(discrimination([sample("e1", 0.5, ids), sample("e1", 0.3, ids)])).toEqual({
      r: 0.4,
      evaluations: 1,
      n: 10,
    });
  });

  it("is null when no exam qualifies", () => {
    expect(discrimination([null, null])).toBeNull();
    expect(discrimination([])).toBeNull();
  });
});

describe("discriminationBand", () => {
  it("reads weak, fair, good, and flags a negative index", () => {
    expect([DISCRIMINATION_FAIR, DISCRIMINATION_GOOD]).toEqual([0.2, 0.3]);
    expect(discriminationBand(-0.01)).toBe("inverse");
    expect(discriminationBand(0)).toBe("weak");
    expect(discriminationBand(0.19)).toBe("weak");
    expect(discriminationBand(0.2)).toBe("fair");
    expect(discriminationBand(0.29)).toBe("fair");
    expect(discriminationBand(0.3)).toBe("good");
  });
});

describe("latestRun", () => {
  const v = (number: number, key: string | null) => ({ number, key });
  const run = (versions: { number: number; key: string | null }[]) =>
    latestRun(versions, (x) => x.key).map((x) => x.number);

  it("takes every version when the options never changed", () => {
    expect(run([v(1, "a"), v(2, "a"), v(3, "a")])).toEqual([1, 2, 3]);
  });

  it("stops at the last change", () => {
    expect(run([v(1, "a"), v(2, "b"), v(3, "b")])).toEqual([2, 3]);
    expect(run([v(1, "a"), v(2, "b")])).toEqual([2]);
  });

  it("keeps a run contiguous: options put back after a change start a new run", () => {
    expect(run([v(1, "a"), v(2, "b"), v(3, "a")])).toEqual([3]);
  });

  it("gives nothing without versions or with an unreadable latest one", () => {
    expect(run([])).toEqual([]);
    expect(run([v(1, "a"), v(2, null)])).toEqual([]);
  });

  it("stops at an unreadable version", () => {
    expect(run([v(1, "a"), v(2, null), v(3, "a")])).toEqual([3]);
  });
});

describe("optionShares", () => {
  it("rounds each share to a whole percent of n", () => {
    expect(optionShares([7, 2, 1], 0, 10)).toEqual({ options: [70, 20, 10], none: 0 });
    // 1/3 = 33.3 → 33; 2/3 = 66.7 → 67 — each on its own.
    expect(optionShares([4, 4, 3, 1], 0, 12)).toEqual({ options: [33, 33, 25, 8], none: 0 });
  });

  it("counts the answers that picked nothing as their own share", () => {
    expect(optionShares([6, 2], 3, 11)).toEqual({ options: [55, 18], none: 27 });
  });

  it("lets a multiple-choice question sum above 100", () => {
    const shares = optionShares([9, 8, 2], 0, 10)!;
    expect(shares.options).toEqual([90, 80, 20]);
    expect(shares.options.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
  });

  it("is null below the threshold of the success rate", () => {
    expect(QUESTION_STATS_MIN_N).toBe(10);
    expect(optionShares([5, 4], 0, 9)).toBeNull();
    expect(optionShares([5, 5], 0, 10)).not.toBeNull();
  });
});
