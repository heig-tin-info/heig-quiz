import { existsSync } from "node:fs";
import { join } from "node:path";

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LOCALES } from "@quiz/domain";

import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { mockFetch, renderWithProviders } from "../test/render";
import { PRIVACY_SOURCES, PrivacyPage } from "./PrivacyPage";

/*
 * The "Data and privacy" page (N-DATA-07): its body is one Markdown file per
 * language, beside the component. A language added to the interface without
 * its file, or a section added in one language only, fails here.
 */

/** The section and subsection headings of a source, in order. */
const headings = (source: string) => source.match(/^#{2,3} .+$/gm) ?? [];
/** The table rows of a source: the retention table must keep its rows in both languages. */
const tableRows = (source: string) => source.match(/^\|.+\|$/gm) ?? [];

describe("the privacy sources", () => {
  it("exist for every interface language", () => {
    for (const locale of LOCALES) {
      const file = locale === "en" ? "privacy.md" : `privacy.${locale}.md`;
      expect(existsSync(join(import.meta.dirname, file)), file).toBe(true);
      expect(PRIVACY_SOURCES[locale].trim()).not.toBe("");
    }
  });

  it("have the same sections and the same table in every language", () => {
    for (const locale of LOCALES) {
      expect(headings(PRIVACY_SOURCES[locale]).length).toBe(headings(PRIVACY_SOURCES.en).length);
      expect(tableRows(PRIVACY_SOURCES[locale]).length).toBe(tableRows(PRIVACY_SOURCES.en).length);
    }
  });

  it("never leave a promise open", () => {
    for (const locale of LOCALES) {
      expect(PRIVACY_SOURCES[locale]).not.toMatch(/to be confirmed|à confirmer|TODO/i);
      // The page renders the title itself, from t().
      expect(PRIVACY_SOURCES[locale]).not.toMatch(/^# /m);
    }
  });
});

describe("PrivacyPage", () => {
  it("renders the title and the body without calling the API", () => {
    const { calls } = mockFetch({});
    renderWithProviders(<PrivacyPage />, { route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(en["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "How long it is kept" })).toBeVisible();
    expect(screen.getByRole("link", { name: en["privacy.home"] })).toHaveAttribute("href", "/");
    expect(calls).toHaveLength(0);
  });

  it("speaks French", () => {
    mockFetch({});
    renderWithProviders(<PrivacyPage />, { locale: "fr", route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fr["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "Combien de temps" })).toBeVisible();
  });
});
