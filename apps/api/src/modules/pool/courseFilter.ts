/**
 * Filtering a pool's questions by a course's concepts (#599 step 7b).
 *
 * The courses on offer are the ones linked to the pool AND on the caller's
 * staff (`staffAccess`, or every linked course under Super Powers): a pool's
 * linked courses are the owner's to see (`PoolMembers.courses`), so the list
 * a member gets here is only what they staff themselves. A course outside
 * that set is refused as a missing one, never told apart.
 */
import { and, asc, eq } from "drizzle-orm";

import type { PoolFilterCourse } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { coursePools, courses } from "../../db/schema.js";
import { conceptsCoveredByCourse } from "../concept/service.js";
import { accessWhere, staffAccess, type Caller } from "../guards.js";

/** The courses `caller` may filter the pool by, by name. */
export async function filterCoursesOf(db: Db, poolId: string, caller: Pick<Caller, "id" | "reach">): Promise<PoolFilterCourse[]> {
  return db
    .select({ id: courses.id, name: courses.name, code: courses.code })
    .from(coursePools)
    .innerJoin(courses, eq(courses.id, coursePools.courseId))
    .where(and(eq(coursePools.poolId, poolId), accessWhere(caller, staffAccess(caller.id))))
    .orderBy(asc(courses.name), asc(courses.id));
}

/**
 * The concept ids a `course` filter matches, or `null` when the caller may
 * not filter by that course (not staffed, not linked to the pool, unknown):
 * the route answers the 404 of a missing entity.
 */
export async function courseFilterConcepts(
  db: Db,
  poolId: string,
  caller: Pick<Caller, "id" | "reach">,
  courseId: string,
): Promise<string[] | null> {
  const offered = await filterCoursesOf(db, poolId, caller);
  if (!offered.some((c) => c.id === courseId)) return null;
  return conceptsCoveredByCourse(db, [courseId]);
}
