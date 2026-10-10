/**
 * The links between questions and concepts (ADR-081, third addendum
 * 2026-10-08), and the resolution of a write that names concepts. The pool
 * module calls these inside its own transactions (addendum §4) and reads
 * the links by join.
 *
 * - `resolveForWrite`: what the inputs of a write designate (addendum §2,
 *   third addendum §4), all or nothing; creates the `proposed` concepts asked
 *   for. The decision is `planConceptWrite` of `@quiz/domain` (invariant 8);
 *   this file loads the vocabulary and the stop list, and writes.
 * - `setQuestionConcepts`: replaces a question's set; `copyQuestionConcepts`
 *   gives a copy its original's.
 * - `conceptsOf`: a question's concepts as a reader sees them;
 *   `poolConcepts`: the concepts a pool's live questions use, counted
 *   (`PoolDetail.concepts`, read once the pool is loaded through its access).
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Concept, ConceptInputError, ConceptLang, ConceptRef, PoolConcept, TagDropReason } from "@quiz/contracts";
import { conceptKey, planConceptWrite, type ConceptToCreate, type ConceptWriteError } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { concepts, conceptTagSortings, questionConcepts, questions } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { columnsOf, conflictOr, perLang, side, toConcept, toConceptRef, toResolvable, type ConceptRow } from "./row.js";

/** Who writes, and how: whether an unknown label creates a concept, in which language. */
export interface ConceptWriteContext {
  /** Explicit (third addendum §4): false refuses an unknown label. */
  create: boolean;
  /** The language of a created concept, and of the labels of the candidates of a refusal. */
  lang: ConceptLang;
  /** The teacher a created concept is credited to (the caller, or the teacher behind an MCP token). */
  createdBy: string;
  actor: AuditActor;
  now: Date;
}

/** The concepts a write designates, one id per input in order, and those it created. */
export interface ConceptWrite {
  ids: string[];
  created: Concept[];
}

/**
 * The stop list (third addendum §4): the `conceptKey` of every tag the admin
 * dropped in the sorting, with the reason of its first drop by tag.
 */
export async function droppedKeys(db: Db | Tx): Promise<Map<string, TagDropReason>> {
  const rows = await db
    .select({ tag: conceptTagSortings.tag, reason: conceptTagSortings.dropReason })
    .from(conceptTagSortings)
    .orderBy(conceptTagSortings.tag, conceptTagSortings.poolId);
  const keys = new Map<string, TagDropReason>();
  for (const { tag, reason } of rows) {
    const key = conceptKey(tag);
    if (key && !keys.has(key)) keys.set(key, reason);
  }
  return keys;
}

/** The 422 of a refused write (`ConceptWriteRefusal`): every input at fault, the first one's code. */
export function refuseInputs(errors: ConceptInputError[]): DomainError {
  return new DomainError(errors[0]!.error, 422, "A concept could not be resolved", { errors });
}

/** A domain error with its candidates' ids replaced by what a reader sees of them (`ConceptRef`). */
function toInputError(
  e: ConceptWriteError<TagDropReason>,
  byId: Map<string, ConceptRow>,
  lang: ConceptLang,
): ConceptInputError {
  if (e.error === "concept_dropped") return e;
  return { ...e, candidates: e.candidates.map((id) => toConceptRef(byId.get(id)!, lang)) };
}

/**
 * Inserts a `proposed` concept in one language, audited `concept.propose`.
 * A key already held answers through `conflictOr` at the caller.
 */
export async function insertProposed(
  tx: Db | Tx,
  ctx: { createdBy: string | null; actor: AuditActor; now: Date },
  lang: ConceptLang,
  input: { label: string; qualifier: string; description: string },
): Promise<ConceptRow> {
  const id = randomUUID();
  const sides = perLang((l) =>
    l === lang ? side(input.label, input.qualifier, input.description) : side(null, "", ""),
  );
  const [row] = await tx
    .insert(concepts)
    .values({
      id,
      createdBy: ctx.createdBy,
      ...columnsOf("fr", sides.fr),
      ...columnsOf("en", sides.en),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await audit(tx, {
    ...ctx.actor,
    action: "concept.propose",
    subjectType: "concept",
    subjectId: id,
    payload: { lang, label: input.label, qualifier: input.qualifier },
  });
  return row!;
}

/**
 * What the inputs of a write designate (addendum §2, third addendum §4), all
 * or nothing: an id (a merged one follows `merged_into`), a qualified label
 * or one exact match resolves; anything else is a 422 naming every input at
 * fault (`concept_ambiguous`, `concept_unknown`, `concept_dropped`, see
 * `ConceptWriteRefusal`). With `create`, an unknown label (or one with close
 * matches only) becomes a `proposed` concept in `ctx.lang`, unless the stop
 * list holds its key. The creations happen in one (nested) transaction, so a
 * caller may pass its own; a key a concurrent write took meanwhile is a 409
 * `concept_exists` naming the holder.
 */
export async function resolveForWrite(
  db: Db | Tx,
  inputs: readonly string[],
  ctx: ConceptWriteContext,
): Promise<ConceptWrite> {
  const rows = await db.select().from(concepts);
  const dropped = ctx.create ? await droppedKeys(db) : new Map<string, TagDropReason>();
  const plan = planConceptWrite(inputs, rows.map(toResolvable), { create: ctx.create, dropped });
  if (plan.kind === "refused") {
    const byId = new Map(rows.map((r) => [r.id, r]));
    throw refuseInputs(plan.errors.map((e) => toInputError(e, byId, ctx.lang)));
  }
  const created = plan.creates.length === 0 ? [] : await createAll(db, ctx, plan.creates);
  return {
    ids: plan.targets.map((t) => (t.kind === "existing" ? t.id : created[t.index]!.id)),
    created: created.map(toConcept),
  };
}

/** The concepts a write asked for, in one (nested) transaction; a key taken meanwhile is a 409. */
async function createAll(
  db: Db | Tx,
  ctx: ConceptWriteContext,
  creates: readonly ConceptToCreate[],
): Promise<ConceptRow[]> {
  const who = { createdBy: ctx.createdBy, actor: ctx.actor, now: ctx.now };
  try {
    return await db.transaction(async (tx) => {
      const out: ConceptRow[] = [];
      for (const c of creates) out.push(await insertProposed(tx, who, ctx.lang, { ...c, description: "" }));
      return out;
    });
  } catch (error) {
    const keys = creates.map((c) => c.key);
    throw await conflictOr(
      db,
      error,
      perLang((lang) => (lang === ctx.lang ? keys : null)),
    );
  }
}

/**
 * Share-locks `ids` in id order, and answers the ones that are not merged.
 * Every writer of links and the merge (`merge.ts`, `FOR UPDATE` in id order) lock in id order,
 * so merges and writers do not deadlock among themselves; a chained merge racing a writer may abort one side (40P01), never corrupting data.
 */
async function lockConcepts(tx: Db | Tx, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await tx
    .select({ id: concepts.id, mergedInto: concepts.mergedInto })
    .from(concepts)
    .where(inArray(concepts.id, [...ids]))
    .orderBy(asc(concepts.id))
    .for("share");
  return new Set(rows.filter((r) => r.mergedInto === null).map((r) => r.id));
}

/**
 * Replaces a question's concepts with `conceptIds` (duplicates ignored),
 * inside the caller's transaction (addendum §4). Every concept must exist
 * and not be merged — a 422 `concept_not_found` naming the others. The
 * wanted concepts AND those the question links now are share-locked, so that
 * a merge cannot move any of them under the write: a removal made while a
 * merge ran is not undone by the link the merge adds.
 */
export async function setQuestionConcepts(
  tx: Db | Tx,
  questionId: string,
  conceptIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(conceptIds)];
  const current = await tx
    .select({ id: questionConcepts.conceptId })
    .from(questionConcepts)
    .where(eq(questionConcepts.questionId, questionId));
  const live = await lockConcepts(tx, [...new Set([...ids, ...current.map((c) => c.id)])]);
  const bad = ids.filter((id) => !live.has(id));
  if (bad.length > 0) {
    throw new DomainError("concept_not_found", 422, "A concept is missing or merged", { ids: bad }); // `ConceptNotFound`
  }
  await tx.delete(questionConcepts).where(eq(questionConcepts.questionId, questionId));
  if (ids.length > 0) {
    await tx.insert(questionConcepts).values(ids.map((conceptId) => ({ questionId, conceptId })));
  }
}

/**
 * The concepts of each question, labelled in `lang` (the other language as
 * a fallback), by label then id. Every asked question has an entry, empty
 * when it has no concept.
 */
export async function conceptsOf(
  db: Db | Tx,
  questionIds: readonly string[],
  lang: ConceptLang,
): Promise<Map<string, ConceptRef[]>> {
  const out = new Map<string, ConceptRef[]>(questionIds.map((id) => [id, []]));
  if (questionIds.length === 0) return out;
  const rows = await db
    .select({ questionId: questionConcepts.questionId, concept: concepts })
    .from(questionConcepts)
    .innerJoin(concepts, eq(concepts.id, questionConcepts.conceptId))
    .where(inArray(questionConcepts.questionId, [...questionIds]));
  for (const { questionId, concept } of rows) out.get(questionId)!.push(toConceptRef(concept, lang));
  for (const refs of out.values()) refs.sort(byLabel);
  return out;
}

/** A reader's order: by label, then id. */
export function byLabel(a: ConceptRef, b: ConceptRef): number {
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
}

/**
 * Gives the question `toId` the concepts of `fromId` (a copy, ADR-017), inside
 * the caller's transaction. Its concepts are share-locked first (`lockConcepts`),
 * so a merge in flight is waited for; the links are read afterwards and a
 * concept merged meanwhile is followed to the one it went into: no link to a
 * merged concept is ever re-created.
 */
export async function copyQuestionConcepts(tx: Db | Tx, fromId: string, toId: string): Promise<void> {
  const source = await tx
    .select({ id: questionConcepts.conceptId })
    .from(questionConcepts)
    .where(eq(questionConcepts.questionId, fromId));
  await lockConcepts(tx, source.map((c) => c.id));
  await tx.execute(sql`
    INSERT INTO ${questionConcepts} (question_id, concept_id)
    SELECT ${toId}::uuid, coalesce(c.merged_into, c.id) FROM ${questionConcepts} qc
    JOIN ${concepts} c ON c.id = qc.concept_id
    WHERE qc.question_id = ${fromId}
    ON CONFLICT DO NOTHING`);
}

/**
 * The concepts the live questions of a pool use, each with how many of them
 * (ADR-081 third addendum §6), by label in `lang`. The caller has loaded the
 * pool through its access predicate.
 */
export async function poolConcepts(db: Db | Tx, poolId: string, lang: ConceptLang): Promise<PoolConcept[]> {
  const rows = await db
    .select({ concept: concepts, count: sql<number>`count(*)::int` })
    .from(questionConcepts)
    .innerJoin(questions, eq(questions.id, questionConcepts.questionId))
    .innerJoin(concepts, eq(concepts.id, questionConcepts.conceptId))
    .where(and(eq(questions.poolId, poolId), isNull(questions.deletedAt)))
    .groupBy(concepts.id);
  return rows
    .map((r) => ({ concept: toConceptRef(r.concept, lang), count: r.count }))
    .sort((a, b) => byLabel(a.concept, b.concept));
}
