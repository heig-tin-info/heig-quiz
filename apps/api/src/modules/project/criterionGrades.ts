/**
 * The one writer of `project_criterion_grades` (ADR-106 §4), modelled on
 * `writeGradings` (`modules/grading/service.ts`): the evidence job writes
 * the automatic rows through it, the review job (L-02c) the llm rows, the
 * grading screen (L-02e) the teacher's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { projectCriterionGrades, projectRepos } from "../../db/schema.js";

export type CriterionGradeRow = typeof projectCriterionGrades.$inferSelect;

/** One criterion's new row. */
export interface CriterionGradeInput {
  criterionId: string;
  points: number;
  max: number;
  source: CriterionGradeRow["source"];
  state: "proposed" | "validated";
  rationale?: string | null;
  reason?: string | null;
  passId: string | null;
  createdBy?: string | null;
}

/**
 * Writes one row per input for the repository, in one transaction under
 * the repository row's lock and two statements: the rows they replace
 * superseded (`UPDATE … RETURNING`), then one insert, each new row pointing
 * at the newest row its criterion lost. A `validated` input supersedes
 * everything standing on its criterion; a `proposed` one only a previous
 * proposal — the callers that propose skip a validated criterion. A
 * criterion appears at most once per call. The rows come back in the order
 * of `inputs`.
 */
export async function writeCriterionGrades(
  db: Db,
  repoId: string,
  inputs: readonly CriterionGradeInput[],
  now: Date,
): Promise<CriterionGradeRow[]> {
  if (new Set(inputs.map((i) => i.criterionId)).size !== inputs.length) {
    throw new Error("writeCriterionGrades: a criterion appears twice in one call");
  }
  if (inputs.length === 0) return [];
  const among = (state: CriterionGradeInput["state"]) => {
    const ids = inputs.filter((i) => i.state === state).map((i) => i.criterionId);
    return ids.length === 0 ? sql`false` : inArray(projectCriterionGrades.criterionId, ids);
  };
  return db.transaction(async (tx) => {
    await tx.select({ id: projectRepos.id }).from(projectRepos).where(eq(projectRepos.id, repoId)).for("update");
    const superseded = await tx
      .update(projectCriterionGrades)
      .set({ state: "superseded" })
      .where(
        and(
          eq(projectCriterionGrades.repoId, repoId),
          ne(projectCriterionGrades.state, "superseded"),
          or(among("validated"), and(among("proposed"), eq(projectCriterionGrades.state, "proposed"))),
        ),
      )
      .returning({ id: projectCriterionGrades.id, criterionId: projectCriterionGrades.criterionId, createdAt: projectCriterionGrades.createdAt });
    const previous = new Map<string, { id: string; createdAt: Date }>();
    for (const row of superseded) {
      const held = previous.get(row.criterionId);
      if (!held || row.createdAt >= held.createdAt) previous.set(row.criterionId, row);
    }
    return tx
      .insert(projectCriterionGrades)
      .values(
        inputs.map((input) => ({
          ...input,
          id: randomUUID(),
          repoId,
          supersedesId: previous.get(input.criterionId)?.id ?? null,
          createdAt: now,
        })),
      )
      .returning();
  });
}
