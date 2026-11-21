import { describe, expect, it } from "vitest";

import { dataLanguage, FALLBACK_LOCALE, isLocale, LOCALE_INFO, LOCALES, matchLocale } from "./locales.js";

describe("the locale registry (ADR-140)", () => {
  it("names every language in itself, and the fallback is a written one", () => {
    expect(LOCALES.map((l) => LOCALE_INFO[l].endonym)).toEqual(["English", "Français"]);
    expect(LOCALE_INFO[FALLBACK_LOCALE].origin).toBe("written");
  });

  it("knows a locale from any other value", () => {
    expect(LOCALES.every(isLocale)).toBe(true);
    for (const other of ["de", "FR", "fr-CH", "", null, undefined, 1]) expect(isLocale(other)).toBe(false);
  });

  it("matches the first tag whose base language is spoken", () => {
    expect(matchLocale(["de-CH", "fr-CH", "en"])).toBe("fr");
    expect(matchLocale(["EN-gb"])).toBe("en");
    expect(matchLocale([" fr-CH;q=0.9", "en;q=0.8"])).toBe("fr");
    expect(matchLocale(["fr_CH"])).toBe("fr");
  });

  it("matches nothing among languages it does not speak", () => {
    expect(matchLocale(["de-CH", "it"])).toBeNull();
    expect(matchLocale([])).toBeNull();
    expect(matchLocale([""])).toBeNull();
  });

  it("reads two-language data in French for French, in English otherwise", () => {
    expect(dataLanguage("fr")).toBe("fr");
    expect(dataLanguage("en")).toBe("en");
  });
});
