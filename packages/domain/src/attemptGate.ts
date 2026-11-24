/**
 * The gate every student write passes (§4.7): THE rule of "may this attempt
 * still be written to", as the reason it may not. The API throws it as the
 * `410 attempt_closed` (`live/gates.ts`), and the documents an evaluation
 * provides are read under it (`providedDocumentsReadable`, ADR-144 §7).
 *
 * Pure: the current instant is injected, the rows are reduced to the fields
 * the rule reads.
 */
import { isWritable } from "./deadline.js";

/** Why an attempt no longer takes a write: the `reason` of the 410 body. */
export const ATTEMPT_CLOSED_REASONS = ["deadline", "submitted", "evaluation_closed", "paused"] as const;
export type AttemptClosedReason = (typeof ATTEMPT_CLOSED_REASONS)[number];

/**
 * How far a gate reaches, from the strictest to the loosest:
 *   - `answer`: a write to an answer. A PAUSED evaluation refuses it
 *     (decision D17: the client greys out and buffers; nothing is lost);
 *   - `presence`: the position, the journal, the sign of life. A paused
 *     evaluation allows it — the student is still in the room;
 *   - `submit`: handing the attempt in. Only the attempt's own state counts.
 */
export type AttemptGateScope = "answer" | "presence" | "submit";

/** What the gate reads of an attempt. */
export interface GatedAttempt {
  state: string;
  /** A practice attempt, started once the evaluation was over (ADR-122, ADR-142). */
  afterDue: boolean;
  deadlineAt: Date | null;
}

/**
 * Why `attempt` takes no write of `scope` now, or null. The arms run in the
 * order the plan fixes, and the grace window is `GRACE_MS`, the same rule the
 * ticker expires the attempt by — the two must never drift (decision D12,
 * invariant 5).
 */
export function attemptClosedReason(
  evaluationState: string,
  attempt: GatedAttempt,
  now: Date,
  scope: AttemptGateScope,
): AttemptClosedReason | null {
  if (attempt.state !== "in_progress") {
    return attempt.state === "submitted" ? "submitted" : "deadline";
  }
  if (scope === "submit") return null;
  // ADR-122: a practice attempt lives on an evaluation that is over; only
  // its own deadline closes it, by the same acceptance rule.
  if (attempt.afterDue) return isWritable(attempt.deadlineAt, now) ? null : "deadline";
  if (evaluationState === "paused") {
    if (scope === "answer") return "paused";
  } else if (evaluationState !== "running") {
    return "evaluation_closed";
  }
  // The acceptance rule the ticker's cutoff is built on.
  return isWritable(attempt.deadlineAt, now) ? null : "deadline";
}
