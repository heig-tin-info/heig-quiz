/**
 * Rounding, half away from zero (PLAN-MVP §7.1, decision D13).
 *
 * `Math.round` rounds half toward +Infinity, so `Math.round(-0.5)` is `-0`:
 * a penalised MCQ could lose a half point to the rounding direction. Every
 * rounding in the platform therefore goes through this module.
 */

export type Rounding = "nearest" | "up" | "down";

/** The epsilon absorbs binary representation error (0.1 * 3 is 0.30000000000000004). */
const EPSILON = 1e-9;

function roundHalfAwayFromZero(scaled: number): number {
  return Math.round(scaled + (scaled >= 0 ? EPSILON : -EPSILON));
}

/** Rounds to one decimal, half away from zero (never banker's rounding). */
export function roundToTenth(x: number, mode: Rounding = "nearest"): number {
  const scaled = x * 10;
  const r =
    mode === "up"
      ? Math.ceil(scaled - EPSILON)
      : mode === "down"
        ? Math.floor(scaled + EPSILON)
        : roundHalfAwayFromZero(scaled);
  return r / 10;
}

/**
 * Rounds to two decimals, half away from zero. This is the granularity of
 * `gradings.points` (`numeric(6,2)`): every grader ends with `round2()`.
 */
export function round2(x: number): number {
  return roundHalfAwayFromZero(x * 100) / 100;
}

/** Clamps into `[lo, hi]`. Used by every fraction computation. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
