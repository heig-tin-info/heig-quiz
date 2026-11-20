/**
 * The rows of the agreement figures (ADR-139 §15, which says how each path
 * of the grading history counts); `evaluationFigures` of `@quiz/domain`
 * assembles them. One query per figure for the whole evaluation, over the
 * class's official attempts only, as `openContestationCounts` counts them.
 *
 * The model's proposal is the grading `source = 'llm'` that no person wrote
 * (`graded_by` null): a validation keeps the source and adds the teacher.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { AiAgreement, GradingFigures } from "@quiz/contracts";
import { evaluationFigures, type AgreementRow, type ContestationRow } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, contestations, evaluations, gradings, isStaffAttempt, officialAttempt } from "../../db/schema.js";

/** The class's official attempts of one evaluation; `attempts` and `evaluations` joined by name. */
const classAttemptOf = (evaluationId: string) =>
  and(eq(attempts.evaluationId, evaluationId), officialAttempt, sql`not ${isStaffAttempt}`);

/**
 * Each compared cell (of `itemIds` only, when given): its latest proposal
 * beside the validated grading in force; none when that proposal is a
 * failed call, which states no confidence.
 */
async function agreementRows(db: Db, evaluationId: string, itemIds?: readonly string[]): Promise<AgreementRow[]> {
  if (itemIds?.length === 0) return [];
  const inForce = alias(gradings, "in_force");
  const latest = await db
    .selectDistinctOn([gradings.attemptId, gradings.itemId], {
      itemId: gradings.itemId,
      proposal: gradings.points,
      confidence: gradings.confidence,
      inForce: inForce.points,
    })
    .from(gradings)
    .innerJoin(
      inForce,
      and(eq(inForce.attemptId, gradings.attemptId), eq(inForce.itemId, gradings.itemId), eq(inForce.state, "validated")),
    )
    .innerJoin(attempts, eq(attempts.id, gradings.attemptId))
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(
      and(
        classAttemptOf(evaluationId),
        eq(gradings.source, "llm"),
        isNull(gradings.gradedBy),
        itemIds ? inArray(gradings.itemId, [...itemIds]) : undefined,
      ),
    )
    .orderBy(gradings.attemptId, gradings.itemId, desc(gradings.gradedAt), desc(gradings.createdAt));
  return latest.flatMap(({ confidence, ...row }) => (confidence === null ? [] : [{ ...row, confidence }]));
}

/** The AI's agreement per item of `itemIds`: the grading panel's question bar. */
export async function aiAgreementByItem(
  db: Db,
  evaluationId: string,
  itemIds: readonly string[],
): Promise<Map<string, AiAgreement | null>> {
  const { byItem } = evaluationFigures(itemIds, await agreementRows(db, evaluationId, itemIds), [], new Map());
  return new Map([...byItem].map(([id, figures]) => [id, figures.agreement]));
}

/**
 * The contestations filed on the class's attempts, each with the source of
 * the grading it contested, and — only when there is one — the graded cells
 * per item, their denominator.
 */
async function contestationRows(
  db: Db,
  evaluationId: string,
): Promise<{ rows: ContestationRow[]; graded: Map<string, number> }> {
  const contested = alias(gradings, "contested");
  const rows = await db
    .select({ itemId: contestations.itemId, state: contestations.state, source: contested.source })
    .from(contestations)
    .innerJoin(attempts, eq(attempts.id, contestations.attemptId))
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .leftJoin(contested, eq(contested.id, contestations.gradingAtFilingId))
    .where(classAttemptOf(evaluationId));
  if (rows.length === 0) return { rows, graded: new Map() };
  const graded = await db
    .select({ itemId: gradings.itemId, n: sql<number>`count(*)::int` })
    .from(gradings)
    .innerJoin(attempts, eq(attempts.id, gradings.attemptId))
    .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
    .where(and(classAttemptOf(evaluationId), eq(gradings.state, "validated")))
    .groupBy(gradings.itemId);
  return { rows, graded: new Map(graded.map((g) => [g.itemId, g.n])) };
}

/** Every figure of the evaluation, per item of `itemIds` and over them all: the results' Questions tab. */
export async function gradingFigures(
  db: Db,
  evaluationId: string,
  itemIds: readonly string[],
): Promise<{ byItem: Map<string, GradingFigures>; total: GradingFigures }> {
  const [compared, filed] = await Promise.all([agreementRows(db, evaluationId), contestationRows(db, evaluationId)]);
  return evaluationFigures(itemIds, compared, filed.rows, filed.graded);
}
