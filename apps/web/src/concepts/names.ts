/**
 * How a concept is named to a reader (ADR-081): in their language, else the
 * other one, with its qualifier when it has one.
 */
import type { Concept, ConceptLang } from "@quiz/contracts";

import type { Locale, TFunction } from "../i18n";

/**
 * A concept in the reader's language: its label and qualifier there, else in
 * the other language (a `proposed` concept may have one only), with `lang`
 * the language they are in; its description in the reader's language, else
 * the other one.
 */
export function conceptSide(c: Concept, locale: Locale) {
  const other: Locale = locale === "fr" ? "en" : "fr";
  const lang = c.labels[locale] !== null ? locale : other;
  return {
    lang,
    label: c.labels[lang] ?? "",
    qualifier: c.qualifiers[lang],
    description: c.descriptions[locale] || c.descriptions[other],
  };
}

/** `Adresse (mémoire)`: a label, and its qualifier when it has one (only homonyms do). */
export function refName({ label, qualifier }: { label: string; qualifier: string }): string {
  return qualifier ? `${label} (${qualifier})` : label;
}

/** The label in the reader's language, else the other, with its qualifier: `Adresse (mémoire)`. */
export const conceptName = (c: Concept, locale: Locale): string => refName(conceptSide(c, locale));

/** How many questions use a concept: "Unused", "1 question", "{n} questions". */
export const usesLabel = (t: TFunction, n: number): string =>
  n === 0 ? t("admin.concepts.uses.none") : n === 1 ? t("admin.concepts.uses.one") : t("admin.concepts.uses", { n });

/**
 * The path above a concept for the picker (ADR-081 §5): its broader concepts
 * from the root down, `Programming › Pointer`. A concept with several broader
 * ones follows the first by name (the picker is compact; the sheet lists them
 * all). The server forbids cycles; should one be stored, the walk still
 * ends where it would come back. Empty when it has none.
 */
export function broaderTrail(concept: Concept, byId: ReadonlyMap<string, Concept>, locale: Locale): string[] {
  const trail: string[] = [];
  const seen = new Set([concept.id]);
  for (let at = broaderOf(concept, byId, locale)[0]; at && !seen.has(at.id); at = broaderOf(at, byId, locale)[0]) {
    seen.add(at.id);
    trail.unshift(conceptName(at, locale));
  }
  return trail;
}

/** Two concepts in the order of their names in the reader's language. */
export const byConceptName =
  (locale: Locale) =>
  (a: Concept, b: Concept): number =>
    conceptName(a, locale).localeCompare(conceptName(b, locale), locale);

/** A concept's broader concepts that `byId` holds, by name: the first is the one its path follows. */
export function broaderOf<C extends Concept>(concept: Concept, byId: ReadonlyMap<string, C>, locale: Locale): C[] {
  return concept.broader.flatMap((id) => byId.get(id) ?? []).sort(byConceptName(locale));
}

/** A language of a concept as the sheet names it: "French", "English". */
export const langName = (t: TFunction, lang: ConceptLang): string =>
  lang === "fr" ? t("admin.concepts.lang.fr") : t("admin.concepts.lang.en");
