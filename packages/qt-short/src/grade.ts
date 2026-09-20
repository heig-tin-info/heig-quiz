/**
 * `short` grading (docs/04 §4.5, PLAN-MVP §2.2).
 *
 * The normalisation pipeline and the six matcher kinds live in
 * `@quiz/domain/short`; the cloze type reuses the same functions, so the two
 * can never drift. This module maps an answer onto them and onto the item
 * scale, nothing more.
 */
import type { GradedResult } from "@quiz/core/server";
import { matchShortAnswer, round2 } from "@quiz/domain";
import type { ShortAnswer, ShortConfig, ShortDetails } from "./schema.js";

export function gradeShort(
  config: ShortConfig,
  answer: ShortAnswer | null,
  itemPoints: number,
): GradedResult<ShortDetails> {
  // An absent answer and an empty one are the same thing: 0 without running a
  // single matcher (F-GRADE-01).
  const match = matchShortAnswer(answer?.text ?? null, config.matchers);
  return {
    kind: "graded",
    points: round2(match.fraction * itemPoints),
    maxPoints: itemPoints,
    state: "validated",
    details: {
      matchedIndex: match.matchedIndex,
      matchedKind: match.matchedKind,
      normalized: match.normalized,
      fraction: match.fraction,
    },
  };
}
