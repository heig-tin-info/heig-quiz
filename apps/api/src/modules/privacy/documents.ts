/**
 * The student's two documents of the export factory (ADR-112 amendment of
 * 2026-11-03, ADR-125 §18): their own copy of a handed-in attempt (the
 * `results` module's Source) and the blank print of a past series (the
 * `evaluation` module's hand-out). Each Source is its module's; what lives
 * here is what they share as an export of the student's own: the scope of
 * the blank print, loaded (invariant 6), and the rate of both.
 *
 * Reached only behind `ownSessionGuard` (the caller's own portal session).
 */
import type { SessionAuth } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { byId, inPastSeries, type EvaluationRecord } from "../evaluation/service.js";
import { findReadableClassroom, type Caller } from "../guards.js";

/**
 * Downloads of the student's documents per person and hour, both together,
 * in a bucket apart from the personal export's: printing a few series never
 * locks that one (ADR-112 amendment of 2026-11-03).
 */
export const STUDENT_DOCUMENTS_PER_HOUR = 20;

/**
 * The evaluation whose blank series `caller` may print, or null for the 404
 * of a missing one: an evaluation of a classroom the caller reads with the
 * student payload — a claimed seat, or a staff member in the student view
 * (`findReadableClassroom`, ADR-018) — that is one of its past series
 * (`inPastSeries`, ADR-122 §9). A draft, an evaluation not over, an exam, an
 * exercise closed to practice or a classroom archived: null.
 */
export async function findPastSeries(
  db: Db,
  caller: Caller,
  auth: Pick<SessionAuth, "kind" | "actorUserId"> | null,
  evaluationId: string,
): Promise<EvaluationRecord | null> {
  const evaluation = await byId(db, evaluationId);
  if (!evaluation?.classroomId) return null;
  // The student payload asked for: a staff member reads as in the student view.
  const room = await findReadableClassroom(db, caller, auth, evaluation.classroomId, { studentView: true });
  if (room === null || !inPastSeries(evaluation, room.room.archivedAt)) return null;
  return evaluation;
}
