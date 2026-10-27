/**
 * The points of an essay graded by criteria (ADR-118): the grader scores each
 * criterion in WEIGHT units, `0..weight`; the item's points are the scale.
 * This rule turns the one into the other, deterministically, so the
 * breakdown a teacher reads and the total the grading stores agree.
 */
import type { BreakdownEntry } from "@quiz/core/reasons";

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

/** A criterion as the item's version declares it: what a breakdown is checked against. */
export interface DeclaredCriterion {
  id: string;
  title: string;
  weight: number;
}

/** One criterion's points as a teacher (or a proposal) gives them, on the item's scale. */
export interface CriterionPoints {
  id: string;
  points: number;
}

/**
 * Each criterion's maximum on the item's scale, in the criteria's order:
 * `itemPoints × weight / Σweights`, rounded like {@link scaleCriteria}'s.
 */
export function criteriaMaxima(criteria: readonly { weight: number }[], itemPoints: number): number[] {
  return scaleCriteria(
    criteria.map((c) => ({ weight: c.weight, earned: 0 })),
    itemPoints,
  ).criteria.map((c) => c.maxPoints);
}

/**
 * The total of a breakdown: the sum of its points, rounded once and clamped
 * to `[0, itemPoints]`. A teacher grading an essay by criteria never types
 * the total (ADR-118, amendment of 2026-10-27): the form and the server
 * both read it here.
 */
export function breakdownTotal(points: readonly number[], itemPoints: number): number {
  return clamp(
    round2(points.reduce((a, p) => a + p, 0)),
    0,
    Math.max(0, itemPoints),
  );
}

/**
 * The breakdown a validation stores, or `null` when `scored` is not one:
 * every declared criterion named exactly once, no other id, each point
 * finite and within `[0, maxPoints]` of its criterion (on the item's scale,
 * two decimals). The lines follow the DECLARED order, titles from the
 * declaration; `total` is {@link breakdownTotal}. No declared criteria: no
 * breakdown.
 */
export function validatedBreakdown(
  declared: readonly DeclaredCriterion[],
  itemPoints: number,
  scored: readonly CriterionPoints[],
): { breakdown: BreakdownEntry[]; total: number } | null {
  if (declared.length === 0 || scored.length !== declared.length) return null;
  const given = new Map<string, number>();
  for (const s of scored) {
    if (given.has(s.id) || !Number.isFinite(s.points)) return null;
    given.set(s.id, round2(s.points));
  }
  const maxima = criteriaMaxima(declared, itemPoints);
  const breakdown: BreakdownEntry[] = [];
  for (const [i, c] of declared.entries()) {
    const points = given.get(c.id);
    const maxPoints = maxima[i]!;
    if (points === undefined || points < 0 || points > maxPoints) return null;
    breakdown.push({ id: c.id, title: c.title, points, maxPoints });
  }
  return { breakdown, total: breakdownTotal(breakdown.map((l) => l.points), itemPoints) };
}
