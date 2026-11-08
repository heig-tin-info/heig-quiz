/**
 * Who holds an attempt and the reads of the attempt rows: the participant (a
 * claimed seat or a guest), the staff seat (ADR-018), the lobby's
 * denominator, and an attempt or its answers by id or by owner.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { answers, attempts, enrollments, evaluations, officialAttempt } from "../../db/schema.js";
import { first } from "../../db/query.js";
import { isLatestAttempt, seatsOf, trustedClients, type EvaluationRecord } from "../evaluation/service.js";
import * as events from "./events.js";

export type AttemptRecord = typeof attempts.$inferSelect;

export type AnswerRecord = typeof answers.$inferSelect;

/**
 * Who holds an attempt. EXACTLY one of the two ids is set — the check
 * constraint `attempts_owner_ck` says the same thing in the schema:
 *   - `userId`: an account, reached through a claimed roster seat for an
 *     exam or an exercise, or through the poll's own code (ADR-014);
 *   - `guestId`: a browser that joined an anonymous poll and nothing else
 *     (F-AUTH-05). A guest has no accommodation, hence no time bonus.
 */
export interface Participant {
  userId: string | null;
  guestId: string | null;
  timeBonusPercent: number;
}

/** The half of {@link Participant} an `attempts` row is keyed on. */
export function ownerOf(participant: Participant): { userId: string | null; guestId: string | null } {
  return { userId: participant.userId, guestId: participant.guestId };
}

/** A student reaches an evaluation only through a CLAIMED roster seat. */
export async function participantOf(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<Participant | null> {
  const [row] = await db
    .select({ timeBonusPercent: enrollments.timeBonusPercent })
    .from(enrollments)
    .where(
      and(
        seatsOf(evaluation),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  return row ? { userId, guestId: null, timeBonusPercent: row.timeBonusPercent } : null;
}

/**
 * ADR-027: the evaluation a `.seb` opens — one that accepts Safe Exam
 * Browser (`trustedClients`, ADR-051 §2) and in which `userId` holds a seat —
 * or `null`. Checked when the
 * file is issued AND when it is used, minutes later.
 */
export async function sebSeat(
  db: Db,
  userId: string,
  evaluationId: string,
): Promise<EvaluationRecord | null> {
  const [evaluation] = await db.select().from(evaluations).where(eq(evaluations.id, evaluationId));
  if (!evaluation || !trustedClients(evaluation).includes("seb")) return null;
  return (await participantOf(db, evaluation, userId)) ? evaluation : null;
}

/**
 * Who holds an existing attempt: the account's claimed seat when there is
 * one, and otherwise the row's own owner with no time bonus — a guest, or an
 * account whose seat has gone since.
 */
export async function participantOfAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  attempt: AttemptRecord,
): Promise<Participant> {
  const seat =
    attempt.userId === null ? null : await participantOf(db, evaluation, attempt.userId);
  return seat ?? { userId: attempt.userId, guestId: attempt.guestId, timeBonusPercent: 0 };
}

/**
 * The caller's own seat in the classroom of an evaluation, or `null`.
 *
 * `staff` is what tells a teacher's test walk apart from a student's attempt
 * (ADR-018): it is written by `POST /classrooms/:id/self-enroll` and it is
 * the only thing that makes the reset route of this module legitimate.
 */
export async function seatOf(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<{ staff: boolean } | null> {
  const [row] = await db
    .select({ staff: enrollments.staff })
    .from(enrollments)
    .where(
      and(
        seatsOf(evaluation),
        eq(enrollments.userId, userId),
      ),
    )
    .limit(1);
  return row ? { staff: row.staff } : null;
}

/**
 * ADR-018: a teacher throws away their OWN test attempt to walk the quiz
 * again. `POST /evaluations/:id/attempt` is idempotent per participant, so
 * without this a teacher tests a quiz exactly once, for ever.
 *
 * Three conditions, all of them loaded rather than checked afterwards
 * (invariant 6): the seat exists, the seat is STAFF, and the attempt is the
 * caller's own. The dependent rows (answers, journal, gradings) go with it
 * through the `ON DELETE CASCADE` of the schema.
 */
export async function resetOwnStaffAttempt(
  db: Db,
  evaluation: EvaluationRecord,
  userId: string,
): Promise<{ deleted: boolean; attemptId: string | null }> {
  const seat = await seatOf(db, evaluation, userId);
  if (!seat?.staff) return { deleted: false, attemptId: null };
  const [row] = await db
    .delete(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.userId, userId)))
    .returning({ id: attempts.id });
  if (!row) return { deleted: false, attemptId: null };
  events.attemptRemoved(evaluation.id, userId);
  return { deleted: true, attemptId: row.id };
}

/**
 * F-LIVE-02: the denominator of the lobby ring — the SEATS IN THE ROOM.
 *
 * The class, plus the staff seats that hold an attempt on this evaluation.
 * That is exactly the row set `dashboardView` builds, so the ring and the
 * grid can never disagree on who is expected, and a teacher walking their own
 * quiz (ADR-018) never reads "1 / 0" on the one screen where being counted is
 * the whole message.
 *
 * It does NOT weaken decision 4 of ADR-018: a staff attempt still counts in
 * no statistic — not in the completion of a question, not in its success
 * rate, not in the class figures. Presence is not a statistic; it is how many
 * people are sitting in the room, and a teacher sitting the quiz is one of
 * them. A staff seat that took no attempt is listed nowhere and counted
 * nowhere, exactly as before.
 */
export async function enrolledCount(db: Db, evaluation: EvaluationRecord): Promise<number> {
  return (await enrolledCounts(db, [evaluation])).get(evaluation.id) ?? 0;
}

/**
 * {@link enrolledCount} for several evaluations in two grouped statements,
 * whatever their number: the class seats per classroom, the staff seats that
 * took an attempt per evaluation.
 */
export async function enrolledCounts(
  db: Db,
  rows: readonly EvaluationRecord[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  // An anonymous poll (or a template) has no classroom, and so no seat to count.
  const classroomIds = [
    ...new Set(rows.flatMap((r) => (r.classroomId === null ? [] : [r.classroomId]))),
  ];
  const klass = await db
    .select({ classroomId: enrollments.classroomId, n: count() })
    .from(enrollments)
    .where(and(inArray(enrollments.classroomId, classroomIds), eq(enrollments.staff, false)))
    .groupBy(enrollments.classroomId);
  const staff = await db
    .select({ evaluationId: attempts.evaluationId, n: count() })
    .from(enrollments)
    .innerJoin(
      attempts,
      // A staff seat is ONE person in the room, however many attempts.
      and(
        eq(attempts.userId, enrollments.userId),
        inArray(attempts.evaluationId, rows.map((r) => r.id)),
        isLatestAttempt,
      ),
    )
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(eq(enrollments.classroomId, evaluations.classroomId), eq(enrollments.staff, true)))
    .groupBy(attempts.evaluationId);
  const byClassroom = new Map(klass.map((k) => [k.classroomId, k.n]));
  const byEvaluation = new Map(staff.map((s) => [s.evaluationId, s.n]));
  return new Map(
    rows.map((r) => [r.id, (byClassroom.get(r.classroomId ?? "") ?? 0) + (byEvaluation.get(r.id) ?? 0)]),
  );
}

// --- Attempts -------------------------------------------------------------

export async function attemptById(db: Db, id: string): Promise<AttemptRecord | null> {
  return first(db.select().from(attempts).where(eq(attempts.id, id)));
}

/**
 * The participant's CURRENT attempt: the latest one (F-EVAL-15). Everything
 * a student enters, resumes or reads back is this one; the earlier attempts
 * of an exercise, and the practice attempts (ADR-122), are only reached by id.
 */
export async function attemptOf(
  db: Db,
  evaluationId: string,
  owner: string | Participant,
): Promise<AttemptRecord | null> {
  const { userId, guestId } =
    typeof owner === "string" ? { userId: owner, guestId: null } : ownerOf(owner);
  return first(db
    .select()
    .from(attempts)
    .where(
      and(
        eq(attempts.evaluationId, evaluationId),
        guestId === null ? eq(attempts.userId, userId!) : eq(attempts.guestId, guestId),
        // A practice attempt after the due date (ADR-122) is never the
        // student's current attempt: it is reached by id.
        officialAttempt,
      ),
    )
    .orderBy(desc(attempts.attemptNumber)));
}

export async function answersOf(db: Db, attemptId: string): Promise<Map<string, AnswerRecord>> {
  const rows = await db.select().from(answers).where(eq(answers.attemptId, attemptId));
  return new Map(rows.map((r) => [r.itemId, r]));
}
