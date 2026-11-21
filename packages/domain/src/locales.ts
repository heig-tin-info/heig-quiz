/**
 * The interface languages and their registry (N-I18N-01, ADR-140): the
 * dictionaries, the account preference, the mails, the printed documents.
 *
 * `LOCALES` is the one list. Outside this file no code compares a locale to
 * a literal: a per-language value is a `Record<Locale, …>`, so a language
 * added here is a compile error at every place that must be filled.
 */
import { CONCEPT_LANGUAGES, type ConceptLanguage } from "./concepts.js";

export const LOCALES = ["en", "fr", "de"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * English: the source language every dictionary is written or translated
 * from, hence the language of a missing key and of a reader whose language
 * the platform does not speak. A fact of the dictionaries, not a setting.
 */
export const FALLBACK_LOCALE = "en" satisfies Locale;

/**
 * How a language's copy is made (ADR-140 §2): `written` by the author of
 * each key, or `translated`, machine-drafted from the English and tracked
 * against it. A legal text exists in a written language only (§5).
 */
export type LocaleOrigin = "written" | "translated";

/**
 * Each language's name in itself, as a picker offers it, the `Intl` tag the
 * interface formats its dates, times and numbers with (ADR-140 §10), and
 * how its copy is made.
 */
export const LOCALE_INFO = {
  en: { endonym: "English", intl: "en-GB", origin: "written" },
  fr: { endonym: "Français", intl: "fr", origin: "written" },
  de: { endonym: "Deutsch", intl: "de-CH", origin: "translated" },
} as const satisfies Readonly<Record<Locale, { endonym: string; intl: string; origin: LocaleOrigin }>>;

/** The languages of one origin, as types: what a per-origin `Record` is keyed by. */
type LocaleOf<O extends LocaleOrigin> = {
  [L in Locale]: (typeof LOCALE_INFO)[L]["origin"] extends O ? L : never;
}[Locale];
export type WrittenLocale = LocaleOf<"written">;
export type TranslatedLocale = LocaleOf<"translated">;

export function isWrittenLocale(locale: Locale): locale is WrittenLocale {
  return LOCALE_INFO[locale].origin === "written";
}

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

const isConceptLanguage = (locale: Locale): locale is Locale & ConceptLanguage =>
  (CONCEPT_LANGUAGES as readonly string[]).includes(locale);

/**
 * The language a reader of `locale` reads two-language data in — concept
 * labels (ADR-081), pool domains (ADR-095 §7), What's new (ADR-087): their
 * own where the data has it, English otherwise (ADR-140).
 */
export function dataLanguage(locale: Locale): ConceptLanguage {
  return isConceptLanguage(locale) ? locale : FALLBACK_LOCALE;
}
