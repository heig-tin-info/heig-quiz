/**
 * What the gradebook stores and reads beside the activities (ADR-074): the
 * settings of a column, the claimed seats that make the rows, the staff
 * marks, the classroom's published-mean switch; the writes' contexts, and
 * the two lookups of a column by its activity (a listed one for a mark, one
 * that may have settings, from the draft on). The activities' own facts and
 * grades come through the `ActivityKind` registry (`GradebookEntry`), never
 * from here.
 */
import { and, asc, eq, isNotNull, type SQL } from "drizzle-orm";

import type { ActivityKindName } from "@quiz/contracts";
import { countsByDefault, WEIGHT_DEFAULT, type GradebookColumnKind, type MarkOutcome } from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { enrollments, gradebookColumns, gradebookMarks, gradebookSettings, users } from "../../db/schema.js";
import type { GradebookColumnFacts, GradebookEntry, GradebookEntryFacts } from "../activity/kind.js";
import { gradebookColumnFacts, gradebookEntries } from "../activity/service.js";
import { notFoundError } from "../http.js";

export type ColumnRow = typeof gradebookColumns.$inferSelect;
export type MarkRow = typeof gradebookMarks.$inferSelect;

/** A column's settings, stored or default; `componentId`: the component of the mean it is in (ADR-131). */
export interface ColumnSettings {
  weight: number;
  counts: boolean;
  position: number | null;
  componentId: string | null;
}

/** The settings of an activity without a stored column: weight 100 %, exams and projects count, exercises do not (D06), in no component. */
export function defaultSettings(mode: GradebookColumnKind): ColumnSettings {
  return { weight: WEIGHT_DEFAULT, counts: countsByDefault(mode), position: null, componentId: null };
}

/** The activity a stored column belongs to. */
export const activityOf = (row: Pick<ColumnRow, "evaluationId" | "projectId">): string => row.evaluationId ?? row.projectId!;

/** The stored column of an entry's activity, as a predicate. */
export const columnOf = (entry: Pick<GradebookEntryFacts, "kind" | "activityId">): SQL =>
  entry.kind === "evaluation" ? eq(gradebookColumns.evaluationId, entry.activityId) : eq(gradebookColumns.projectId, entry.activityId);

/** The activity reference of a stored column's row, for an insert. */
export const activityRef = (entry: Pick<GradebookEntryFacts, "kind" | "activityId">) =>
  entry.kind === "evaluation" ? { evaluationId: entry.activityId } : { projectId: entry.activityId };

/** The key of a cell in the maps of marks: an activity and a roster line. */
export const cellKey = (activityId: string, enrollmentId: string): string => `${activityId}:${enrollmentId}`;

/** The stored columns of a classroom, by activity id. */
export async function storedColumns(db: Db | Tx, classroomId: string): Promise<Map<string, ColumnRow>> {
  const rows = await db.select().from(gradebookColumns).where(eq(gradebookColumns.classroomId, classroomId));
  return new Map(rows.map((row) => [activityOf(row), row]));
}

export const settingsOf = (row: ColumnRow | undefined, mode: GradebookColumnKind): ColumnSettings =>
  row ? { weight: row.weight, counts: row.counts, position: row.position, componentId: row.componentId } : defaultSettings(mode);

/** A staff write's context: who, and the server's clock. */
export interface CourseWriteContext {
  actor: AuditActor;
  userId: string;
  now: Date;
}

/** A classroom write's context; `owner`: the caller is an owner of the course (ADR-068, `isCourseOwner`), which the marks ask. */
export interface WriteContext extends CourseWriteContext {
  owner: boolean;
}

/** The classroom and the course it is of, as the route's loader gives them. */
export interface RoomScope {
  room: { id: string };
  course: { id: string };
}

/** The column the classroom's gradebook lists for this activity — a mark's —, or the 404 of a missing one. */
export async function entryOf(db: Db, classroomId: string, kind: ActivityKindName, activityId: string): Promise<GradebookEntry> {
  const entry = (await gradebookEntries(db, classroomId)).find((e) => e.kind === kind && e.activityId === activityId);
  if (!entry) throw notFoundError("column");
  return entry;
}

/**
 * The activity whose column's settings may be written and read, from the
 * draft on — each kind's rule (`columnFacts`, ADR-131 §13) — or the 404 of
 * a missing column: a poll, another classroom's activity, an archived or
 * ungraded project.
 */
export async function columnFactsOf(db: Db, classroomId: string, kind: ActivityKindName, activityId: string): Promise<GradebookColumnFacts> {
  const facts = await gradebookColumnFacts(db, classroomId, kind, activityId);
  if (facts === null) throw notFoundError("column");
  return facts;
}

/** The teacher's order first, then the activity's own date. */
export function inOrder<T extends { entry: Pick<GradebookEntryFacts, "date" | "title">; settings: Pick<ColumnSettings, "position"> }>(
  columns: T[],
): T[] {
  return columns.sort(
    (a, b) =>
      (a.settings.position ?? Number.MAX_SAFE_INTEGER) - (b.settings.position ?? Number.MAX_SAFE_INTEGER) ||
      a.entry.date.getTime() - b.entry.date.getTime() ||
      a.entry.title.localeCompare(b.entry.title),
  );
}

/** A claimed student seat: a row of the table. A staff seat is never one (ADR-018 §3), nor an unclaimed roster line. */
export interface Seat {
  enrollmentId: string;
  userId: string;
  email: string;
  nom: string;
  prenom: string;
}

export async function claimedSeats(db: Db | Tx, classroomId: string): Promise<Seat[]> {
  const rows = await db
    .select({ enrollmentId: enrollments.id, userId: enrollments.userId, email: enrollments.email, nom: enrollments.nom, prenom: enrollments.prenom })
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false), isNotNull(enrollments.userId)))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom), asc(enrollments.email));
  return rows.map((row) => ({ ...row, userId: row.userId! }));
}

/** A staff mark with the name of whoever set it. */
export interface MarkWithSetter extends MarkRow {
  activityId: string;
  setByName: string | null;
}

const setterName = (user: Pick<typeof users.$inferSelect, "givenName" | "familyName" | "email"> | null): string | null =>
  user === null ? null : `${user.givenName} ${user.familyName}`.trim() || user.email;

/**
 * The marks of a classroom (`enrollmentId` narrows them to one seat: a
 * student reads their own and nobody's else), by `activity:enrollment`.
 */
export async function marksByCell(db: Db | Tx, classroomId: string, enrollmentId?: string): Promise<Map<string, MarkWithSetter>> {
  const rows = await db
    .select({ mark: gradebookMarks, column: gradebookColumns, setter: users })
    .from(gradebookMarks)
    .innerJoin(gradebookColumns, eq(gradebookColumns.id, gradebookMarks.columnId))
    .leftJoin(users, eq(users.id, gradebookMarks.setBy))
    .where(and(eq(gradebookMarks.classroomId, classroomId), enrollmentId === undefined ? undefined : eq(gradebookMarks.enrollmentId, enrollmentId)));
  return new Map(
    rows.map(({ mark, column, setter }) => {
      const activityId = activityOf(column);
      return [cellKey(activityId, mark.enrollmentId), { ...mark, activityId, setByName: setterName(setter) }];
    }),
  );
}

/** A mark as the rules read it: `score` converted by the activity's own scale. */
export function markOutcome(mark: Pick<MarkRow, "kind" | "points" | "max">, entry: Pick<GradebookEntryFacts, "markGrade">): MarkOutcome {
  return mark.kind === "score" ? { kind: "score", grade: entry.markGrade(mark.points!, mark.max!) } : { kind: mark.kind };
}

/** Whether the teacher publishes the mean to the students (off without a row). */
export async function meanPublished(db: Db | Tx, classroomId: string): Promise<boolean> {
  const [row] = await db.select({ published: gradebookSettings.meanPublished }).from(gradebookSettings).where(eq(gradebookSettings.classroomId, classroomId));
  return row?.published ?? false;
}
