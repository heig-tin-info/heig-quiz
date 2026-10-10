/**
 * The relations between concepts (ADR-081 §4, sixth addendum 7c), the
 * admin's: `broader` (a concept may have several broader concepts, never a
 * cycle) and `related` (symmetric, stored once in canonical order). The
 * rules are `@quiz/domain`'s (`checkBroaderEdge`, `checkRelatedEdge`).
 *
 * **Locks.** A cycle check reads the whole graph, so two writes that are each
 * valid alone (`A broader B` and `B broader A`) could both pass it. Every
 * relation write, the merge (which rewrites relations) and the deletion of a
 * concept (whose relations cascade, and which a merge may be inserting a
 * relation to) first take ONE transaction-scoped advisory lock
 * (`lockRelations`): they serialize, and the second reads the first's edge.
 * A deletion therefore never meets a merge's insert, so no foreign key
 * violation or deadlock can come of it. Then the two concepts are
 * share-locked in id order, like `lockLinkSet`. The advisory lock is always
 * taken BEFORE any row lock and no writer of question or course links takes
 * it, so advisory-then-rows cannot form a cycle with them: a relation write
 * and a link write share-lock rows; the merge takes the advisory lock, then
 * `FOR UPDATE` in id order, as before.
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Concept, ConceptCycle, ConceptLang, ConceptRelationAdd, ConceptRelationKind } from "@quiz/contracts";
import {
  canonicalRelated,
  checkBroaderEdge,
  checkRelatedEdge,
  type RelationEdges,
  type RelationRefusal,
} from "@quiz/domain";

import { audit } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { conceptRelations, concepts } from "../../db/schema.js";
import { DomainError, notFoundError } from "../http.js";
import { loadConcept, loadEdges, perLang, sideOf, toConceptRef } from "./row.js";
import type { ConceptContext } from "./service.js";

/** The key of the advisory lock every relation write and every merge takes first. */
export async function lockRelations(tx: Db | Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('concept-relations', 0))`);
}

/** The concepts of `path`, labelled in `lang`: the body of a cycle refusal. */
export async function cyclePath(tx: Db | Tx, path: readonly string[], lang: ConceptLang): Promise<ConceptCycle["path"]> {
  const rows = await tx.select().from(concepts).where(inArray(concepts.id, [...new Set(path)]));
  return path.map((id) => toConceptRef(rows.find((r) => r.id === id)!, lang));
}

/** The 409 of a closed `path`, named by its concepts. */
export async function cycleError(
  tx: Db | Tx,
  code: ConceptCycle["error"],
  path: readonly string[],
  lang: ConceptLang,
): Promise<DomainError> {
  return new DomainError(code, 409, "This would make a concept broader than itself", {
    path: await cyclePath(tx, path, lang),
  } satisfies Omit<ConceptCycle, "error" | "message">);
}

async function refusalError(tx: Db | Tx, refusal: RelationRefusal, lang: ConceptLang): Promise<DomainError> {
  switch (refusal.kind) {
    case "self":
      return new DomainError("relation_self", 422, "A concept is not related to itself");
    case "exists":
      return new DomainError("relation_exists", 409, "This relation exists already");
    case "redundant":
      return new DomainError("relation_redundant", 409, "These concepts are already connected by a hierarchy or a relation");
    case "cycle":
      return cycleError(tx, "concept_cycle", refusal.path, lang);
  }
}

/** Serializes, then share-locks both concepts in id order; the first is live (409 otherwise), the second must be too (422). */
async function lockPair(tx: Db | Tx, id: string, target: string) {
  await lockRelations(tx);
  const rows = await tx
    .select()
    .from(concepts)
    .where(inArray(concepts.id, [id, target]))
    .orderBy(concepts.id)
    .for("share");
  const row = rows.find((r) => r.id === id);
  if (!row) throw notFoundError("concept");
  if (row.status === "merged") throw new DomainError("concept_merged", 409, "A merged concept has no relations");
  const other = rows.find((r) => r.id === target);
  if (!other || other.status === "merged") {
    throw new DomainError("concept_not_found", 422, "A concept is missing or merged", { ids: [target] });
  }
  return { row, other };
}

export async function addRelation(
  db: Db,
  ctx: ConceptContext,
  id: string,
  body: ConceptRelationAdd,
  lang: ConceptLang,
): Promise<Concept> {
  return db.transaction(async (tx) => {
    const { row, other } = await lockPair(tx, id, body.target);
    const edges: RelationEdges = await loadEdges(tx);
    const refusal =
      body.kind === "broader" ? checkBroaderEdge(edges, id, body.target) : checkRelatedEdge(edges, id, body.target);
    if (refusal) throw await refusalError(tx, refusal, lang);
    const edge = body.kind === "broader" ? { concept: id, target: body.target } : canonicalRelated(id, body.target);
    await tx.insert(conceptRelations).values({
      conceptId: edge.concept,
      targetId: edge.target,
      kind: body.kind,
      createdBy: ctx.caller.id,
      createdAt: ctx.now,
    });
    await audit(tx, {
      ...ctx.actor,
      action: "concept.relation_add",
      subjectType: "concept",
      subjectId: id,
      payload: { kind: body.kind, target: body.target, labels: perLang((l) => sideOf(other, l).label) },
    });
    return loadConcept(tx, row);
  });
}

export async function removeRelation(
  db: Db,
  ctx: ConceptContext,
  id: string,
  kind: ConceptRelationKind,
  target: string,
): Promise<Concept> {
  return db.transaction(async (tx) => {
    await lockRelations(tx);
    const [row] = await tx.select().from(concepts).where(eq(concepts.id, id)).for("share");
    if (!row) throw notFoundError("concept");
    const edge = kind === "broader" ? { concept: id, target } : canonicalRelated(id, target);
    const [gone] = await tx
      .delete(conceptRelations)
      .where(
        and(
          eq(conceptRelations.conceptId, edge.concept),
          eq(conceptRelations.targetId, edge.target),
          eq(conceptRelations.kind, kind),
        ),
      )
      .returning();
    if (!gone) throw notFoundError("relation");
    await audit(tx, {
      ...ctx.actor,
      action: "concept.relation_remove",
      subjectType: "concept",
      subjectId: id,
      payload: { kind, target },
    });
    return loadConcept(tx, row);
  });
}
