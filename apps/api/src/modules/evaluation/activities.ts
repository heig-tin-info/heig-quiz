/**
 * The Activities section (issue #190): every evaluation the caller manages,
 * across their classrooms, and their own anonymous polls — in ONE query.
 *
 * The scope is the caller's access predicate itself, handed in by the route
 * (`managedEvaluationAccess` in `guards.ts`: a staff seat on the classroom's
 * course, or the ownership of a classroom-less poll; nothing for an admin).
 * A row outside it is never loaded, so there is nothing to filter afterwards
 * (invariant 6). Out of the list by construction: templates (`course_id`
 * set, never run) and the evaluations of an archived classroom, like
 * everywhere else in the navigation.
 */
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";

import type { ActivitySummary } from "@quiz/contracts";
import { isTakeHome } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, evaluations } from "../../db/schema.js";

export async function listActivities(
  db: Db,
  access: SQL | undefined,
): Promise<ActivitySummary[]> {
  const rows = await db
    .select({
      id: evaluations.id,
      title: evaluations.title,
      mode: evaluations.mode,
      state: evaluations.state,
      lobby: sql<string | null>`${evaluations.settings} ->> 'lobby'`,
      opensAt: evaluations.opensAt,
      closesAt: evaluations.closesAt,
      startedAt: evaluations.startedAt,
      updatedAt: evaluations.updatedAt,
      classroomId: classrooms.id,
      classroomName: classrooms.name,
      courseCode: courses.code,
    })
    .from(evaluations)
    .leftJoin(classrooms, eq(classrooms.id, evaluations.classroomId))
    .leftJoin(courses, eq(courses.id, classrooms.courseId))
    .where(and(isNull(evaluations.courseId), isNull(classrooms.archivedAt), access))
    .orderBy(desc(evaluations.createdAt));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    mode: r.mode,
    state: r.state,
    classroom:
      r.classroomId === null
        ? null
        : { id: r.classroomId, name: r.classroomName!, courseCode: r.courseCode! },
    takeHome: isTakeHome(r),
    opensAt: isoOrNull(r.opensAt),
    closesAt: isoOrNull(r.closesAt),
    startedAt: isoOrNull(r.startedAt),
    updatedAt: iso(r.updatedAt),
  }));
}
