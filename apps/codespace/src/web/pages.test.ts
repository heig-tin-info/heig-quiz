import { describe, expect, it } from "vitest";

import { errorPage, escapeHtml, landingPage, workspaceErrorPage } from "./pages.js";

describe("escaping", () => {
  it("neutralizes HTML", () => {
    expect(escapeHtml('<script>"&')).toBe("&lt;script&gt;&quot;&amp;");
  });

  it("a hostile detail does not come out as a tag", () => {
    const html = workspaceErrorPage("<img onerror=x>");
    expect(html).not.toContain("<img onerror");
    expect(html).toContain("&lt;img onerror=x&gt;");
  });
});

describe("pages", () => {
  it("the landing page offers nothing to start: a session opens from the platform", () => {
    const html = landingPage();
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/auth/");
  });

  it("an error page links back to the landing page", () => {
    expect(errorPage("T", "D")).toContain('href="/"');
  });
});
