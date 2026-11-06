/**
 * What the gradebook reads of a project (F-GBOOK, D06, ADR-074; merge task
 * M5-03a). It never recomputes: the final score is the page's own
 * (`repoScores`, `releasableScore`), the grade `scoreGrade` by the project's
 * scale, the snapshot what the release wrote, its stored grade included
 * (`released_grade`, ADR-119 §11; decision 3 of `grades.ts`).
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
import { and, eq, isNotNull, ne, type SQL } from "drizzle-orm";

import type { FinalScoreSource } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { classrooms, courses, enrollments, excusedMarkOfSeat, gradebookColumns, gradebookMarks, projects } from "../../db/schema.js";
import { liveProject } from "../guards.js";
import { repoScores, releasableScore } from "./detail.js";
import { scoreFacts } from "./scores.js";
import { seatRepos } from "./groupRepos.js";
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

/** {@link gradebookProjects}' rule, on a query that has `projects` in scope. */
const inGradebook = (): SQL => and(liveProject(), ne(projects.gradingMode, "none"))!;

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
 * repository, no score, or a score without a maximum is absent from the map.
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
    const final = releasableScore(project, repo, scores.final);
    if (final?.max != null && final.grade !== null) {
      cells.set(id, { points: final.points, max: final.max, grade: final.grade.grade, source: final.source, changedAfterRelease });
    }
  }
  return cells;
}

/** A repository's release snapshot, null without a repository or a score at the release. */
function releasedSnapshot(repo: RepoRow | null): { points: number; max: number; grade: number } | null {
  const grade = repo?.releasedGrade ?? null;
  return repo === null || grade === null ? null : { points: repo.releasedPoints!, max: repo.releasedMax!, grade };
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
  /** The seat holds an `excused` mark on that column (#969), never its comment. */
  excused: boolean;
  /** The release's snapshot of the seat's own or group's repository; null without one or a score. */
  score: { points: number; max: number; grade: number } | null;
}

/**
 * The RELEASED projects of every classroom where `userId` holds a claimed
 * student seat, archived classrooms included — the gradebook's columns
 * ({@link gradebookProjects}' rule), never a staff seat (ADR-018 §3).
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
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .innerJoin(projects, eq(projects.classroomId, classrooms.id))
    .leftJoin(gradebookColumns, eq(gradebookColumns.projectId, projects.id))
    .leftJoin(gradebookMarks, excusedMarkOfSeat())
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.staff, false),
        classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
        inGradebook(),
        isNotNull(projects.releasedAt),
      ),
    );
  // One read of the seats' repositories for every project: a fixed number of statements (audit D-05).
  const seats = await seatRepos(db, rows.map((row) => row.project), rows.map((row) => row.enrollmentId));
  return rows.map(({ enrollmentId, excusedMarkId, ...row }) => ({
    ...row,
    excused: excusedMarkId !== null,
    score: releasedSnapshot(seats.of(row.project.id, enrollmentId)),
  }));
}
