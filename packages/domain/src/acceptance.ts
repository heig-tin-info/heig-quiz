/**
 * Accepting an answer at grading time (ADR-128): a teacher counts right, on
 * one item of one evaluation, an answer the key counts wrong — at one part
 * of the question (a cloze blank), for everyone who gave it or for one
 * attempt. The pool question is never touched.
 *
 * What an answer's parts and identities ARE is the question type's
 * (`QuestionTypeServer.acceptance`); these are the rules around them that
 * the API and the grading screen share, so the count the screen announces
 * and the cells the server re-grades are one computation.
 */

import type { AcceptedAnswer } from "@quiz/core/server";

/** Who an acceptance reaches: everyone who gave the answer (the default), or one attempt. */
export const ACCEPTANCE_SCOPES = ["everyone", "student"] as const;
export type AcceptanceScope = (typeof ACCEPTANCE_SCOPES)[number];

/**
 * The scopes an item offers, the one rule. Only "this student only" when
 * the same answer is not the same from one student to the next:
 *
 *  - a parameterized question (ADR-056 §9) gives each student their own key;
 *  - the type says its answers depend on the rest of the answer
 *    (`singleAnswer` of its hook: a card's rank in an ordered categorize
 *    column, which every card above it moves).
 */
export function acceptanceScopes(item: { parameterized: boolean; singleAnswer: boolean }): readonly AcceptanceScope[] {
  return item.parameterized || item.singleAnswer ? ["student"] : ACCEPTANCE_SCOPES;
}

/** One acceptance in force on an item; `attemptId` null reaches everyone. */
export interface AcceptanceRule extends AcceptedAnswer {
  attemptId: string | null;
}

/**
 * The acceptances one attempt is graded with: the item's rules for everyone
 * and its own. A PRACTICE attempt (ADR-122) gets none: it, like the drill,
 * is graded against the pool's key.
 */
export function rulesForAttempt(
  rules: readonly AcceptanceRule[],
  attempt: { id: string; practice: boolean },
): AcceptedAnswer[] {
  if (attempt.practice) return [];
  return rules
    .filter((r) => r.attemptId === null || r.attemptId === attempt.id)
    .map(({ part, answer }) => ({ part, answer }));
}

/** One answer of the item as the reach reads it. */
export interface AcceptanceCell {
  attemptId: string;
  /** The parts of the answer a rule can name, with their identities (the type's `given`). */
  given: readonly AcceptedAnswer[];
  /** The grading in force is a teacher's manual override (F-GRADE-05). */
  manual: boolean;
}

/**
 * The answers an acceptance — or its removal — reaches: those that gave
 * `rule.answer` at `rule.part`, within the rule's scope. A manual override
 * is the teacher's word on that answer and is left alone (ADR-128 §5):
 * those are `unchanged`, the rest are `reached` and re-graded.
 */
export function acceptanceReach(
  cells: readonly AcceptanceCell[],
  rule: AcceptanceRule,
): { reached: string[]; unchanged: string[] } {
  const reached: string[] = [];
  const unchanged: string[] = [];
  for (const cell of cells) {
    if (rule.attemptId !== null && cell.attemptId !== rule.attemptId) continue;
    if (!cell.given.some((g) => g.part === rule.part && g.answer === rule.answer)) continue;
    (cell.manual ? unchanged : reached).push(cell.attemptId);
  }
  return { reached, unchanged };
}
