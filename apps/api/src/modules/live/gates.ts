/**
 * The write gate every student write passes (§4.7): the one rule of "may this
 * attempt still be written to", thrown as the 410 `attempt_closed`.
 */
import type { AttemptClosed } from "@quiz/contracts";
import { isWritable } from "@quiz/domain";

import type { EvaluationRecord } from "../evaluation/service.js";
import type { AttemptRecord } from "./access.js";
import { AttemptClosedError } from "./failures.js";

/**
 * How far a gate reaches, from the strictest to the loosest:
 *   - `answer`: a write to an answer. A PAUSED evaluation refuses it
 *     (decision D17: the client greys out and buffers; nothing is lost);
 *   - `presence`: the position, the journal, the sign of life. A paused
 *     evaluation allows it — the student is still in the room;
 *   - `submit`: handing the attempt in. Only the attempt's own state counts.
 */
type GateScope = "answer" | "presence" | "submit";

/**
 * THE rule of "may this attempt still be written to", as the reason it may
 * not, or `null`. The arms run in the order the plan fixes, and the grace
 * window is `GRACE_MS`, the same rule the ticker expires the attempt by —
 * the two must never drift (decision D12, invariant 5).
 */
function closedReason(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  scope: GateScope,
): AttemptClosed["reason"] | null {
  if (attempt.state !== "in_progress") {
    return attempt.state === "submitted" ? "submitted" : "deadline";
  }
  if (scope === "submit") return null;
  // ADR-122: a practice attempt lives on an evaluation that is over; only
  // its own deadline closes it, by the same acceptance rule.
  if (attempt.afterDue) return isWritable(attempt.deadlineAt, now) ? null : "deadline";
  if (evaluation.state === "paused") {
    if (scope === "answer") return "paused";
  } else if (evaluation.state !== "running") {
    return "evaluation_closed";
  }
  // `@quiz/domain`'s acceptance rule, the one the ticker's cutoff is built on.
  return isWritable(attempt.deadlineAt, now) ? null : "deadline";
}

/** {@link closedReason} as the 410 of §4.7. */
export function assertGate(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
  scope: GateScope,
): void {
  const reason = closedReason(evaluation, attempt, now, scope);
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
  return closedReason(evaluation, attempt, now, "presence") === null;
}

/** {@link isOpen}, as the 410 of §4.7. */
export function assertOpen(
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
  now: Date,
): void {
  assertGate(evaluation, attempt, now, "presence");
}
