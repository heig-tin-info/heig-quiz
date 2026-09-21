/**
 * `cloze` grading (docs/04 §4.6, PLAN-MVP §2.3).
 *
 * `gradeCloze` in `@quiz/domain/cloze` owns the rule — weighted sum of the
 * blanks that match, matching itself reusing the `short` normalisation — so
 * this module only parses the text once and maps the fraction onto the item.
 */
import type { GradedResult } from "@quiz/core/server";
import { gradeCloze, parseCloze, round2 } from "@quiz/domain";
import type { ClozeAnswer, ClozeConfig, ClozeDetails } from "./schema.js";

export function gradeClozeAnswer(
  config: ClozeConfig,
  answer: ClozeAnswer | null,
  itemPoints: number,
): GradedResult<ClozeDetails> {
  const parse = parseCloze(config.text);
  // An absent answer is an array of untouched blanks: every one of them is
  // wrong, and the item scores 0 (F-GRADE-01).
  const grade = gradeCloze(parse, answer?.blanks ?? [], config.caseSensitive);
  return {
    kind: "graded",
    points: round2(grade.fraction * itemPoints),
    maxPoints: itemPoints,
    state: "validated",
    details: {
      perBlank: grade.perBlank,
      earned: grade.earned,
      total: grade.total,
      fraction: grade.fraction,
    },
  };
}
