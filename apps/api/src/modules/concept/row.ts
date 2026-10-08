/**
 * A concept's row as the `concept` module's services read and write it: the
 * columns of each language, and the JSON a route answers with. Shared by
 * the registry (`service.ts`) and the sorting of the tags (`sorting.ts`).
 */
import { and, inArray, ne, or } from "drizzle-orm";

import { CONCEPT_LANGS, type Concept, type ConceptExists, type ConceptLang, type ConceptRef } from "@quiz/contracts";
import { conceptLabelIn, qualifiedConceptKey, type ResolvableConcept } from "@quiz/domain";

import { isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { concepts } from "../../db/schema.js";
import { DomainError } from "../http.js";

export type ConceptRow = typeof concepts.$inferSelect;

/** The columns of one language, and the unique index of its key. */
export const COLUMNS = {
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
 * The concepts, not merged, that hold one of `keys` in its language: who
 * answers a write that hit a key's unique index (addendum §3).
 */
export async function holdersOf(db: Db | Tx, keys: Record<ConceptLang, readonly string[]>): Promise<ConceptRow[]> {
  const held = (["fr", "en"] as const)
    .filter((lang) => keys[lang].length > 0)
    .map((lang) => inArray(concepts[COLUMNS[lang].key], [...keys[lang]]));
  if (held.length === 0) return [];
  return db
    .select()
    .from(concepts)
    .where(and(ne(concepts.status, "merged"), or(...held)));
}

/** A concept as the resolver of `@quiz/domain` sees it: its id, its merge, its labels with their qualifiers. */
export function toResolvable(row: ConceptRow): ResolvableConcept {
  return {
    id: row.id,
    mergedInto: row.mergedInto,
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
        concept: toConcept(holder),
      } satisfies Omit<ConceptExists, "error" | "message">)
    : error;
}
