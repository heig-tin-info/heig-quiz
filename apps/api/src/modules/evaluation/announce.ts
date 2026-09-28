/**
 * What the students of a classroom are told when one of its EXERCISES moves
 * (ADR-030, addendum §c and §h): `activity_scheduled` the first time it is
 * scheduled, `activity_available` when it starts running. Never an exam —
 * the students are in the room, and a teacher may keep it a surprise — and
 * never a poll, which happens live.
 *
 * ONE entry, {@link announceMove}, called with the row a move has just
 * committed by the two places that make those moves: `transition` (the
 * authoring moves, `scheduled` among them) and `startEvaluation` in the
 * `live` module (the move to `running`, by hand or by the ticker). Both call
 * it only when THEIR compare-and-set won, so a double click or a second
 * ticker process does not tell the class twice.
 *
 * Best-effort: a notification that fails is logged and never fails the move,
 * which has already happened.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { isTakeHome } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { classrooms, enrollments, evaluations } from "../../db/schema.js";
import { notifyMany } from "../notifications/service.js";
import { settingsOf } from "./reads.js";
import type { EvaluationRecord } from "./shared.js";

/** Tells the classroom's students about `row`, which has just moved to `row.state`. */
export async function announceMove(db: Db, row: EvaluationRecord, now: Date): Promise<void> {
  if (row.mode !== "exercise" || row.classroomId === null) return;
  if (row.state !== "scheduled" && row.state !== "running") return;
  try {
    if (row.state === "scheduled") await announceScheduled(db, row, row.classroomId, now);
    else await announceAvailable(db, row, row.classroomId);
  } catch (err) {
    // The service layer has no logger (as `realtime/bus.ts`): stderr, which
    // the process log collects.
    console.error(`evaluation: telling the students of ${row.id} (${row.state}) failed`, err);
  }
}

/**
 * Once in the exercise's life: the marker `scheduled_announced_at` is
 * claimed by a conditional UPDATE before anything is sent, so a reschedule,
 * a trip back to draft and forward again, or two concurrent moves tell
 * nobody a second time. Folded per classroom by `notifyMany` (§e): a term of
 * exercises scheduled in one sitting is one entry, "16 exercises scheduled".
 */
async function announceScheduled(
  db: Db,
  row: EvaluationRecord,
  classroomId: string,
  now: Date,
): Promise<void> {
  const claimed = await db
    .update(evaluations)
    .set({ scheduledAnnouncedAt: now })
    .where(and(eq(evaluations.id, row.id), isNull(evaluations.scheduledAnnouncedAt)))
    .returning({ id: evaluations.id });
  if (claimed.length === 0) return;
  const { name, students } = await studentsOf(db, classroomId);
  await notifyMany(
    db,
    students.map((userId) => ({
      userId,
      payload: { kind: "activity_scheduled", classroomId, classroomName: name, count: 1 },
    })),
  );
}

/**
 * Every move to `running`. A take-home exercise may reach the students by
 * e-mail and Teams; an in-class one opens with them in the room and stays in
 * the app (§h.3), whatever their preferences say.
 */
async function announceAvailable(db: Db, row: EvaluationRecord, classroomId: string): Promise<void> {
  const takeHome = isTakeHome({ mode: row.mode, lobby: settingsOf(row).lobby });
  const { students } = await studentsOf(db, classroomId);
  await notifyMany(
    db,
    students.map((userId) => ({
      userId,
      payload: { kind: "activity_available", evaluationId: row.id, evaluationTitle: row.title },
      ...(takeHome ? {} : { channels: ["bell"] as const }),
    })),
  );
}

/** The classroom's name and its CLAIMED student seats (no staff seat, no unclaimed roster line). */
async function studentsOf(db: Db, classroomId: string): Promise<{ name: string; students: string[] }> {
  const rows = await db
    .select({ name: classrooms.name, userId: enrollments.userId })
    .from(classrooms)
    .leftJoin(
      enrollments,
      and(
        eq(enrollments.classroomId, classrooms.id),
        eq(enrollments.staff, false),
        isNotNull(enrollments.userId),
      ),
    )
    .where(eq(classrooms.id, classroomId));
  return {
    name: rows[0]?.name ?? "",
    students: rows.flatMap((r) => (r.userId === null ? [] : [r.userId])),
  };
}
