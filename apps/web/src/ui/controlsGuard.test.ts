/**
 * Guard rail of the control scale (ADR-094, issue #552): the source of
 * `apps/web` and of every package is scanned for the three ways a control
 * used to drift off the scale.
 *
 *  1. a raw `<select>`: the shared `Select` (`@quiz/ui`, wrapped by
 *     `apps/web`'s labelled one) draws the chevron and wears the field family;
 *  2. a raw single-line `<input>`: `TextInput`, `Field` or `SearchInput`;
 *     a checkbox, a radio, a file, a range or a hidden input is native by type;
 *  3. a `rounded-full` or a literal height (`h-8`, `h-[30px]`) on a control of
 *     the scale: next to `inputClass`, or on a `TextInput`, `Select`, `Field`,
 *     `SearchInput`, `NumberField` or `Button` tag. The scale owns the
 *     height and the radius.
 *
 * It reads source text, no DOM and no build: a few hundred files, under a
 * second. Comments are blanked first, so a sentence about `<select>` is not
 * a violation. Tests are not scanned.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function sourceFiles(): string[] {
  const roots = ["apps/web/src", ...readdirSync(join(ROOT, "packages")).map((p) => `packages/${p}/src`)];
  const files: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(join(ROOT, root), { recursive: true, encoding: "utf8" });
    } catch {
      continue; // a package with no `src`
    }
    for (const entry of entries) {
      if (/\.(tsx|jsx)$/.test(entry) && !/\.test\./.test(entry) && !entry.includes("node_modules")) {
        files.push(`${root}/${entry}`.split("\\").join("/"));
      }
    }
  }
  return files.sort();
}

/** Replaces comments with spaces (same offsets, same line numbers). */
function blankComments(src: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead: string) => lead + blank(m.slice(lead.length)));
}

/** The opening tags of `names` (up to the first `>` outside braces), with their line. */
function tagsOf(src: string, names: string): { tag: string; line: number }[] {
  const found: { tag: string; line: number }[] = [];
  for (const m of src.matchAll(new RegExp(`<(?:${names})(?=[\\s/>])`, "g"))) {
    let depth = 0;
    let quote = "";
    let end = m.index;
    for (; end < src.length; end++) {
      const c = src[end];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push({ tag: src.slice(m.index, end + 1), line: src.slice(0, m.index).split("\n").length });
  }
  return found;
}

/**
 * Files allowed a raw element, each with the reason. A reason is a role, not
 * a convenience: add a line here only for a control that is not a form field
 * of the scale. The key is `<repo path>`; the value says what is allowed.
 */
const ALLOW_RAW_SELECT: Record<string, string> = {
  "packages/ui/src/controls.tsx": "the shared Select primitive itself",
};

const ALLOW_RAW_INPUT: Record<string, string> = {
  "packages/ui/src/controls.tsx": "the shared TextInput primitive itself",
  "apps/web/src/ui/page.tsx": "the in-place editor of a page title, drawn at the heading's own size and weight",
  "apps/web/src/CommandPalette.tsx": "the palette's top band IS the field; a second chrome inside the panel is noise",
  "apps/web/src/concepts/ConceptPicker.tsx": "the typing cursor inside a token field: chips and input share one box",
  "packages/qt-mcq/src/ui.tsx": "the radio or checkbox of a choice, its type decided at run time (a box drawn over it)",
  "packages/qt-categorize/src/Editor.tsx": "a column title edited in place on the board (borderless until hovered)",
};

const NATIVE_TYPES = new Set(["checkbox", "radio", "file", "range", "hidden", "submit"]);

/** Components whose height and radius come from the scale. */
const SCALE_TAGS = "TextInput|Select|Field|SearchInput|NumberField|Button";
const LITERAL_HEIGHT = /(?:^|[\s"'`{(])(?:h-(?:\d|\[|px|full|auto|screen|fit|min|max)|rounded-full)/;

describe("control scale guard rail (ADR-094)", () => {
  const files = sourceFiles().map((path) => ({ path, src: blankComments(readFileSync(join(ROOT, path), "utf8")) }));

  it("scans the app and every package", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path.startsWith("packages/qt-short/"))).toBe(true);
    expect(files.some((f) => f.path.startsWith("apps/web/"))).toBe(true);
  });

  it("has no raw <select> beside the shared Select", () => {
    const bad = files.flatMap(({ path, src }) =>
      path in ALLOW_RAW_SELECT ? [] : tagsOf(src, "select").map((t) => `${path}:${t.line}`),
    );
    expect(bad).toEqual([]);
  });

  it("has no raw single-line <input> outside TextInput, Field and SearchInput", () => {
    const bad = files.flatMap(({ path, src }) => {
      if (path in ALLOW_RAW_INPUT) return [];
      // `apps/web`'s own Checkbox / RadioRow / Switch are the native ones by type.
      return tagsOf(src, "input")
        .filter(({ tag }) => !NATIVE_TYPES.has(/\btype="(\w+)"/.exec(tag)?.[1] ?? ""))
        .map((t) => `${path}:${t.line}`);
    });
    expect(bad).toEqual([]);
  });

  it("writes no rounded-full and no literal height beside the scale", () => {
    const bad: string[] = [];
    for (const { path, src } of files) {
      // The primitives define the scale; the gallery measures it.
      if (path === "packages/ui/src/styles.ts" || path.startsWith("apps/web/src/devgallery/") || path === "apps/web/src/DevGallery.tsx") continue;
      for (const { tag, line } of tagsOf(src, SCALE_TAGS)) {
        const cls = /\bclassName=(?:"([^"]*)"|\{([\s\S]*)\})/.exec(tag);
        if (cls && LITERAL_HEIGHT.test(cls[1] ?? cls[2] ?? "")) bad.push(`${path}:${line}`);
      }
      src.split("\n").forEach((text, i) => {
        if (!/\binputClass\b/.test(text) || /^\s*(import|export|\{?\s*inputClass,?\s*\}?)/.test(text)) return;
        const window = src.split("\n").slice(Math.max(0, i - 2), i + 3).join("\n");
        if (LITERAL_HEIGHT.test(window.replace(/\binputClass\b/g, ""))) bad.push(`${path}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
