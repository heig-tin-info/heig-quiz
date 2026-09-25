/**
 * The Swiss grade scale (F-RES, F-EVAL-10, PLAN-MVP §7.1).
 *
 * A grade is 1.0 … 6.0 at one decimal. `linear` maps the full point total onto
 * the scale; `threshold` names the point count that earns a 6, so anything
 * above it is still a 6 — the way a teacher announces "18 points suffisent".
 */
import { round2, roundToTenth, type Rounding } from "./round.js";

export type Scale =
  | { kind: "linear"; rounding?: Rounding | undefined }
  | { kind: "threshold"; threshold: number; rounding?: Rounding | undefined };

export const MIN_GRADE = 1;
export const MAX_GRADE = 6;

/**
 * points -> Swiss grade 1.0 … 6.0 at 0.1.
 *  linear    : 1 + 5 * points / total
 *  threshold : 1 + 5 * points / threshold, capped at 6
 * `total <= 0` gives 1.0; negative points clamp to 1.0 (a caller that went
 * through {@link attemptTotal} never passes any).
 */
export function gradeFromPoints(points: number, total: number, scale: Scale): number {
  const base = scale.kind === "threshold" ? scale.threshold : total;
  if (!(base > 0)) return MIN_GRADE;
  const raw = 1 + 5 * (points / base);
  return Math.min(MAX_GRADE, Math.max(MIN_GRADE, roundToTenth(raw, scale.rounding ?? "nearest")));
}

/** True when the grade is a pass (4.0 in the Swiss system). */
export function isPassing(grade: number): boolean {
  return grade >= 4;
}

/**
 * THE total of an attempt: the sum of its per-question points, rounded to the
 * granularity of `gradings.points`, and FLOORED AT 0 (ADR-026, #130).
 *
 * Under negative marking a question may be worth less than nothing, and those
 * negative points are stored and shown as such, question by question. The
 * evaluation as a whole is not: a student whose guesses cost more than their
 * right answers earned is brought back to 0, never below. Every total the
 * platform shows — the grade table, the CSV, the release snapshot, the kept
 * attempt of a retake (ADR-025), the student's own cards, the statistics —
 * is computed by this one function, and the grade is computed FROM it, so no
 * two screens can disagree on it.
 *
 * Outside negative marking every item scores in [0, max], and the floor
 * changes nothing.
 */
export function attemptTotal(points: Iterable<number>): number {
  let sum = 0;
  for (const p of points) sum += p;
  // `+ 0` turns a `-0` into a `0`: a total prints as "0", never "-0".
  return Math.max(0, round2(sum)) + 0;
}

/**
 * The points a teacher may give one item by hand (F-GRADE-05): `[0, max]`,
 * or `[-max, max]` for a choice question of an evaluation with negative
 * marking (ADR-026) — the same range the automatic grading can reach, so a
 * correction can land on any score the rule itself could have given.
 */
export function overridePointsRange(
  maxPoints: number,
  negative: boolean,
): { min: number; max: number } {
  return { min: negative ? -maxPoints : 0, max: maxPoints };
}
