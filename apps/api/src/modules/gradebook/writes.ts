/**
 * The gradebook's staff writes (F-GBOOK-06, ADR-074): a staff mark, a
 * column's settings, the published mean. Every write is audited with its
 * before and after, refused on an archived classroom (`409
 * classroom_archived`, re-read under a share lock in the write's own
 * transaction), and followed by a refresh hint.
 *
 * A column is addressed by its activity (`kind` + `activityId`). A mark's
 * must be one the classroom's gradebook has (`gradebookEntries`); a column's
 * settings, any activity that may have them, from the draft on
 * (`columnFactsOf`, ADR-131); anything else is the 404 of a missing column.
 * A stored column row is materialized by the first write that names it, with
 * the defaults of its kind; a draft's stays inert, every reader going
 * through `gradebookEntries`, until it leaves the draft.
 *
 * A mark wins over what the activity gives the student, so putting one over
 * a REAL grade is deliberate: the request says `override: true`, or it is
 * `409 grade_exists`. Replacing a mark already there needs no override (it
 * was one); clearing one is explicit (`DELETE`). On a RELEASED column that
 * override is an owner's act, as the release is (ADR-068, ADR-074 §9): an
 * assistant gets `403 owner_required`; so is a mark over the absence a
 * release derived (amended 2026-10-10).
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";

import type { GradebookColumnPatch, GradebookMarkParams, GradebookMarkPut, GradebookSettingsPatch } from "@quiz/contracts";

import { audit } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, gradebookColumns, gradebookMarks, gradebookSettings } from "../../db/schema.js";
import type { GradebookEntry, GradebookEntryFacts } from "../activity/kind.js";
import { notFoundError } from "../http.js";
import {
  activityRef,
  claimedSeats,
  columnFactsOf,
  columnOf,
  defaultSettings,
  entryOf,
  meanPublished,
  settingsOf,
  type ColumnRow,
  type ColumnSettings,
  type CourseWriteContext,
  type RoomScope,
  type WriteContext,
} from "./columns.js";
import { componentOfCourse } from "./components.js";
import { GradebookError } from "./errors.js";
import { gradebookChanged } from "./events.js";

/** The classroom read FOR SHARE: an archived one's gradebook is read-only. */
async function lockClassroom(tx: Tx, classroomId: string): Promise<void> {
  const [room] = await tx.select({ archivedAt: classrooms.archivedAt }).from(classrooms).where(eq(classrooms.id, classroomId)).for("share");
  if (!room) throw notFoundError("classroom");
  if (room.archivedAt !== null) throw new GradebookError("classroom_archived", "The classroom is archived: its gradebook is read-only");
}

/** The stored column of an activity, made with its kind's defaults when it is the first write to name it. */
async function ensureColumn(tx: Tx, classroomId: string, entry: GradebookEntryFacts, ctx: CourseWriteContext): Promise<ColumnRow> {
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
  if (!seat) throw notFoundError("student");
  return seat;
}

/** The accounts of the classroom's claimed students, whom a change may reach. */
const studentUserIds = async (db: Db | Tx, classroomId: string) => (await claimedSeats(db, classroomId)).map((s) => s.userId);

/**
 * A mark over a real grade is deliberate (`grade_exists` without `override`
 * for a new one), and on a RELEASED column publishing, changing or clearing
 * it is the owner's, as the release is (ADR-068, ADR-074 §9): `403
 * owner_required` for an assistant. So is a mark over a DERIVED absence (a
 * released exam not taken, an a1.0 the release published, amended
 * 2026-10-10) — which is no real grade, so it asks no override. An empty
 * cell, and a column not released, stay open to every member.
 */
async function guardOverride(
  db: Db,
  entry: GradebookEntry,
  seat: { id: string; userId: string | null },
  { replacing, override }: { replacing: boolean; override: boolean },
  ctx: WriteContext,
): Promise<void> {
  const beneath = (await entry.staffCells(db, [{ enrollmentId: seat.id, userId: seat.userId ?? "" }])).get(seat.id);
  if (beneath?.hasGrade && replacing && !override) {
    throw new GradebookError("grade_exists", "A grade already stands there: set the mark with override to replace it", {
      activityId: entry.activityId,
      enrollmentId: seat.id,
    });
  }
  const published = beneath?.hasGrade === true || beneath?.source === "derived";
  if (published && entry.released && !ctx.owner) {
    throw new GradebookError("owner_required", "Only an owner of this course may alter a released grade");
  }
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

/**
 * `PATCH …/gradebook/columns/:kind/:activityId`: the weight, whether it
 * counts, its position, its component of the mean (F-GBOOK-06, ADR-131) — a
 * component of the classroom's course, else the 404 of a missing one. From
 * the draft on: a draft's settings are stored, kept across a change of mode
 * (ADR-092 §4), and its column takes them when it appears (ADR-131).
 */
export async function patchColumn(
  db: Db,
  scope: RoomScope,
  params: Pick<GradebookMarkParams, "kind" | "activityId">,
  body: GradebookColumnPatch,
  ctx: CourseWriteContext,
): Promise<void> {
  const entry = await columnFactsOf(db, scope.room.id, params.kind, params.activityId);
  const changed = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    if (body.componentId) await componentOfCourse(tx, scope.course.id, body.componentId, "key share");
    const column = await ensureColumn(tx, scope.room.id, entry, ctx);
    const before: ColumnSettings = settingsOf(column, entry.mode);
    const after: ColumnSettings = {
      weight: body.weight ?? before.weight,
      counts: body.counts ?? before.counts,
      position: body.position === undefined ? before.position : body.position,
      componentId: body.componentId === undefined ? before.componentId : body.componentId,
    };
    if ((Object.keys(after) as (keyof ColumnSettings)[]).every((field) => after[field] === before[field])) return false;
    await tx.update(gradebookColumns).set({ ...after, updatedBy: ctx.userId, updatedAt: ctx.now }).where(eq(gradebookColumns.id, column.id));
    await audit(tx, {
      ...ctx.actor,
      action: "gradebook.column_updated",
      subjectType: "classroom",
      subjectId: scope.room.id,
      payload: { activityKind: entry.kind, activityId: entry.activityId, before, after },
    });
    return true;
  });
  // The students read a listed column's flag, its component and its place always, its weight with the published
  // mean; a column not listed yet (a draft) reaches none of them, so only the staff re-read.
  if (changed) gradebookChanged(scope.course.id, entry.listed ? await studentUserIds(db, scope.room.id) : []);
}

/**
 * A duplicated evaluation's column settings (ADR-131 §13): the copy
 * `to.activityId`, just made in the classroom `to.room`, takes the weight
 * and flag its source `fromId` has stored, and the component too when both
 * are of the same course — another course has not got it; never the
 * position, which orders the source's classroom. It is `patchColumn`, so
 * the copy's row is stored even when it holds its mode's defaults (a stored
 * flag survives a change of mode, ADR-092 §4), audited only when it differs
 * from them. Nothing stored, nothing copied. The caller skips an archived
 * target, whose gradebook is read-only.
 */
export async function copyColumnSettings(
  db: Db,
  fromId: string,
  sourceCourseId: string,
  to: RoomScope & { activityId: string },
  ctx: CourseWriteContext,
): Promise<void> {
  const [source] = await db.select().from(gradebookColumns).where(eq(gradebookColumns.evaluationId, fromId));
  if (!source) return;
  const componentId = to.course.id === sourceCourseId ? source.componentId : null;
  await patchColumn(db, to, { kind: "evaluation", activityId: to.activityId }, { weight: source.weight, counts: source.counts, componentId }, ctx);
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
