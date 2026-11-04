/**
 * A schematic as a printed figure (ADR-126 §1): the same drawing as
 * `SchematicView.tsx` — the box, its ports, the wires, the junctions, the
 * parts with their designators and values — written as a closed `Drawing` of
 * `@quiz/docexport`, never as markup. Pure: no React, no DOM, nothing of
 * `canvasStyles` (whose classes are the screen's); it composes the geometry
 * the editor itself draws with (`symbols.ts`, `geometry.ts`, `router.ts`) and
 * reaches the API through the server entry.
 *
 * The screen's semantic colours become the drawing's closed paints: the ink
 * is `ink`, the box outline `grey`, a hollow body is filled with `paper`, the
 * grid `faint`. The sizes are the screen's, in canvas units.
 */
import type { Drawing, DrawingItem, Matrix } from "@quiz/docexport";
import { PX_MM } from "@quiz/docexport/typst";

import { GRID, MAJOR } from "../library.js";
import type { Orientation } from "../schema.js";

import { fitView, pinPosition, portPosition, transform } from "./geometry.js";
import { junctionPoints, pathOf, withRoutes } from "./router.js";
import type { CanvasComponent, CanvasSchematic, SchematicLibrary } from "./schematicLibrary.js";
import type { SymbolShape, SymbolSpec } from "./symbols.js";

/** The printed size of one grid cell, in millimetres: a 40 × 25 box prints 160 × 100 mm (ADR-126 §5). */
export const CELL_MM = 4;

/**
 * Text sizes, in canvas units: a symbol's own text as on screen (15 px,
 * `symbolText`); a designator or a port a little larger than the screen's
 * 11 px, which prints under 7 pt at {@link CELL_MM} per cell.
 */
const LABEL_SIZE = 13;
const SYMBOL_TEXT_SIZE = 15;

/** One piece of a symbol, painted as `shapeClass` paints it on screen. */
function shapeItem(shape: SymbolShape): DrawingItem {
  switch (shape.paint) {
    case "thick":
      return { kind: "path", d: shape.d, width: 2.6 };
    case "hollow":
      return { kind: "path", d: shape.d, fill: "paper", width: 1.7 };
    case "solid":
      return { kind: "path", d: shape.d, fill: "ink", width: 1.2 };
    default:
      return { kind: "path", d: shape.d, width: 1.7 };
  }
}

/**
 * A symbol placed at `(x, y)` and turned by `m`: its shapes under the
 * transform, its `+`/`−` marks and its texts upright, as the screen keeps them.
 */
function symbolItems(symbol: SymbolSpec, m: Orientation, x: number, y: number): DrawingItem[] {
  const matrix: Matrix = [m[0], m[1], m[2], m[3], x, y];
  return [
    { kind: "g", transform: matrix, items: symbol.shapes.map(shapeItem) },
    ...symbol.marks.map((mark): DrawingItem => {
      const [mx, my] = transform(m, mark.x, mark.y);
      const px = x + mx;
      const py = y + my;
      return { kind: "path", d: `M${px - 3.5} ${py}h7${mark.sign === "+" ? `M${px} ${py - 3.5}v7` : ""}`, width: 1.4 };
    }),
    ...(symbol.texts ?? []).map((text): DrawingItem => {
      const [tx, ty] = transform(m, text.x, text.y);
      return { kind: "text", x: x + tx, y: y + ty, text: text.text, anchor: "middle", baseline: "middle", size: SYMBOL_TEXT_SIZE };
    }),
  ];
}

/** The designator and the value at the part's label anchor, placed as `ComponentGlyph` places them. */
function labelItem(component: CanvasComponent, library: SchematicLibrary): DrawingItem | null {
  const at = library.part(component.kind).label_at;
  if (at === null) return null;
  const [lx, ly] = transform(component.m, at[0], at[1]);
  const text = component.value === "" ? component.name : `${component.name} ${component.value}`;
  const base = { kind: "text" as const, text, size: LABEL_SIZE };
  if (Math.abs(lx) > Math.abs(ly)) {
    return { ...base, x: component.x + lx, y: component.y + ly, anchor: lx > 0 ? "start" : "end", baseline: "middle" };
  }
  return { ...base, x: component.x + lx, y: component.y + ly + (ly > 0 ? 0.8 * LABEL_SIZE : 0), anchor: "middle" };
}

/** `"c1:0"` for every pin a wire ends on: the wire draws it, not a pin dot. */
function connectedPins(schematic: CanvasSchematic): Set<string> {
  const set = new Set<string>();
  for (const w of schematic.wires) {
    for (const e of [w.a, w.b]) if (e.kind === "pin") set.add(`${e.c}:${e.p}`);
  }
  return set;
}

function componentItems(component: CanvasComponent, library: SchematicLibrary, connected: ReadonlySet<string>): DrawingItem[] {
  const pins = library.part(component.kind).pins.flatMap((_, i): DrawingItem[] => {
    const q = pinPosition(component, i, library);
    if (q === null || connected.has(`${component.id}:${i}`)) return [];
    return [{ kind: "ellipse", cx: q.x, cy: q.y, rx: 2.6, ry: 2.6, fill: "paper", width: 1.2 }];
  });
  const label = labelItem(component, library);
  return [
    ...symbolItems(library.symbol(component.kind, component.name), component.m, component.x, component.y),
    ...pins,
    ...(label === null ? [] : [label]),
  ];
}

/** The library's ports on the border, their names inside the box (`Ports`). */
function portItems(library: SchematicLibrary): DrawingItem[] {
  return library.ports.flatMap(({ name }): DrawingItem[] => {
    const q = portPosition(name, library);
    const right = q.x > library.box.width / 2;
    return [
      { kind: "ellipse", cx: q.x, cy: q.y, rx: 4.5, ry: 4.5, fill: "paper", width: 1.4 },
      { kind: "text", x: right ? q.x - 9 : q.x + 9, y: q.y - 8, text: name, anchor: right ? "end" : "start", size: LABEL_SIZE },
    ];
  });
}

/** The box's grid, minor and major lines, as `GridDefs` draws it inside the box. */
function gridItems(box: SchematicLibrary["box"]): DrawingItem[] {
  const lines: DrawingItem[] = [];
  for (let x = GRID; x < box.width; x += GRID) {
    const major = (x / GRID) % MAJOR === 0;
    lines.push({ kind: "line", x1: x, y1: 0, x2: x, y2: box.height, stroke: "faint", width: major ? 0.8 : 0.35 });
  }
  for (let y = GRID; y < box.height; y += GRID) {
    const major = (y / GRID) % MAJOR === 0;
    lines.push({ kind: "line", x1: 0, y1: y, x2: box.width, y2: y, stroke: "faint", width: major ? 0.8 : 0.35 });
  }
  return lines;
}

export interface FigureOptions {
  /** Draw the box's grid (a key's figure); a starter under a ruled frame has the frame's own. */
  grid?: boolean;
}

/**
 * The schematic as the read-only view draws it: one grid cell of margin
 * around the box (`fitView`). The stored `points` are drawn; a wire stored
 * without them is routed as the editor would (`withRoutes`).
 */
export function schematicFigure(schematic: CanvasSchematic, library: SchematicLibrary, options: FigureOptions = {}): Drawing {
  const routed = schematic.wires.some((w) => w.points.length < 2) ? withRoutes(schematic, library) : schematic;
  const routes = new Map(routed.wires.map((w) => [w.id, w.points] as const));
  const connected = connectedPins(routed);
  const fit = fitView(library.box);
  return {
    viewBox: [fit.x, fit.y, fit.w, fit.h],
    items: [
      ...(options.grid === true ? gridItems(library.box) : []),
      { kind: "rect", x: 0, y: 0, w: library.box.width, h: library.box.height, stroke: "grey", width: 1.2 },
      ...routed.wires.flatMap((w): DrawingItem[] => (w.points.length < 2 ? [] : [{ kind: "path", d: pathOf(w.points), width: 1.7 }])),
      ...junctionPoints(routed, routes, library).map(
        ([x, y]): DrawingItem => ({ kind: "ellipse", cx: x, cy: y, rx: 3.6, ry: 3.6, stroke: "none", fill: "ink" }),
      ),
      ...routed.components.flatMap((c) => componentItems(c, library, connected)),
      ...portItems(library),
    ],
  };
}

/**
 * `figure` at {@link CELL_MM} per grid cell when printed at one drawing unit
 * per CSS pixel — the fixed scale of a frame's starter (ADR-126 §4) — with
 * its top left at the origin, so the box sits one cell inside the frame and
 * every grid point of the box on a line of the frame's ruling.
 */
export function atCellScale(figure: Drawing): Drawing {
  const s = CELL_MM / (GRID * PX_MM);
  const [x, y, w, h] = figure.viewBox;
  return {
    viewBox: [0, 0, w * s, h * s],
    items: [{ kind: "g", transform: [s, 0, 0, s, -x * s, -y * s], items: figure.items }],
  };
}

/** The width of a printed schematic figure, in millimetres: {@link CELL_MM} per cell, the margin included. */
export const figureWidthMm = (library: SchematicLibrary): number => (library.box.width / GRID + 2) * CELL_MM;

/** The height of a schematic figure, or of the frame it is drawn in, in millimetres. */
export const figureHeightMm = (library: SchematicLibrary): number => (library.box.height / GRID + 2) * CELL_MM;

/** The cells of a palette figure: this many in a row at most, each this size in drawing units. */
const PALETTE = { columns: 7, cell: 110, symbol: 80, mm: 24 } as const;

/**
 * The parts a student may place, one symbol per cell with its code under it
 * (`R`, `GND`, `AND`): a palette on paper, worded in no language.
 */
export function paletteFigure(entries: readonly { kind: string; code: string }[], library: SchematicLibrary): Drawing {
  const columns = Math.max(1, Math.min(PALETTE.columns, entries.length));
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const items = entries.flatMap(({ kind, code }, i): DrawingItem[] => {
    const symbol = library.symbol(kind, code);
    const [vx, vy, vw, vh] = symbol.viewBox.split(/\s+/).map(Number) as [number, number, number, number];
    const s = Math.min(1, PALETTE.symbol / vw, (PALETTE.symbol * 0.8) / vh);
    const cx = (i % columns) * PALETTE.cell + PALETTE.cell / 2;
    const top = Math.floor(i / columns) * PALETTE.cell;
    const cy = top + PALETTE.symbol / 2 + 4;
    return [
      {
        kind: "g",
        transform: [s, 0, 0, s, cx - (vx + vw / 2) * s, cy - (vy + vh / 2) * s],
        items: symbolItems(symbol, [1, 0, 0, 1], 0, 0),
      },
      { kind: "text", x: cx, y: top + PALETTE.cell - 14, text: code, anchor: "middle", size: 13 },
    ];
  });
  return { viewBox: [0, 0, columns * PALETTE.cell, rows * PALETTE.cell], items };
}

/** The printed width of a palette figure of `count` entries, in millimetres. */
export const paletteWidthMm = (count: number): number => Math.max(1, Math.min(PALETTE.columns, count)) * PALETTE.mm;
