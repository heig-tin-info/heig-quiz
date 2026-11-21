import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LOCALE_INFO, LOCALES } from "@quiz/domain";

import { en } from "../i18n/en";
import { fr } from "../i18n/fr";
import { renderWithProviders } from "../test/render";
import { PRIVACY_SOURCES, PrivacyPage } from "./PrivacyPage";

/*
 * The "Data and privacy" page (N-DATA-07): its body is one Markdown file per
 * written language, beside the component; a written language added to the
 * interface without its file does not compile (`PRIVACY_SOURCES`), a
 * translated one reads the English (ADR-140), and a section added in one
 * language only fails here.
 */

/** Every source the page has: each written language's, and any reviewed translation. */
const SOURCES = Object.values(PRIVACY_SOURCES);

/** The section and subsection headings of a source, in order. */
const headings = (source: string) => source.match(/^#{2,3} .+$/gm) ?? [];
/** The table rows of a source: the retention table must keep its rows in both languages. */
const tableRows = (source: string) => source.match(/^\|.+\|$/gm) ?? [];

describe("the privacy sources", () => {
  it("are not empty in any written language", () => {
    for (const locale of LOCALES) {
      if (LOCALE_INFO[locale].origin === "written") expect(PRIVACY_SOURCES[locale]?.trim()).toBeTruthy();
    }
  });

  it("have the same sections and the same table in every language", () => {
    for (const source of SOURCES) {
      expect(headings(source).length).toBe(headings(PRIVACY_SOURCES.en).length);
      expect(tableRows(source).length).toBe(tableRows(PRIVACY_SOURCES.en).length);
    }
  });

  it("never leave a promise open", () => {
    for (const source of SOURCES) {
      expect(source).not.toMatch(/to be confirmed|à confirmer|TODO/i);
      // The page renders the title itself, from t().
      expect(source).not.toMatch(/^# /m);
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

  it("speaks French", () => {
    renderWithProviders(<PrivacyPage />, { locale: "fr", route: "/privacy" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(fr["privacy.title"]);
    expect(screen.getByRole("heading", { level: 2, name: "Combien de temps" })).toBeVisible();
  });
});
