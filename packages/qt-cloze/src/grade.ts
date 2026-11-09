/**
 * `cloze` grading (docs/04 §4.6, PLAN-MVP §2.3).
 *
 * `gradeCloze` in `@quiz/domain/cloze` owns the rule — weighted sum of the
 * blanks that match, matching itself reusing the `short` normalisation — so
 * this module only parses the text once and maps the fraction onto the item.
 */
import type { AcceptedAnswer, GradedResult } from "@quiz/core/server";
import { clozePartIndex, gradeCloze, parseCloze, type ClozeAccepted } from "@quiz/domain/cloze";
import { round2 } from "@quiz/domain/round";
import type { ClozeAnswer, ClozeConfig, ClozeDetails } from "./schema.js";

export function gradeClozeAnswer(
  config: ClozeConfig,
  answer: ClozeAnswer | null,
  itemPoints: number,
  accepted: readonly AcceptedAnswer[] = [],
): GradedResult<ClozeDetails> {
  const parse = parseCloze(config.text);
  // An absent answer is an array of untouched blanks: every one of them is
  // wrong, and the item scores 0 (F-GRADE-01).
  const grade = gradeCloze(parse, answer?.blanks ?? [], config.caseSensitive, acceptedByBlank(accepted));
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

/** The acceptances of the context (ADR-128), blank by blank; a part naming no blank is ignored. */
function acceptedByBlank(accepted: readonly AcceptedAnswer[]): ClozeAccepted {
  const byBlank = new Map<number, Set<string>>();
  for (const { part, answer } of accepted) {
    const index = clozePartIndex(part);
    if (index === null) continue;
    const set = byBlank.get(index) ?? new Set<string>();
    set.add(answer);
    byBlank.set(index, set);
  }
  return byBlank;
}
