/**
 * The automatic recall rating of a drill review, strategy A of issue #317
 * (ADR-041 §4): correctness from the grading, speed from the active time
 * against the question's reference time on the same device class.
 */
import type { QuestionTypeId } from "@quiz/core/server";

import type { DrillRating } from "./drillSchedule.js";
import { quantile } from "./stats.js";

/**
 * The question types that become drill cards in v1: graded at once and
 * without a runner. `rich` is graded by hand and `circuit` needs ngspice;
 * `code` and `codeimage` will follow through the browser runner, on a
 * computer only.
 */
export const DRILL_TYPES = ["mcq", "short", "cloze", "categorize"] as const satisfies readonly QuestionTypeId[];

export const isDrillType = (type: string): boolean => (DRILL_TYPES as readonly string[]).includes(type);

/** What the grading said: every point, some points, or none (a blank included). */
export type DrillCorrectness = "right" | "partial" | "wrong";

/** The pointer the review was made with, the test of `useCoarsePointer`: `coarse` is a phone or a tablet. */
export type DrillDeviceClass = "coarse" | "fine";

/** Right, but slower than this multiple of the reference: Hard. */
export const DRILL_SLOW_FACTOR = 1.5;
/** Right, and at most this multiple of the reference: Easy. */
export const DRILL_FAST_FACTOR = 0.6;
/** Correct times needed, on one question and one device class, before their median is the reference. */
export const DRILL_REFERENCE_MIN_N = 10;

/**
 * Correctness from a grading's points. Negative marking (ADR-026) makes a
 * negative score: wrong. No positive maximum: nothing to be right about.
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
 * `DRILL_REFERENCE_MIN_N` exist, else the student's own previous time, else
 * the type's estimate, else none.
 */
export function drillReferenceMs(input: DrillReferenceInput): number | null {
  if (input.correctTimesMs.length >= DRILL_REFERENCE_MIN_N) {
    return quantile(
      [...input.correctTimesMs].sort((a, b) => a - b),
      0.5,
    );
  }
  return input.previousOwnMs ?? input.typeDefaultMs;
}

export interface DrillRatingInput {
  correctness: DrillCorrectness;
  /** Time the question was on a visible screen, measured by the server (the clock pauses while the tab is hidden). */
  activeMs: number;
  /** From `drillReferenceMs`. Null: time is not judged, a right answer is Good. */
  referenceMs: number | null;
}

/**
 * wrong → 1 Again; partial, or right in more than 1.5 × ref → 2 Hard;
 * right in at most 0.6 × ref → 4 Easy; otherwise right → 3 Good.
 */
export function drillRating({ correctness, activeMs, referenceMs }: DrillRatingInput): DrillRating {
  if (correctness === "wrong") return 1;
  if (correctness === "partial") return 2;
  if (referenceMs === null || referenceMs <= 0) return 3;
  if (activeMs > DRILL_SLOW_FACTOR * referenceMs) return 2;
  if (activeMs <= DRILL_FAST_FACTOR * referenceMs) return 4;
  return 3;
}
