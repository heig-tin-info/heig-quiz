/**
 * What the gradebook stores and reads beside the activities (ADR-074): the
 * settings of a column, the claimed seats that make the rows, the staff
 * marks, the classroom's published-mean switch. The activities' own facts
 * and grades come through the `ActivityKind` registry (`GradebookEntry`),
 * never from here.
 */
import { and, asc, eq, isNotNull, type SQL } from "drizzle-orm";

import { countsByDefault, WEIGHT_DEFAULT, type GradebookColumnKind, type MarkOutcome } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { enrollments, gradebookColumns, gradebookMarks, gradebookSettings, users } from "../../db/schema.js";
import type { GradebookEntryFacts } from "../activity/kind.js";

export type ColumnRow = typeof gradebookColumns.$inferSelect;
export type MarkRow = typeof gradebookMarks.$inferSelect;

/** A column's settings, stored or default. */
export interface ColumnSettings {
  weight: number;
  counts: boolean;
  position: number | null;
}

/** The settings of an activity without a stored column: weight 100 %, exams and projects count, exercises do not (D06). */
export function defaultSettings(mode: GradebookColumnKind): ColumnSettings {
  return { weight: WEIGHT_DEFAULT, counts: countsByDefault(mode), position: null };
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
  row ? { weight: row.weight, counts: row.counts, position: row.position } : defaultSettings(mode);

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
  return mark.kind === "absent" ? { kind: "absent" } : { kind: "score", grade: entry.markGrade(mark.points!, mark.max!) };
}

/** Whether the teacher publishes the mean to the students (off without a row). */
export async function meanPublished(db: Db | Tx, classroomId: string): Promise<boolean> {
  const [row] = await db.select({ published: gradebookSettings.meanPublished }).from(gradebookSettings).where(eq(gradebookSettings.classroomId, classroomId));
  return row?.published ?? false;
}
