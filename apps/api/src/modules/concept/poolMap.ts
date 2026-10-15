/**
 * A pool's concepts, counted with their narrower ones (ADR-116): one
 * computation, the pure `conceptMap` of `@quiz/domain` (invariant 8), feeds
 * both the table of the pool's Concepts tab (`PoolDetail.concepts`, through
 * {@link poolConcepts}) and its map (`GET /pools/:id/concept-map`, through
 * {@link poolConceptMap}). A concept's number is what its click opens: the
 * pool's filter widens to the narrower concepts by the same rule
 * (`coverage`, `./courseConcepts.ts`).
 *
 * The caller has loaded the pool through its access predicate; nothing here
 * reaches a student.
 */
import { and, eq, isNull } from "drizzle-orm";

import type { ConceptLang, ConceptRef, PoolConcept, PoolConceptMap } from "@quiz/contracts";
import { conceptMap, type ConceptLink, type ConceptMap } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { questionConcepts, questions } from "../../db/schema.js";
import { byLabel } from "./links.js";
import { finalConceptRefs, loadEdges } from "./row.js";

/** The links of the pool's live questions (drafts included, deleted ones not): one query. */
async function poolLinks(db: Db | Tx, poolId: string): Promise<ConceptLink[]> {
  return db
    .select({ question: questionConcepts.questionId, concept: questionConcepts.conceptId })
    .from(questionConcepts)
    .innerJoin(questions, eq(questions.id, questionConcepts.questionId))
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)));
}

/** The pool's concepts and their broader ones, counted (ADR-116 §1); the edges are read once. */
async function poolConceptCounts(db: Db | Tx, poolId: string): Promise<ConceptMap> {
  const links = await poolLinks(db, poolId);
  return conceptMap(links, (await loadEdges(db)).broader);
}

/** The given nodes, each with its concept labelled in `lang`, by label then id. */
async function labelled<N extends { id: string }>(db: Db | Tx, nodes: readonly N[], lang: ConceptLang): Promise<(N & { concept: ConceptRef })[]> {
  const refs = await finalConceptRefs(db, nodes.map((n) => n.id), lang);
  return nodes.map((n) => ({ ...n, concept: refs.get(n.id)! })).sort((a, b) => byLabel(a.concept, b.concept));
}

/**
 * The concepts the live questions of a pool use (ADR-081 third addendum §6),
 * each with its COVERED count (ADR-116 §8): the live questions linked to it
 * or to a narrower concept, once each. By label in `lang`.
 */
export async function poolConcepts(db: Db | Tx, poolId: string, lang: ConceptLang): Promise<PoolConcept[]> {
  const { nodes } = await poolConceptCounts(db, poolId);
  return (await labelled(db, nodes.filter((n) => n.linked), lang)).map((n) => ({ concept: n.concept, count: n.covered }));
}

/** The pool's concept map (ADR-116 §7): every concept it reaches, counted, and the broader edges among them. */
export async function poolConceptMap(db: Db | Tx, poolId: string, lang: ConceptLang): Promise<PoolConceptMap> {
  const map = await poolConceptCounts(db, poolId);
  const nodes = await labelled(db, map.nodes, lang);
  return { nodes: nodes.map((n) => ({ concept: n.concept, covered: n.covered, own: n.own })), broader: map.broader };
}
