/**
 * Display helpers for a split template.
 *
 * The authoritative split is `splitTemplate` in `@quiz/domain/lockedTemplate`;
 * nothing here decides what is locked. These helpers only answer a rendering
 * question: the marker lines are comments that must survive into the compiled
 * source, so they stay in the stored template — but showing `// @@lock` to a
 * student is noise, so the player hides them (PLAN-MVP §2.4).
 */
import { markerOf as domainMarkerOf, splitTemplate, type TemplateMarker } from "@quiz/domain/lockedTemplate";

import type { CodeLanguage, CodeSegment } from "./schema.js";

/**
 * `@@lock` and `@@endlock` (or its synonym `@@unlock`) delimit the locked
 * regions of a template; `@@next` separates the pieces of a reference
 * solution (`./reference.ts`). All of them are recognised by THE matcher,
 * `markerOf` in `@quiz/domain/lockedTemplate` — this package never writes a
 * second regex that could drift from the one the server splits with.
 */
export type Marker = TemplateMarker;

/**
 * The marker this line carries, or null when it is ordinary code.
 * Deliberately language-agnostic (the domain's matcher without a language):
 * this is a cosmetic filter, and a `#` line inside a C template that reads
 * exactly `# @@lock` is not a case worth a second lookup.
 */
export const markerOf = (line: string): Marker | null => domainMarkerOf(line);

/**
 * A template marker line. `@@next` is NOT one: it never appears in a
 * template, only in a reference solution, and hiding it from the player would
 * be hiding nothing.
 */
export const isMarkerLine = (line: string): boolean => {
  const marker = markerOf(line);
  return marker === "lock" || marker === "endlock";
};

/** The separator between two pieces of a reference solution. */
export const isNextMarkerLine = (line: string): boolean => markerOf(line) === "next";

/** The same text without its marker lines, for display only. */
export function stripMarkerLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !isMarkerLine(line))
    .join("\n");
}

/** Drops a single trailing newline, so a block does not render an empty last row. */
export const trimTrailingNewline = (text: string): string => text.replace(/\n$/, "");

/** The editable segments, in order. */
export const editableSegments = (segments: readonly CodeSegment[]): CodeSegment[] =>
  segments.filter((s) => s.kind === "editable");

/** The regions a fresh answer starts from: the editable text of the template. */
export const initialRegions = (segments: readonly CodeSegment[]): string[] =>
  editableSegments(segments).map((s) => s.text);

export interface DisplaySegment extends CodeSegment {
  /** The same text, without the marker lines and without a trailing blank row. */
  display: string;
}

/**
 * The template as the player shows it: the authoritative split, plus the
 * marker-free text of each segment.
 */
export function splitForDisplay(template: string, language: CodeLanguage): DisplaySegment[] {
  return splitTemplate(template, language).map((segment) => ({
    ...segment,
    display: trimTrailingNewline(stripMarkerLines(segment.text)),
  }));
}
