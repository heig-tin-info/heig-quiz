/**
 * `mcq` grading (docs/04 §4.4, PLAN-MVP §2.1).
 *
 * The five policies live in `@quiz/domain/mcqScore` and are NOT reimplemented
 * here: this module only resolves WHICH policy applies, maps an answer onto
 * that function and onto the item scale. An unanswered question scores 0
 * (F-GRADE-01) and an over-long payload is truncated rather than refused — an
 * answer is never lost.
 *
 * The policy is a three-level hierarchy, resolved here and nowhere else:
 *
 *   1. the teacher's preference (`users.mcq_policy`), which seeds
 *   2. the evaluation's own setting (`evaluations.mcq_policy`), handed over
 *      in `GradeContext.defaults.mcq`, which is what
 *   3. a question configured `inherit` defers to. A question that names a
 *      policy overrides both.
 *
 * `POST /questions/:id/try` — the teacher's Try panel — has NO evaluation, so
 * it passes no `defaults`: an `inherit` question is then graded
 * `all_or_nothing`, the same thing an evaluation would default to.
 */
import type { GradeContext, GradedResult } from "@quiz/core/server";
import { mcqFraction, truncateSelection } from "@quiz/domain/mcqScore";
import { round2 } from "@quiz/domain/round";
import {
  correctIndices,
  MCQ_DEFAULT_POLICY,
  McqDefaultsSchema,
  type McqAnswer,
  type McqConfig,
  type McqDetails,
  type McqPolicy,
} from "./schema.js";

/**
 * The applied policy: the question's own, or the evaluation's when it says
 * `inherit`. A `single` question is always all or nothing — with one key
 * there is nothing to be partial about — whatever either level says.
 */
export function resolvePolicy(
  config: McqConfig,
  defaults: GradeContext["defaults"] | undefined,
): McqPolicy {
  if (config.mode === "single") return "all_or_nothing";
  if (config.policy !== "inherit") return config.policy;
  const parsed = McqDefaultsSchema.safeParse(defaults?.["mcq"]);
  return parsed.success ? parsed.data.policy : MCQ_DEFAULT_POLICY;
}

export function gradeMcq(
  config: McqConfig,
  answer: McqAnswer | null,
  itemPoints: number,
  defaults?: GradeContext["defaults"],
): GradedResult<McqDetails> {
  const policy = resolvePolicy(config, defaults);
  const correct = correctIndices(config);
  const { selected, truncated } = truncateSelection(
    answer === null ? [] : answer.selected,
    config.maxSelections ?? null,
  );
  const score = mcqFraction({
    correct,
    selected,
    choiceCount: config.choices.length,
    policy,
  });

  return {
    kind: "graded",
    points: round2(score.fraction * itemPoints),
    maxPoints: itemPoints,
    // Deterministic: nothing here needs a teacher's eyes.
    state: "validated",
    details: {
      // The APPLIED policy, `inherit` resolved: the teacher panel shows what
      // actually scored this answer, not what the config happens to say now.
      policy,
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
