/**
 * A course's catalog of conditions (ADR-079 §5, F-ORG-16): the frequent
 * conditions its staff picks from. A helper of the `org` module, re-exported
 * by `./service.ts`; every statement on `course_conditions` is here.
 *
 * Access is not decided here: the routes load the course under
 * `staffAccess` first (invariant 6), with no role step — every member of
 * the staff manages the catalog (ADR-068 §3) — and an entry is then looked
 * up WITHIN that course, so an id of another course is a 404.
 *
 * Archived, never deleted: an evaluation that copied an entry keeps its
 * `catalogId`, and its text is a snapshot nothing here rewrites.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull, max, sql, type SQL } from "drizzle-orm";

import type { CourseCondition, CourseConditionCreate, CourseConditionPatch } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { courseConditions } from "../../db/schema.js";
import { DomainError } from "../http.js";

export type CourseConditionRecord = typeof courseConditions.$inferSelect;

/** What the staff reads of an entry. */
export const conditionView = (row: CourseConditionRecord): CourseCondition => ({
  id: row.id,
  kind: row.kind,
  text: row.text,
  archivedAt: row.archivedAt?.toISOString() ?? null,
});

const active = (courseId: string): SQL =>
  and(eq(courseConditions.courseId, courseId), isNull(courseConditions.archivedAt))!;

/** The whole catalog: the active entries in their order, then the archived ones in theirs. */
export async function listConditions(db: Db, courseId: string): Promise<CourseCondition[]> {
  const rows = await db
    .select()
    .from(courseConditions)
    .where(eq(courseConditions.courseId, courseId))
    .orderBy(
      sql`${courseConditions.archivedAt} is not null`,
      asc(courseConditions.position),
      asc(courseConditions.createdAt),
    );
  return rows.map(conditionView);
}

/** One entry of THIS course, or null: an id of another course is a miss. */
export async function conditionOfCourse(
  db: Db,
  courseId: string,
  conditionId: string,
): Promise<CourseConditionRecord | null> {
  const [row] = await db
    .select()
    .from(courseConditions)
    .where(and(eq(courseConditions.id, conditionId), eq(courseConditions.courseId, courseId)))
    .limit(1);
  return row ?? null;
}

/** The position after every entry of the course, archived ones included. */
async function nextPosition(db: Db, courseId: string): Promise<number> {
  const [row] = await db
    .select({ last: max(courseConditions.position) })
    .from(courseConditions)
    .where(eq(courseConditions.courseId, courseId));
  return (row?.last ?? -1) + 1;
}

/** A new entry, last. */
export async function createCondition(
  db: Db,
  courseId: string,
  body: CourseConditionCreate,
): Promise<CourseConditionRecord> {
  const [row] = await db
    .insert(courseConditions)
    .values({ id: randomUUID(), courseId, ...body, position: await nextPosition(db, courseId) })
    .returning();
  return row!;
}

/** Its kind and/or text. An evaluation that copied it keeps its own snapshot. */
export async function updateCondition(
  db: Db,
  conditionId: string,
  body: CourseConditionPatch,
  now: Date,
): Promise<CourseConditionRecord> {
  const [row] = await db
    .update(courseConditions)
    .set({ ...body, updatedAt: now })
    .where(eq(courseConditions.id, conditionId))
    .returning();
  return row!;
}

/** Archive or bring back; an entry brought back goes last. The route skips a no-op. */
export async function setConditionArchived(
  db: Db,
  row: CourseConditionRecord,
  archived: boolean,
  now: Date,
): Promise<CourseConditionRecord> {
  const [updated] = await db
    .update(courseConditions)
    .set(
      archived
        ? { archivedAt: now, updatedAt: now }
        : { archivedAt: null, position: await nextPosition(db, row.courseId), updatedAt: now },
    )
    .where(eq(courseConditions.id, row.id))
    .returning();
  return updated!;
}

/**
 * The active entries in a new order. `ids` must be exactly the active
 * entries, each once — a list read before a colleague's add or archive is
 * `409 stale_order`, and nothing moves.
 */
export async function reorderConditions(db: Db, courseId: string, ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.select({ id: courseConditions.id }).from(courseConditions).where(active(courseId));
    const current = new Set(rows.map((r) => r.id));
    if (ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every((id) => current.has(id))) {
      throw new DomainError("stale_order", 409, "The order must name every active condition once");
    }
    for (const [position, id] of ids.entries()) {
      await tx.update(courseConditions).set({ position }).where(eq(courseConditions.id, id));
    }
  });
}
