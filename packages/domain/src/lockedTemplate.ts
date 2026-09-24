/**
 * Locked regions of a code template (docs/04 §4.7, PLAN-MVP §2.4, invariant 14).
 *
 * A line is a marker if and only if, once the leading whitespace and the
 * language's line-comment prefix are stripped, it equals `@@lock`, or
 * `@@endlock` / `@@unlock` (synonyms: teachers naturally write the second
 * one, and reading it as code used to lock the whole tail of the file).
 * Markers are COMMENTS and stay inside the locked text, so the assembled
 * source still compiles.
 *
 * The source sent to the runner is always rebuilt here from the stored
 * template plus the student's editable regions — client text is never accepted
 * for a locked segment.
 */
import type { RunnerLanguage } from "@quiz/core/server";

/**
 * The languages a template may be written in: the runner's, minus `spice`
 * (a netlist has no editable regions; it serves the `circuit` type only).
 * `@quiz/qt-code`'s `CodeLanguage` is checked equal to this at compile time.
 */
export type TemplateLanguage = Exclude<RunnerLanguage, "spice">;

/**
 * The comment prefixes a marker may hide behind, per language. The FIRST one
 * is the language's line comment, the one {@link markerLine} writes.
 */
const LINE_COMMENT: Record<TemplateLanguage, readonly string[]> = {
  c: ["//", "/*"],
  cpp: ["//", "/*"],
  js: ["//", "/*"],
  rust: ["//"],
  python: ["#"],
};

export const LOCK_MARKER = "@@lock";
export const ENDLOCK_MARKER = "@@endlock";
/** A synonym of {@link ENDLOCK_MARKER}, accepted everywhere a template is split. */
export const UNLOCK_MARKER = "@@unlock";
/**
 * The separator between the pieces of a reference solution (`@quiz/qt-code`'s
 * `reference.ts`). Recognised here so the package has one matcher; it means
 * nothing in a template, where it is reported as an unknown marker.
 */
export const NEXT_MARKER = "@@next";

/** What a marker line means once its synonyms are folded. */
export type TemplateMarker = "lock" | "endlock" | "next";

const MARKER_MEANING: Readonly<Record<string, TemplateMarker>> = {
  lock: "lock",
  endlock: "endlock",
  unlock: "endlock",
  next: "next",
};

/**
 * THE marker matcher — the only regex that recognises a marker, in this
 * package or in `@quiz/qt-code`. A marker-LOOKING line: optional indentation,
 * an optional comment prefix (any language's; the caller's language narrows
 * it), `@@word`, an optional `*\/` closing a block comment, nothing else. The
 * word is captured whether it is known or not, so a typo (`@@unlok`) can be
 * reported instead of silently read as code.
 */
const MARKER_LINE = /^\s*(\/\/|\/\*|#)?\s*@@([A-Za-z][\w-]*)\s*(?:\*\/)?\s*$/;

/**
 * The word of a marker-looking line (`"unlok"` for `// @@unlok`), or null for
 * ordinary code. With a language, only that language's comment prefixes
 * count (`# @@lock` is code in C); without one, any of them does — the
 * cosmetic, language-free reading of the display helpers.
 */
export function markerWordOf(line: string, language?: TemplateLanguage): string | null {
  const found = MARKER_LINE.exec(line);
  if (found === null) return null;
  const prefix = found[1];
  if (prefix !== undefined && language !== undefined && !LINE_COMMENT[language].includes(prefix)) {
    return null;
  }
  return found[2]!;
}

/** The marker this line carries (synonyms folded), or null when it is code or an unknown word. */
export function markerOf(line: string, language?: TemplateLanguage): TemplateMarker | null {
  const word = markerWordOf(line, language);
  return word === null ? null : (MARKER_MEANING[word] ?? null);
}

/** A marker line in the language's own line-comment syntax: `// @@lock`, `# @@endlock`. */
export function markerLine(marker: "lock" | "endlock", language: TemplateLanguage): string {
  return `${LINE_COMMENT[language][0]!} ${marker === "lock" ? LOCK_MARKER : ENDLOCK_MARKER}`;
}

export interface TemplateSegment {
  kind: "locked" | "editable";
  /** 0-based position among the EDITABLE segments; `null` for a locked one. */
  index: number | null;
  text: string;
}

/** The number of editable regions an answer must carry for this template. */
export function regionCount(template: string, language: TemplateLanguage): number {
  return splitTemplate(template, language).filter((s) => s.kind === "editable").length;
}

/** Thrown when an answer does not carry exactly one string per editable region. */
export class TemplateRegionMismatch extends Error {
  readonly code = "template_region_mismatch";

  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`template has ${expected} editable region(s), got ${received}`);
    this.name = "TemplateRegionMismatch";
  }
}

/**
 * Splits the template into alternating locked and editable segments.
 * Concatenating the segment texts reproduces the template byte for byte.
 * A template with no marker is entirely editable: one region.
 */
export function splitTemplate(template: string, language: TemplateLanguage): TemplateSegment[] {
  const lines = template.split("\n");
  // A template ending with a newline splits into a trailing empty piece; it
  // must not become a phantom editable region.
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const segments: TemplateSegment[] = [];
  let locked = false;
  let editableIndex = 0;

  for (let i = 0; i < count; i++) {
    const text = i === lines.length - 1 ? lines[i]! : `${lines[i]!}\n`;
    // `@@next` (and any unknown word) is ordinary text in a template.
    const marker = markerOf(lines[i]!, language);
    if (marker === "lock") locked = true;
    const kind: TemplateSegment["kind"] = locked ? "locked" : "editable";
    if (marker === "endlock") locked = false;

    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind) {
      last.text += text;
    } else {
      segments.push({ kind, index: kind === "editable" ? editableIndex++ : null, text });
    }
  }

  return segments;
}

/**
 * Rebuilds the compilable source from the template and the student's regions.
 * Throws {@link TemplateRegionMismatch} when the answer does not fit the
 * template: a stale answer is never silently pasted into the wrong hole.
 */
export function assembleSource(
  template: string,
  language: TemplateLanguage,
  regions: readonly string[],
): string {
  const segments = splitTemplate(template, language);
  const expected = segments.filter((s) => s.kind === "editable").length;
  if (regions.length !== expected) throw new TemplateRegionMismatch(expected, regions.length);

  return segments
    .map((segment) => {
      if (segment.kind === "locked") return segment.text;
      const region = regions[segment.index!]!;
      // The region takes the place of a block of whole lines: if the template
      // ended that block with a line break, the rebuilt source must too, or the
      // next locked line would be glued to the student's last line.
      const needsBreak = segment.text.endsWith("\n") && region !== "" && !region.endsWith("\n");
      return needsBreak ? `${region}\n` : region;
    })
    .join("");
}

/** The editable parts of a template, used to seed a fresh answer. */
export function emptyRegions(template: string, language: TemplateLanguage): string[] {
  return splitTemplate(template, language)
    .filter((s) => s.kind === "editable")
    .map((s) => s.text);
}

/**
 * A marker line the split does not read the way its author meant, found by
 * {@link templateMarkerIssues}. `line` is 1-based, as an editor numbers it;
 * `marker` is the text to quote back (`@@unlok`).
 *
 * - `unknown`: a marker-looking comment whose word is none of `@@lock`,
 *   `@@endlock`, `@@unlock` — it is read as code;
 * - `unopened`: an `@@endlock` / `@@unlock` with no lock open — it closes
 *   nothing, and itself stays editable;
 * - `nested`: an `@@lock` inside an already open lock — it opens nothing.
 *
 * A lock left open until the end of the file is NOT an issue: the tail of the
 * file is locked, which is a legitimate template.
 */
export interface TemplateMarkerIssue {
  line: number;
  kind: "unknown" | "unopened" | "nested";
  marker: string;
}

/** The marker issues of a template, in line order. Pure; walks the lines exactly as {@link splitTemplate} does. */
export function templateMarkerIssues(template: string, language: TemplateLanguage): TemplateMarkerIssue[] {
  const issues: TemplateMarkerIssue[] = [];
  let locked = false;
  template.split("\n").forEach((text, i) => {
    const word = markerWordOf(text, language);
    if (word === null) return;
    const marker = `@@${word}`;
    const meaning = MARKER_MEANING[word];
    if (meaning === "lock") {
      if (locked) issues.push({ line: i + 1, kind: "nested", marker });
      locked = true;
    } else if (meaning === "endlock") {
      if (!locked) issues.push({ line: i + 1, kind: "unopened", marker });
      locked = false;
    } else {
      issues.push({ line: i + 1, kind: "unknown", marker });
    }
  });
  return issues;
}

/** Main file name expected by the runner for each language. */
export function mainFileName(language: TemplateLanguage): string {
  switch (language) {
    case "c":
      return "main.c";
    case "cpp":
      return "main.cpp";
    case "python":
      return "main.py";
    case "js":
      return "main.js";
    case "rust":
      return "main.rs";
  }
}
