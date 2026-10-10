/**
 * THE view of one item of one attempt (ADR-097): the seed, the item, the
 * per-type settings and — above all — whether its choices are shuffled.
 *
 * A student names a choice by the position it was displayed at, and the
 * server converts at its single entry (`answerFromStudent`) and exit
 * (`studentViewOf`, `answerToStudent`). Both ends must therefore compute the
 * SAME view, or a position is decoded through another permutation than the
 * one it was picked in and a wrong answer is stored without a sound. So the
 * view is computed here and nowhere else on the student path: the attempt
 * builder, the answer write and its stale reply, the feedback page, and a
 * partial retake's carried-over items, which are re-read under the new
 * attempt's seed.
 *
 * The shuffle decision reads FROZEN data only: the evaluation's switch, which
 * locks at the first attempt (`configLock`), and the item's frozen instance,
 * whose `shuffleable(config)` already holds the question's own setting
 * (`shuffleChoices`, `shuffleOptions`, …). Never the live
 * `questions.shuffleable` column, which a write may change during an exam —
 * which also keeps a student's order stable, as F-EVAL-09 asks. A poll never
 * shuffles: the room reads the beamer's order and the tally counts by
 * canonical index (ADR-014).
 */
import type { StudentView } from "@quiz/core/server";

import { gradeDefaults, settingsOf, type EvaluationRecord, type JoinedItem } from "../evaluation/service.js";
import { itemInstance, loadConfig, typeOf, type InstanceAttempt } from "../pool/service.js";

export interface ItemView {
  /** The registered question-type id. */
  type: string;
  /** The item's frozen instance (ADR-056): the attempt's own values for a parameterized question. */
  instance: ReturnType<typeof itemInstance>;
  /** The instance's config, parsed through the one pipeline (`loadConfig`). */
  config: unknown;
  view: StudentView;
}

/** Whether `evaluation` shuffles the choices of `config`: its switch AND the config's own, never in a poll. */
function shufflesChoices(evaluation: EvaluationRecord, type: string, config: unknown): boolean {
  return evaluation.mode !== "poll" && settingsOf(evaluation).shuffleChoices && typeOf(type).shuffleable(config);
}

/** The view `attempt` was (or, for a preview, would be) served of `entry`. */
export function attemptItemView(
  evaluation: EvaluationRecord,
  entry: JoinedItem,
  attempt: InstanceAttempt,
): ItemView {
  const type = entry.question.type;
  const instance = itemInstance(entry, attempt);
  const config = loadConfig(type, instance.version);
  return {
    type,
    instance,
    config,
    view: {
      seed: attempt.seed,
      itemId: entry.item.id,
      shuffle: shufflesChoices(evaluation, type, config),
      // What the student must know before answering: `mcq`'s negative marking (ADR-026).
      defaults: gradeDefaults(evaluation),
    },
  };
}
