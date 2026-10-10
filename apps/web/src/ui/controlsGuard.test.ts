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
      if (/\.(tsx|jsx|ts)$/.test(entry) && !/\.d\.ts$|\.test\./.test(entry) && !entry.includes("node_modules")) {
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
 * Files allowed a raw element, each with how many and why. A reason is a role,
 * not a convenience, and the count is exact: a new raw element in an
 * allow-listed file fails the test until someone decides it is a role too.
 */
type Allowed = Record<string, { count: number; reason: string }>;

const ALLOW_RAW_SELECT: Allowed = {
  "packages/ui/src/controls.tsx": { count: 1, reason: "the shared Select primitive itself" },
};

const ALLOW_RAW_INPUT: Allowed = {
  "packages/ui/src/controls.tsx": { count: 1, reason: "the shared TextInput primitive itself" },
  "apps/web/src/ui/page.tsx": { count: 1, reason: "the in-place editor of a page title, drawn at the heading's own size and weight" },
  "apps/web/src/CommandPalette.tsx": { count: 1, reason: "the palette's top band IS the field; a second chrome inside the panel is noise" },
  "apps/web/src/concepts/ConceptPicker.tsx": { count: 1, reason: "the typing cursor inside a token field: chips and input share one box" },
  "packages/qt-mcq/src/ui.tsx": { count: 1, reason: "the radio or checkbox of a choice, its type decided at run time (a box drawn over it)" },
  "packages/qt-categorize/src/Editor.tsx": { count: 1, reason: "a column title edited in place on the board (borderless until hovered)" },
};

/** Every file whose found count differs from its allowance (a file with no entry is allowed none). */
function beyondAllowance(allow: Allowed, found: Map<string, number[]>): string[] {
  const out: string[] = [];
  for (const path of new Set([...found.keys(), ...Object.keys(allow)])) {
    const lines = found.get(path) ?? [];
    const allowed = allow[path]?.count ?? 0;
    if (lines.length !== allowed) out.push(`${path}: ${lines.length} found, ${allowed} allowed (lines ${lines.join(", ") || "none"})`);
  }
  return out;
}

/** The lines of each file where `find` reports a raw element, by path. */
function foundBy(files: { path: string; src: string }[], find: (src: string) => number[]): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const { path, src } of files) {
    const lines = find(src);
    if (lines.length > 0) found.set(path, lines);
  }
  return found;
}

const NATIVE_TYPES = new Set(["checkbox", "radio", "file", "range", "hidden", "submit"]);

/** The value of the `className` prop of an opening tag: a string, or the braces matched like `tagsOf` does. */
function classNameOf(tag: string): string {
  const m = /\bclassName=/.exec(tag);
  if (!m) return "";
  const start = m.index + m[0].length;
  if (tag[start] === '"') return tag.slice(start + 1, tag.indexOf('"', start + 1));
  if (tag[start] !== "{") return "";
  let depth = 0;
  let quote = "";
  for (let i = start; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return tag.slice(start + 1, i);
  }
  return tag.slice(start + 1);
}

/** Components whose height and radius come from the scale. */
const SCALE_TAGS = "TextInput|Select|Field|SearchInput|NumberField|Button";
// `:` leads too, so a variant (`sm:h-8`, `hover:rounded-full`) is a violation as well.
const LITERAL_HEIGHT = /(?:^|[\s"'`{(:])(?:h-(?:\d|\[|px|full|auto|screen|fit|min|max)|rounded-full)/;

describe("control scale guard rail (ADR-094)", () => {
  const files = sourceFiles().map((path) => ({ path, src: blankComments(readFileSync(join(ROOT, path), "utf8")) }));

  it("scans the app and every package", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.path.startsWith("packages/qt-short/"))).toBe(true);
    expect(files.some((f) => f.path.startsWith("apps/web/"))).toBe(true);
  });

  it("has no raw <select> beside the shared Select", () => {
    expect(beyondAllowance(ALLOW_RAW_SELECT, foundBy(files, (src) => tagsOf(src, "select").map((t) => t.line)))).toEqual([]);
  });

  it("has no raw single-line <input> outside TextInput, Field and SearchInput", () => {
    // `apps/web`'s own Checkbox / RadioRow / Switch are the native ones by type.
    const raw = (src: string): number[] =>
      tagsOf(src, "input")
        .filter(({ tag }) => !NATIVE_TYPES.has(/\btype="(\w+)"/.exec(tag)?.[1] ?? ""))
        .map((t) => t.line);
    expect(beyondAllowance(ALLOW_RAW_INPUT, foundBy(files, raw))).toEqual([]);
  });

  it("writes no <button> by hand from buttonClass(...): Button and LinkButton are the way", () => {
    const bad = files.flatMap(({ path, src }) =>
      path.startsWith("packages/ui/src/") ? [] : tagsOf(src, "button").filter((t) => /\bbuttonClass\(/.test(t.tag)).map((t) => `${path}:${t.line}`),
    );
    expect(bad).toEqual([]);
  });

  it("imports the control primitives of apps/web from its own ui, never from @quiz/ui", () => {
    // `@quiz/ui` has a Button (secondary by default) and a Select with other defaults than the app's.
    const bad = files.flatMap(({ path, src }) => {
      if (!path.startsWith("apps/web/src/") || path.startsWith("apps/web/src/ui/")) return [];
      const guarded = /\b(?:Button|Select|IconButton|TextInput)\b/;
      // `import { … }` and `export { … } from`, then `import * as x` and `export *`: all reach the same names.
      const named = [...src.matchAll(/\b(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@quiz\/ui"/g)].filter((m) =>
        guarded.test((m[1] ?? "").replace(/\bButtonSize\b|\bButtonVariant\b/g, "")),
      );
      const whole = [...src.matchAll(/\b(?:import\s*\*\s*as\s+\w+|export\s*\*(?:\s*as\s+\w+)?)\s*from\s*"@quiz\/ui"/g)];
      return [...named, ...whole].map((m) => `${path}:${src.slice(0, m.index).split("\n").length}`);
    });
    expect(bad).toEqual([]);
  });

  it("writes no rounded-full and no literal height beside the scale", () => {
    const bad: string[] = [];
    for (const { path, src } of files) {
      // The primitives define the scale; the gallery measures it.
      if (path === "packages/ui/src/styles.ts" || path.startsWith("apps/web/src/devgallery/") || path === "apps/web/src/DevGallery.tsx") continue;
      for (const { tag, line } of tagsOf(src, SCALE_TAGS)) {
        const classes = classNameOf(tag);
        if (LITERAL_HEIGHT.test(classes) || (/^<TextInput\b/.test(tag) && /(?:^|[\s"'`{(:])rounded-/.test(classes))) bad.push(`${path}:${line}`);
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
