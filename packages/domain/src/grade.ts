/**
 * The Swiss grade scale (F-RES, F-EVAL-10, PLAN-MVP §7.1).
 *
 * A grade is 1.0 … 6.0 at one decimal. `linear` maps the full point total onto
 * the scale; `threshold` names the point count that earns a 6, so anything
 * above it is still a 6 — the way a teacher announces "18 points suffisent".
 */
import { roundToTenth, type Rounding } from "./round.js";

export type Scale =
  | { kind: "linear"; rounding?: Rounding | undefined }
  | { kind: "threshold"; threshold: number; rounding?: Rounding | undefined };

export const MIN_GRADE = 1;
export const MAX_GRADE = 6;

/**
 * points -> Swiss grade 1.0 … 6.0 at 0.1.
 *  linear    : 1 + 5 * points / total
 *  threshold : 1 + 5 * points / threshold, capped at 6
 * `total <= 0` gives 1.0; negative points (allowNegative) clamp to 1.0.
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
