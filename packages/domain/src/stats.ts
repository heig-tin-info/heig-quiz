/**
 * Descriptive statistics for the results screens (PLAN-MVP §7.6).
 *
 * Item analysis proper is out of the MVP; these are the numbers the results
 * page and the grade histogram need.
 */
import { MAX_GRADE, MIN_GRADE } from "./grade.js";
import { round2 } from "./round.js";

export interface Description {
  count: number;
  mean: number;
  median: number;
  /** Population standard deviation (divided by n, not n-1). */
  stdev: number;
  min: number;
  max: number;
}

/** An empty series is all zeroes with `count: 0`; the UI shows a dash for it. */
export function describe(values: readonly number[]): Description {
  const count = values.length;
  if (count === 0) return { count: 0, mean: 0, median: 0, stdev: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / count;
  const middle = count >> 1;
  const median = count % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
  return {
    count,
    mean: round2(mean),
    median: round2(median),
    stdev: round2(Math.sqrt(variance)),
    min: sorted[0]!,
    max: sorted[count - 1]!,
  };
}

export interface HistogramBucket {
  /** Lower bound of the bucket, e.g. 3.5 for [3.5, 4.0). The last bucket is exactly 6.0. */
  bucket: number;
  count: number;
}

/**
 * Buckets grades from 1.0 to 6.0. A grade falls in `[bucket, bucket + step)`,
 * except 6.0 which gets its own final bucket. Values outside the scale are
 * clamped into the first or last bucket.
 */
export function histogram(grades: readonly number[], step = 0.5): HistogramBucket[] {
  const buckets: HistogramBucket[] = [];
  for (let b = MIN_GRADE; b < MAX_GRADE - 1e-9; b += step) buckets.push({ bucket: round2(b), count: 0 });
  buckets.push({ bucket: MAX_GRADE, count: 0 });

  for (const grade of grades) {
    if (grade >= MAX_GRADE) {
      buckets[buckets.length - 1]!.count += 1;
      continue;
    }
    const slot = Math.max(0, Math.floor((grade - MIN_GRADE) / step));
    buckets[Math.min(slot, buckets.length - 2)]!.count += 1;
  }
  return buckets;
}

/** How many students selected each choice of an MCQ, by canonical index. */
export function mcqDistribution(
  answers: readonly { selected: readonly number[] }[],
  choiceCount: number,
): number[] {
  const counts = Array.from({ length: choiceCount }, () => 0);
  for (const answer of answers) {
    for (const index of new Set(answer.selected)) {
      if (index >= 0 && index < choiceCount) counts[index]! += 1;
    }
  }
  return counts;
}
