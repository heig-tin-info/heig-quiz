import { describe, expect, it } from "vitest";

import { renderStandalone } from "./render.js";

describe("renderStandalone (a document of a course's library, ADR-144)", () => {
  it("escapes raw HTML into visible text, with one warning", () => {
    const r = renderStandalone("# Sheet\n\n<script>alert(1)</script>\n\n<b>bold</b>\n");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.warnings).toEqual([{ code: "raw_html" }]);
  });

  it("turns a relative image into its alt text and a warning; drops an external one", () => {
    const r = renderStandalone("![Pinout](images/pinout.png)\n\n![Logo](https://example.org/logo.png)\n");
    expect(r.html).not.toContain("<img");
    expect(r.html).toContain("Pinout");
    expect(r.html).toContain("Logo");
    expect(r.warnings).toEqual([
      { code: "target_missing", href: "images/pinout.png", path: "images/pinout.png" },
      { code: "external_image", href: "https://example.org/logo.png" },
    ]);
  });

  it("keeps a relative link's text and loses its target; an external link stays", () => {
    const r = renderStandalone("[other](other.md) and [site](https://example.org)\n");
    expect(r.html).not.toContain('href="other.md"');
    expect(r.html).toContain('href="https://example.org"');
  });

  it("gives the table of contents", () => {
    expect(renderStandalone("# Datasheet\n\n## Pins\n\n### Power\n").toc).toEqual([
      { id: "datasheet", depth: 1, text: "Datasheet" },
      { id: "pins", depth: 2, text: "Pins" },
      { id: "power", depth: 3, text: "Power" },
    ]);
  });

  it("ignores the journal's front matter dates", () => {
    const r = renderStandalone("---\nvisible_from: never\n---\nText\n");
    expect(r.warnings).toEqual([]);
  });
});
