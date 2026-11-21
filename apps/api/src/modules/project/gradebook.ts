/**
 * What the gradebook reads of a project (F-GBOOK, D06, ADR-074; merge task
 * M5-03a). It never recomputes: the final score is the page's own
 * (`repoScores`, `releaseOf`), the grade `scoreGrade` by the project's
 * scale through the grade adjustment (ADR-135), the snapshot what the
 * release wrote, its stored — adjusted — grade included (`released_grade`,
 * ADR-119 §11; decision 3 of `grades.ts`). A teacher's stored mark still
 * wins over either (`resolveCell`).
 *
 * - The STAFF read the LIVE final score of each seat's repository
 *   ({@link projectLiveScores}), with its source (I42) and whether it moved
 *   since the release — a column follows its activity (F-GBOOK-03).
 * - A STUDENT reads the release's snapshot of their own seat's repository
 *   ({@link studentProjectGrades}), as `studentProject` does: never the
 *   source, the comment, the review or the CI — on the classroom's Grades
 *   tab and on their Grades page (F-ORG-14) alike.
 *
 * A student who never accepted has no repository: no score here — the
 * teacher's own mark (`gradebook_marks`) fills the cell (spec 06 no. 48).
 */
import { and, eq, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";

import type { FinalScoreSource } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import {
  classrooms,
  courseHasComponents,
  courses,
  enrollments,
  excusedMarkOfSeat,
  gradebookColumns,
  gradebookComponents,
  gradebookMarks,
  projects,
} from "../../db/schema.js";
import { liveProject } from "../guards.js";
import { releaseOf, repoScores } from "./detail.js";
import { scoreFacts } from "./scores.js";
import { seatRepos } from "./groupRepos.js";
import { gradesIn, repoGrades, type RepoGrades } from "./repoGrades.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/**
 * The projects of a classroom the gradebook has a column for: graded, no
 * draft, and not archived — an archived project's grades leave the table and
 * the mean, for the staff and the students alike, until it is restored
 * (product owner, 2026-10-14).
 */
export function gradebookProjects(db: Db, classroomId: string): Promise<ProjectRow[]> {
  return db.select().from(projects).where(and(eq(projects.classroomId, classroomId), inGradebook()));
}

/** A project that may have a column, whatever its state: graded and not archived (`projectHasColumn` of `@quiz/domain`, in SQL). On a query that has `projects` in scope. */
const columnable = (): SQL => and(isNull(projects.archivedAt), ne(projects.gradingMode, "none"))!;

/** {@link gradebookProjects}' rule, on a query that has `projects` in scope. */
const inGradebook = (): SQL => and(liveProject(), columnable())!;

/**
 * A project of the classroom whose gradebook column's settings may be
 * written and read (ADR-131 §13): {@link gradebookProjects}' rule whatever
 * the state, a draft or a scheduled one included, and whether that rule
 * lists its column yet. Undefined otherwise. The caller has loaded the
 * classroom through `staffAccess`.
 */
export async function columnProject(
  db: Db,
  classroomId: string,
  projectId: string,
): Promise<{ project: ProjectRow; listed: boolean } | undefined> {
  const [row] = await db
    .select({ project: projects, listed: sql<boolean>`(${inGradebook()})` })
    .from(projects)
    .where(and(eq(projects.classroomId, classroomId), eq(projects.id, projectId), columnable()));
  return row;
}

/** A seat's grade as the staff read it. */
export interface ProjectGradeCell {
  points: number;
  max: number;
  grade: number;
  source: FinalScoreSource;
  changedAfterRelease: boolean;
}

/**
 * The LIVE final score of each seat's repository, graded by the project's
 * scale: the seat's own or its copy group's (`seatRepos`). A seat with no
 * repository, no score, a score without a maximum, or one without a grade —
 * the CI's share of a project graded by criteria before its validation
 * (`ciShareOnly`) — is absent from the map.
 */
export async function projectLiveScores(
  db: Db,
  project: ProjectRow,
  enrollmentIds: readonly string[],
): Promise<Map<string, ProjectGradeCell>> {
  const seats = await seatRepos(db, [project], enrollmentIds);
  const held = enrollmentIds.flatMap((id) => {
    const repo = seats.of(project.id, id);
    return repo === null ? [] : [{ id, repo }];
  });
  const facts = await scoreFacts(db, [...new Map(held.map(({ repo }) => [repo.id, repo] as const)).values()]);
  const cells = new Map<string, ProjectGradeCell>();
  for (const { id, repo } of held) {
    const { scores, changedAfterRelease } = repoScores(project, repo, facts);
    // The grade the release would write: the adjusted one (ADR-135).
    const { final, grade } = releaseOf(project, repo, scores);
    if (final?.max != null && grade !== null) {
      cells.set(id, { points: final.points, max: final.max, grade, source: final.source, changedAfterRelease });
    }
  }
  return cells;
}

/** A repository's release snapshot, null without a repository or a score at the release. */
function releasedSnapshot(repo: RepoRow | null, grades: ReadonlyMap<string, RepoGrades>): { points: number; max: number; grade: number } | null {
  if (repo === null) return null;
  const { releasedGrade: grade, releasedPoints: points, releasedMax: max } = gradesIn(grades, repo.id);
  return grade === null ? null : { points: points!, max: max!, grade };
}

/** One released project of a student's seat, with its classroom's header columns (F-ORG-14). */
export interface StudentProjectGrade {
  project: ProjectRow;
  classroomName: string;
  courseCode: string;
  courseName: string;
  period: string;
  archivedAt: Date | null;
  /** The teacher's `counts` of the project's stored gradebook column, null without one. */
  storedCounts: boolean | null;
  /** That column's component of the mean, null without one; whether the course has any (ADR-131, `countsInMean`). */
  componentId: string | null;
  componentName: string | null;
  courseHasComponents: boolean;
  /** The seat holds an `excused` mark on that column (#969), never its comment. */
  excused: boolean;
  /** The release's snapshot of the seat's own or group's repository; null without one or a score. */
  score: { points: number; max: number; grade: number } | null;
}

/**
 * The RELEASED projects of every classroom where `userId` holds a claimed
 * seat, archived classrooms included — the gradebook's columns
 * ({@link gradebookProjects}' rule). A teacher's staff seat reads them by
 * the same rule (ADR-018, amended 2026-11-17): its test repository is never
 * released (`studentRepos`), so its cell stays empty.
 * `classroomId` narrows it to one classroom. Each with the release's snapshot
 * of the seat's own repository or its group's (`seatRepos`, N-SEC-20).
 */
export async function studentProjectGrades(db: Db, userId: string, classroomId?: string): Promise<StudentProjectGrade[]> {
  const rows = await db
    .select({
      project: projects,
      enrollmentId: enrollments.id,
      classroomName: classrooms.name,
      period: classrooms.period,
      archivedAt: classrooms.archivedAt,
      courseCode: courses.code,
      courseName: courses.name,
      storedCounts: gradebookColumns.counts,
      excusedMarkId: gradebookMarks.id,
      componentId: gradebookColumns.componentId,
      componentName: gradebookComponents.name,
      courseHasComponents: courseHasComponents(courses.id),
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(projects, eq(projects.classroomId, classrooms.id))
    .leftJoin(gradebookColumns, eq(gradebookColumns.projectId, projects.id))
    .leftJoin(gradebookMarks, excusedMarkOfSeat())
    .leftJoin(gradebookComponents, eq(gradebookComponents.id, gradebookColumns.componentId))
    .where(
      and(
        eq(enrollments.userId, userId),
        classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
        inGradebook(),
        isNotNull(projects.releasedAt),
      ),
    );
  // One read of the seats' repositories for every project: a fixed number of statements (audit D-05).
  const seats = await seatRepos(db, rows.map((row) => row.project), rows.map((row) => row.enrollmentId));
  const held = rows.flatMap((row) => seats.of(row.project.id, row.enrollmentId) ?? []);
  const grades = await repoGrades(db, held.map((repo) => repo.id));
  return rows.map(({ enrollmentId, excusedMarkId, ...row }) => ({
    ...row,
    excused: excusedMarkId !== null,
    score: releasedSnapshot(seats.of(row.project.id, enrollmentId), grades),
  }));
}
