/**
 * Descriptive statistics for the results screens (PLAN-MVP §7.6), and the
 * item analysis of a question in its pool (ADR-038): the mean success rate
 * over the answers counted, reported with their number and shown only from
 * `QUESTION_STATS_MIN_N` answers on — the time spent on it (ADR-039) and
 * its discrimination index (ADR-040).
 */
import { MAX_GRADE, MIN_GRADE } from "./grade.js";
import { clamp, round2 } from "./round.js";

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

/**
 * The discrimination index of a question (ADR-040): does it separate the
 * students who did well on the rest of the test from those who did not? A
 * corrected point-biserial — the Pearson correlation between the item's
 * score and the rest of the test WITHOUT it — per exam, combined over the
 * exams by Fisher's z.
 */

/** An exam with fewer other items than this says too little about "the rest of the test". */
export const DISCRIMINATION_MIN_ITEMS = 5;

/** An exam with fewer counted attempts than this is left out of the index. */
export const DISCRIMINATION_MIN_N = 10;

/**
 * The Pearson correlation of two paired series; `null` when it does not
 * exist — fewer than two pairs, or no variance on either side.
 */
export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i]!;
    my += ys[i]!;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  // Below this, a "variance" is the rounding error of identical values.
  if (sxx < 1e-12 || syy < 1e-12) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * One counted attempt of an exam: which attempt, the question's own points,
 * and the rest of the test — the points and the maximum of every OTHER
 * item, summed.
 */
export interface DiscriminationAttempt {
  attemptId: string;
  item: ScoredAnswer;
  rest: ScoredAnswer;
}

/** One exam's correlation, with the attempts it rests on. */
export interface DiscriminationSample {
  evaluationId: string;
  r: number;
  attemptIds: readonly string[];
}

/**
 * The corrected point-biserial of a question in ONE exam: the correlation
 * of the item's ratio (signed, unclamped) with the rest-of-test ratio.
 * `null` when the exam has fewer than {@link DISCRIMINATION_MIN_ITEMS}
 * other items, fewer than {@link DISCRIMINATION_MIN_N} attempts with a
 * positive maximum on both sides, or no variance on either side.
 */
export function evaluationDiscrimination(
  evaluationId: string,
  attempts: Iterable<DiscriminationAttempt>,
  otherItems: number,
): DiscriminationSample | null {
  if (otherItems < DISCRIMINATION_MIN_ITEMS) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  const attemptIds: string[] = [];
  for (const { attemptId, item, rest } of attempts) {
    if (item.maxPoints <= 0 || rest.maxPoints <= 0) continue;
    xs.push(item.points / item.maxPoints);
    ys.push(rest.points / rest.maxPoints);
    attemptIds.push(attemptId);
  }
  if (attemptIds.length < DISCRIMINATION_MIN_N) return null;
  const r = pearson(xs, ys);
  return r === null ? null : { evaluationId, r, attemptIds };
}

/** Keeps `atanh` finite on a perfect correlation. */
const R_LIMIT = 0.9999;

/**
 * A question's discrimination index, over `evaluations` distinct exams and
 * `n` distinct attempts.
 */
export interface Discrimination {
  r: number;
  evaluations: number;
  n: number;
}

/**
 * The index as it may be shown: the qualifying samples combined by Fisher's
 * z — `atanh(r)` averaged with the weight `n - 3` (the inverse of its
 * variance), back-transformed —, rounded to two decimals; `null` when no
 * exam qualifies (each `null` of {@link evaluationDiscrimination} is
 * skipped). Every sample holds at least {@link DISCRIMINATION_MIN_N}
 * attempts, so every weight is positive. A question placed twice in one
 * exam gives two samples but counts one exam, and its attempts once.
 */
export function discrimination(samples: Iterable<DiscriminationSample | null>): Discrimination | null {
  const kept = [...samples].filter((s): s is DiscriminationSample => s !== null);
  if (kept.length === 0) return null;
  let weights = 0;
  let sum = 0;
  for (const { r, attemptIds } of kept) {
    const w = attemptIds.length - 3;
    sum += w * Math.atanh(clamp(r, -R_LIMIT, R_LIMIT));
    weights += w;
  }
  return {
    r: round2(Math.tanh(sum / weights)),
    evaluations: new Set(kept.map((s) => s.evaluationId)).size,
    n: new Set(kept.flatMap((s) => s.attemptIds)).size,
  };
}

/** From this index on, a question discriminates fairly (ADR-040). */
export const DISCRIMINATION_FAIR = 0.2;

/** From this index on, a question discriminates well (ADR-040). */
export const DISCRIMINATION_GOOD = 0.3;

/**
 * The reading of an index: below {@link DISCRIMINATION_FAIR} weak, then
 * fair, from {@link DISCRIMINATION_GOOD} good — and `inverse` below zero,
 * where the stronger students do WORSE on the question (a wrong key, an
 * ambiguous wording).
 */
export type DiscriminationBand = "inverse" | "weak" | "fair" | "good";

export function discriminationBand(r: number): DiscriminationBand {
  if (r < 0) return "inverse";
  if (r < DISCRIMINATION_FAIR) return "weak";
  if (r < DISCRIMINATION_GOOD) return "fair";
  return "good";
}

/**
 * The distractor analysis of a choice question (ADR-041): which option the
 * counted answers picked, as whole-percent shares. It reads only the answers
 * given to the versions whose options are the latest version's own.
 */

/**
 * The versions that share the LATEST one's key, going back from it until
 * the first one that differs: a contiguous run, never a version from before
 * a change, even when a later edit put the options back. `ascending` is in
 * version order; a `null` key (a version that cannot be read) matches
 * nothing and ends the run — and an unreadable latest version gives none.
 */
export function latestRun<T>(ascending: readonly T[], keyOf: (version: T) => string | null): T[] {
  const latest = ascending.at(-1);
  const key = latest === undefined ? null : keyOf(latest);
  if (key === null) return [];
  let start = ascending.length - 1;
  while (start > 0 && keyOf(ascending[start - 1]!) === key) start -= 1;
  return ascending.slice(start);
}

/** What the counted answers picked, as whole percents of `n`. */
export interface OptionShares {
  /** One share per option, in the options' order. */
  options: number[];
  /** The answers that picked nothing: blank, skipped, not reached on an older attempt. */
  none: number;
}

/**
 * The shares as they may be shown: each count over `n`, rounded to a whole
 * percent on its own — so a single-choice question may sum to 99 or 101,
 * and a multiple-choice one well above 100, since an answer may pick several
 * options. `null` below {@link QUESTION_STATS_MIN_N} answers: the threshold
 * of the success rate, applied to this analysis's own `n` (ADR-041). Never a
 * count, only a share (N-DATA-06).
 */
export function optionShares(counts: readonly number[], none: number, n: number): OptionShares | null {
  if (n < QUESTION_STATS_MIN_N) return null;
  const share = (count: number) => Math.round((100 * count) / n);
  return { options: counts.map(share), none: share(none) };
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
