/**
 * The staff's views of projects (merge task M3-02): the summary of one
 * project, and the rows of the Activities lists. Never a student's: the
 * student view of a project is M3-09's, its one exit (N-SEC-20).
 */
import { and, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";

import type { ProjectActivitySummary, ProjectSummary } from "@quiz/contracts";
import { editableProjectFields, projectListDates, projectPhase, type ProjectLifeLike } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { classrooms, courses, projectRepos, projects } from "../../db/schema.js";
import { staffAccess, type Caller } from "../guards.js";
import { awaitsValidation } from "./criterionGrades.js";
import { LIVE } from "./deadline.js";
import { STUDENT_REPO } from "./repos.js";
import { finalOf, scoreFacts } from "./scores.js";

export type ProjectRow = typeof projects.$inferSelect;

/** The facts of a row the patch rule reads (`ProjectLifeLike`): its release a boolean. */
export const lifeOf = (row: ProjectRow): ProjectLifeLike => ({ ...row, released: row.releasedAt !== null });

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
    testsCriterion: row.testsCriterion,
    identityCriterion: row.identityCriterion,
    buildCommand: row.buildCommand,
    testCommand: row.testCommand,
    evidenceOutputs: row.evidenceOutputs,
    source: { fullName: row.sourceFullName },
    distribution: row.distributionFullName === null ? null : { fullName: row.distributionFullName },
    deadlineAppliedAt: isoOrNull(row.deadlineAppliedAt),
    archivedAt: isoOrNull(row.archivedAt),
    createdAt: iso(row.createdAt),
    accepted: repo !== undefined,
    editable: editableProjectFields(lifeOf(row), now),
  };
}

/** `releaseCounts` of `deadline.ts` and the `unverified` and `unvalidated` of `detail.ts`, over the live student repositories of one project. */
interface PhaseCounts {
  live: number;
  frozen: number;
  unverified: number;
  unvalidated: number;
}

const NO_REPOS: PhaseCounts = { live: 0, frozen: 0, unverified: 0, unvalidated: 0 };

/**
 * The counts the phase of a locked project rests on (`projectPhase`,
 * ADR-104), for every project of `projectIds` in a few reads — a list never
 * loads a project's detail, nor asks GitHub (F-PROJ-13): every live
 * (`LIVE`) student (`STUDENT_REPO`, the page's and the release's set)
 * repository, its final score through `finalOf` as the page resolves it
 * (`scoreFacts`: the slot runs and, graded by criteria, the standing,
 * ADR-106 §7), and whether it waits for its validation (§8). A project
 * with no such repository is absent: zero of each.
 */
async function phaseCounts(db: Db, projectIds: string[]): Promise<Map<string, PhaseCounts>> {
  if (projectIds.length === 0) return new Map();
  const rows = await db
    .select({ repo: projectRepos, gradingMode: projects.gradingMode })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(inArray(projectRepos.projectId, projectIds), LIVE, STUDENT_REPO));
  const facts = await scoreFacts(
    db,
    rows.map((r) => r.repo),
  );
  const counts = new Map<string, PhaseCounts>();
  for (const { repo, gradingMode } of rows) {
    const c = counts.get(repo.projectId) ?? { ...NO_REPOS };
    c.live += 1;
    if (repo.frozenAt !== null) c.frozen += 1;
    if (awaitsValidation(gradingMode, facts.criteria.get(repo.id))) c.unvalidated += 1;
    if (finalOf(repo, facts)?.toVerify) c.unverified += 1;
    counts.set(repo.projectId, c);
  }
  return counts;
}

/** The Activities rows of the projects `where` selects, newest first. */
async function activityRows(db: Db, where: SQL | undefined): Promise<ProjectActivitySummary[]> {
  const rows = await db
    .select({
      id: projects.id,
      title: projects.name,
      state: projects.state,
      gradingMode: projects.gradingMode,
      releasedAt: projects.releasedAt,
      startAt: projects.startAt,
      deadlineAt: projects.deadlineAt,
      publishMode: projects.publishMode,
      durationMinutes: projects.durationMinutes,
      source: projects.sourceFullName,
      distribution: projects.distributionFullName,
      classroomId: classrooms.id,
      classroomName: classrooms.name,
      courseCode: courses.code,
    })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .where(where)
    .orderBy(desc(projects.createdAt));
  // Only a locked project's phase reads its repositories (`projectPhase`): the counts of those alone.
  const counts = await phaseCounts(
    db,
    rows.filter((r) => r.state === "locked").map((r) => r.id),
  );
  return rows.map((r) => {
    const dates = projectListDates(r);
    return {
      kind: "project" as const,
      id: r.id,
      title: r.title,
      state: r.state,
      phase: projectPhase({
        state: r.state,
        publishMode: r.publishMode,
        gradingMode: r.gradingMode,
        released: r.releasedAt !== null,
        ...(counts.get(r.id) ?? NO_REPOS),
      }),
      classroom: { id: r.classroomId, name: r.classroomName, courseCode: r.courseCode },
      startAt: isoOrNull(dates.startAt),
      deadlineAt: isoOrNull(dates.deadlineAt),
      source: { fullName: r.source },
      distribution: r.distribution === null ? null : { fullName: r.distribution },
    };
  });
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
