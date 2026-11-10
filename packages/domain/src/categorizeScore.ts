/**
 * The scoring rules of the `categorize` question type (docs/04 §4.13,
 * ADR-036). This module is the REFERENCE for what each policy means;
 * `packages/qt-categorize` only reduces an answer to the counts below.
 *
 * A question holds CARDS and COLUMNS. A card the key puts in a column is a
 * TARGET; a card the key puts in no column is a DISTRACTOR, which the student
 * is expected to leave in the tray. Notation, for one answer:
 *
 *   T = targets, D = distractors, n = T + D, k = number of columns (≥ 2)
 *   t = targets in their column (and at their rank when the order counts)
 *   x = targets placed, but in the wrong column or at the wrong rank
 *   p = distractors placed in a column (the rest, D − p, were left out)
 *
 * The tray is where a card nobody placed stays, so an EMPTY answer leaves
 * every distractor "right" — and would earn D/n for doing nothing. It does
 * not: an answer that places no card at all scores 0, whatever the policy.
 *
 * `per_item` — every card is worth 1/n, a distractor left in the tray counts.
 *
 *     f = (t + D − p) / n
 *
 * `all_or_nothing` — every target at its place and no distractor placed.
 *
 *     f = (t === T && p === 0) ? 1 : 0
 *
 * Both lie in [0, 1]. With "the order counts", a target is right only at its
 * exact rank: a card missing near the top of a column shifts every card
 * under it (ADR-036 accepts that cascade, for a rule a student can check).
 *
 * NEGATIVE MARKING (ADR-026, extended to this type by ADR-036) is a setting
 * of the evaluation and overrides the policy, as it does for `mcq`: a
 * placed card is a bet among k columns.
 *
 *     f = (t − (x + p) / (k − 1)) / T,   NOT floored, in [−1, 1]
 *
 *   A target is +1 in its column and −1/(k − 1) in another one, so placing a
 *   target at random has an expected value of 0 (without "the order
 *   counts"). A card left in the tray is 0, target or distractor: no answer
 *   costs nothing, and leaving a distractor out earns nothing either — it is
 *   the absence of an answer. The evaluation's TOTAL is floored at 0
 *   elsewhere (`attemptTotal`).
 */
import { clamp } from "./round.js";

/** The policies of a `categorize` question: the one list of their names. */
export const CATEGORIZE_SCORE_POLICIES = ["per_item", "all_or_nothing"] as const;
export type CategorizeScorePolicy = (typeof CATEGORIZE_SCORE_POLICIES)[number];

/** The fallback wherever no policy was expressed. */
export const DEFAULT_CATEGORIZE_SCORE_POLICY = "per_item" satisfies CategorizeScorePolicy;

export interface CategorizeCounts {
  /** Targets: cards the key puts in a column. */
  T: number;
  /** Distractors: cards the key puts in no column. */
  D: number;
  /** Targets at their place. */
  t: number;
  /** Targets placed at a wrong place. */
  x: number;
  /** Distractors placed in a column. */
  p: number;
}

export interface CategorizeScoreInput extends CategorizeCounts {
  /** Number of columns. */
  k: number;
  policy: CategorizeScorePolicy;
  /** The evaluation scores with negative marking (ADR-026): `policy` is ignored. */
  negativeMarking?: boolean | undefined;
}

/**
 * One card of an answer, judged: whether the key puts it in a column (a
 * target), whether the student placed it, whether it is at its place — and
 * whether it is right only because the teacher accepted where the student
 * put it (ADR-128).
 */
export interface CategorizeCardOutcome {
  target: boolean;
  placed: boolean;
  right: boolean;
  accepted?: boolean;
}

/**
 * The counts of one answer. An ACCEPTED card counts as right under every
 * policy, negative marking included (ADR-128, product owner):
 *
 *  - a target accepted where the student put it is at its place: `t`, no
 *    longer `x` — so an all-or-nothing answer may go from 0 to full;
 *  - a distractor accepted where the student put it stays a distractor, and
 *    is no longer counted against them: right means "as if left out", so it
 *    leaves `p` and stays in `D`. It never raises `T`: under negative marking
 *    a student who placed it scores exactly as one who rightly left it out.
 */
export function categorizeCounts(cards: readonly CategorizeCardOutcome[]): CategorizeCounts {
  const counts = { T: 0, D: 0, t: 0, x: 0, p: 0 };
  for (const card of cards) {
    const accepted = card.accepted === true;
    if (card.target) {
      counts.T += 1;
      if (card.right || accepted) counts.t += 1;
      else if (card.placed) counts.x += 1;
    } else {
      counts.D += 1;
      if (card.placed && !accepted) counts.p += 1;
    }
  }
  return counts;
}

export function categorizeFraction(input: CategorizeScoreInput): number {
  const { T, D, t, x, p, k } = input;
  // T === 0 is refused by the config schema; staying total keeps a corrupted
  // row from throwing inside the grading worker.
  if (T === 0) return 0;
  if (input.negativeMarking === true) {
    return clamp((t - (x + p) / Math.max(1, k - 1)) / T, -1, 1);
  }
  if (t + x + p === 0) return 0;
  switch (input.policy) {
    case "per_item":
      return clamp((t + D - p) / (T + D), 0, 1);
    case "all_or_nothing":
      return t === T && p === 0 ? 1 : 0;
  }
}
