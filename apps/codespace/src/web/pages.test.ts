import { describe, expect, it } from "vitest";

import { langOf, t } from "./i18n.js";
import { errorPage, escapeHtml, landingPage, workspaceErrorPage } from "./pages.js";

describe("escaping", () => {
  it("neutralizes HTML", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
  });

  it("a hostile repository name does not come out as a tag", () => {
    const html = workspaceErrorPage("fr", { key: "causeNotFound", repo: "<img onerror=x>" });
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });
});

describe("pages", () => {
  it("the landing page offers nothing to start: a session opens from the platform", () => {
    const html = landingPage("fr");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/auth/");
  });

  it("an error page links back to the landing page", () => {
    expect(errorPage("en", "T", "D")).toContain('href="/"');
  });

  it("speaks the reader's language, and says which in <html lang>", () => {
    expect(landingPage("en")).toContain('<html lang="en">');
    expect(landingPage("en")).toContain(t("en", "landingTitle"));
    expect(landingPage("fr")).toContain('<html lang="fr">');
    expect(landingPage("fr")).toContain("Environnements de développement");
    expect(landingPage("de")).toContain('<html lang="de">');
    expect(landingPage("de")).toContain("Entwicklungsumgebungen");
    expect(landingPage("it")).toContain('<html lang="it">');
    expect(landingPage("it")).toContain("Ambienti di sviluppo");
  });

  it("German names a failed workspace's cause in German", () => {
    const html = workspaceErrorPage("de", { key: "causeNotFound", repo: "org/depot" });
    expect(html).toContain("Repository org/depot nicht gefunden");
    expect(workspaceErrorPage("de", { key: "causeFetchFailed", repo: null })).toContain(
      "das Quell-Repository konnte nicht abgerufen werden",
    );
  });
});

describe("langOf", () => {
  it.each([
    // English when the browser names none of the portal's languages (ADR-140 §4).
    [undefined, "en"],
    ["", "en"],
    ["xx", "en"],
    ["xx-YY,xx;q=0.9", "en"],
    ["it", "it"],
    ["it-CH,it;q=0.9", "it"],
    ["de", "de"],
    ["de-CH", "de"],
    ["en-US,en;q=0.9", "en"],
    ["fr-CH,fr;q=0.9,en;q=0.8", "fr"],
    ["fr", "fr"],
    ["de-CH,de;q=0.9,en;q=0.8,fr;q=0.7", "de"],
    ["it-CH,en;q=0.8,fr;q=0.9", "it"],
    ["xx-YY,en;q=0.8,fr;q=0.9", "fr"],
    ["fr-CH;q=0.9, de;q=0.8", "fr"],
    ["de;q=0.8, fr-CH;q=0.9", "fr"],
    ["fr;q=0.5,en;q=0.8", "en"],
    ["en;q=0,fr", "fr"],
    ["de;q=0,it", "it"],
    ["de;q=0,xx", "en"],
  ] as const)("%s → %s", (header, lang) => {
    expect(langOf(header)).toBe(lang);
  });
});
