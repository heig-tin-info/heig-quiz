import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * The docked tools' stepping aside lives in style.css, which jsdom never
 * applies: the rules are pinned here as text (#450). The assistant's button
 * leaves the bottom edge to a list's bulk bar under `lg`, and to a screen's
 * sticky action bar under `sm` (where that bar is sticky).
 */
const css = readFileSync(new URL("./style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the `@variant <name> { … }` blocks, concatenated. */
function variant(name: string): string {
  return [...css.matchAll(new RegExp(`@variant ${name} \\{([\\s\\S]*?)\\n\\}`, "g"))].map((m) => m[1]).join("\n");
}

describe("the assistant's button steps aside (style.css)", () => {
  it("for the bulk bar, under lg", () => {
    expect(variant("max-lg")).toMatch(/:root:has\(\[data-bulk-bar\]\) \[data-assist-dock\] \{\s*display: none;/);
  });

  it("for a screen's sticky action bar, under sm", () => {
    expect(variant("max-sm")).toMatch(/:root:has\(\[data-action-bar\]\) \[data-assist-dock\] \{\s*display: none;/);
  });
});

describe("a field a finger types in is 16 px at least (style.css, #849)", () => {
  // iOS zooms the page in when a field under 16 px takes the focus, and stays zoomed.
  // Important in the base layer, so it beats the fields' own size, even a `!` utility.
  const rule = /\n@layer base \{\s*@media \(pointer: coarse\) \{\s*:where\(([\s\S]*?)\)\s*\{\s*font-size: max\(16px, 1em\) !important;/.exec(css);

  it("covers every kind of text field", () => {
    expect(rule).not.toBeNull();
    for (const kind of ["input:not(", "textarea", "select", "[contenteditable]"]) expect(rule![1]).toContain(kind);
  });

  it("and the person's own zoom stays (WCAG 1.4.4)", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');
    expect(html).not.toMatch(/maximum-scale|user-scalable/);
  });
});
