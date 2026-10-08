/**
 * The vocabulary of concepts (ADR-081, addendum 2026-10-08): reading it,
 * resolving what someone typed to a concept, proposing a concept and editing
 * it. No question, course or tag reads or writes it yet: the links to
 * questions (`./links.ts`) are inert until the cut-over (third addendum §1).
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
  type ConceptPatch,
  type ConceptResolution,
} from "@quiz/contracts";
import { cleanConceptLabel, cleanConceptQualifier, conceptKey, droppedReason, resolveConceptLabel } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isForeignKeyViolation, isRestrictViolation, type Db } from "../../db/client.js";
import { concepts } from "../../db/schema.js";
import type { Caller } from "../guards.js";
import { DomainError } from "../http.js";
import { droppedKeys, insertProposed, refuseInputs } from "./links.js";
import { columnsOf, conflictOr, perLang, side, sideOf, toConcept, toResolvable } from "./row.js";

export { toConcept } from "./row.js";
export { acceptTagSortings, listTagSortings, type SortingContext } from "./sorting.js";
export { lastSortRun, startSortRun } from "./propose.js";
export {
  conceptsOf,
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
 * keys itself). One result per input, in order.
 */
export async function resolveLabels(db: Db, inputs: readonly string[]): Promise<ConceptResolution[]> {
  const rows = await db.select().from(concepts);
  const byId = new Map(rows.map((r) => [r.id, toConcept(r)]));
  const vocabulary = rows.map(toResolvable);
  const concept = (id: string) => byId.get(id)!;

  return inputs.map((input) => {
    const outcome = resolveConceptLabel(input, vocabulary);
    return outcome.kind === "resolved"
      ? { input, kind: "resolved", concept: concept(outcome.id) }
      : { input, kind: outcome.kind, candidates: outcome.candidates.map(concept) };
  });
}

/**
 * A `proposed` concept in the creator's language (addendum §3, §5). A key
 * already held by a concept that is not merged is a 409 `concept_exists`
 * naming it; a label whose key is a tag the admin dropped in the sorting is
 * a 422 `concept_dropped` (the stop list, third addendum §4).
 */
export async function createConcept(db: Db, ctx: ConceptContext, body: ConceptCreate): Promise<Concept> {
  const label = cleanConceptLabel(body.label);
  const qualifier = cleanConceptQualifier(body.qualifier ?? "");
  const reason = droppedReason(label, await droppedKeys(db));
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
 * 422 `concept_label_missing`. A rename — a label whose bare key changes —
 * onto the key of a tag the admin dropped is a 422 `concept_dropped`, for
 * the admin too (the stop list, third addendum §4); a qualifier or
 * description edit is not a rename.
 */
export async function patchConcept(db: Db, ctx: ConceptContext, id: string, patch: ConceptPatch): Promise<Concept> {
  let keys = perLang<string | null>(() => null);
  try {
    const row = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(concepts).where(eq(concepts.id, id)).for("update");
      if (!current) throw new DomainError("not_found", 404, "No such concept");
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
      const dropped = await droppedKeys(tx);
      const refused = CONCEPT_LANGS.flatMap((lang) => {
        const { label } = sides[lang];
        const was = sideOf(current, lang).label;
        if (label === null || (was !== null && conceptKey(label) === conceptKey(was))) return [];
        const reason = droppedReason(label, dropped);
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
    if (!current) throw new DomainError("not_found", 404, "No such concept");
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
 * addendum §7): a sorting decision that maps to it, a concept merged into
 * it, or a question linked to it makes the
 * foreign key refuse, answered 409 `concept_in_use`; a missing one is a 404.
 * Before the cut-over this is the only deletion; afterwards a concept is
 * merged, never deleted.
 */
export async function deleteConcept(db: Db, ctx: Omit<ConceptContext, "caller">, id: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [gone] = await tx.delete(concepts).where(eq(concepts.id, id)).returning();
      if (!gone) throw new DomainError("not_found", 404, "No such concept");
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
      isForeignKeyViolation(error, "concept_tag_sortings_concept_id_concepts_id_fk") ||
      isForeignKeyViolation(error, "concepts_merged_into_fk") ||
      isRestrictViolation(error, "question_concepts_concept_id_concepts_id_fk")
    ) {
      throw new DomainError("concept_in_use", 409, "A sorting decision, a merge or a question refers to this concept");
    }
    throw error;
  }
}
