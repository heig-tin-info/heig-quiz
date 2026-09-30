/**
 * The Activities section (issue #190): every evaluation the caller manages,
 * across their classrooms, and their own anonymous polls — in ONE query.
 *
 * The scope is the caller's access predicate itself, handed in by the route
 * (`ownEvaluationAccess` in `guards.ts`: a staff seat on the classroom's
 * course, or the ownership of a classroom-less poll — for an admin too, who
 * sees their own work here and not the platform's).
 * A row outside it is never loaded, so there is nothing to filter afterwards
 * (invariant 6). Out of the list by construction: templates (`course_id`
 * set, never run) and the evaluations of an archived classroom, like
 * everywhere else in the navigation.
 *
 * The list is bounded by one more rule: an anonymous poll that ended more
 * than {@link OLD_POLL_DAYS} days ago is left out. A teacher who polls every
 * lecture piles them up by the hundred, and the launcher's "Recent polls"
 * already keeps that history; an evaluation of a classroom stays, since its
 * classroom being archived is what retires it.
 */
import { and, desc, eq, isNull, not, sql, type SQL } from "drizzle-orm";

import type { EvaluationActivitySummary } from "@quiz/contracts";
import { isTakeHome } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, evaluations, ownedPollSql } from "../../db/schema.js";

/** How long an ended anonymous poll stays in the list. */
export const OLD_POLL_DAYS = 120;

export async function listActivities(
  db: Db,
  access: SQL,
  now: Date,
): Promise<EvaluationActivitySummary[]> {
  const cutoff = new Date(now.getTime() - OLD_POLL_DAYS * 86_400_000);
  const oldPoll = sql`(${ownedPollSql()} and ${evaluations.state} in ('closed', 'grading', 'released') and coalesce(${evaluations.closedAt}, ${evaluations.createdAt}) < ${cutoff.toISOString()}::timestamptz)`;
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
    .where(and(isNull(evaluations.courseId), isNull(classrooms.archivedAt), not(oldPoll), access))
    .orderBy(desc(evaluations.createdAt));
  return rows.map((r) => ({
    kind: "evaluation" as const,
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
