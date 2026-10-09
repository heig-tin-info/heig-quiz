import { JournalWarning } from "@quiz/contracts";
import { describe, expect, it } from "vitest";

import { splitFrontMatter } from "./frontMatter.js";
import { renderPage, type RenderContext } from "./render.js";

const CLASSROOM = "018f0000-0000-7000-8000-00000000c1a5";
const ASSET_BASE = `/app/api/classrooms/${CLASSROOM}/journal/assets`;

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  classroomId: CLASSROOM,
  pagePath: "010-basics/020-pointers.md",
  fallbackTitle: "Pointers",
  pages: new Set(["010-basics/020-pointers.md", "020-tooling/010-make.md"]),
  assets: new Set(["010-basics/images/p.svg", "010-basics/handout 1.pdf"]),
  oversized: new Set(["010-basics/video.mp4"]),
  ...over,
});

const codes = (warnings: readonly JournalWarning[]) => warnings.map((w) => w.code);

describe("splitFrontMatter", () => {
  it("takes the mapping off the top", () => {
    const r = splitFrontMatter("---\ntitle: Pointers\ndraft: true\n---\nBody\n");
    expect(r.frontMatter).toEqual({ title: "Pointers", draft: true });
    expect(r.body).toBe("Body\n");
    expect(r.warnings).toEqual([]);
  });

  it("leaves a page without front matter alone", () => {
    const r = splitFrontMatter("# Title\n\n---\n\nA horizontal rule is not front matter.\n");
    expect(r.frontMatter).toEqual({});
    expect(r.body.startsWith("# Title")).toBe(true);
  });

  it("takes an empty block as no front matter", () => {
    const r = splitFrontMatter("---\n\n---\nBody\n");
    expect(r.frontMatter).toEqual({});
    expect(r.warnings).toEqual([]);
  });

  it("reports broken YAML with its line in the file, and keeps the body", () => {
    const r = splitFrontMatter("---\ntitle: ok\nlist: [unclosed\n---\nBody\n");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe("front_matter_yaml");
    expect(r.warnings[0]).toHaveProperty("line");
    expect(r.body).toBe("Body\n");
  });

  it("reports a block that is not a mapping", () => {
    const r = splitFrontMatter("---\n- a\n- b\n---\nBody\n");
    expect(r.frontMatter).toEqual({});
    expect(r.warnings).toEqual([{ code: "front_matter_not_mapping" }]);
  });
});

describe("title", () => {
  it("prefers the front matter", () => {
    const p = renderPage("---\ntitle: From the front matter\n---\n# From the heading\n", ctx());
    expect(p.title).toBe("From the front matter");
  });

  it("falls back to the first h1, then to the file name", () => {
    expect(renderPage("# From the heading\n", ctx()).title).toBe("From the heading");
    expect(renderPage("Just a paragraph.\n", ctx()).title).toBe("Pointers");
  });

  it("keeps the h1 in the body: the page owns its own title", () => {
    expect(renderPage("# Pointers\n", ctx()).html).toContain("<h1");
  });
});

describe("visibility", () => {
  it("reads draft in the spellings a teacher may use", () => {
    expect(renderPage("---\ndraft: true\n---\n", ctx()).draft).toBe(true);
    expect(renderPage("---\ndraft: yes\n---\n", ctx()).draft).toBe(true);
    expect(renderPage("---\ndraft: 1\n---\n", ctx()).draft).toBe(true);
    expect(renderPage("---\ndraft: false\n---\n", ctx()).draft).toBe(false);
    expect(renderPage("---\ndraft: [a]\n---\n", ctx()).draft).toBe(false);
    expect(renderPage("Nothing\n", ctx()).draft).toBe(false);
  });

  it("reads visible_from as a date, unquoted or quoted", () => {
    const p = renderPage("---\nvisible_from: 2026-10-01T08:00:00Z\n---\n", ctx());
    expect(p.visibleFrom?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
    const q = renderPage('---\nvisible_from: "2026-10-01T08:00:00Z"\n---\n', ctx());
    expect(q.visibleFrom?.toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("keeps a page visible when its date is unusable, and says so with the value", () => {
    const p = renderPage("---\nvisible_from: next monday\n---\n", ctx());
    expect(p.visibleFrom).toBeNull();
    expect(p.warnings).toEqual([{ code: "visible_from_invalid", value: "next monday" }]);
    const q = renderPage("---\nvisible_from: [2026]\n---\n", ctx());
    expect(codes(q.warnings)).toEqual(["visible_from_invalid"]);
  });
});

describe("raw HTML (D15, N-SEC-14)", () => {
  it("shows a script as text instead of running it", () => {
    const p = renderPage("<script>alert(1)</script>\n", ctx());
    expect(p.html).not.toContain("<script");
    expect(p.html).toContain("&lt;script&gt;");
    expect(p.warnings).toEqual([{ code: "raw_html" }]);
  });

  it("escapes an inline tag too, and warns once for the page", () => {
    const p = renderPage("A <b>bold</b> and an <i>italic</i> tag.\n\n<div>block</div>\n", ctx());
    expect(p.html).not.toContain("<b>");
    expect(p.html).not.toContain("<div>");
    expect(p.html).toContain("&lt;b&gt;");
    expect(p.warnings).toEqual([{ code: "raw_html" }]);
  });

  it("leaves a smuggled img, iframe or event handler no way in", () => {
    const p = renderPage(
      '<img src=x onerror="alert(1)">\n\n<iframe src="https://evil.example"></iframe>\n\nText <a href="javascript:alert(1)">x</a>\n',
      ctx(),
    );
    expect(p.html).not.toMatch(/<(img|iframe|a)\b/);
    expect(p.html).toContain("&lt;img");
    expect(p.html).toContain("&lt;iframe");
    expect(p.html).not.toMatch(/<[a-z]+[^>]*\sonerror=/i);
  });

  it("keeps a comment out of the markup too", () => {
    const p = renderPage("<!-- secret note -->\n", ctx());
    expect(p.html).not.toContain("<!--");
    expect(p.html).toContain("&lt;!--");
  });
});

describe("links", () => {
  it("rewrites a relative page link to a relative in-app href", () => {
    const p = renderPage("[Make](../020-tooling/010-make.md)\n", ctx());
    expect(p.html).toContain('href="../020-tooling/010-make.md"');
    expect(p.warnings).toEqual([]);
  });

  it("keeps the fragment of a page link", () => {
    const p = renderPage("[Make](../020-tooling/010-make.md#install)\n", ctx());
    expect(p.html).toContain('href="../020-tooling/010-make.md#install"');
  });

  it("links another file of the repository to its classroom-scoped asset URL", () => {
    const p = renderPage("[Handout](handout%201.pdf)\n", ctx());
    expect(p.html).toContain(`href="${ASSET_BASE}/010-basics/handout%201.pdf"`);
    expect(p.assets).toEqual(["010-basics/handout 1.pdf"]);
  });

  it("opens an external link in a new tab without a referrer", () => {
    const p = renderPage("[HEIG](https://heig-vd.ch) and <mailto:a@b.ch>\n", ctx());
    expect(p.html).toContain('<a href="https://heig-vd.ch" target="_blank" rel="noreferrer">');
    expect(p.html).toContain('href="mailto:a@b.ch" target="_blank" rel="noreferrer"');
  });

  it("keeps an in-page anchor", () => {
    expect(renderPage("[top](#pointers)\n", ctx()).html).toContain('href="#pointers"');
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox",
  ])("drops a %j link and keeps its text", (href) => {
    const p = renderPage(`[click](<${href}>)\n`, ctx());
    expect(p.html).not.toMatch(/<a\b/);
    expect(p.html).not.toMatch(/javascript:|data:|vbscript:/i);
    expect(p.html).toContain("click");
  });

  it("drops an absolute path or a climb out of the repository, silently", () => {
    const p = renderPage("[root](/etc/passwd) [up](../../../x.md)\n", ctx());
    expect(p.html).not.toMatch(/<a\b/);
    expect(p.warnings).toEqual([]);
  });

  it("leaves a malformed escape as typed", () => {
    const p = renderPage("[bad](a%E0.pdf)\n", ctx());
    expect(p.warnings).toEqual([
      { code: "target_missing", href: "a%E0.pdf", path: "010-basics/a%E0.pdf" },
    ]);
  });

  it("drops a link that resolves nowhere, and reports its href and path", () => {
    const p = renderPage("[gone](./030-missing.md)\n", ctx());
    expect(p.html).not.toContain("<a ");
    expect(p.html).toContain("gone");
    expect(p.warnings).toEqual([
      { code: "target_missing", href: "./030-missing.md", path: "010-basics/030-missing.md" },
    ]);
  });

  it("says a file is too large rather than missing", () => {
    const p = renderPage("[video](video.mp4)\n", ctx());
    expect(p.html).not.toContain("<a ");
    expect(p.warnings).toEqual([
      { code: "asset_too_large", href: "video.mp4", path: "010-basics/video.mp4" },
    ]);
  });
});

describe("images", () => {
  it("serves a committed image at the classroom-scoped asset URL", () => {
    const p = renderPage('![A pointer](images/p.svg "Fig. 1")\n', ctx());
    expect(p.html).toContain(`src="${ASSET_BASE}/010-basics/images/p.svg"`);
    expect(p.html).toContain('alt="A pointer"');
    expect(p.html).toContain('title="Fig. 1"');
    expect(p.html).toContain('loading="lazy"');
    expect(p.assets).toEqual(["010-basics/images/p.svg"]);
  });

  it("lists a referenced asset once", () => {
    const p = renderPage("![a](images/p.svg) ![b](./images/p.svg) [c](images/p.svg)\n", ctx());
    expect(p.assets).toEqual(["010-basics/images/p.svg"]);
  });

  it("drops an external image, keeps its alt text, and tells the author", () => {
    const p = renderPage("![remote](https://example.org/p.png)\n", ctx());
    expect(p.html).not.toContain("<img");
    expect(p.html).toContain("remote");
    expect(p.warnings).toEqual([{ code: "external_image", href: "https://example.org/p.png" }]);
    expect(p.assets).toEqual([]);
  });

  it("reports an image missing from the repository", () => {
    const p = renderPage("![nope](images/none.png)\n", ctx());
    expect(p.html).not.toContain("<img");
    expect(codes(p.warnings)).toEqual(["target_missing"]);
  });

  it("escapes the alt text of a dropped image", () => {
    const p = renderPage('![<b onmouseover="x">](https://example.org/p.png)\n', ctx());
    expect(p.html).not.toContain("<b ");
  });
});

describe("code", () => {
  it("highlights a fence and names its language", () => {
    const p = renderPage("```c\nint x = 1; // a\n```\n", ctx());
    expect(p.html).toContain('class="language-c"');
    expect(p.html).toContain('<span class="tok-kw">int</span>');
    expect(p.html).toContain('<span class="tok-com">// a</span>');
  });

  it("escapes a fence with no language", () => {
    const p = renderPage("```\n<not html>\n```\n", ctx());
    expect(p.html).toContain("&lt;not html&gt;");
    expect(p.warnings).toEqual([]);
  });

  it("escapes the language tag", () => {
    const p = renderPage('```"><script>\nx\n```\n', ctx());
    expect(p.html).not.toContain("<script>");
  });

  it("leaves a dollar inside code alone", () => {
    const p = renderPage("Run `echo $HOME` first.\n", ctx());
    expect(p.html).toContain("$HOME");
  });
});

describe("math", () => {
  it("renders an inline formula", () => {
    const p = renderPage("The value $x^2$ grows.\n", ctx());
    expect(p.html).toContain("katex");
    expect(p.warnings).toEqual([]);
  });

  it("renders a display formula", () => {
    const p = renderPage("$$\n\\int_0^1 x\\,dx\n$$\n", ctx());
    expect(p.html).toContain("katex-display");
  });

  it("reports a broken formula with its source and keeps it readable", () => {
    const p = renderPage("$\\frac{1}{$\n", ctx());
    expect(p.warnings).toEqual([{ code: "math_error", source: "\\frac{1}{" }]);
    expect(p.html).toContain('<code class="md-math-error">');
  });

  it("marks a broken display formula as a block", () => {
    const p = renderPage("$$\n\\frac{\n$$\n", ctx());
    expect(p.html).toContain('<code class="md-math-error md-math-block">');
  });

  it("does not let a formula smuggle a link in", () => {
    // KaTeX runs with `trust: false`, so `\\href` renders as red text. The TeX
    // source does survive inside the MathML annotation, as escaped text: what
    // must not exist is an anchor or an attribute carrying it.
    const p = renderPage("$\\href{javascript:alert(1)}{x}$\n", ctx());
    expect(p.html).not.toContain("<a ");
    expect(p.html).not.toMatch(/href="javascript:/);
  });
});

describe("table of contents", () => {
  it("lists the headings with stable anchors", () => {
    const p = renderPage("# Pointers\n\n## What is it\n\n## Why\n", ctx());
    expect(p.toc).toEqual([
      { id: "pointers", depth: 1, text: "Pointers" },
      { id: "what-is-it", depth: 2, text: "What is it" },
      { id: "why", depth: 2, text: "Why" },
    ]);
    expect(p.html).toContain('<h2 id="what-is-it">');
  });

  it("disambiguates two headings that read the same", () => {
    const p = renderPage("## Notes\n\n## Notes\n\n## Notes\n", ctx());
    expect(p.toc.map((t) => t.id)).toEqual(["notes", "notes-2", "notes-3"]);
  });

  it("folds accents and keeps the displayed text intact", () => {
    const p = renderPage("## Référence à l'opérateur\n", ctx());
    expect(p.toc[0]!.id).toBe("reference-a-l-operateur");
    expect(p.toc[0]!.text).toBe("Référence à l'opérateur");
  });

  it("takes the plain text of a heading that has markup", () => {
    const p = renderPage("## The `malloc` **call**\n", ctx());
    expect(p.toc[0]!.text).toBe("The malloc call");
  });

  it("names a heading with no usable character", () => {
    const p = renderPage("## ???\n\n## ***\n", ctx());
    expect(p.toc.map((t) => t.id)).toEqual(["section", "section-2"]);
  });
});

describe("gfm", () => {
  it("renders a table", () => {
    const p = renderPage("| a | b |\n| --- | --- |\n| 1 | 2 |\n", ctx());
    expect(p.html).toContain("<table>");
  });

  it("escapes text in a table cell", () => {
    const p = renderPage("| a |\n| --- |\n| <script> |\n", ctx());
    expect(p.html).not.toContain("<script>");
  });
});

describe("task lists", () => {
  const plan = [
    "- [ ] Numbers",
    "  - [x] Bases",
    "  - [ ] Two's complement",
    "- [ ] Tools",
    "  - [ ] Compiler",
    "    - [ ] gcc",
    "- [ ] Types",
    "  - [x] Integers",
    "  - [x] Floats",
    "- [x] Loops",
    "  - [ ] for",
    "- plain item",
    "",
  ].join("\n");
  const items = (html: string) => [...html.matchAll(/<li class="md-check md-check-(\w+)">/g)].map((m) => m[1]);

  it("derives a parent's state from its sub-tasks", () => {
    const p = renderPage(plan, ctx());
    expect(items(p.html)).toEqual([
      "doing", "done", "todo", // Numbers: one leaf of two ticked
      "todo", "todo", "todo", // Tools: nothing ticked, two levels deep
      "done", "done", "done", // Types: every sub-task ticked
      "done", "todo", // Loops: ticked by hand, whatever is below
    ]);
  });

  it("counts the covered leaves on a parent, none on a leaf", () => {
    const counts = [...renderPage(plan, ctx()).html.matchAll(/md-check-count">([^<]*)</g)].map((m) => m[1]);
    expect(counts).toEqual(["1/2", "0/1", "0/1", "2/2", "1/1"]);
  });

  it("keeps a disabled native checkbox, ticked when the item is done, and no bullet item is touched", () => {
    const p = renderPage("- [ ] a\n  - [x] b\n  - [ ] d\n- c\n", ctx());
    expect(p.html).toContain('<li class="md-check md-check-doing"><input type="checkbox" class="md-check-box" disabled><div class="md-check-label">a');
    expect(p.html).toContain('<input type="checkbox" class="md-check-box" disabled checked><div class="md-check-label">b</div>');
    expect(p.html).toContain("<li>c</li>");
    expect(p.html.match(/type="checkbox"/g)).toHaveLength(3);
  });

  it("escapes the label like any text", () => {
    expect(renderPage("- [ ] <script>\n", ctx()).html).not.toContain("<script>");
  });
});

describe("warnings (J5)", () => {
  it("are codes with parameters, every one valid for the contract, never a sentence", () => {
    const p = renderPage(
      [
        "---",
        "visible_from: someday",
        "---",
        "<b>raw</b> ![x](https://e.org/a.png) [m](missing.md) [v](video.mp4) $\\frac{$",
        "",
      ].join("\n"),
      ctx(),
    );
    expect(codes(p.warnings).sort()).toEqual(
      ["asset_too_large", "external_image", "math_error", "raw_html", "target_missing", "visible_from_invalid"].sort(),
    );
    for (const w of p.warnings) expect(JournalWarning.parse(w)).toEqual(w);
  });
});

describe("the student rendering (N-SEC-12)", () => {
  it("turns a link to a page missing from the context into plain text", () => {
    const md = "See [the draft](030-draft.md) and [make](../020-tooling/010-make.md).\n";
    const staff = renderPage(md, ctx({ pages: new Set(["010-basics/030-draft.md", "020-tooling/010-make.md"]) }));
    const student = renderPage(md, ctx({ pages: new Set(["020-tooling/010-make.md"]) }));
    expect(staff.html).toContain('href="./030-draft.md"');
    expect(student.html).not.toContain("030-draft");
    expect(student.html).toContain("the draft");
    expect(student.html).toContain('href="../020-tooling/010-make.md"');
  });
});

describe("control characters never block a synchronisation", () => {
  it("drops a link whose decoded path holds a NUL, silently", () => {
    const p = renderPage("[a](%00x)\n", ctx());
    expect(p.html).not.toMatch(/<a\b/);
    expect(p.html).not.toContain("\u0000");
    expect(p.warnings).toEqual([]);
  });

  it("strips a NUL byte from the body", () => {
    const p = renderPage("# Ti\u0000tle\n\nBo\u0000dy\n", ctx());
    expect(p.html).not.toContain("\u0000");
    expect(p.title).toBe("Title");
    expect(p.html).toContain("Body");
  });

  it("keeps control characters out of the front matter, the title and the warnings", () => {
    const p = renderPage(
      '---\ntitle: "A\\u0000B\\u0007C"\nnote: "x\\u0001y\\nz"\nvisible_from: "never\\u0002"\n---\n$\\frac{\u0003$\n',
      ctx(),
    );
    expect(p.title).toBe("A�B�C");
    expect(p.frontMatter.note).toBe("x�y\nz");
    for (const w of p.warnings) {
      for (const v of Object.values(w)) if (typeof v === "string") expect(v).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    expect(codes(p.warnings).sort()).toEqual(["math_error", "visible_from_invalid"]);
  });
});

describe("title and TOC are plain text", () => {
  it("decode entities, keep raw HTML as the text a reader sees", () => {
    const p = renderPage("# Fish &amp; chips \\< <i>x</i> &#233;&#xE9; &copy;\n", ctx());
    expect(p.title).toBe("Fish & chips < <i>x</i> éé &copy;");
    expect(p.toc[0]!.text).toBe(p.title);
  });

  it("is null when nothing names the page", () => {
    expect(renderPage("No heading.\n", ctx({ fallbackTitle: null })).title).toBeNull();
  });
});

describe("lone surrogates never reach the output", () => {
  const wellFormed = (s: string) => s === s.toWellFormed();

  it("leaves an entity naming a surrogate as typed", () => {
    const p = renderPage("# A &#xD800; B &#55296;\n", ctx());
    expect(p.title).toBe("A &#xD800; B &#55296;");
    expect(wellFormed(p.toc[0]!.text)).toBe(true);
  });

  it("replaces one in the front matter's title, values, keys and warnings", () => {
    const p = renderPage(
      '---\ntitle: "A\\uD800B"\nvisible_from: "x\\uD800"\n"k\\uDC00": "v\\uD800"\n---\n',
      ctx(),
    );
    expect(p.title).toBe("A�B");
    expect(p.frontMatter).toMatchObject({ "k�": "v�" });
    expect(p.warnings).toEqual([{ code: "visible_from_invalid", value: "x�" }]);
    expect(wellFormed(JSON.stringify(p))).toBe(true);
  });
});
