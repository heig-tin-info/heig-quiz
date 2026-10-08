/**
 * The vocabulary of concepts (ADR-081, addendum 2026-10-08): reading it,
 * resolving what someone typed to a concept, proposing a concept and editing
 * it. The registry alone (addendum §1a): no question, course or tag reads or
 * writes it yet.
 *
 * Every teacher reads the whole vocabulary, proposed concepts included, so
 * as not to recreate one (addendum §5). A teacher proposes; the creator
 * edits their concept while it is `proposed`, the admin always. The pure
 * rules — the key, the matching, the resolution — are `@quiz/domain`'s
 * (invariant 8); this file loads rows and writes them. Uniqueness is the
 * database's (addendum §3): a write that hits a key's unique index is
 * answered with the concept that holds it.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, ne, sql } from "drizzle-orm";

import {
  CONCEPT_LANGS,
  type Concept,
  type ConceptCreate,
  type ConceptLang,
  type ConceptPatch,
  type ConceptResolution,
} from "@quiz/contracts";
import { cleanConceptLabel, qualifiedConceptKey, resolveConceptLabel } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isUniqueViolation, type Db } from "../../db/client.js";
import { concepts } from "../../db/schema.js";
import type { Caller } from "../guards.js";
import { DomainError } from "../http.js";

type ConceptRow = typeof concepts.$inferSelect;

/** Who writes: the caller for the rights, the actor for the audit, the server's instant. */
export interface ConceptContext {
  caller: Pick<Caller, "id" | "role">;
  actor: AuditActor;
  now: Date;
}

/** The columns of one language, and the unique index of its key. */
const COLUMNS = {
  fr: {
    label: "labelFr",
    qualifier: "qualifierFr",
    description: "descriptionFr",
    key: "keyFr",
    index: "concepts_key_fr_uq",
  },
  en: {
    label: "labelEn",
    qualifier: "qualifierEn",
    description: "descriptionEn",
    key: "keyEn",
    index: "concepts_key_en_uq",
  },
} as const satisfies Record<
  ConceptLang,
  {
    label: keyof ConceptRow;
    qualifier: keyof ConceptRow;
    description: keyof ConceptRow;
    key: keyof ConceptRow;
    index: string;
  }
>;

/** What one language of a concept holds. */
interface Side {
  label: string | null;
  qualifier: string;
  description: string;
  key: string | null;
}

/** One value per language. */
function perLang<T>(f: (lang: ConceptLang) => T): Record<ConceptLang, T> {
  return { fr: f("fr"), en: f("en") };
}

function sideOf(row: ConceptRow, lang: ConceptLang): Side {
  const c = COLUMNS[lang];
  return { label: row[c.label], qualifier: row[c.qualifier], description: row[c.description], key: row[c.key] };
}

/** The columns a side is written to. */
function columnsOf(lang: ConceptLang, side: Side): Partial<typeof concepts.$inferInsert> {
  const c = COLUMNS[lang];
  return { [c.label]: side.label, [c.qualifier]: side.qualifier, [c.description]: side.description, [c.key]: side.key };
}

/** A side as typed, cleaned, with its key: none without a label. */
function side(label: string | null, qualifier: string, description: string): Side {
  return { label, qualifier, description, key: label === null ? null : qualifiedConceptKey(label, qualifier) };
}

/** A qualifier is trimmed and its inner spaces collapsed; nothing else is touched. */
const cleanQualifier = (qualifier: string) => qualifier.trim().replace(/\s+/g, " ");

export function toConcept(row: ConceptRow): Concept {
  const sides = perLang((lang) => sideOf(row, lang));
  return {
    id: row.id,
    status: row.status,
    mergedInto: row.mergedInto,
    labels: perLang((lang) => sides[lang].label),
    qualifiers: perLang((lang) => sides[lang].qualifier),
    descriptions: perLang((lang) => sides[lang].description),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A write that hit a key's unique index: the 409 `concept_exists` naming the
 * concept that holds the key. Anything else is rethrown as it came.
 */
async function conflictOr(db: Db, error: unknown, keys: Record<ConceptLang, string | null>): Promise<unknown> {
  for (const lang of CONCEPT_LANGS) {
    const key = keys[lang];
    if (key === null || !isUniqueViolation(error, COLUMNS[lang].index)) continue;
    const [holder] = await db
      .select()
      .from(concepts)
      .where(and(eq(concepts[COLUMNS[lang].key], key), ne(concepts.status, "merged")))
      .limit(1);
    if (holder) {
      return new DomainError("concept_exists", 409, "A concept with this label already exists", {
        concept: toConcept(holder),
      });
    }
  }
  return error;
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
  const vocabulary = rows.map((r) => ({
    id: r.id,
    mergedInto: r.mergedInto,
    labels: CONCEPT_LANGS.flatMap((lang) => {
      const { label, qualifier } = sideOf(r, lang);
      return label === null ? [] : [{ label, qualifier }];
    }),
  }));
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
 * naming it.
 */
export async function createConcept(db: Db, ctx: ConceptContext, body: ConceptCreate): Promise<Concept> {
  const id = randomUUID();
  const sides = perLang((lang) =>
    lang === body.lang
      ? side(cleanConceptLabel(body.label), cleanQualifier(body.qualifier ?? ""), body.description ?? "")
      : side(null, "", ""),
  );
  try {
    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(concepts)
        .values({
          id,
          createdBy: ctx.caller.id,
          ...columnsOf("fr", sides.fr),
          ...columnsOf("en", sides.en),
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .returning();
      const { label, qualifier } = sides[body.lang];
      await audit(tx, {
        ...ctx.actor,
        action: "concept.propose",
        subjectType: "concept",
        subjectId: id,
        payload: { lang: body.lang, label, qualifier },
      });
      return row!;
    });
    return toConcept(row);
  } catch (error) {
    throw await conflictOr(
      db,
      error,
      perLang((lang) => sides[lang].key),
    );
  }
}

/**
 * Edits a concept's label, qualifier or description, in either language,
 * and recomputes its keys. The creator while it is `proposed`, the admin
 * always (addendum §5); anyone else a 403 `concept_forbidden`. A merged
 * concept is no longer edited (409 `concept_merged`), a missing one is a
 * 404. A language left with a qualifier or a description but no label is a
 * 422 `concept_label_missing`.
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
          p.qualifier === undefined ? was.qualifier : cleanQualifier(p.qualifier),
          p.description ?? was.description,
        );
        if (next.label === null && (next.qualifier || next.description)) {
          throw new DomainError("concept_label_missing", 422, "A qualifier or a description needs a label", { lang });
        }
        return next;
      });
      keys = perLang((lang) => sides[lang].key);

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
