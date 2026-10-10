/**
 * The vocabulary as a model reads it, shared by the passes that send it
 * (the probable duplicates, ADR-081 fifth addendum §4; Suggest concepts, sixth
 * addendum §6): one line per concept, an index local to the call, its labels
 * and qualifiers in both languages — never an id, a description, an alias, a
 * count or a person (open question 43).
 */
import { CONCEPT_LABEL_MAX, CONCEPT_QUALIFIER_MAX } from "@quiz/domain";

import { oneLine } from "../llm/service.js";

/** The sentence of a system prompt that explains the lines. */
export const VOCABULARY_FORMAT =
  "Each line is one concept: an index, then its French and English label, each with its qualifier in parentheses when it has one " +
  "(the qualifier tells homonyms apart, as in « adresse (mémoire) »).";

interface VocabularyRow {
  labelFr: string | null;
  qualifierFr: string;
  labelEn: string | null;
  qualifierEn: string;
}

/** A label or qualifier as a field of a line: one line, no separator, so that it cannot fake another line. */
const field = (text: string, max: number) => oneLine(text.replaceAll("|", " "), max);

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
