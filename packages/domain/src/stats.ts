/**
 * Descriptive statistics for the results screens (PLAN-MVP §7.6), and the
 * item analysis of a question in its pool (ADR-038): the mean success rate
 * over the answers counted, reported with their number and shown only from
 * `QUESTION_STATS_MIN_N` answers on — and the time spent on it (ADR-039).
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

/** Below this many answers, a question's statistics are not shown (ADR-038). */
export const QUESTION_STATS_MIN_N = 10;

/** One counted answer to a question: the points it earned out of its maximum. */
export interface ScoredAnswer {
  points: number;
  maxPoints: number;
}

/**
 * The item analysis of a question: `n` answers counted, `p` their mean
 * success rate. `p` is SIGNED: negative marking (ADR-026) can push it below
 * zero, and that is reported as is. No spread, no extremes (N-DATA-06).
 */
export interface ItemStats {
  n: number;
  p: number;
}

/** Answers with no positive maximum carry no rate and are left out. */
export function itemStats(answers: Iterable<ScoredAnswer>): ItemStats {
  const ratios: number[] = [];
  for (const a of answers) if (a.maxPoints > 0) ratios.push(a.points / a.maxPoints);
  const { count, mean } = describe(ratios);
  return { n: count, p: mean };
}

/** The statistics as they may be shown: `null` below `QUESTION_STATS_MIN_N` answers. */
export function shownItemStats(stats: ItemStats): ItemStats | null {
  return stats.n >= QUESTION_STATS_MIN_N ? stats : null;
}

/**
 * The `q`-quantile of an ascending series, by linear interpolation between
 * the closest ranks (type 7 of Hyndman & Fan, the default of R and NumPy):
 * `h = (n - 1) q`. `quantile(sorted, 0.5)` is the median of {@link describe},
 * unrounded. An empty series answers 0, like `describe`.
 */
export function quantile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const h = (n - 1) * q;
  const low = Math.floor(h);
  const high = Math.min(low + 1, n - 1);
  return sorted[low]! + (h - low) * (sorted[high]! - sorted[low]!);
}

/** Below this many timed answers, a question's time is not shown (ADR-039). */
export const QUESTION_TIME_MIN_N = 10;

/**
 * The idle cap of the dwell (ADR-039): an interval on screen is credited up
 * to this long after the later of its start and the student's last write to
 * the question. The SQL flush of the `live` module and the sentence of the
 * statistics sheet both read it.
 */
export const DWELL_IDLE_CAP_MS = 600_000;

/**
 * A series' centre and middle half, in the unit of its values, unrounded:
 * what the time spent on a question shows (ADR-039). No extremes, no
 * standard deviation (N-DATA-06).
 */
export interface Spread {
  n: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
}

/**
 * The {@link Spread} of the finite values; anything else is left out. Which
 * values belong in the series is the caller's call (the time: a positive
 * dwell, filtered in the query).
 */
export function spread(values: Iterable<number>): Spread {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    mean: n === 0 ? 0 : sorted.reduce((s, v) => s + v, 0) / n,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
}

/** The time as it may be shown: `null` below `QUESTION_TIME_MIN_N` timed answers. */
export function shownTimeSpread(stats: Spread): Spread | null {
  return stats.n >= QUESTION_TIME_MIN_N ? stats : null;
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
