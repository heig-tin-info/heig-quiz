import { describe, expect, it } from "vitest";

import { CONCEPT_LANGUAGES } from "./concepts.js";
import { dataLanguage, FALLBACK_LOCALE, isLocale, type Locale, LOCALE_INFO, LOCALES, matchLocale } from "./locales.js";

describe("the locale registry (ADR-140)", () => {
  it("names every language in itself, and falls back to one of them", () => {
    for (const locale of LOCALES) expect(LOCALE_INFO[locale].endonym.trim()).not.toBe("");
    expect(LOCALES).toContain(FALLBACK_LOCALE);
  });

  it("knows a locale from any other value", () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    for (const other of ["zz", "FR", "fr-CH", "", null, undefined, 1]) expect(isLocale(other)).toBe(false);
  });

  it("matches the first tag whose base language is spoken", () => {
    expect(matchLocale(["zz-YY", "fr-CH", "en"])).toBe("fr");
    expect(matchLocale(["EN-gb"])).toBe("en");
    expect(matchLocale([" fr-CH;q=0.9", "en;q=0.8"])).toBe("fr");
    expect(matchLocale(["fr_CH"])).toBe("fr");
  });

  it("matches nothing among languages it does not speak", () => {
    expect(matchLocale(["xx-YY", "zz"])).toBeNull();
    expect(matchLocale([])).toBeNull();
    expect(matchLocale([""])).toBeNull();
  });

  it("reads two-language data in the reader's language when the data has it, in English otherwise", () => {
    for (const locale of LOCALES) {
      const expected = (CONCEPT_LANGUAGES as readonly string[]).includes(locale) ? locale : "en";
      expect(dataLanguage(locale)).toBe(expected);
    }
    expect(dataLanguage("fr")).toBe("fr");
    // A language the data lacks, as a translated one will be.
    expect(dataLanguage("zz" as Locale)).toBe("en");
  });
});
