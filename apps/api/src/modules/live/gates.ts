/**
 * The write gate every student write passes (§4.7): the one rule of "may this
 * attempt still be written to", thrown as the 410 `attempt_closed`.
 */
import { attemptClosedReason, type AttemptGateScope } from "@quiz/domain";

import type { EvaluationRecord } from "../evaluation/service.js";
import type { AttemptRecord } from "./access.js";
import { AttemptClosedError } from "./failures.js";

/**
 * THE rule of "may this attempt still be written to" (`@quiz/domain`'s
 * `attemptClosedReason`, on the rows), as the 410 of §4.7.
 */
export function assertGate(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  scope: AttemptGateScope,
): void {
  const reason = attemptClosedReason(evaluation.state, attempt, now, scope);
  if (reason !== null) throw new AttemptClosedError(reason, attempt.deadlineAt);
}

/** The gate of an answer write. It runs BEFORE the write. */
export function assertWritable(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): void {
  assertGate(evaluation, attempt, now, "answer");
}

/**
 * The lighter half of {@link assertWritable}, for what is not a write to an
 * answer: the position, the journal and the sign of life.
 *
 * It allows a PAUSED evaluation — the student is still in the room, and
 * their client keeps saying so (decision D17) — and refuses everything a
 * finished attempt or a finished evaluation would otherwise keep writing:
 * a submitted student must stop refreshing `present_at` and growing the
 * journal for ever.
 */
export function isOpen(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): boolean {
  return attemptClosedReason(evaluation.state, attempt, now, "presence") === null;
}

/** {@link isOpen}, as the 410 of §4.7. */
export function assertOpen(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): void {
  assertGate(evaluation, attempt, now, "presence");
}
