import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LOCALES } from "@quiz/domain";

import { loadLocale } from "../i18n";
import { de } from "../i18n/de";
import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { renderWithProviders } from "../test/render";
import { PRIVACY_SOURCES, PrivacyPage, privacySource } from "./PrivacyPage";

// German is lazy like French, which the test setup loads: a German render reads it from its first frame.
await loadLocale("de");

/*
 * The "Data and privacy" page (N-DATA-07): its body is one Markdown file per
 * WRITTEN language, beside the component; a written language added to the
 * interface without its file does not compile (`PRIVACY_SOURCES`), a
 * translated one reads the English (ADR-140 §5), and a section added in one
 * language only fails here.
 */

/** The section and subsection headings of a source, in order. */
const headings = (source: string) => source.match(/^#{2,3} .+$/gm) ?? [];
/** The table rows of a source: the retention table must keep its rows in both languages. */
const tableRows = (source: string) => source.match(/^\|.+\|$/gm) ?? [];

describe("the privacy sources", () => {
  it("are not empty in any interface language", () => {
    for (const locale of LOCALES) expect(privacySource(locale).trim()).not.toBe("");
  });

  it("have the same sections and the same table in every language", () => {
    for (const locale of LOCALES) {
      expect(headings(privacySource(locale)).length).toBe(headings(PRIVACY_SOURCES.en).length);
      expect(tableRows(privacySource(locale)).length).toBe(tableRows(PRIVACY_SOURCES.en).length);
    }
  });

  it("never leave a promise open", () => {
    for (const locale of LOCALES) {
      expect(privacySource(locale)).not.toMatch(/to be confirmed|à confirmer|TODO/i);
      // The page renders the title itself, from t().
      expect(privacySource(locale)).not.toMatch(/^# /m);
    }
  });
});

describe("PrivacyPage", () => {
  it("renders the title and the body", () => {
    renderWithProviders(<PrivacyPage />, { route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(en["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "How long it is kept" })).toBeVisible();
    expect(screen.getByRole("link", { name: en["privacy.home"] })).toHaveAttribute("href", "/");
  });

  it("gives a translated language the English text, marked as English, under its own title", () => {
    expect(privacySource("de")).toBe(PRIVACY_SOURCES.en);
    const { container } = renderWithProviders(<PrivacyPage />, { locale: "de", route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(de["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "How long it is kept" })).toBeVisible();
    expect(container.querySelector("article")).toHaveAttribute("lang", "en");
  });

  it("speaks French", () => {
    renderWithProviders(<PrivacyPage />, { locale: "fr", route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fr["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "Combien de temps" })).toBeVisible();
  });
});
