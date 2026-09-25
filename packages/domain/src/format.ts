/**
 * The two written forms of a score (FF-21, invariant 8).
 *
 * The platform shows numbers of exactly two kinds and they are not written
 * the same way:
 *
 *  - points, the currency of a grading (`numeric(6,2)`): at most two
 *    decimals and no trailing zeroes, because `3 / 5` reads better than
 *    `3.00 / 5.00` on a cell a teacher scans;
 *  - a grade, the Swiss 1.0 … 6.0 scale: always one decimal, because a `4`
 *    without its tenth is not how a grade is written here.
 *
 * Both live in the domain so that a list, a detail, a table, a histogram and
 * a student's feedback cannot drift apart — they were seven one-liners.
 */
import { clamp, round2 } from "./round.js";

/**
 * Points: at most two decimals, no trailing zeroes (`3` , `2.5`, `2.33`).
 *
 * The rounding is the platform's own (`round2`, decision D13: half away from
 * zero, epsilon-corrected), not `Math.round`, so a penalised answer does not
 * lose half a hundredth to the rounding direction.
 */
export function formatPoints(n: number): string {
  // `String(-0)` is "0", which is what a cell should show for a zero score.
  return String(round2(n));
}

/**
 * A grade: always one decimal, the way a Swiss grade is written (`4.0`).
 *
 * Grades reach the client already rounded to a tenth by `gradeFromPoints`,
 * so this only fixes the written form; it is not a second rounding pass.
 */
export function formatGrade(n: number): string {
  return n.toFixed(1);
}

/**
 * A success rate as a screen shows it: clamped to [0, 1]. Under negative
 * marking (ADR-026) the class's mean fraction on a choice question may fall
 * below 0; "-12 %" of success means nothing to a reader, so the screens show
 * 0 %, while the raw value stays what the API and the CSV carry.
 */
export function displayedRate(rate: number): number {
  return clamp(rate, 0, 1);
}
