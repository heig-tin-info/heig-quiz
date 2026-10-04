/**
 * The staff's views of projects (merge task M3-02): the summary of one
 * project, and the rows of the Activities lists. Never a student's: the
 * student view of a project is M3-09's, its one exit (N-SEC-20).
 */
import { and, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";

import type { ProjectActivitySummary, ProjectSummary } from "@quiz/contracts";
import { editableProjectFields } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, projectRepos, projects } from "../../db/schema.js";
import { staffAccess, type Caller } from "../guards.js";

export type ProjectRow = typeof projects.$inferSelect;

/** One project for its staff (`ProjectSummary`): the settings, the repositories, what may still change. */
export async function projectSummary(db: Db, row: ProjectRow, now: Date): Promise<ProjectSummary> {
  const [repo] = await db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(eq(projectRepos.projectId, row.id))
    .limit(1);
  return {
    id: row.id,
    classroomId: row.classroomId,
    name: row.name,
    slug: row.slug,
    state: row.state,
    publishMode: row.publishMode,
    startAt: iso(row.startAt),
    deadlineAt: iso(row.deadlineAt),
    durationMinutes: row.durationMinutes,
    graceMinutes: row.graceMinutes,
    sourceStrategy: row.sourceStrategy,
    deadlineStrategy: row.deadlineStrategy,
    gradingMode: row.gradingMode,
    gradingScale: row.gradingScale,
    branches: row.branches,
    protectedFiles: row.protectedFiles,
    groupMode: row.groupMode,
    groupSetId: row.groupSetId,
    source: { fullName: row.sourceFullName },
    distribution: row.distributionFullName === null ? null : { fullName: row.distributionFullName },
    deadlineAppliedAt: isoOrNull(row.deadlineAppliedAt),
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
    accepted: repo !== undefined,
    editable: editableProjectFields(row, now),
  };
}

/** The Activities rows of the projects `where` selects, newest first. */
async function activityRows(db: Db, where: SQL | undefined): Promise<ProjectActivitySummary[]> {
  const rows = await db
    .select({
      id: projects.id,
      title: projects.name,
      state: projects.state,
      startAt: projects.startAt,
      deadlineAt: projects.deadlineAt,
      classroomId: classrooms.id,
      classroomName: classrooms.name,
      courseCode: courses.code,
    })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .where(where)
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({
    kind: "project" as const,
    id: r.id,
    title: r.title,
    state: r.state,
    classroom: { id: r.classroomId, name: r.classroomName, courseCode: r.courseCode },
    startAt: iso(r.startAt),
    deadlineAt: iso(r.deadlineAt),
  }));
}

/**
 * `GET /app/api/classrooms/:id/projects`: the classroom's projects, drafts
 * included, the archived ones only when asked (F-PROJ-16). The classroom was
 * loaded under `staffAccess` by the route (invariant 6).
 */
export function classroomProjects(db: Db, classroomId: string, archived: boolean): Promise<ProjectActivitySummary[]> {
  return activityRows(
    db,
    and(eq(projects.classroomId, classroomId), archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt)),
  );
}

/**
 * The Activities section (`projectActivity.listForTeacher`): the projects of
 * every classroom the caller holds a staff seat on — an admin's own too,
 * never the platform's, like the evaluations —, drafts included, archived
 * projects and archived classrooms left out. The scope is `staffAccess` in
 * the WHERE (invariant 6).
 */
export function teacherProjects(db: Db, caller: Caller): Promise<ProjectActivitySummary[]> {
  return activityRows(
    db,
    and(
      staffAccess(caller.id),
      isNull(projects.archivedAt),
      isNull(classrooms.archivedAt),
    ),
  );
}
