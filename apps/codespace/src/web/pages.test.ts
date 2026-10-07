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
  });
});

describe("langOf", () => {
  it.each([
    [undefined, "fr"],
    ["", "fr"],
    ["de-CH", "fr"],
    ["en-US,en;q=0.9", "en"],
    ["fr-CH,fr;q=0.9,en;q=0.8", "fr"],
    ["de-CH,de;q=0.9,en;q=0.8,fr;q=0.7", "en"],
    ["fr;q=0.5,en;q=0.8", "en"],
    ["en;q=0,fr", "fr"],
  ] as const)("%s → %s", (header, lang) => {
    expect(langOf(header)).toBe(lang);
  });
});
