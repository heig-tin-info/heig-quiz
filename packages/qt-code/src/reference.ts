/**
 * The teacher's reference solution, read as REGIONS (docs/spec/04 §4.7).
 *
 * The "try" button of the editor runs the reference against the cases, and
 * the source it runs is rebuilt from the template exactly like a student's
 * (invariant 14): `assembleSource` therefore wants one string per editable
 * region, not one blob. The teacher writes it in the student's own locked
 * editor, one region per template region; this file is the pure rule between
 * that list and the stored `referenceSolution` string, in both directions.
 *
 * The storage format:
 *   - the reference is the content of the EDITABLE regions of the template,
 *     in template order;
 *   - with ONE editable region, the whole `referenceSolution` is that region,
 *     byte for byte, and nothing is parsed;
 *   - with several, the pieces are separated by a marker LINE `@@next`,
 *     written in the language's comment syntax exactly like `@@lock` and
 *     `@@endlock` — same matcher (`./segments.ts`). The editor writes it; a
 *     canonical file may write it by hand;
 *   - the marker line is dropped with the line break that closes the piece
 *     before it: a piece is its region WITHOUT the line break its template
 *     region ends with, so writing a list and reading it back is the identity
 *     (the editor would otherwise reload on every keystroke);
 *   - a count that does not match the template returns `null` from
 *     {@link referenceRegions}, never a silently misplaced piece.
 */
import { NEXT_MARKER, splitTemplate } from "@quiz/domain/lockedTemplate";

import type { CodeLanguage, CodeSegment, ProgramConfig } from "./schema.js";
import { editableSegments, isNextMarkerLine } from "./segments.js";

/** What the cut reads: the template, its language and the reference itself. */
type ReferenceSource = Pick<ProgramConfig, "template" | "language" | "referenceSolution">;

/** The `@@next` line in the language's own line comment. */
const NEXT_LINE: Record<CodeLanguage, string> = {
  c: `// ${NEXT_MARKER}`,
  cpp: `// ${NEXT_MARKER}`,
  js: `// ${NEXT_MARKER}`,
  rust: `// ${NEXT_MARKER}`,
  python: `# ${NEXT_MARKER}`,
};

const templateRegions = (config: Pick<ProgramConfig, "template" | "language">): CodeSegment[] =>
  editableSegments(splitTemplate(config.template, config.language));

/** How many regions this template expects — the count the player fills. */
export function referenceRegionCount(config: ReferenceSource): number {
  return templateRegions(config).length;
}

/** A region ends with a line break exactly when its template region does. */
const endsWithBreak = (segment: CodeSegment): boolean => segment.text.endsWith("\n");

const hasNextMarker = (reference: string): boolean => reference.split("\n").some(isNextMarkerLine);

/**
 * The stored text cut on its `@@next` lines, as written: one string per
 * piece, no region count assumed. Without a marker it is one piece.
 */
function pieces(reference: string): string[] {
  const found: string[][] = [[]];
  for (const line of reference.split("\n")) {
    if (isNextMarkerLine(line)) found.push([]);
    else found[found.length - 1]!.push(line);
  }
  return found.map((piece) => piece.join("\n"));
}

/** A stored piece as the region it stands for: the line break it lost comes back. */
const pieceToRegion = (piece: string, segment: CodeSegment): string =>
  endsWithBreak(segment) ? `${piece}\n` : piece;

/**
 * The reference solution cut into one string per editable region, or `null`
 * when the cut does not fit the template (the editor turns that into a
 * sentence rather than running a source assembled from the wrong pieces).
 *
 * A reference never written at all is the template's own editable text —
 * exactly what the reference editor shows before the first keystroke — so
 * "try" on an untouched question runs what the teacher sees.
 */
export function referenceRegions(config: ReferenceSource): string[] | null {
  const regions = templateRegions(config);
  const reference = config.referenceSolution;

  // A template with nothing editable has no region to fill: only an empty
  // reference fits it.
  if (regions.length === 0) return reference.trim() === "" ? [] : null;

  if (reference.trim() === "") return regions.map((segment) => segment.text);

  // One region and no separator: the whole reference, byte for byte.
  if (regions.length === 1 && !hasNextMarker(reference)) return [reference];

  const cut = pieces(reference);
  if (cut.length !== regions.length) return null;
  return cut.map((piece, i) => pieceToRegion(piece, regions[i]!));
}

/** What the reference editor shows, and what it could not place. */
export interface ReferenceEditorView {
  /** One region per editable region of the template. */
  regions: string[];
  /** Stored pieces beyond the template's count; the next write drops them. */
  extra: number;
}

/**
 * The reference as the teacher's locked editor shows it. Unlike
 * {@link referenceRegions} it always fits: a MISSING piece is shown as the
 * template's own editable text, and so is an EMPTY one while `prefillEmpty`
 * holds (the editor turns it off once the teacher has typed, so a region
 * they clear stays cleared). Extra pieces are counted, not shown.
 */
export function referenceEditorView(
  config: ReferenceSource,
  { prefillEmpty }: { prefillEmpty: boolean },
): ReferenceEditorView {
  const regions = templateRegions(config);
  const reference = config.referenceSolution;
  if (regions.length === 0) return { regions: [], extra: 0 };

  const single = regions.length === 1 && !hasNextMarker(reference);
  const cut = single ? [reference] : pieces(reference);

  return {
    regions: regions.map((segment, i) => {
      const piece = cut[i];
      if (piece === undefined || (prefillEmpty && piece.trim() === "")) return segment.text;
      return single ? piece : pieceToRegion(piece, segment);
    }),
    extra: Math.max(0, cut.length - regions.length),
  };
}

/**
 * The stored text for a list of regions, the inverse of
 * {@link referenceRegions}: with several regions, joined by the `@@next`
 * line of the language, each without the line break its template region
 * ends with.
 */
export function joinReference(
  config: Pick<ProgramConfig, "template" | "language">,
  written: readonly string[],
): string {
  const regions = templateRegions(config);
  if (regions.length === 0) return "";
  if (regions.length === 1) return written[0] ?? "";
  return regions
    .map((segment, i) => {
      const region = written[i] ?? "";
      return endsWithBreak(segment) ? region.replace(/\n$/, "") : region;
    })
    .join(`\n${NEXT_LINE[config.language]}\n`);
}
