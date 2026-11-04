/**
 * A scene as a printed figure (ADR-126 §1): the primitives of `paint.ts`,
 * each role given a paint of the document's closed drawing model. Pure, no
 * React: the API prints through `@quiz/diagram/server`.
 *
 * The layout is measured in the one font a figure is printed in, DejaVu Sans
 * Mono (ADR-126 §2), so a box is as wide as its text on paper. Its
 * typography is not the screen's: the boxes may be a little wider.
 */
import type { Drawing, DrawingItem, Paints, Paint } from "@quiz/docexport";

import { FACE_PX, GRID, drawOrder, type Measure } from "./geometry.js";
import type { DiagramKind } from "./kinds.js";
import { bounds, layout } from "./layout.js";
import { paintLink, paintNode, type Prim, type ShapeRole, type TextRole } from "./paint.js";
import type { Scene } from "./scene.js";

/** DejaVu Sans Mono's advance, in em: every face, bold and oblique included. */
export const MONO_ADVANCE = 0.602;

/** The width of a text printed at `size`. */
const monoWidth = (text: string, size: number): number => [...text].length * size * MONO_ADVANCE;

/** The width of a text as printed. */
export const monoMeasure: Measure = (face, text) => monoWidth(text, FACE_PX[face]);

/** How each shape role is painted. */
const SHAPE_PAINT: Readonly<Record<ShapeRole, Paints>> = {
  shape: { stroke: "ink", fill: "paper", width: 1.5 },
  outline: { stroke: "ink", fill: "none", width: 1.5 },
  thin: { stroke: "ink", fill: "none", width: 1.1 },
  ink: { stroke: "ink", fill: "none", width: 1.6 },
  dot: { stroke: "none", fill: "ink" },
  card: { stroke: "none", fill: "paper" },
  // The screen's tinted header is plain paper: a starter's grey name stays legible on it.
  header: { stroke: "none", fill: "paper" },
  frame: { stroke: "ink", fill: "none", width: 1.4 },
  line: { stroke: "ink", fill: "none", width: 1.6 },
  headOpen: { stroke: "ink", fill: "none", width: 1.6 },
  headSolid: { stroke: "ink", fill: "ink", width: 1.6 },
  headHollow: { stroke: "ink", fill: "paper", width: 1.6 },
};

/** How each text role is set; a size off a face is the screen's class (`editor/styles.ts`). */
const TEXT_SET: Readonly<Record<TextRole, { size: number; bold?: true; italic?: true; fill?: Paint }>> = {
  name: { size: FACE_PX.name, bold: true },
  frameName: { size: 13, bold: true },
  stereo: { size: FACE_PX.stereo, fill: "grey" },
  member: { size: FACE_PX.mono },
  label: { size: FACE_PX.label },
  lineLabel: { size: 12, italic: true },
  lineLabelMono: { size: 11.5 },
};

const DASH = [7, 5] as const;

/** One primitive as items of a drawing: a link's label on a paper ground, a member's underline drawn. */
function printed(p: Prim): DrawingItem[] {
  if (p.el === "text") {
    const set = TEXT_SET[p.role];
    const width = monoWidth(p.text, set.size);
    const x0 = p.anchor === "middle" ? p.x - width / 2 : p.anchor === "end" ? p.x - width : p.x;
    const ground: DrawingItem[] =
      p.role === "lineLabel" || p.role === "lineLabelMono"
        ? [{ kind: "rect", x: x0 - 2, y: p.y - set.size * 0.8, w: width + 4, h: set.size, stroke: "none", fill: "paper" }]
        : [];
    const text: DrawingItem = {
      kind: "text",
      x: p.x,
      y: p.y,
      text: p.text,
      size: set.size,
      ...(p.anchor === "middle" || p.anchor === "end" ? { anchor: p.anchor } : {}),
      ...(set.bold ? { weight: "bold" as const } : {}),
      ...(set.italic || p.italic === true ? { italic: true } : {}),
      ...(set.fill ? { fill: set.fill } : {}),
    };
    const underline: DrawingItem[] =
      p.underline === true ? [{ kind: "line", x1: x0, y1: p.y + 2, x2: x0 + width, y2: p.y + 2, width: 0.8 }] : [];
    return [...ground, text, ...underline];
  }
  const paints: Paints = { ...SHAPE_PAINT[p.role], ...(p.el === "path" && p.dashed === true ? { dash: DASH } : {}) };
  switch (p.el) {
    case "path":
      return [{ kind: "path", d: p.d, ...paints }];
    case "rect":
      return [{ kind: "rect", x: p.x ?? 0, y: p.y ?? 0, w: p.w, h: p.h, ...(p.rx === undefined ? {} : { rx: p.rx }), ...paints }];
    case "ellipse":
      return [{ kind: "ellipse", cx: p.cx, cy: p.cy, rx: p.rx, ry: p.ry, ...paints }];
    case "circle":
      return [{ kind: "ellipse", cx: p.cx, cy: p.cy, rx: p.r, ry: p.r, ...paints }];
  }
}

/** Room around the content, in canvas units: an initial arrow or a loop goes beyond an element. */
const MARGIN = 40;

const down = (v: number): number => Math.floor(v / GRID) * GRID;
const up = (v: number): number => Math.ceil(v / GRID) * GRID;

/**
 * The figure of `scene` drawn as `kind` (ADR-126 §1), framed on its content
 * with a margin; `null` when the scene is empty. The frame's corners are on
 * the editor's grid, so a figure printed at one unit per pixel on a grid of
 * {@link GRID} pixels keeps its elements on the printed lines (ADR-126 §4).
 */
export function figure(scene: Scene, kind: DiagramKind): Drawing | null {
  const lay = layout(scene, kind, monoMeasure);
  const box = bounds(lay);
  if (box === null) return null;
  const x0 = down(box.x0 - MARGIN);
  const y0 = down(box.y0 - MARGIN);
  const items: DrawingItem[] = drawOrder(scene.nodes).map((n) => ({
    kind: "g",
    transform: [1, 0, 0, 1, n.x, n.y],
    items: paintNode(n, monoMeasure).flatMap(printed),
  }));
  for (const link of scene.links) {
    const route = lay.routes.get(link.id);
    if (route) items.push(...paintLink(link, route).flatMap(printed));
  }
  return { viewBox: [x0, y0, up(box.x1 + MARGIN) - x0, up(box.y1 + MARGIN) - y0], items };
}
