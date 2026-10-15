/**
 * The vocabulary as a model reads it, shared by the passes that send it
 * (the probable duplicates, ADR-081 fifth addendum §4; Suggest concepts, sixth
 * addendum §6; the relations, ADR-114 §2): one line per concept, an index
 * local to the call, its labels and qualifiers in both languages — never an
 * id, a description, an alias, a count or a person (open question 43). And
 * what those passes read back the same way: a reason, a label to create.
 */
import { CONCEPT_AI_REASON_MAX, type ConceptLang } from "@quiz/contracts";
import {
  CONCEPT_LABEL_MAX,
  CONCEPT_QUALIFIER_MAX,
  conceptToCreate,
  resolveConceptLabel,
  type ConceptToCreate,
  type LabelResolution,
  type ResolvableConcept,
} from "@quiz/domain";

import { oneLine } from "../llm/service.js";

/** The sentence of a system prompt that explains the lines. */
export const VOCABULARY_FORMAT =
  "Each line is one concept: an index, then its French and English label, each with its qualifier in parentheses when it has one " +
  "(the qualifier tells homonyms apart, as in « adresse (mémoire) »).";

/** A language as a prompt names it. */
export const LANG_NAME = { fr: "French", en: "English" } as const satisfies Record<ConceptLang, string>;

interface VocabularyRow {
  labelFr: string | null;
  qualifierFr: string;
  labelEn: string | null;
  qualifierEn: string;
}

/**
 * A label or qualifier as a field of a line: one line, no separator and no
 * trailing `*` (a pass's marker), so that it cannot fake another line or a mark.
 */
const field = (text: string, max: number) => oneLine(text.replaceAll("|", " "), max).replace(/[\s*]+$/, "");

const named = (label: string | null, qualifier: string) =>
  label === null
    ? "-"
    : qualifier === ""
      ? field(label, CONCEPT_LABEL_MAX)
      : `${field(label, CONCEPT_LABEL_MAX)} (${field(qualifier, CONCEPT_QUALIFIER_MAX)})`;

/** `c1 | fr: Adresse (mémoire) | en: Address`, one per row, in order. */
export function vocabularyLines(rows: readonly VocabularyRow[]): string[] {
  return rows.map(
    (r, i) => `c${i + 1} | fr: ${named(r.labelFr, r.qualifierFr)} | en: ${named(r.labelEn, r.qualifierEn)}`,
  );
}

/** The 0-based position a model's `c3` designates among `length` lines; null when it is no index of the call. */
export function lineIndex(ref: string, length: number): number | null {
  const n = /^c(\d+)$/.exec(ref.trim())?.[1];
  const i = n === undefined ? -1 : Number(n) - 1;
  return i >= 0 && i < length ? i : null;
}

/** A model's reason: one line, within its maximum ("" when it gave none). */
export const aiReason = (text: string) => oneLine(text, CONCEPT_AI_REASON_MAX);

/**
 * A label and qualifier a model proposed, cleaned as a new concept's
 * (`conceptToCreate`, a label typed as « Adresse (mémoire) » split there) and
 * resolved against the vocabulary as cleaned; null when no valid label comes out.
 */
export function resolveFresh(
  label: string,
  qualifier: string,
  vocab: readonly ResolvableConcept[],
): { fresh: ConceptToCreate; outcome: LabelResolution } | null {
  const [l, q] = [oneLine(label, CONCEPT_LABEL_MAX), oneLine(qualifier, CONCEPT_QUALIFIER_MAX)];
  const fresh = conceptToCreate(q === "" ? l : `${l} (${q})`);
  if (!fresh) return null;
  return { fresh, outcome: resolveConceptLabel(fresh.qualifier === "" ? fresh.label : `${fresh.label} (${fresh.qualifier})`, vocab) };
}
