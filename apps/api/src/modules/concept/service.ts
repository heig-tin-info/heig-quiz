/**
 * The vocabulary of concepts (ADR-081, addendum 2026-10-08): reading it,
 * resolving what someone typed to a concept, proposing a concept and editing
 * it. Questions are classified by it since the cut-over (third addendum):
 * their links are `./links.ts`'s.
 *
 * Every teacher reads the whole vocabulary, proposed concepts included, so
 * as not to recreate one (addendum §5). A teacher proposes; the creator
 * edits their concept while it is `proposed`, the admin always. The pure
 * rules — the key, the matching, the resolution — are `@quiz/domain`'s
 * (invariant 8); this file loads rows and writes them. Uniqueness is the
 * database's (addendum §3): a write that hits a key's unique index is
 * answered with the concept that holds it.
 */
import { asc, eq, ne, sql } from "drizzle-orm";

import {
  CONCEPT_LANGS,
  type Concept,
  type ConceptCreate,
  type ConceptLang,
  type ConceptPatch,
  type ConceptResolution,
  type TagDropReason,
} from "@quiz/contracts";
import {
  cleanConceptLabel,
  cleanConceptQualifier,
  conceptToCreate,
  droppedReason,
  qualifiedConceptKey,
  resolveConceptLabel,
} from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isForeignKeyViolation, isRestrictViolation, type Db, type Tx } from "../../db/client.js";
import { concepts } from "../../db/schema.js";
import type { Caller } from "../guards.js";
import { DomainError, notFoundError } from "../http.js";
import { droppedKeys, insertProposed, refuseInputs } from "./links.js";
import { columnsOf, conflictOr, perLang, side, sideOf, toConcept, toConceptRef, toResolvable } from "./row.js";

export { listAdminConcepts } from "./admin.js";
export { toConcept, toConceptRef } from "./row.js";
export {
  byLabel,
  conceptsOf,
  copyQuestionConcepts,
  poolConcepts,
  resolveForWrite,
  setQuestionConcepts,
  type ConceptWrite,
  type ConceptWriteContext,
} from "./links.js";

/** Who writes: the caller for the rights, the actor for the audit, the server's instant. */
export interface ConceptContext {
  caller: Pick<Caller, "id" | "role">;
  actor: AuditActor;
  now: Date;
}

/** Every concept that is not merged, by label. The vocabulary is small: it is loaded whole. */
export async function listConcepts(db: Db): Promise<Concept[]> {
  const rows = await db
    .select()
    .from(concepts)
    .where(ne(concepts.status, "merged"))
    .orderBy(asc(sql`lower(coalesce(${concepts.labelFr}, ${concepts.labelEn}))`), asc(concepts.id));
  return rows.map(toConcept);
}

/**
 * What each typed string designates (ADR-081 addendum §2): an id, a
 * qualified label, or a bare label matched against the labels of the
 * concepts that are not merged (`resolveConceptLabel`, which computes the
 * keys itself). One result per input, in order, each concept labelled in
 * the reader's language. An input that designates no concept and whose key
 * is a dropped tag's is `dropped` (third addendum §4), so a client can
 * refuse it before writing anything. It previews the picker's
 * `POST /concepts`, not a question write: the admin, whom the stop list does
 * not bind there ({@link stopList}), never sees `dropped`, though a question
 * write of theirs naming that label is still refused.
 */
export async function resolveLabels(
  db: Db,
  inputs: readonly string[],
  lang: ConceptLang,
  caller: Pick<Caller, "role">,
): Promise<ConceptResolution[]> {
  const rows = await db.select().from(concepts);
  const byId = new Map(rows.map((r) => [r.id, toConceptRef(r, lang)]));
  const vocabulary = rows.map(toResolvable);
  const concept = (id: string) => byId.get(id)!;
  const dropped = await stopList(db, caller);

  return inputs.map((input): ConceptResolution => {
    const outcome = resolveConceptLabel(input, vocabulary);
    if (outcome.kind === "resolved") return { input, kind: "resolved", concept: concept(outcome.id) };
    const fresh = outcome.kind === "unknown" ? conceptToCreate(input) : null;
    const reason = fresh && droppedReason(fresh, dropped);
    if (reason !== null) return { input, kind: "dropped", reason };
    return { input, kind: outcome.kind, candidates: outcome.candidates.map(concept) };
  });
}

/**
 * The stop list as it binds `caller` (third addendum §4, amended
 * 2026-10-08): the dropped keys for a teacher, nothing for the admin, the
 * curator of the vocabulary, who may create or rename onto a dropped key
 * ("C", "Logique"). A question write names no caller here: it is always
 * bound, the admin's included, so neither the editor nor an MCP client
 * recreates a dropped tag.
 */
async function stopList(db: Db | Tx, caller: Pick<Caller, "role">): Promise<Map<string, TagDropReason>> {
  return caller.role === "admin" ? new Map() : droppedKeys(db);
}

/**
 * A `proposed` concept in the creator's language (addendum §3, §5). A key
 * already held by a concept that is not merged is a 409 `concept_exists`
 * naming it; an unqualified label whose key is a tag the admin dropped in
 * the sorting is a 422 `concept_dropped` for a teacher (the stop list,
 * {@link stopList}).
 */
export async function createConcept(db: Db, ctx: ConceptContext, body: ConceptCreate): Promise<Concept> {
  const label = cleanConceptLabel(body.label);
  const qualifier = cleanConceptQualifier(body.qualifier ?? "");
  const reason = droppedReason({ label, qualifier }, await stopList(db, ctx.caller));
  if (reason !== null) throw refuseInputs([{ input: body.label, error: "concept_dropped", reason }]);
  const who = { createdBy: ctx.caller.id, actor: ctx.actor, now: ctx.now };
  const input = { label, qualifier, description: body.description ?? "" };
  try {
    return toConcept(await db.transaction((tx) => insertProposed(tx, who, body.lang, input)));
  } catch (error) {
    const key = side(label, qualifier, "").key;
    throw await conflictOr(
      db,
      error,
      perLang((lang) => (lang === body.lang ? key : null)),
    );
  }
}

/**
 * Edits a concept's label, qualifier or description, in either language,
 * and recomputes its keys. The creator while it is `proposed`, the admin
 * always (addendum §5); anyone else a 403 `concept_forbidden`. A merged
 * concept is no longer edited (409 `concept_merged`), a missing one is a
 * 404. A language left with a qualifier or a description but no label is a
 * 422 `concept_label_missing`. An edit that changes a side's key and
 * leaves it on the stop list — unqualified, its label's key a dropped
 * tag's — is a 422 `concept_dropped` for the creator; the admin is not
 * bound ({@link stopList}). A side already on it whose key stays (a concept
 * older than the drop, a description edit) may still be edited.
 */
export async function patchConcept(db: Db, ctx: ConceptContext, id: string, patch: ConceptPatch): Promise<Concept> {
  let keys = perLang<string | null>(() => null);
  try {
    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(concepts).where(eq(concepts.id, id)).for("update");
      if (!current) throw notFoundError("concept");
      if (current.status === "merged") throw new DomainError("concept_merged", 409, "A merged concept is not edited");
      const admin = ctx.caller.role === "admin";
      const creator = current.status === "proposed" && current.createdBy === ctx.caller.id;
      if (!admin && !creator) throw new DomainError("concept_forbidden", 403, "Only the admin edits this concept");

      const sides = perLang((lang) => {
        const was = sideOf(current, lang);
        const p = patch[lang] ?? {};
        const next = side(
          p.label === undefined ? was.label : cleanConceptLabel(p.label),
          p.qualifier === undefined ? was.qualifier : cleanConceptQualifier(p.qualifier),
          p.description ?? was.description,
        );
        if (next.label === null && (next.qualifier || next.description)) {
          throw new DomainError("concept_label_missing", 422, "A qualifier or a description needs a label", { lang });
        }
        return next;
      });
      keys = perLang((lang) => sides[lang].key);
      const dropped = await stopList(tx, ctx.caller);
      const keyOf = (s: { label: string | null; qualifier: string }) =>
        s.label === null ? null : qualifiedConceptKey(s.label, s.qualifier);
      const refused = CONCEPT_LANGS.flatMap((lang) => {
        const { label, qualifier } = sides[lang];
        if (label === null || keyOf(sides[lang]) === keyOf(sideOf(current, lang))) return [];
        const reason = droppedReason({ label, qualifier }, dropped);
        return reason === null ? [] : [{ input: label, error: "concept_dropped" as const, reason }];
      });
      if (refused.length > 0) throw refuseInputs(refused);

      const [row] = await tx
        .update(concepts)
        .set({ ...columnsOf("fr", sides.fr), ...columnsOf("en", sides.en), updatedAt: ctx.now })
        .where(eq(concepts.id, id))
        .returning();
      await audit(tx, { ...ctx.actor, action: "concept.edit", subjectType: "concept", subjectId: id, payload: patch });
      return row!;
    });
    return toConcept(row);
  } catch (error) {
    throw await conflictOr(db, error, keys);
  }
}

/**
 * Validates a `proposed` concept (ADR-081 §7, the admin's): a validated
 * concept has both labels, so a missing one is a 422
 * `concept_label_missing` naming the language. A validated concept is
 * answered as it is; a merged one is a 409 `concept_merged`; a missing one
 * a 404. The route is the admin's.
 */
export async function validateConcept(db: Db, ctx: Omit<ConceptContext, "caller">, id: string): Promise<Concept> {
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(concepts).where(eq(concepts.id, id)).for("update");
    if (!current) throw notFoundError("concept");
    if (current.status === "merged") throw new DomainError("concept_merged", 409, "A merged concept is not validated");
    if (current.status === "validated") return current;
    for (const lang of CONCEPT_LANGS) {
      if (sideOf(current, lang).label === null) {
        throw new DomainError("concept_label_missing", 422, "A validated concept has both labels", { lang });
      }
    }
    const [row] = await tx
      .update(concepts)
      .set({ status: "validated", updatedAt: ctx.now })
      .where(eq(concepts.id, id))
      .returning();
    await audit(tx, {
      ...ctx.actor,
      action: "concept.validate",
      subjectType: "concept",
      subjectId: id,
      payload: { labels: perLang((lang) => sideOf(current, lang).label) },
    });
    return row!;
  });
  return toConcept(row);
}

/**
 * Deletes a concept nothing refers to (ADR-081 second addendum §2, third
 * addendum §7): a concept merged into it, or a question linked to it makes the foreign key refuse, answered 409
 * `concept_in_use`; a missing one is a 404. A concept a question uses is
 * merged, never deleted.
 */
export async function deleteConcept(db: Db, ctx: Omit<ConceptContext, "caller">, id: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [gone] = await tx.delete(concepts).where(eq(concepts.id, id)).returning();
      if (!gone) throw notFoundError("concept");
      await audit(tx, {
        ...ctx.actor,
        action: "concept.delete",
        subjectType: "concept",
        subjectId: id,
        payload: { status: gone.status, labels: perLang((lang) => sideOf(gone, lang).label) },
      });
    });
  } catch (error) {
    if (
      isForeignKeyViolation(error, "concepts_merged_into_fk") ||
      isRestrictViolation(error, "question_concepts_concept_id_concepts_id_fk")
    ) {
      throw new DomainError("concept_in_use", 409, "A merge or a question refers to this concept");
    }
    throw error;
  }
}
