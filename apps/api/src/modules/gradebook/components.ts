/**
 * The components of the mean of a course (ADR-131, F-GBOOK-07): a named,
 * weighted share of the mean ("Labo", "Cours") that the columns of every
 * classroom of the course may join. Stored on the course
 * (`gradebook_components`), read live by every table of the course, archived
 * classrooms included (no freeze, ADR-131 §6).
 *
 * The writes are the course owner's (the route's loader refuses an assistant,
 * `403 owner_required`, ADR-068 §3); reading the list is any member's. A name
 * is unique in the course whatever its case (`409 component_name_taken`); a
 * component a column of any classroom is in cannot be deleted (`409
 * component_in_use`). Every write is audited, subject the course, and hints
 * the course's staff and the claimed students of every classroom of the
 * course — a component's name and the `counts` flags it decides are always
 * theirs to read (`gradebookChanged`, never `classroom:`).
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import type { GradebookComponentCreate, GradebookComponentPatch, GradebookComponents } from "@quiz/contracts";

import { audit } from "../../audit.js";
import { isUniqueViolation, qualified, type Db, type Tx } from "../../db/client.js";
import { classrooms, enrollments, gradebookColumns, gradebookComponents } from "../../db/schema.js";
import { notFoundError } from "../http.js";
import { GradebookError } from "./errors.js";
import { gradebookChanged } from "./events.js";
import type { WriteContext } from "./writes.js";

export type ComponentRow = typeof gradebookComponents.$inferSelect;

/** A course write's context: the owner's role was checked by the route's loader. */
export type CourseWriteContext = Omit<WriteContext, "owner">;

/** The order of a course's components: their creation (ADR-131 §1: no position, no reorder). */
const CREATION_ORDER = [asc(gradebookComponents.createdAt), asc(gradebookComponents.id)];

/** Whether a column of any classroom is in the component of the row. */
const inUse = sql<boolean>`exists (select 1 from ${gradebookColumns} where ${qualified(gradebookColumns.componentId)} = ${qualified(gradebookComponents.id)})`;

/** The course's components in creation order, each with whether a column of any classroom is in it: what the tables and the list read. */
export async function courseComponents(db: Db | Tx, courseId: string): Promise<(ComponentRow & { inUse: boolean })[]> {
  const rows = await db
    .select({ component: gradebookComponents, inUse })
    .from(gradebookComponents)
    .where(eq(gradebookComponents.courseId, courseId))
    .orderBy(...CREATION_ORDER);
  return rows.map(({ component, inUse: used }) => ({ ...component, inUse: used }));
}

/**
 * The component of the course, read `FOR KEY SHARE` (a column's assignment)
 * or `FOR UPDATE` (its own write), or the 404 of a missing one: another
 * course's id is the same 404. Locked, a deletion and an assignment of the
 * same component are ordered: the one that waits re-reads the other's result.
 */
export async function componentOfCourse(tx: Tx, courseId: string, componentId: string, lock: "key share" | "update"): Promise<ComponentRow> {
  const [row] = await tx
    .select()
    .from(gradebookComponents)
    .where(and(eq(gradebookComponents.id, componentId), eq(gradebookComponents.courseId, courseId)))
    .for(lock);
  if (!row) throw notFoundError("component");
  return row;
}

/** `GET /courses/:id/gradebook/components`, and every write's answer. */
export async function listComponents(db: Db, courseId: string): Promise<GradebookComponents> {
  return (await courseComponents(db, courseId)).map(({ id, name, weight, inUse: used }) => ({ id, name, weight, inUse: used }));
}

/** The accounts of the claimed students of every classroom of the course, archived ones included: whom a component's change reaches. */
async function courseStudentIds(db: Db, courseId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: enrollments.userId })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .where(and(eq(classrooms.courseId, courseId), eq(enrollments.staff, false), isNotNull(enrollments.userId)));
  return rows.map((row) => row.userId!);
}

const NAME_INDEX = "gradebook_components_course_name_uq";

/** A write that may clash on the name: `409 component_name_taken` instead of the unique index's error. */
async function namedWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (isUniqueViolation(err, NAME_INDEX)) throw new GradebookError("component_name_taken", "Another component of the course has that name");
    throw err;
  }
}

const facts = (row: Pick<ComponentRow, "name" | "weight">) => ({ name: row.name, weight: row.weight });

/** `POST /courses/:id/gradebook/components`: a new component, last in the order. */
export async function createComponent(db: Db, courseId: string, body: GradebookComponentCreate, ctx: CourseWriteContext): Promise<void> {
  const id = randomUUID();
  await namedWrite(() =>
    db.transaction(async (tx) => {
      await tx.insert(gradebookComponents).values({ id, courseId, ...facts(body), createdAt: ctx.now, updatedBy: ctx.userId, updatedAt: ctx.now });
      await audit(tx, {
        ...ctx.actor,
        action: "gradebook.component_created",
        subjectType: "course",
        subjectId: courseId,
        payload: { componentId: id, ...facts(body) },
      });
    }),
  );
  gradebookChanged(courseId, await courseStudentIds(db, courseId));
}

/** `PATCH …/components/:componentId`: its name, its weight, or both; read live by every classroom of the course (ADR-131 §6). */
export async function updateComponent(
  db: Db,
  courseId: string,
  componentId: string,
  body: GradebookComponentPatch,
  ctx: CourseWriteContext,
): Promise<void> {
  const changed = await namedWrite(() =>
    db.transaction(async (tx) => {
      const before = facts(await componentOfCourse(tx, courseId, componentId, "update"));
      const after = { name: body.name ?? before.name, weight: body.weight ?? before.weight };
      if (after.name === before.name && after.weight === before.weight) return false;
      await tx.update(gradebookComponents).set({ ...after, updatedBy: ctx.userId, updatedAt: ctx.now }).where(eq(gradebookComponents.id, componentId));
      await audit(tx, {
        ...ctx.actor,
        action: "gradebook.component_updated",
        subjectType: "course",
        subjectId: courseId,
        payload: { componentId, before, after },
      });
      return true;
    }),
  );
  if (changed) gradebookChanged(courseId, await courseStudentIds(db, courseId));
}

/** `DELETE …/components/:componentId`: only while no column of any classroom of the course is in it (`409 component_in_use`). */
export async function deleteComponent(db: Db, courseId: string, componentId: string, ctx: CourseWriteContext): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await componentOfCourse(tx, courseId, componentId, "update");
    const [used] = await tx.select({ id: gradebookColumns.id }).from(gradebookColumns).where(eq(gradebookColumns.componentId, componentId)).limit(1);
    if (used) throw new GradebookError("component_in_use", "A column is still in this component");
    await tx.delete(gradebookComponents).where(eq(gradebookComponents.id, componentId));
    await audit(tx, {
      ...ctx.actor,
      action: "gradebook.component_deleted",
      subjectType: "course",
      subjectId: courseId,
      payload: { componentId, ...facts(row) },
    });
  });
  gradebookChanged(courseId, await courseStudentIds(db, courseId));
}
