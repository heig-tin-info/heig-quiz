/**
 * What a project repository's final score reads, and the score itself
 * (F-PROJ-14, ADR-106 §7): its three slot runs and, graded by criteria, its
 * standing — loaded for many repositories in a few reads ({@link
 * scoreFacts}) — and ONE resolution over them ({@link finalOf}), which the
 * page's rows, the score's write, the release, the gradebook and the lists'
 * phase all go through.
 */
import { inArray } from "drizzle-orm";

import { resolveFinalScore, type FinalScore } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { projectGradeRuns } from "../../db/schema.js";
import { criteriaStandings, type CriteriaStanding } from "./criterionGrades.js";
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

/** What a repository's final score reads: its slot runs and, graded by criteria, its standing (ADR-106 §7). */
export interface ScoreFacts {
  runs: Map<string, RunRow>;
  criteria: Map<string, CriteriaStanding>;
}

/** The {@link ScoreFacts} of `repos`, in a few reads whatever their count. */
export async function scoreFacts(db: Db | Tx, repos: readonly RepoRow[]): Promise<ScoreFacts> {
  const [runs, criteria] = await Promise.all([slotRuns(db, repos), criteriaStandings(db, repos)]);
  return { runs, criteria };
}

type SlotIds = Pick<RepoRow, "currentGradeRunId" | "frozenGradeRunId" | "reviewGradeRunId">;

/** The repository's three slot runs — current, frozen, review — from {@link slotRuns}'s map. */
export function slots(repo: SlotIds, runs: Map<string, RunRow>): (RunRow | undefined)[] {
  return [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].map((id) => (id === null ? undefined : runs.get(id)));
}

/** The repository's final score (`resolveFinalScore`): the teacher's, else the validated criteria's, else the review's, else the frozen or current CI score. */
export function finalOf(
  repo: SlotIds & Pick<RepoRow, "id" | "teacherPoints" | "teacherMax">,
  facts: ScoreFacts,
): FinalScore | null {
  const [current, frozen, review] = slots(repo, facts.runs);
  return resolveFinalScore({
    teacherPoints: repo.teacherPoints,
    teacherMax: repo.teacherMax,
    criteriaScore: facts.criteria.get(repo.id)?.score ?? null,
    reviewScore: review ?? null,
    frozenScore: frozen ?? null,
    score: current ?? null,
  });
}