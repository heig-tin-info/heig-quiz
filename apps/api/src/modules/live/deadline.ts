/**
 * The deadline of an attempt and its bonus, from the evaluation's timing and
 * the participant's extra time (invariant 5, §10).
 */
import { attemptDeadline, bonusSeconds } from "@quiz/domain";

import { settingsOf, type EvaluationRecord } from "../evaluation/service.js";

export interface DeadlineParts {
  deadlineAt: Date | null;
  bonusS: number;
}

/**
 * The ONE place an attempt deadline is computed (§10), for the first start,
 * a retake and a reopen alike. `startedAt` is the student's own start in
 * `duration` timing, and is ignored in `deadline` timing, where the anchor is
 * `closesAt` as it stands and the base of the bonus is the announced window,
 * extensions and pauses taken out (decision D8, #253). `participant` is who
 * holds the attempt, for their extra time; `extraS` what this attempt alone
 * was granted.
 */
export function deadlineFor(
  evaluation: EvaluationRecord,
  participant: { timeBonusPercent: number },
  startedAt: Date,
  extraS: number,
): DeadlineParts {
  const settings = settingsOf(evaluation);
  const base = {
    timing: settings.timing,
    durationS: evaluation.durationS,
    opensAt: evaluation.opensAt,
    closesAt: evaluation.closesAt,
    closesAtShiftS: evaluation.closesAtShiftS,
    timeBonusPercent: participant.timeBonusPercent,
  };
  return {
    deadlineAt: attemptDeadline({ ...base, startedAt, extraS }),
    bonusS: Math.round(bonusSeconds(base)),
  };
}
