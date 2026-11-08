/**
 * Everything the `live` module refuses: the refusal table, the error classes
 * and the failure arms the `live` and `poll` routes answer in their own shape
 * (the 410 of §4.7). Imported through `./service.ts`.
 */
import type { AttemptClosed } from "@quiz/contracts";
import type { PracticeRefusal, RetakeRefusal } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import { refusalClass, type FailureArms, type Refusal } from "../http.js";

/**
 * Everything this module refuses, by code: its status and, where the
 * refusal reads the same wherever it is thrown, its message.
 */
const REFUSALS = {
  // The 410 of §4.7, `AttemptClosedError`.
  attempt_closed: [410],
  // Reopening gives a student their paper back, which only means something
  // while the evaluation still takes writes: `running` or `paused`; anywhere
  // else a reopened attempt would be `in_progress` and yet unusable (#95).
  evaluation_not_live: [409, "the evaluation is not running or paused"],
  // Extra time on a finished evaluation (`closed`, `released`) moves a
  // deadline nobody can use any more; the dashboard offers no `+N min` there.
  evaluation_finished: [409, "the evaluation is already closed"],
  // `RetakeRefused`.
  retake_refused: [409],
  // `PracticeRefused` (ADR-122).
  practice_refused: [409],
  // ADR-091: a question a partial retake carried over is the previous
  // attempt's, as it stood: no write of any kind reaches it.
  item_acquired: [409, "this question was acquired in the previous attempt and is kept as it is"],
  // An exercise that allows several attempts reopens none (ADR-025): the
  // student starts another attempt instead, which is what retakes are for.
  retakes_enabled: [409, "this exercise allows retakes: the student starts a new attempt"],
  // ADR-050: a reopened student would rewrite their answers with the
  // correction in hand.
  correction_published: [409, "the correction of this exercise is published: no attempt is reopened"],
  // ADR-125: a paper copy was handed in whole by the staff, and a replaced
  // attempt counts nowhere: neither goes back to a student's screen.
  not_reopenable: [409, "a paper copy, or an attempt a paper copy replaced, is not reopened"],
  not_open: [409, "this evaluation is not open"],
  // `AnswerInvalid`.
  answer_invalid: [422],
  irreversible: [409, "a validated question cannot be re-opened"],
  // "I won't answer" on a question that holds an answer (#89): skipping is
  // not a way to throw an answer away.
  answered: [409, "this question holds an answer"],
  // `done: true` where there is nothing to validate: a `free` evaluation, or
  // a question that is not a checkpoint in `milestones` (#89).
  not_validatable: [409, "this question has no validation step"],
  item_locked: [409, "navigation does not allow going back to this question"],
  // ADR-124 §3, the refusals of `@quiz/domain#checkRefusal`: a check off an
  // exercise, a question checked already (and every later write to it), an
  // empty question.
  not_checkable: [409, "only a question of an exercise can be checked"],
  item_checked: [409, "this question was checked: it is locked for this attempt"],
  nothing_to_check: [422, "an empty question cannot be checked"],
  // `RateLimited`.
  rate_limited: [429],
  // `RunnerDown`.
  runner_unavailable: [503],
  not_runnable: [422, "this question type has nothing to run"],
  // The type CAN run, and this answer has nothing to run (an empty
  // schematic, a circuit with no stimulus): the player says "draw something
  // first" rather than "the simulator is down".
  nothing_to_run: [422, "this answer has nothing to run yet"],
  not_found: [404],
  not_implemented: [501],
  internal_error: [500],
} satisfies Record<string, Refusal>;

export class LiveError extends refusalClass("LiveError", REFUSALS) {}

/** The 410 of §4.7. The body carries the reason AND the server's clock. */
export class AttemptClosedError extends LiveError {
  constructor(
    readonly reason: AttemptClosed["reason"],
    readonly deadlineAt: Date | null,
  ) {
    super("attempt_closed", `attempt closed: ${reason}`);
  }
  body(now: Date): AttemptClosed {
    return {
      error: "attempt_closed",
      reason: this.reason,
      deadlineAt: isoOrNull(this.deadlineAt),
      serverNow: iso(now),
    };
  }
}

/**
 * F-EVAL-15: a retake the rule refuses (`@quiz/domain#retakeRefusal`), or a
 * retake of the questions to review `partialRetakeRefusal` refuses
 * (ADR-091). The reason travels in the body, so the screens can say which.
 */
export class RetakeRefused extends LiveError {
  constructor(readonly reason: RetakeRefusal) {
    super("retake_refused", `retake refused: ${reason}`, { reason });
  }
}

/**
 * ADR-122: a practice attempt the rule refuses (`@quiz/domain#practiceRefusal`).
 * The reason travels in the body, so the screens can say which.
 */
export class PracticeRefused extends LiveError {
  constructor(readonly reason: PracticeRefusal) {
    super("practice_refused", `practice refused: ${reason}`, { reason });
  }
}

export class AnswerInvalid extends LiveError {
  constructor(readonly issues: unknown) {
    super("answer_invalid");
  }
}

/** A 429 with its `Retry-After` (`sendFailure` sends the header). */
export class RateLimited extends LiveError {
  constructor(override readonly retryAfterS: number) {
    super("rate_limited");
  }
}

/**
 * `reason` beside `message`: the player names the failure with it ("busy",
 * "not_configured", "timeout") without parsing a sentence.
 */
export class RunnerDown extends LiveError {
  constructor(readonly reason: string) {
    super("runner_unavailable", reason, { reason });
  }
}

/**
 * The failures answered in their own shape before the shared tail: the 410
 * with the server's clock, the type's issues. The `live` and `poll` routes
 * share them.
 */
export const liveFailureArms: FailureArms = (reply, error, now) => {
  if (error instanceof AttemptClosedError) return reply.code(410).send(error.body(now));
  if (error instanceof AnswerInvalid) return reply.code(422).send({ error: error.code, details: error.issues });
  return null;
};
