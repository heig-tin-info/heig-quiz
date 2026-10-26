/**
 * The points of an essay graded by criteria (ADR-118): the grader scores each
 * criterion in WEIGHT units, `0..weight`; the item's points are the scale.
 * This rule turns the one into the other, deterministically, so the
 * breakdown a teacher reads and the total the grading stores agree.
 */
import { clamp, round2 } from "./round.js";

export interface CriterionScore {
  /** The criterion's weight, its maximum in the grader's units. */
  weight: number;
  /** What the grader gave it, in the same units; clamped to `[0, weight]` here. */
  earned: number;
}

export interface ScaledCriterion {
  /** `itemPoints × earned / Σweights`, rounded to two decimals. */
  points: number;
  /** `itemPoints × weight / Σweights`, rounded to two decimals. */
  maxPoints: number;
}

export interface ScaledCriteria {
  /** In the order given: a caller maps them back by index. */
  criteria: ScaledCriterion[];
  /**
   * `itemPoints × Σearned / Σweights`, rounded once and clamped to
   * `[0, itemPoints]`. It comes from the RAW sum, never from the rounded
   * parts: three criteria of weight 1 on 2 points show 0.67 each, and all
   * three earned make 2, not 2.01.
   */
  total: number;
}

/**
 * Scales criteria scored in weight units to an item worth `itemPoints`.
 * A total weight of zero (no criteria, or only empty ones) scales every
 * criterion and the total to 0 rather than dividing by it.
 */
export function scaleCriteria(criteria: readonly CriterionScore[], itemPoints: number): ScaledCriteria {
  const weights = criteria.map((c) => Math.max(0, c.weight));
  const sum = weights.reduce((a, w) => a + w, 0);
  const earned = criteria.map((c, i) => clamp(Number.isFinite(c.earned) ? c.earned : 0, 0, weights[i]!));
  const scale = (x: number) => (sum === 0 ? 0 : round2((itemPoints * x) / sum));
  return {
    criteria: criteria.map((_, i) => ({ points: scale(earned[i]!), maxPoints: scale(weights[i]!) })),
    total: clamp(scale(earned.reduce((a, e) => a + e, 0)), 0, Math.max(0, itemPoints)),
  };
}
