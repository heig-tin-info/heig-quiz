/**
 * How a concept is named to a reader (ADR-081): in their language, else the
 * other one, with its qualifier when it has one.
 */
import type { Concept } from "@quiz/contracts";

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
 * all). The server forbids cycles, so the walk ends. Empty when it has none.
 */
export function broaderTrail(concept: Concept, byId: ReadonlyMap<string, Concept>, locale: Locale): string[] {
  const trail: string[] = [];
  for (let at: Concept | undefined = concept; at; ) {
    const parent: Concept | undefined = at.broader
      .map((id) => byId.get(id))
      .filter((c): c is Concept => c !== undefined)
      .sort((a, b) => conceptName(a, locale).localeCompare(conceptName(b, locale)))[0];
    if (parent) trail.unshift(conceptName(parent, locale));
    at = parent;
  }
  return trail;
}
