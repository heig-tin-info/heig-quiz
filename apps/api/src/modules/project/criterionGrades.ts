/**
 * The one writer of `project_criterion_grades` (ADR-106 §4), modelled on
 * `writeGradings` (`modules/grading/service.ts`): the evidence job writes
 * the automatic rows through it, the review job (L-02c) the llm rows, the
 * grading screen (L-02e) the teacher's.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import type { Db, Tx } from "../../db/client.js";
import { projectCriterionGrades, projectRepos } from "../../db/schema.js";

export type CriterionGradeRow = typeof projectCriterionGrades.$inferSelect;

/**
 * The criteria of a repository a machine may not propose: a standing
 * validated or teacher's row — and, with `passId`, a row of that pass (a
 * job run twice proposes nothing again).
 */
export async function heldCriteria(db: Db | Tx, repoId: string, passId?: string): Promise<Set<string>> {
  const rows = await db
    .select({ criterionId: projectCriterionGrades.criterionId })
    .from(projectCriterionGrades)
    .where(
      and(
        eq(projectCriterionGrades.repoId, repoId),
        ne(projectCriterionGrades.state, "superseded"),
        or(
          eq(projectCriterionGrades.state, "validated"),
          eq(projectCriterionGrades.source, "manual"),
          passId === undefined ? sql`false` : eq(projectCriterionGrades.passId, passId),
        ),
      ),
    );
  return new Set(rows.map((r) => r.criterionId));
}

/**
 * A deadline moved later before the release (ADR-106 §5, §6): the
 * machine's standing proposals (`auto`, `llm`) of the reopened
 * repositories superseded, with no successor — the next freeze's pass
 * proposes again. A validated row and a teacher's stay. In the caller's
 * transaction, which holds the repositories' rows.
 */
export async function supersedeProposals(tx: Tx, repoIds: readonly string[]): Promise<number> {
  if (repoIds.length === 0) return 0;
  const rows = await tx
    .update(projectCriterionGrades)
    .set({ state: "superseded" })
    .where(
      and(
        inArray(projectCriterionGrades.repoId, [...repoIds]),
        eq(projectCriterionGrades.state, "proposed"),
        inArray(projectCriterionGrades.source, ["auto", "llm"]),
      ),
    )
    .returning({ id: projectCriterionGrades.id });
  return rows.length;
}

/** One criterion's new row. */
export interface CriterionGradeInput {
  criterionId: string;
  points: number;
  max: number;
  source: CriterionGradeRow["source"];
  state: "proposed" | "validated";
  rationale?: string | null;
  reason?: CriterionGradeRow["reason"];
  passId: string | null;
  createdBy?: string | null;
}

/**
 * Writes one row per input for the repository, in one transaction under
 * the repository row's lock and two statements: the rows they replace
 * superseded (`UPDATE … RETURNING`), then one insert, each new row pointing
 * at the newest row its criterion lost.
 *
 * - A `manual` input — a teacher's row, in the state it carries — and a
 *   `validated` one supersede everything standing on their criterion,
 *   whatever its source or state.
 * - A machine's `proposed` input supersedes only a machine's proposal, and
 *   is DROPPED when its criterion is held ({@link heldCriteria}: a standing
 *   validated or teacher's row) — read under the lock, so a teacher's row
 *   written while a model was being asked always wins (the callers' own
 *   check only spares a needless call).
 *
 * A criterion appears at most once per call. The rows written come back in
 * the order of `inputs`.
 */
export async function writeCriterionGrades(
  db: Db,
  repoId: string,
  all: readonly CriterionGradeInput[],
  now: Date,
): Promise<CriterionGradeRow[]> {
  if (new Set(all.map((i) => i.criterionId)).size !== all.length) {
    throw new Error("writeCriterionGrades: a criterion appears twice in one call");
  }
  if (all.length === 0) return [];
  const overrides = (i: CriterionGradeInput) => i.source === "manual" || i.state === "validated";
  return db.transaction(async (tx) => {
    await tx.select({ id: projectRepos.id }).from(projectRepos).where(eq(projectRepos.id, repoId)).for("update");
    const held = await heldCriteria(tx, repoId);
    const inputs = all.filter((i) => overrides(i) || !held.has(i.criterionId));
    if (inputs.length === 0) return [];
    const among = (override: boolean) => {
      const ids = inputs.filter((i) => overrides(i) === override).map((i) => i.criterionId);
      return ids.length === 0 ? sql`false` : inArray(projectCriterionGrades.criterionId, ids);
    };
    const superseded = await tx
      .update(projectCriterionGrades)
      .set({ state: "superseded" })
      .where(
        and(
          eq(projectCriterionGrades.repoId, repoId),
          ne(projectCriterionGrades.state, "superseded"),
          or(
            among(true),
            and(among(false), eq(projectCriterionGrades.state, "proposed"), ne(projectCriterionGrades.source, "manual")),
          ),
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
