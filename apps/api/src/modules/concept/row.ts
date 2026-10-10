/**
 * A concept's row as the `concept` module's services read and write it: the
 * columns of each language, and the JSON a route answers with. Shared by
 * the registry (`service.ts`) and the links (`links.ts`).
 */
import { and, asc, eq, inArray, ne, or } from "drizzle-orm";

import { CONCEPT_LANGS, type Concept, type ConceptExists, type ConceptLang, type ConceptRef } from "@quiz/contracts";
import { conceptKey, conceptLabelIn, qualifiedConceptKey, type ResolvableConcept } from "@quiz/domain";

import { isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { conceptAliases, concepts } from "../../db/schema.js";
import { DomainError } from "../http.js";

export type ConceptRow = typeof concepts.$inferSelect;

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
export interface Side {
  label: string | null;
  qualifier: string;
  description: string;
  key: string | null;
}

/** One value per language. */
export function perLang<T>(f: (lang: ConceptLang) => T): Record<ConceptLang, T> {
  return { fr: f("fr"), en: f("en") };
}

export function sideOf(row: ConceptRow, lang: ConceptLang): Side {
  const c = COLUMNS[lang];
  return { label: row[c.label], qualifier: row[c.qualifier], description: row[c.description], key: row[c.key] };
}

/** The columns a side is written to. */
export function columnsOf(lang: ConceptLang, side: Side): Partial<typeof concepts.$inferInsert> {
  const c = COLUMNS[lang];
  return { [c.label]: side.label, [c.qualifier]: side.qualifier, [c.description]: side.description, [c.key]: side.key };
}

/** A side as typed, cleaned, with its key: none without a label. */
export function side(label: string | null, qualifier: string, description: string): Side {
  return { label, qualifier, description, key: label === null ? null : qualifiedConceptKey(label, qualifier) };
}


/** The curated aliases (display texts) of every concept, by concept id; one query for the whole vocabulary or for `ids`. */
export async function loadAliases(db: Db | Tx, ids?: readonly string[]): Promise<Map<string, string[]>> {
  if (ids?.length === 0) return new Map();
  const rows = await db
    .select({ conceptId: conceptAliases.conceptId, text: conceptAliases.text })
    .from(conceptAliases)
    .where(ids ? inArray(conceptAliases.conceptId, [...ids]) : undefined)
    .orderBy(asc(conceptAliases.text), asc(conceptAliases.key));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.conceptId, [...(out.get(r.conceptId) ?? []), r.text]);
  return out;
}

/** A concept as a route answers; `aliases` come from {@link loadAliases} (none by default). */
export function toConcept(row: ConceptRow, aliases: readonly string[] = []): Concept {
  const sides = perLang((lang) => sideOf(row, lang));
  return {
    id: row.id,
    status: row.status,
    mergedInto: row.mergedInto,
    labels: perLang((lang) => sides[lang].label),
    qualifiers: perLang((lang) => sides[lang].qualifier),
    descriptions: perLang((lang) => sides[lang].description),
    aliases: [...aliases],
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}


/**
 * The concepts, not merged, that hold one of `keys` in its language: who
 * answers a write that hit a key's unique index (addendum §3).
 */
async function holdersOf(db: Db | Tx, keys: Record<ConceptLang, readonly string[]>): Promise<ConceptRow[]> {
  const held = (["fr", "en"] as const)
    .filter((lang) => keys[lang].length > 0)
    .map((lang) => inArray(concepts[COLUMNS[lang].key], [...keys[lang]]));
  if (held.length === 0) return [];
  return db
    .select()
    .from(concepts)
    .where(and(ne(concepts.status, "merged"), or(...held)));
}

/** A concept as the resolver of `@quiz/domain` sees it: its id, its merge, its labels with their qualifiers and its aliases. */
export function toResolvable(row: ConceptRow, aliases: ReadonlyMap<string, readonly string[]>): ResolvableConcept {
  return {
    id: row.id,
    mergedInto: row.mergedInto,
    aliases: aliases.get(row.id) ?? [],
    labels: CONCEPT_LANGS.flatMap((lang) => {
      const { label, qualifier } = sideOf(row, lang);
      return label === null ? [] : [{ label, qualifier }];
    }),
  };
}

/** A concept as a question shows it, in the reader's language or the other one (`conceptLabelIn`). */
export function toConceptRef(row: ConceptRow, lang: ConceptLang): ConceptRef {
  return { id: row.id, status: row.status, ...conceptLabelIn(perLang((l) => sideOf(row, l)), lang) };
}

/**
 * Refuses a label that another live concept answers to as an ALIAS (the
 * mirror of the alias guard, ADR-081 §6): the same 409 `concept_exists` as a
 * taken label, naming that concept, because the typed word would otherwise
 * be ambiguous for every teacher. `selfId` is the concept being renamed.
 */
export async function refuseAliasHolder(db: Db | Tx, labels: readonly string[], selfId: string | null): Promise<void> {
  const keys = labels.map(conceptKey).filter(Boolean);
  if (keys.length === 0) return;
  const [hit] = await db
    .select({ concept: concepts })
    .from(conceptAliases)
    .innerJoin(concepts, eq(concepts.id, conceptAliases.conceptId))
    .where(
      and(
        inArray(conceptAliases.key, keys),
        ne(concepts.status, "merged"),
        selfId === null ? undefined : ne(concepts.id, selfId),
      ),
    )
    .limit(1);
  if (!hit) return;
  throw new DomainError("concept_exists", 409, "A concept answers to this label as an alias", {
    concept: toConcept(hit.concept, (await loadAliases(db, [hit.concept.id])).get(hit.concept.id)),
  } satisfies Omit<ConceptExists, "error" | "message">);
}

/**
 * A write that hit a key's unique index: the 409 `concept_exists` naming the
 * concept that holds the key (any of the keys asked, per language). Anything
 * else is rethrown as it came.
 */
export async function conflictOr(
  db: Db | Tx,
  error: unknown,
  keys: Record<ConceptLang, string | null | readonly string[]>,
): Promise<unknown> {
  const violated = perLang((lang) => {
    const key = keys[lang];
    const asked = key === null ? [] : typeof key === "string" ? [key] : key;
    return isUniqueViolation(error, COLUMNS[lang].index) ? asked : [];
  });
  const [holder] = await holdersOf(db, violated);
  return holder
    ? new DomainError("concept_exists", 409, "A concept with this label already exists", {
        concept: toConcept(holder, (await loadAliases(db, [holder.id])).get(holder.id)),
      } satisfies Omit<ConceptExists, "error" | "message">)
    : error;
}
