/**
 * The automatic recall rating of a drill review, strategy A of issue #317
 * (ADR-041 §4): correctness from the grading, speed from the active time
 * against the question's reference time on the same device class.
 */
import type { DrillRating } from "./drillSchedule.js";
import { quantile } from "./stats.js";

/** What the grading said: every point, some points, or none (a blank included). */
export type DrillCorrectness = "right" | "partial" | "wrong";

/** The pointer the review was made with, the test of `useCoarsePointer`: `coarse` is a phone or a tablet. */
export type DrillDeviceClass = "coarse" | "fine";

/** Right, but slower than this multiple of the reference: Hard (ADR-041 §4). */
export const DRILL_SLOW_FACTOR = 1.5;
/** Right, and at most this multiple of the reference: Easy. */
export const DRILL_FAST_FACTOR = 0.6;
/** Correct times needed, on one question and one device class, before their median is the reference. */
export const DRILL_REFERENCE_MIN_N = 10;

/**
 * Correctness from a grading's points: all of them right, none wrong, the
 * rest partial. Negative marking (ADR-026) makes a negative score: wrong.
 * No positive maximum: nothing to be right about.
 */
export function drillCorrectness(points: number, maxPoints: number): DrillCorrectness {
  if (maxPoints <= 0 || points <= 0) return "wrong";
  return points >= maxPoints ? "right" : "partial";
}

export interface DrillReferenceInput {
  /** Active times (ms) of the CORRECT reviews of this question, by every student, on the review's device class. */
  correctTimesMs: readonly number[];
  /** The student's own previous correct time on this question, on the same class, if any. */
  previousOwnMs: number | null;
  /** The estimate per question type, used when nothing was measured yet. */
  typeDefaultMs: number | null;
}

/**
 * The reference time of a question: the median of the correct times once
 * there are `DRILL_REFERENCE_MIN_N`, else the student's own previous time,
 * else the type's estimate, else none.
 */
export function drillReferenceMs(input: DrillReferenceInput): number | null {
  const n = input.correctTimesMs.length;
  return drillReferenceOf({
    correctCount: n,
    correctMedianMs: n === 0 ? null : quantile([...input.correctTimesMs].sort((a, b) => a - b), 0.5),
    previousOwnMs: input.previousOwnMs,
    typeDefaultMs: input.typeDefaultMs,
  });
}

/** {@link DrillReferenceInput} already aggregated: what a database computes in one query. */
export interface DrillReferenceSummary {
  /** How many correct reviews there are, on this question and this device class. */
  correctCount: number;
  /** Their median (linear interpolation, `percentile_cont(0.5)`); null when there are none. */
  correctMedianMs: number | null;
  previousOwnMs: number | null;
  typeDefaultMs: number | null;
}

/** THE rule of {@link drillReferenceMs}, on the aggregates rather than on every time. */
export function drillReferenceOf(input: DrillReferenceSummary): number | null {
  if (input.correctCount >= DRILL_REFERENCE_MIN_N && input.correctMedianMs !== null) return input.correctMedianMs;
  return input.previousOwnMs ?? input.typeDefaultMs;
}

export interface DrillRatingInput {
  correctness: DrillCorrectness;
  /** Time the question was on a visible screen, summed by the server (the clock pauses while the tab is hidden). */
  activeMs: number;
  /** From `drillReferenceMs`. Null: time is not judged, a right answer is Good. */
  referenceMs: number | null;
}

/**
 * wrong → Again; partial, or right slower than `DRILL_SLOW_FACTOR` × ref →
 * Hard; right within `DRILL_FAST_FACTOR` × ref → Easy; otherwise right →
 * Good. The thresholds are ADR-041 §4's table.
 */
export function drillRating({ correctness, activeMs, referenceMs }: DrillRatingInput): DrillRating {
  if (correctness === "wrong") return 1;
  if (correctness === "partial") return 2;
  if (referenceMs === null || referenceMs <= 0) return 3;
  if (activeMs > DRILL_SLOW_FACTOR * referenceMs) return 2;
  if (activeMs <= DRILL_FAST_FACTOR * referenceMs) return 4;
  return 3;
}
