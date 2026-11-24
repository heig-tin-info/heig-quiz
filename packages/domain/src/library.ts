/**
 * The course library (F-ORG-18, ADR-144): the kinds of document a course may
 * hold, and the documents an evaluation provides (ADR-144 §7, F-EVAL-37,
 * F-LIVE-15).
 *
 * The kind is decided by the bytes of the upload, never by the type a
 * browser declared (N-SEC-24).
 */
import { practiceProvidesDocuments } from "./afterDue.js";
import { attemptClosedReason, type GatedAttempt } from "./attemptGate.js";
import { calculatorAllowedFor, type EvaluationModeName } from "./evaluationConfig.js";

export const DOCUMENT_KINDS = ["pdf", "markdown"] as const;

/** At most this many documents on one evaluation. */
export const MAX_PROVIDED_DOCUMENTS = 10;

/**
 * A poll has nothing to read: the server refuses a selection there, as the
 * calculator (ADR-069) and the notepad (ADR-090).
 */
export const providedDocumentsAllowedFor = calculatorAllowedFor;

/**
 * Whether the student holding `attempt` may read the documents its
 * evaluation provides, now (F-LIVE-15, ADR-144 §7) — THE rule of the
 * student's exit (`library/studentView.ts`) and of `AttemptView.documents`:
 *
 *   - never on a poll;
 *   - a practice attempt only where its mode's practice provides them: an
 *     exercise after its due date (ADR-122) does, an exam's blank practice
 *     after the release (ADR-142) never does;
 *   - otherwise the gate of an ANSWER write (`attemptClosedReason`): the
 *     attempt in progress, the evaluation `running` — not the lobby, not a
 *     pause, not once it is over — and the server's clock before the
 *     attempt's deadline plus the grace (invariant 5).
 */
export function providedDocumentsReadable(
  input: { mode: EvaluationModeName; evaluationState: string; attempt: GatedAttempt },
  now: Date,
): boolean {
  if (!providedDocumentsAllowedFor(input.mode)) return false;
  if (input.attempt.afterDue && !practiceProvidesDocuments(input.mode)) return false;
  return attemptClosedReason(input.evaluationState, input.attempt, now, "answer") === null;
}
