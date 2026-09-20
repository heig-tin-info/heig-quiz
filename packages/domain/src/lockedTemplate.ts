/**
 * Locked regions of a code template (docs/04 §4.7, PLAN-MVP §2.4, invariant 14).
 *
 * A line is a marker if and only if, once the leading whitespace and the
 * language's line-comment prefix are stripped, it equals `@@lock` or
 * `@@endlock`. Markers are COMMENTS and stay inside the locked text, so the
 * assembled source still compiles.
 *
 * The source sent to the runner is always rebuilt here from the stored
 * template plus the student's editable regions — client text is never accepted
 * for a locked segment.
 */

export type CodeLanguage = "c" | "cpp" | "python" | "js" | "rust";

const LINE_COMMENT: Record<CodeLanguage, readonly string[]> = {
  c: ["//", "/*"],
  cpp: ["//", "/*"],
  js: ["//", "/*"],
  rust: ["//"],
  python: ["#"],
};

export const LOCK_MARKER = "@@lock";
export const ENDLOCK_MARKER = "@@endlock";

export interface TemplateSegment {
  kind: "locked" | "editable";
  /** 0-based position among the EDITABLE segments; `null` for a locked one. */
  index: number | null;
  text: string;
}

/** The number of editable regions an answer must carry for this template. */
export function regionCount(template: string, language: CodeLanguage): number {
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

function markerOf(line: string, language: CodeLanguage): "lock" | "endlock" | null {
  let body = line.trim();
  for (const prefix of LINE_COMMENT[language]) {
    if (body.startsWith(prefix)) {
      body = body.slice(prefix.length).trim();
      break;
    }
  }
  body = body.replace(/\*\/$/, "").trim();
  if (body === LOCK_MARKER) return "lock";
  if (body === ENDLOCK_MARKER) return "endlock";
  return null;
}

/**
 * Splits the template into alternating locked and editable segments.
 * Concatenating the segment texts reproduces the template byte for byte.
 * A template with no marker is entirely editable: one region.
 */
export function splitTemplate(template: string, language: CodeLanguage): TemplateSegment[] {
  const lines = template.split("\n");
  // A template ending with a newline splits into a trailing empty piece; it
  // must not become a phantom editable region.
  const count = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const segments: TemplateSegment[] = [];
  let locked = false;
  let editableIndex = 0;

  for (let i = 0; i < count; i++) {
    const text = i === lines.length - 1 ? lines[i]! : `${lines[i]!}\n`;
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
  language: CodeLanguage,
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
export function emptyRegions(template: string, language: CodeLanguage): string[] {
  return splitTemplate(template, language)
    .filter((s) => s.kind === "editable")
    .map((s) => s.text);
}

/** Main file name expected by the runner for each language. */
export function mainFileName(language: CodeLanguage): string {
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
