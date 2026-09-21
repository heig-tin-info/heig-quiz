/**
 * The teacher's reference solution, read as REGIONS (docs/spec/04 §4.7).
 *
 * The "try" button of the editor runs the reference against the cases, and
 * the source it runs is rebuilt from the template exactly like a student's
 * (invariant 14): `assembleSource` therefore wants one string per editable
 * region, not one blob. This file is the pure rule that turns the stored
 * `referenceSolution` into that list.
 *
 * The rule:
 *   - the reference is the content of the EDITABLE regions of the template,
 *     in template order;
 *   - with ONE editable region, the whole `referenceSolution` is that region
 *     and nothing is parsed;
 *   - with several, the pieces are separated by a marker LINE `@@next`,
 *     written in the language's comment syntax exactly like `@@lock` and
 *     `@@endlock` — same matcher (`./segments.ts`), so a teacher spells the
 *     three the same way;
 *   - the marker line is dropped and the line breaks that surrounded it go
 *     with it, the way `stripMarkerLines` drops a lock marker;
 *   - a count that does not match the template returns `null`, never a
 *     silently misplaced piece.
 */
import { splitTemplate } from "@quiz/domain";

import type { CodeConfig } from "./schema.js";
import { editableSegments, isNextMarkerLine, trimTrailingNewline } from "./segments.js";

/** How many regions this template expects — the count the player fills. */
export function referenceRegionCount(config: CodeConfig): number {
  return editableSegments(splitTemplate(config.template, config.language)).length;
}

/**
 * The reference solution cut into one string per editable region, or `null`
 * when the cut does not fit the template (the editor turns that into a
 * sentence rather than running a source assembled from the wrong pieces).
 */
export function referenceRegions(config: CodeConfig): string[] | null {
  const expected = referenceRegionCount(config);
  const reference = config.referenceSolution;

  // A template with nothing editable has no region to fill: only an empty
  // reference fits it.
  if (expected === 0) return reference.trim() === "" ? [] : null;

  const lines = reference.split("\n");
  if (!lines.some(isNextMarkerLine)) {
    // No separator: the whole reference is the single region, byte for byte.
    return expected === 1 ? [reference] : null;
  }

  const pieces: string[][] = [[]];
  for (const line of lines) {
    if (isNextMarkerLine(line)) pieces.push([]);
    else pieces[pieces.length - 1]!.push(line);
  }
  // Joining on "\n" already drops the break that opened the marker line; the
  // trailing one is the document's own last empty row.
  const regions = pieces.map((piece) => trimTrailingNewline(piece.join("\n")));
  return regions.length === expected ? regions : null;
}
