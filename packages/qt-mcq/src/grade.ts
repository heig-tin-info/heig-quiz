/**
 * `mcq` grading (docs/04 §4.4, PLAN-MVP §2.1).
 *
 * The three policies live in `@quiz/domain/mcqScore` and are NOT reimplemented
 * here: this module only maps an answer onto that function and onto the item
 * scale. An unanswered question scores 0 (F-GRADE-01) and an over-long payload
 * is truncated rather than refused — an answer is never lost.
 */
import type { GradedResult } from "@quiz/core/server";
import { mcqFraction, round2, truncateSelection } from "@quiz/domain";
import { correctIndices, type McqAnswer, type McqConfig, type McqDetails } from "./schema.js";

export function gradeMcq(
  config: McqConfig,
  answer: McqAnswer | null,
  itemPoints: number,
): GradedResult<McqDetails> {
  const correct = correctIndices(config);
  const { selected, truncated } = truncateSelection(
    answer === null ? [] : answer.selected,
    config.maxSelections ?? null,
  );
  const score = mcqFraction({
    correct,
    selected,
    choiceCount: config.choices.length,
    policy: config.policy,
    penalty: config.penalty,
    allowNegative: config.allowNegative,
  });

  return {
    kind: "graded",
    points: round2(score.fraction * itemPoints),
    maxPoints: itemPoints,
    // Deterministic: nothing here needs a teacher's eyes.
    state: "validated",
    details: {
      policy: config.policy,
      correct,
      selected,
      c: score.c,
      w: score.w,
      C: score.C,
      W: score.W,
      fraction: score.fraction,
      truncated,
    },
  };
}
