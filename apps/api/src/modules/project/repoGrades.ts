/**
 * A repository's grading as stored (`project_repo_grades`, F-PROJ-14,
 * ADR-135): the teacher's score, the grade adjustment, the release's
 * snapshot. The one reader and the one writer of that table: a row exists
 * only while one of its values is set, so an absent row reads as every value
 * null ({@link NO_GRADES}), and a write that leaves none deletes it.
 */
import { eq, inArray } from "drizzle-orm";

import type { Db, Tx } from "../../db/client.js";
import { projectRepoGrades } from "../../db/schema.js";

export type RepoGrades = Omit<typeof projectRepoGrades.$inferSelect, "repoId">;

/** The grading of a repository without a row: nothing written. */
export const NO_GRADES: Readonly<RepoGrades> = Object.freeze({
  teacherPoints: null,
  teacherMax: null,
  teacherComment: null,
  teacherGradedBy: null,
  teacherGradedAt: null,
  gradeAdjustKind: null,
  gradeAdjustValue: null,
  gradeAdjustBase: null,
  gradeAdjustComment: null,
  gradeAdjustedBy: null,
  gradeAdjustedAt: null,
  releasedPoints: null,
  releasedMax: null,
  releasedGrade: null,
  releasedComment: null,
  releasedAdjustmentComment: null,
});

const withoutKey = ({ repoId: _repoId, ...grades }: typeof projectRepoGrades.$inferSelect): RepoGrades => grades;

/** The grading of `repoIds`, by repository, in one read; a repository without a row is absent (read it through {@link gradesIn}). */
export async function repoGrades(db: Db | Tx, repoIds: readonly string[]): Promise<Map<string, RepoGrades>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db.select().from(projectRepoGrades).where(inArray(projectRepoGrades.repoId, [...new Set(repoIds)]));
  return new Map(rows.map((row) => [row.repoId, withoutKey(row)]));
}

/** A repository's grading from {@link repoGrades}'s map: {@link NO_GRADES} without a row. */
export const gradesIn = (grades: ReadonlyMap<string, RepoGrades>, repoId: string): RepoGrades => grades.get(repoId) ?? NO_GRADES;

/**
 * Writes `values` into `repoId`'s grading, in the caller's transaction: one
 * upsert — a plain update when every value is null, which creates no row —,
 * then the row deleted when it holds no value any more. The columns
 * written together (a score, an adjustment's six, a release's snapshot) are
 * one statement, so `project_repo_grades_adjust_whole` sees them whole —
 * and `values` is always such a whole group: the upsert's proposed row is
 * checked before its conflict is. Answers the grading as it now stands.
 */
export async function writeGrades(tx: Tx, repoId: string, values: Partial<RepoGrades>): Promise<RepoGrades> {
  const clearing = Object.values(values).every((value) => value === null);
  const [row] = clearing
    ? await tx.update(projectRepoGrades).set(values).where(eq(projectRepoGrades.repoId, repoId)).returning()
    : await tx
        .insert(projectRepoGrades)
        .values({ ...values, repoId })
        .onConflictDoUpdate({ target: projectRepoGrades.repoId, set: values })
        .returning();
  // Clearing a repository without a row: nothing to write, nothing written.
  if (row === undefined) return NO_GRADES;
  const grades = withoutKey(row);
  if (Object.values(grades).every((value) => value === null)) {
    await tx.delete(projectRepoGrades).where(eq(projectRepoGrades.repoId, repoId));
  }
  return grades;
}
