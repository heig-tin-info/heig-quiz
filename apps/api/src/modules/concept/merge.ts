/**
 * Merging a concept into a validated one (ADR-081, fifth addendum §2), the
 * admin's, in ONE audited transaction:
 *
 * 1. both rows are locked `FOR UPDATE`, in id order (no deadlock between two
 *    merges). `setQuestionConcepts` and `copyQuestionConcepts` share-lock the
 *    concept they link, so a write in flight finishes before the merge reads
 *    the links, and one that starts after it sees the loser merged;
 * 2. every link of the loser moves to the winner (a question linked to both
 *    keeps one), soft-deleted questions included: no link to a merged concept
 *    remains anywhere;
 * 3. the concepts already merged into the loser are re-pointed to the winner
 *    (`merged_into` always names the final concept, third addendum §3; the
 *    database checks the key and the self-merge, not the chain);
 * 4. the loser becomes `merged`, `merged_into` the winner. Its keys stay but
 *    leave the unique indexes (`status <> 'merged'`), so its label may be
 *    taken again; its old label no longer resolves (a bare label matches the
 *    live concepts only), while its id still resolves to the winner.
 *
 * The winner keeps its labels, qualifiers, descriptions and status. The audit
 * lists the question ids moved and those that already had the winner, so a
 * reviewed SQL undo is possible; there is no undo button.
 */
import { and, asc, eq, inArray } from "drizzle-orm";

import type { ConceptMergeResult } from "@quiz/contracts";

import { audit } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { concepts, questionConcepts } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { perLang, sideOf, toConcept } from "./row.js";
import type { ConceptContext } from "./service.js";

export async function mergeConcept(
  db: Db,
  ctx: Omit<ConceptContext, "caller">,
  loserId: string,
  winnerId: string,
): Promise<ConceptMergeResult> {
  if (loserId === winnerId) throw new DomainError("concept_merge_self", 422, "A concept is not merged into itself");
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(concepts)
      .where(inArray(concepts.id, [loserId, winnerId]))
      .orderBy(asc(concepts.id))
      .for("update");
    const loser = rows.find((r) => r.id === loserId);
    const winner = rows.find((r) => r.id === winnerId);
    if (!loser || !winner) throw notFoundError("concept");
    if (loser.status === "merged" || winner.status === "merged") {
      throw new DomainError("concept_merged", 409, "A merged concept is not merged again");
    }
    if (winner.status !== "validated") {
      throw new DomainError("concept_merge_target_not_validated", 422, "A concept is merged into a validated one only");
    }

    const linked = (
      await tx
        .select({ questionId: questionConcepts.questionId })
        .from(questionConcepts)
        .where(eq(questionConcepts.conceptId, loserId))
    ).map((l) => l.questionId);
    const had = new Set(
      linked.length === 0
        ? []
        : (
            await tx
              .select({ questionId: questionConcepts.questionId })
              .from(questionConcepts)
              .where(and(eq(questionConcepts.conceptId, winnerId), inArray(questionConcepts.questionId, linked)))
          ).map((l) => l.questionId),
    );
    const ids = linked.sort();
    const moved = ids.filter((id) => !had.has(id));
    const alreadyLinked = ids.filter((id) => had.has(id));
    // Chunked: the busiest concept of the vocabulary may hold thousands of questions.
    for (let i = 0; i < moved.length; i += 5000) {
      await tx
        .insert(questionConcepts)
        .values(moved.slice(i, i + 5000).map((questionId) => ({ questionId, conceptId: winnerId })))
        .onConflictDoNothing();
    }
    await tx.delete(questionConcepts).where(eq(questionConcepts.conceptId, loserId));

    const repointed = await tx
      .update(concepts)
      .set({ mergedInto: winnerId, updatedAt: ctx.now })
      .where(eq(concepts.mergedInto, loserId))
      .returning({ id: concepts.id });
    // Course-concept links (step 7, #578) join this transaction: rewrite them here as well.
    await tx
      .update(concepts)
      .set({ status: "merged", mergedInto: winnerId, updatedAt: ctx.now })
      .where(eq(concepts.id, loserId));

    const describe = (row: typeof loser) => ({
      id: row.id,
      labels: perLang((lang) => sideOf(row, lang).label),
      qualifiers: perLang((lang) => sideOf(row, lang).qualifier),
    });
    await audit(tx, {
      ...ctx.actor,
      action: "concept.merge",
      subjectType: "concept",
      subjectId: loserId,
      payload: {
        loser: describe(loser),
        winner: describe(winner),
        moved,
        alreadyLinked,
        repointed: repointed.map((r) => r.id).sort(),
      },
    });
    return { concept: toConcept(winner), moved: moved.length, alreadyLinked: alreadyLinked.length };
  });
}
