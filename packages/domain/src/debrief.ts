/**
 * The class debrief of one item (F-RES-03, ADR-033): how the class fared on
 * it, and what it wrote, grouped and judged.
 *
 * Pure (invariant 8). The caller loads, per counted attempt, the points of
 * its validated grading — or nothing, for a blank — and the question type's
 * aggregate of that one attempt's answer; this rule adds them up.
 */
import type { ItemAggregate } from "@quiz/core/server";

import { round2 } from "./round.js";

/**
 * How one attempt fared on one item. The three answered outcomes are the
 * `correct` / `partial` / `wrong` of `Verdict` (`@quiz/contracts`), which
 * adds `pending` for a proposal; `blank` is no answer at all, not a verdict.
 */
export type ItemOutcome = "correct" | "partial" | "wrong" | "blank";

/**
 * The outcome of an answer worth `points` out of `maxPoints`: full marks,
 * above zero, or zero and below — a negative mark (ADR-026) is wrong.
 */
export function outcomeOf(points: number, maxPoints: number): Exclude<ItemOutcome, "blank"> {
  if (maxPoints > 0 && points >= maxPoints) return "correct";
  return points > 0 ? "partial" : "wrong";
}

/** What one counted attempt contributed to one item. */
export interface AttemptTally {
  /** The validated grading of its answer; `null` when it left the item blank. */
  grading: { points: number; maxPoints: number } | null;
  /** The type's aggregate of this attempt alone; empty for a blank. */
  aggregate: ItemAggregate;
}

/** One answer group, as the debrief shows it. */
export interface DebriefEntry {
  key: string;
  /** What the class wrote; `""` for an empty answer, which the screen names. */
  label: string;
  count: number;
  /** `true` or `false` when every answer of the group agrees, `null` when mixed. */
  correct: boolean | null;
  /** The part of the question the group answers (a cloze blank), or `null`. */
  part: number | null;
}

export interface ItemDebrief {
  outcomes: Record<ItemOutcome, number>;
  /** The mean of `points / maxPoints` over the same attempts, a blank at 0; `null` with none. */
  successRate: number | null;
  /**
   * Every group, most frequent first. Not capped: a part has at most one
   * group per attempt, and a cap would make what is derived from the groups
   * (a blank's right and wrong, "n more answers") lie.
   */
  distribution: DebriefEntry[];
  casePassRate: { name: string; label: string; passed: number; total: number }[];
}

/** The verdict an attempt's outcome lends to what it wrote. */
const lent = (outcome: ItemOutcome): boolean | null =>
  outcome === "correct" ? true : outcome === "wrong" ? false : null;

export function debrief(attempts: readonly AttemptTally[]): ItemDebrief {
  const outcomes: Record<ItemOutcome, number> = { correct: 0, partial: 0, wrong: 0, blank: 0 };
  let earned = 0;
  // A group takes the verdict of its first answer, and `null` for good as
  // soon as another answer of the group disagrees.
  const groups = new Map<string, DebriefEntry>();
  const cases = new Map<string, ItemDebrief["casePassRate"][number]>();
  for (const { grading, aggregate } of attempts) {
    const outcome = grading ? outcomeOf(grading.points, grading.maxPoints) : "blank";
    outcomes[outcome] += 1;
    if (grading && grading.maxPoints > 0) earned += grading.points / grading.maxPoints;
    for (const entry of aggregate.distribution ?? []) {
      // The type's own verdict when it can judge the key alone, else the attempt's.
      const verdict = entry.correct ?? lent(outcome);
      const group = groups.get(entry.key);
      if (group) {
        group.count += entry.count;
        if (group.correct !== verdict) group.correct = null;
      } else {
        groups.set(entry.key, {
          key: entry.key,
          label: entry.label ?? entry.key,
          count: entry.count,
          correct: verdict,
          part: entry.part ?? null,
        });
      }
    }
    for (const c of aggregate.casePassRate ?? []) {
      const acc = cases.get(c.name) ?? { name: c.name, label: c.label ?? c.name, passed: 0, total: 0 };
      acc.passed += c.passed;
      acc.total += c.total;
      cases.set(c.name, acc);
    }
  }
  return {
    outcomes,
    successRate: attempts.length === 0 ? null : round2(earned / attempts.length),
    distribution: [...groups.values()].sort((a, b) => b.count - a.count),
    casePassRate: [...cases.values()],
  };
}
