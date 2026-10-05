/**
 * The gradebook's staff writes (F-GBOOK-06, ADR-074): a staff mark, a
 * column's settings, the published mean. Every write is audited with its
 * before and after, refused on an archived classroom (`409
 * classroom_archived`, re-read under a share lock in the write's own
 * transaction), and followed by a refresh hint.
 *
 * A column is addressed by its activity (`kind` + `activityId`), which must
 * be one the classroom's gradebook has (`gradebookEntries`): anything else
 * is the 404 of a missing column. A stored column row is materialized by the
 * first write that names it, with the defaults of its kind.
 *
 * A mark wins over what the activity gives the student, so putting one over
 * a REAL grade is deliberate: the request says `override: true`, or it is
 * `409 grade_exists`. Replacing a mark already there needs no override (it
 * was one); clearing one is explicit (`DELETE`). On a RELEASED column that
 * override is an owner's act, as the release is (ADR-068, ADR-074 §9): an
 * assistant gets `403 owner_required`.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import type { GradebookColumnPatch, GradebookMarkParams, GradebookMarkPut, GradebookSettingsPatch } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, gradebookColumns, gradebookMarks, gradebookSettings } from "../../db/schema.js";
import type { GradebookEntry } from "../activity/kind.js";
import { gradebookEntries } from "../activity/service.js";
import { DomainError } from "../http.js";
import {
  activityRef,
  claimedSeats,
  columnOf,
  defaultSettings,
  meanPublished,
  settingsOf,
  type ColumnRow,
  type ColumnSettings,
} from "./columns.js";
import { GradebookError } from "./errors.js";
import { gradebookChanged } from "./events.js";

export interface WriteContext {
  actor: AuditActor;
  userId: string;
  /** The caller is an owner of the course (ADR-068): `isCourseOwner`. */
  owner: boolean;
  now: Date;
}

/** The classroom and the course it is of, as the route's loader gives them. */
export interface RoomScope {
  room: { id: string };
  course: { id: string };
}

const notFound = (what: string) => new DomainError("not_found", 404, `No such ${what}`);

/** The classroom read FOR SHARE: an archived one's gradebook is read-only. */
async function lockClassroom(tx: Tx, classroomId: string): Promise<void> {
  const [room] = await tx.select({ archivedAt: classrooms.archivedAt }).from(classrooms).where(eq(classrooms.id, classroomId)).for("share");
  if (!room) throw notFound("classroom");
  if (room.archivedAt !== null) throw new GradebookError("classroom_archived", "The classroom is archived: its gradebook is read-only");
}

/** The column the classroom's gradebook has for this activity, or the 404 of a missing one. */
async function entryOf(db: Db, classroomId: string, kind: GradebookEntry["kind"], activityId: string): Promise<GradebookEntry> {
  const entry = (await gradebookEntries(db, classroomId)).find((e) => e.kind === kind && e.activityId === activityId);
  if (!entry) throw notFound("column");
  return entry;
}

/** The stored column of an entry, made with its kind's defaults when it is the first write to name it. */
async function ensureColumn(tx: Tx, classroomId: string, entry: GradebookEntry, ctx: WriteContext): Promise<ColumnRow> {
  await tx
    .insert(gradebookColumns)
    .values({ id: randomUUID(), classroomId, ...activityRef(entry), ...defaultSettings(entry.mode), updatedBy: ctx.userId, updatedAt: ctx.now })
    .onConflictDoNothing();
  const [row] = await tx.select().from(gradebookColumns).where(columnOf(entry));
  return row!;
}

/** The student seat a mark is on (404 otherwise); `claimed`: the line must hold an account, as a new mark's does. */
async function seatOf(db: Db, classroomId: string, enrollmentId: string, { claimed }: { claimed: boolean }) {
  const [seat] = await db
    .select({ id: enrollments.id, userId: enrollments.userId })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.id, enrollmentId),
        eq(enrollments.classroomId, classroomId),
        eq(enrollments.staff, false),
        claimed ? isNotNull(enrollments.userId) : undefined,
      ),
    );
  if (!seat) throw notFound("student");
  return seat;
}

/** The accounts of the classroom's claimed students, whom a change may reach. */
const studentUserIds = async (db: Db | Tx, classroomId: string) => (await claimedSeats(db, classroomId)).map((s) => s.userId);

/**
 * A mark over a real grade is deliberate (`grade_exists` without `override`
 * for a new one), and on a RELEASED column publishing, changing or clearing
 * it is the owner's, as the release is (ADR-068, ADR-074 §9): `403
 * owner_required` for an assistant. A cell with no real grade beneath, and a
 * column not released, stay open to every member.
 */
async function guardOverride(
  db: Db,
  entry: GradebookEntry,
  seat: { id: string; userId: string | null },
  { replacing, override }: { replacing: boolean; override: boolean },
  ctx: WriteContext,
): Promise<void> {
  const beneath = (await entry.staffCells(db, [{ enrollmentId: seat.id, userId: seat.userId ?? "" }])).get(seat.id);
  if (!beneath?.hasGrade) return;
  if (replacing && !override) {
    throw new GradebookError("grade_exists", "A grade already stands there: set the mark with override to replace it", {
      activityId: entry.activityId,
      enrollmentId: seat.id,
    });
  }
  if (entry.released && !ctx.owner) throw new GradebookError("owner_required", "Only an owner of this course may alter a released grade");
}

/** A mark as the audit records it. */
const markFacts = (mark: { kind: string; points: number | null; max: number | null; comment: string | null } | undefined) =>
  mark === undefined ? null : { kind: mark.kind, points: mark.points, max: mark.max, comment: mark.comment };

/**
 * `PUT …/gradebook/columns/:kind/:activityId/marks/:eid`: an absence or the
 * teacher's own score on a claimed student seat of the classroom.
 */
export async function setMark(db: Db, scope: RoomScope, params: GradebookMarkParams, body: GradebookMarkPut, ctx: WriteContext): Promise<void> {
  const entry = await entryOf(db, scope.room.id, params.kind, params.activityId);
  const seat = await seatOf(db, scope.room.id, params.eid, { claimed: true });
  if (body.kind === "score" && body.points > body.max) throw new GradebookError("score_above_max", "The score is above its maximum");

  // A grade lies beneath unless a mark already stands: the staff meant to replace it, or did not. (A grade
  // landing between this read and the write is the same grade a moment later: the mark wins either way.)
  const [stored] = await db
    .select({ id: gradebookMarks.id })
    .from(gradebookMarks)
    .innerJoin(gradebookColumns, eq(gradebookColumns.id, gradebookMarks.columnId))
    .where(and(eq(gradebookMarks.enrollmentId, seat.id), columnOf(entry)));
  await guardOverride(db, entry, seat, { replacing: !stored, override: body.override === true }, ctx);

  const values = {
    kind: body.kind,
    points: body.kind === "score" ? body.points : null,
    max: body.kind === "score" ? body.max : null,
    comment: body.comment || null,
    setBy: ctx.userId,
    setAt: ctx.now,
  };
  await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const column = await ensureColumn(tx, scope.room.id, entry, ctx);
    const [before] = await tx
      .select()
      .from(gradebookMarks)
      .where(and(eq(gradebookMarks.columnId, column.id), eq(gradebookMarks.enrollmentId, seat.id)))
      .for("update");
    await tx
      .insert(gradebookMarks)
      .values({ id: randomUUID(), classroomId: scope.room.id, columnId: column.id, enrollmentId: seat.id, ...values })
      .onConflictDoUpdate({ target: [gradebookMarks.columnId, gradebookMarks.enrollmentId], set: values });
    await audit(tx, {
      ...ctx.actor,
      action: "gradebook.mark_set",
      subjectType: "classroom",
      subjectId: scope.room.id,
      payload: {
        activityKind: entry.kind,
        activityId: entry.activityId,
        enrollmentId: seat.id,
        before: markFacts(before),
        after: markFacts(values),
        override: body.override === true,
      },
    });
  });
  gradebookChanged(scope.course.id, [seat.userId!]);
}

/**
 * `DELETE …/marks/:eid`: the mark is cleared, and the cell is the activity's
 * own again. Idempotent: no mark, nothing audited.
 */
export async function clearMark(db: Db, scope: RoomScope, params: GradebookMarkParams, ctx: WriteContext): Promise<void> {
  const entry = await entryOf(db, scope.room.id, params.kind, params.activityId);
  // An unclaimed line is allowed: a student who lost their claim after a mark was set keeps it, and it must stay clearable.
  const seat = await seatOf(db, scope.room.id, params.eid, { claimed: false });
  await guardOverride(db, entry, seat, { replacing: false, override: true }, ctx);
  const cleared = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const [row] = await tx
      .select({ mark: gradebookMarks })
      .from(gradebookMarks)
      .innerJoin(gradebookColumns, eq(gradebookColumns.id, gradebookMarks.columnId))
      .where(and(eq(gradebookMarks.enrollmentId, seat.id), columnOf(entry)))
      .for("update", { of: gradebookMarks });
    if (!row) return false;
    await tx.delete(gradebookMarks).where(eq(gradebookMarks.id, row.mark.id));
    await audit(tx, {
      ...ctx.actor,
      action: "gradebook.mark_cleared",
      subjectType: "classroom",
      subjectId: scope.room.id,
      payload: { activityKind: entry.kind, activityId: entry.activityId, enrollmentId: seat.id, before: markFacts(row.mark), after: null },
    });
    return true;
  });
  if (cleared) gradebookChanged(scope.course.id, seat.userId === null ? [] : [seat.userId]);
}

/** `PATCH …/gradebook/columns/:kind/:activityId`: the weight, whether it counts, its position (F-GBOOK-06). */
export async function patchColumn(
  db: Db,
  scope: RoomScope,
  params: Pick<GradebookMarkParams, "kind" | "activityId">,
  body: GradebookColumnPatch,
  ctx: WriteContext,
): Promise<void> {
  const entry = await entryOf(db, scope.room.id, params.kind, params.activityId);
  const readers = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const column = await ensureColumn(tx, scope.room.id, entry, ctx);
    const before: ColumnSettings = settingsOf(column, entry.mode);
    const after: ColumnSettings = { weight: body.weight ?? before.weight, counts: body.counts ?? before.counts, position: body.position === undefined ? before.position : body.position };
    if (after.weight === before.weight && after.counts === before.counts && after.position === before.position) return null;
    await tx.update(gradebookColumns).set({ ...after, updatedBy: ctx.userId, updatedAt: ctx.now }).where(eq(gradebookColumns.id, column.id));
    await audit(tx, {
      ...ctx.actor,
      action: "gradebook.column_updated",
      subjectType: "classroom",
      subjectId: scope.room.id,
      payload: { activityKind: entry.kind, activityId: entry.activityId, before, after },
    });
    // The students read a weight only with the published mean.
    return (await meanPublished(tx, scope.room.id)) ? await studentUserIds(tx, scope.room.id) : [];
  });
  if (readers !== null) gradebookChanged(scope.course.id, readers);
}

/** `PATCH …/gradebook`: publish the mean to the students, or stop (F-GBOOK-05, F-GBOOK-06). */
export async function patchSettings(db: Db, scope: RoomScope, body: GradebookSettingsPatch, ctx: WriteContext): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    if ((await meanPublished(tx, scope.room.id)) === body.meanPublished) return false;
    const values = { meanPublished: body.meanPublished, updatedBy: ctx.userId, updatedAt: ctx.now };
    await tx
      .insert(gradebookSettings)
      .values({ classroomId: scope.room.id, ...values })
      .onConflictDoUpdate({ target: gradebookSettings.classroomId, set: values });
    await audit(tx, {
      ...ctx.actor,
      action: body.meanPublished ? "gradebook.mean_published" : "gradebook.mean_unpublished",
      subjectType: "classroom",
      subjectId: scope.room.id,
    });
    return true;
  });
  if (changed) gradebookChanged(scope.course.id, await studentUserIds(db, scope.room.id));
}
