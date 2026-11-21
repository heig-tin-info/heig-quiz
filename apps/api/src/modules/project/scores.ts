/**
 * What a project repository's final score reads, and the score itself
 * (F-PROJ-14, ADR-106 §7): its three slot runs and, graded by criteria, its
 * standing — loaded for many repositories in a few reads ({@link
 * scoreFacts}) — and ONE resolution over them ({@link finalOf}), which the
 * page's rows, the score's write, the release, the gradebook and the lists'
 * phase all go through.
 */
import { eq, inArray } from "drizzle-orm";

import { resolveFinalScore, type FinalScore } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { projectGradeRuns, projectRepoGrades, users } from "../../db/schema.js";
import { fullName } from "../live/service.js";
import { criteriaStandings, type CriteriaStanding } from "./criterionGrades.js";
import { gradesIn, repoGrades, type RepoGrades } from "./repoGrades.js";
import type { RepoRow } from "./repos.js";

export type RunRow = typeof projectGradeRuns.$inferSelect;

/** The runs filling the three slots of `repos`, by id (M3-08b: shared with the score's write). */
export async function slotRuns(db: Db | Tx, repos: readonly RepoRow[]): Promise<Map<string, RunRow>> {
  const ids = repos.flatMap((repo) =>
    [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].filter((id): id is string => id !== null),
  );
  if (ids.length === 0) return new Map();
  return new Map((await db.select().from(projectGradeRuns).where(inArray(projectGradeRuns.id, ids))).map((r) => [r.id, r]));
}

/**
 * The names of the staff who wrote the grade adjustments of `repos`
 * (ADR-135), by account, as the staff name a person (`fullName`): one read,
 * none without an adjustment. Read where a staff view is built, never by
 * the release or the gradebook.
 */
export async function adjusterNames(db: Db | Tx, repos: readonly Pick<RepoRow, "id">[]): Promise<Map<string, string>> {
  if (repos.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ id: users.id, given: users.givenName, family: users.familyName, email: users.email })
    .from(projectRepoGrades)
    .innerJoin(users, eq(users.id, projectRepoGrades.gradeAdjustedBy))
    .where(inArray(projectRepoGrades.repoId, repos.map((repo) => repo.id)));
  return new Map(rows.map((u) => [u.id, fullName(u.given, u.family, u.email)]));
}

/**
 * What a repository's final score reads: its slot runs, graded by criteria
 * its standing (ADR-106 §7), and its grading as stored — the teacher's
 * score, the adjustment, the release's snapshot (`project_repo_grades`,
 * read through {@link gradesOf}).
 */
export interface ScoreFacts {
  runs: Map<string, RunRow>;
  criteria: Map<string, CriteriaStanding>;
  grades: Map<string, RepoGrades>;
}

/** The {@link ScoreFacts} of `repos`, in a few reads whatever their count. */
export async function scoreFacts(db: Db | Tx, repos: readonly RepoRow[]): Promise<ScoreFacts> {
  const [runs, criteria, grades] = await Promise.all([
    slotRuns(db, repos),
    criteriaStandings(db, repos),
    repoGrades(db, repos.map((repo) => repo.id)),
  ]);
  return { runs, criteria, grades };
}

/** A repository's grading from its {@link ScoreFacts}: every value null without a row. */
export const gradesOf = (facts: Pick<ScoreFacts, "grades">, repoId: string): RepoGrades => gradesIn(facts.grades, repoId);

type SlotIds = Pick<RepoRow, "currentGradeRunId" | "frozenGradeRunId" | "reviewGradeRunId">;

/** The repository's three slot runs — current, frozen, review — from {@link slotRuns}'s map. */
export function slots(repo: SlotIds, runs: Map<string, RunRow>): (RunRow | undefined)[] {
  return [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].map((id) => (id === null ? undefined : runs.get(id)));
}

/**
 * The repository's final score (`resolveFinalScore`): the teacher's, else the validated criteria's, else the review's, else the
 * frozen or current CI score. `teacher` is the stored teacher's score unless the caller asks without it (`teacherRunMax`).
 */
export function finalOf(
  repo: SlotIds & Pick<RepoRow, "id">,
  facts: ScoreFacts,
  teacher: Pick<RepoGrades, "teacherPoints" | "teacherMax"> = gradesOf(facts, repo.id),
): FinalScore | null {
  const [current, frozen, review] = slots(repo, facts.runs);
  return resolveFinalScore({
    teacherPoints: teacher.teacherPoints,
    teacherMax: teacher.teacherMax,
    criteriaScore: facts.criteria.get(repo.id)?.score ?? null,
    reviewScore: review ?? null,
    frozenScore: frozen ?? null,
    score: current ?? null,
  });
}
