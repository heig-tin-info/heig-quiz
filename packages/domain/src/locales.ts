/**
 * The interface languages and their registry (N-I18N-01, ADR-140): the
 * dictionaries, the account preference, the mails, the printed documents.
 *
 * `LOCALES` is the one list. Outside this file no code compares a locale to
 * a literal: a per-language value is a `Record<Locale, …>`, so a language
 * added here is a compile error at every place that must be filled.
 */
import type { ConceptLanguage } from "./concepts.js";

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

/** The language of a missing key, and of a reader whose language the platform does not speak. */
export const FALLBACK_LOCALE = "en" satisfies Locale;

/**
 * How a language's copy is made (ADR-140): `written` by the author of the
 * key, in that language, with the English (N-I18N-04); `translated`, drafted
 * from the English and tracked for review.
 */
export type LocaleOrigin = "written" | "translated";

interface LocaleInfo {
  /** The language named in itself, as a picker offers it. */
  endonym: string;
  origin: LocaleOrigin;
}

export const LOCALE_INFO = {
  en: { endonym: "English", origin: "written" },
  fr: { endonym: "Français", origin: "written" },
} as const satisfies Record<Locale, LocaleInfo>;

/** The languages whose copy is written, not translated: a legal text exists in each of them (N-DATA-07). */
export type WrittenLocale = {
  [L in Locale]: (typeof LOCALE_INFO)[L]["origin"] extends "written" ? L : never;
}[Locale];

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The first language of `tags` (BCP-47, as `navigator.languages` or the
 * entries of `Accept-Language` give them, in order) whose base language the
 * platform speaks: `de-CH`, `fr-CH;q=0.9` → `fr`. Null when none.
 */
export function matchLocale(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const base = tag.trim().toLowerCase().split(/[-_;]/)[0];
    if (isLocale(base)) return base;
  }
  return null;
}

/**
 * The language a reader of `locale` reads two-language data in — concept
 * labels (ADR-081), pool domains (ADR-095 §7), What's new (ADR-087): their
 * own where the data has it, English otherwise (ADR-140).
 */
export function dataLanguage(locale: Locale): ConceptLanguage {
  return locale === "fr" ? "fr" : "en";
}
