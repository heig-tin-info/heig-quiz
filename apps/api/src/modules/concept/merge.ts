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
 * 7. the loser's relations (ADR-081 §4, sixth addendum 7c) are rewritten
 *    onto the winner by `mergedRelations`: an edge between the loser and the
 *    winner is dropped (it would be a self-loop), an edge the winner has is
 *    not written twice, and a rewrite that would close a longer broader cycle
 *    is refused BEFORE anything is written, 409 `concept_merge_cycle` naming
 *    the path. The audit lists the loser's edges and those moved, dropped and
 *    duplicate. The advisory lock of `relations.ts` is taken first.
 *
 * The winner keeps its labels, qualifiers, descriptions and status. The audit
 * lists the loser's former status and the question ids moved and those that
 * already had the winner, and the aliases moved, added and dropped, so a
 * reviewed SQL undo is possible; there is no undo button.
 */
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { Concept, ConceptLang } from "@quiz/contracts";
import { conceptKey, mergedAliases, mergedRelations } from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { conceptAliases, conceptRelations, concepts, courseConcepts, questionConcepts } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { cycleError, lockRelations } from "./relations.js";
import { loadAliases, loadEdges, loadRelations, perLang, sideOf, toConcept, toResolvable } from "./row.js";
import type { ConceptContext } from "./service.js";

/**
 * Moves the links of `loserId` in `table` to `winnerId`, for the owner column
 * `owner` (a question, a course): an owner that already links the winner
 * loses its link to the loser (`already`), every other link is re-pointed
 * (`moved`), keeping its other columns (author, date). The owners are
 * answered sorted, for the audit.
 */
async function moveLinks(
  tx: Tx,
  table: typeof questionConcepts | typeof courseConcepts,
  owner: PgColumn,
  loserId: string,
  winnerId: string,
): Promise<{ moved: string[]; already: string[] }> {
  const concept = table.conceptId;
  const t = table as PgTable;
  const already = await tx
    .delete(t)
    .where(and(eq(concept, loserId), inArray(owner, tx.select({ o: owner }).from(t).where(eq(concept, winnerId)))))
    .returning({ id: owner });
  const moved = await tx
    .update(t)
    .set({ conceptId: winnerId } as never)
    .where(eq(concept, loserId))
    .returning({ id: owner });
  const ids = (rows: { id: unknown }[]) => rows.map((r) => String(r.id)).sort();
  return { moved: ids(moved), already: ids(already) };
}

export async function mergeConcept(
  db: Db,
  ctx: ConceptContext,
  loserId: string,
  winnerId: string,
  keepAsAlias: boolean,
  lang: ConceptLang,
): Promise<Concept> {
  if (loserId === winnerId) throw new DomainError("concept_merge_self", 422, "A concept is not merged into itself");
  return db.transaction(async (tx) => {
    // Before any row lock, like every relation write (`relations.ts`): the relations are rewritten below.
    await lockRelations(tx);
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

    // The relations are decided first: a cycle is refused before anything is written.
    const edges = await loadEdges(tx);
    const relations = mergedRelations(edges, loserId, winnerId);
    if (relations.cycle) throw await cycleError(tx, "concept_merge_cycle", relations.cycle, lang);

    const questionLinks = await moveLinks(tx, questionConcepts, questionConcepts.questionId, loserId, winnerId);

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
    // The loser's relations go with it; those that survive are rewritten onto the winner (sixth addendum, 7c).
    const touching = (e: { concept: string; target: string }) => e.concept === loserId || e.target === loserId;
    const ofLoser = { broader: edges.broader.filter(touching), related: edges.related.filter(touching) };
    await tx.delete(conceptRelations).where(or(eq(conceptRelations.conceptId, loserId), eq(conceptRelations.targetId, loserId)));
    const rewritten = [
      ...relations.moved.broader.map((e) => ({ ...e, kind: "broader" as const })),
      ...relations.moved.related.map((e) => ({ ...e, kind: "related" as const })),
    ];
    if (rewritten.length > 0) {
      await tx.insert(conceptRelations).values(
        rewritten.map((e) => ({ conceptId: e.concept, targetId: e.target, kind: e.kind, createdBy: ctx.caller.id, createdAt: ctx.now })),
      );
    }
    // The courses listing the loser list the winner instead (sixth addendum): a course listing both keeps one.
    const courseLinks = await moveLinks(tx, courseConcepts, courseConcepts.courseId, loserId, winnerId);
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
        moved: questionLinks.moved,
        alreadyLinked: questionLinks.already,
        coursesMoved: courseLinks.moved,
        coursesAlreadyListed: courseLinks.already,
        repointed: repointed.map((r) => r.id).sort(),
        aliasesMoved,
        aliasesAdded,
        aliasesDropped,
        relationsOfLoser: ofLoser,
        relationsMoved: relations.moved,
        relationsDropped: relations.dropped,
        relationsDuplicate: relations.duplicates,
      },
    });
    return toConcept(winner, (await loadAliases(tx, [winnerId])).get(winnerId), (await loadRelations(tx, [winnerId])).get(winnerId));
  });
}
