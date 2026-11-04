/**
 * The blocks both canvas types of this package print (ADR-126): a schematic
 * drawn as a figure, the squared frame a student draws in, the palette of
 * what they may place, and their own answer. `circuit` and `logic` differ
 * only by the library they pass.
 */
import { answerZone, drawing, labelled, markdown, type Block, type Labels } from "@quiz/docexport";

import { atCellScale, CELL_MM, designation, figureSizeMm, paletteFigure, paletteWidthMm, schematicFigure } from "./figure.js";
import type { CanvasSchematic, SchematicLibrary } from "./schematicLibrary.js";

/** A schematic as a figure at the frame's scale, with its grid, its parts named in its alt text. */
export function schematicBlock(schematic: CanvasSchematic, library: SchematicLibrary, labels: Labels): Block {
  const parts = schematic.components.map(designation).join(", ");
  return drawing(schematicFigure(schematic, library, { grid: true }), parts === "" ? labels.schematic : labelled(labels, labels.schematic, parts), {
    widthMm: figureSizeMm(library).width,
  });
}

/** A student's schematic, or the sentence that says there is none when `isEmpty`. */
export const drawnAnswer = (schematic: CanvasSchematic, library: SchematicLibrary, labels: Labels, isEmpty: boolean): Block =>
  isEmpty ? markdown(labels.noAnswer) : schematicBlock(schematic, library, labels);

/** The squared frame a student draws in, the `starter` (the box, its fixed parts) drawn grey under it. */
export function canvasZone(starter: CanvasSchematic, library: SchematicLibrary): Block {
  return answerZone("free", {
    heightMm: figureSizeMm(library).height,
    ruling: { kind: "grid", pitchMm: CELL_MM },
    underlay: atCellScale(schematicFigure(starter, library)),
  });
}

/** What a student may place, one symbol per entry with its code; `alt` names the list, which the statement words. */
export function paletteBlock(entries: readonly { kind: string; code: string }[], library: SchematicLibrary, alt: string): Block {
  return drawing(paletteFigure(entries, library), alt, { widthMm: paletteWidthMm(entries.length) });
}
