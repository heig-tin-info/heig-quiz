/**
 * What the gradebook reads of a project (F-GBOOK, D06, ADR-074; merge task
 * M5-03a). It never recomputes: the final score is the page's own
 * (`repoScores`, `releasableScore`), the grade `scoreGrade` by the project's
 * scale, the snapshot what the release wrote (decision 3 of `grades.ts`).
 *
 * - The STAFF read the LIVE final score of each seat's repository
 *   ({@link projectLiveScores}), with its source (I42) and whether it moved
 *   since the release — a column follows its activity (F-GBOOK-03).
 * - A STUDENT reads the release's snapshot of their own seat's repository
 *   ({@link projectReleasedScore}), as `studentProject` does: never the
 *   source, the comment, the review or the CI.
 *
 * A student who never accepted has no repository: no score here — the
 * teacher's own mark (`gradebook_marks`) fills the cell (spec 06 no. 48).
 */
import { and, eq, ne } from "drizzle-orm";

import { scoreGrade, type FinalScoreSource } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { repoScores, releasableScore, slotRuns } from "./detail.js";
import { seatRepo, seatRepos } from "./groupRepos.js";
import type { ProjectRow } from "./views.js";

/** The projects of a classroom the gradebook has a column for: graded, and no draft. */
export function gradebookProjects(db: Db, classroomId: string): Promise<ProjectRow[]> {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.classroomId, classroomId), ne(projects.state, "draft"), eq(projects.gradingMode, "auto")));
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
  const runs = await slotRuns(db, [...new Map(held.map(({ repo }) => [repo.id, repo] as const)).values()]);
  const cells = new Map<string, ProjectGradeCell>();
  for (const { id, repo } of held) {
    const { scores, changedAfterRelease } = repoScores(project, repo, runs);
    const final = releasableScore(project, repo, scores.final);
    if (final?.max != null && final.grade !== null) {
      cells.set(id, { points: final.points, max: final.max, grade: final.grade.grade, source: final.source, changedAfterRelease });
    }
  }
  return cells;
}

/**
 * What the release wrote for the seat's repository, graded by the project's
 * scale: null before the release, for a seat with no repository, and for a
 * repository that had no score at the release.
 */
export async function projectReleasedScore(
  db: Db,
  project: ProjectRow,
  enrollmentId: string,
): Promise<{ points: number; max: number; grade: number } | null> {
  if (project.releasedAt === null) return null;
  const repo = await seatRepo(db, project, enrollmentId);
  const grade = scoreGrade(repo?.releasedPoints ?? null, repo?.releasedMax ?? null, project.gradingScale);
  return repo === null || grade === null ? null : { points: repo.releasedPoints!, max: repo.releasedMax!, grade: grade.grade };
}
