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
 * 5. the loser's curated aliases move to the winner, so none resolves to
 *    the loser; one the winner answers to already is dropped. With
 *    `keepAsAlias` (the caller always says; by default §6 drops the label) the
 *    loser's labels become aliases of the winner too. The rule is
 *    `mergedAliases` of `@quiz/domain`; the audit records what moved, was
 *    added and was dropped.
 *
 * 6. the courses listing the loser list the winner instead (a course listing
 *    both keeps one), recorded as `coursesMoved` and `coursesAlreadyListed`.
 *
 * The winner keeps its labels, qualifiers, descriptions and status. The audit
 * lists the loser's former status and the question ids moved and those that
 * already had the winner, and the aliases moved, added and dropped, so a
 * reviewed SQL undo is possible; there is no undo button.
 */
import { asc, eq, inArray, sql } from "drizzle-orm";

import type { Concept } from "@quiz/contracts";
import { conceptKey, mergedAliases } from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { conceptAliases, concepts, courseConcepts, questionConcepts } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { loadAliases, perLang, sideOf, toConcept, toResolvable } from "./row.js";
import type { ConceptContext } from "./service.js";

export async function mergeConcept(
  db: Db,
  ctx: ConceptContext,
  loserId: string,
  winnerId: string,
  keepAsAlias: boolean,
): Promise<Concept> {
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

    // Two statements: the links the winner lacked are `moved`, every link of the loser is deleted.
    const moved = (
      await tx
        .insert(questionConcepts)
        .select(
          tx
            .select({ questionId: questionConcepts.questionId, conceptId: sql<string>`${winnerId}::uuid`.as("concept_id") })
            .from(questionConcepts)
            .where(eq(questionConcepts.conceptId, loserId)),
        )
        .onConflictDoNothing()
        .returning({ id: questionConcepts.questionId })
    )
      .map((r) => r.id)
      .sort();
    const all = (await tx.delete(questionConcepts).where(eq(questionConcepts.conceptId, loserId)).returning({ id: questionConcepts.questionId }))
      .map((r) => r.id);
    const movedSet = new Set(moved);
    const alreadyLinked = all.filter((id) => !movedSet.has(id)).sort();

    const repointed = await tx
      .update(concepts)
      .set({ mergedInto: winnerId, updatedAt: ctx.now })
      .where(eq(concepts.mergedInto, loserId))
      .returning({ id: concepts.id });
    const aliases = await loadAliases(tx, [loserId, winnerId]);
    const { moved: aliasesMoved, added: aliasesAdded, dropped: aliasesDropped } = mergedAliases(
      toResolvable(loser, aliases),
      toResolvable(winner, aliases),
      keepAsAlias,
    );
    await tx.delete(conceptAliases).where(eq(conceptAliases.conceptId, loserId));
    const gained = [...aliasesMoved, ...aliasesAdded];
    if (gained.length > 0) {
      await tx.insert(conceptAliases).values(
        gained.map((text) => ({ conceptId: winnerId, key: conceptKey(text), text, createdBy: ctx.caller.id, createdAt: ctx.now })),
      );
    }
    // The courses listing the loser list the winner instead (sixth addendum): a course listing both keeps one.
    const coursesMoved = (
      await tx
        .insert(courseConcepts)
        .select(
          tx
            .select({
              courseId: courseConcepts.courseId,
              conceptId: sql<string>`${winnerId}::uuid`.as("concept_id"),
              addedBy: courseConcepts.addedBy,
              addedAt: courseConcepts.addedAt,
            })
            .from(courseConcepts)
            .where(eq(courseConcepts.conceptId, loserId)),
        )
        .onConflictDoNothing()
        .returning({ id: courseConcepts.courseId })
    )
      .map((r) => r.id)
      .sort();
    const coursesAll = (
      await tx.delete(courseConcepts).where(eq(courseConcepts.conceptId, loserId)).returning({ id: courseConcepts.courseId })
    ).map((r) => r.id);
    const coursesMovedSet = new Set(coursesMoved);
    const coursesAlreadyListed = coursesAll.filter((id) => !coursesMovedSet.has(id)).sort();
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
        loser: { ...describe(loser), status: loser.status },
        winner: describe(winner),
        moved,
        alreadyLinked,
        coursesMoved,
        coursesAlreadyListed,
        repointed: repointed.map((r) => r.id).sort(),
        aliasesMoved,
        aliasesAdded,
        aliasesDropped,
      },
    });
    return toConcept(winner, (await loadAliases(tx, [winnerId])).get(winnerId));
  });
}
