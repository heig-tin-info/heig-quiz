/**
 * The geometry of an element and of a link as primitives, each with the ROLE
 * it plays in the notation (ADR-126 §1): a shape's ink, an outline, a name, a
 * line, a head… Pure, no React and no DOM. Two painters read it: the editor
 * and the view (`editor/shapes.tsx`), which give each role its classes, and
 * the printed figure (`print.ts`), which gives it a paint of the document's
 * closed drawing model. One geometry, so the screen and the paper agree.
 */
import { DIRS } from "@quiz/domain/gridRouter";

import { FINAL_RADIUS, HEAD, INITIAL_RADIUS, PAD, PSEUDO, ROW, bodyCompartments, member, sizeOf, wrapName, wrapWidth, type Measure } from "./geometry.js";
import { CIRCLES, FLOW_NODES, INK, LINK_STYLE, SHAPES } from "./kinds.js";
import type { End, Route } from "./layout.js";
import type { Cardinality, DiagramLink, DiagramNode, LinkType } from "./scene.js";

type XY = readonly [number, number];

/**
 * What a primitive is in the notation. Shapes: `shape` (outlined, filled
 * with the paper), `outline` (no fill), `thin` (a compartment's rule), `ink`
 * (a freehand stroke, an actor), `dot` (a filled disc), `card` and `header`
 * (a class's fills, under its outline), `frame` (a system boundary), `line`
 * (a link), and a head drawn open, solid or hollow. Texts: `name`,
 * `frameName`, `stereo`, `member`, `label` (a name centred in its shape),
 * `lineLabel` and `lineLabelMono` (on a link).
 */
export type ShapeRole = "shape" | "outline" | "thin" | "ink" | "dot" | "card" | "header" | "frame" | "line" | "headOpen" | "headSolid" | "headHollow";
export type TextRole = "name" | "frameName" | "stereo" | "member" | "label" | "lineLabel" | "lineLabelMono";
export type PaintRole = ShapeRole | TextRole;

/** One primitive, in the coordinates of its element (a node) or of the canvas (a link). */
export type Prim =
  | { el: "path"; role: ShapeRole; d: string; dashed?: boolean }
  /** `x` and `y` absent: 0. */
  | { el: "rect"; role: ShapeRole; x?: number; y?: number; w: number; h: number; rx?: number }
  | { el: "ellipse"; role: ShapeRole; cx: number; cy: number; rx: number; ry: number }
  | { el: "circle"; role: ShapeRole; cx: number; cy: number; r: number }
  | {
      el: "text";
      role: TextRole;
      x: number;
      y: number;
      text: string;
      /** Absent: the start, set by no attribute. */
      anchor?: "start" | "middle" | "end";
      italic?: boolean;
      underline?: boolean;
    };

/** A brush stroke, smoothed through the midpoints of its points. */
export function inkPath(pts: readonly XY[]): string {
  if (pts.length < 3) return `M${pts.map((q) => `${q[0]} ${q[1]}`).join("L")}`;
  const first = pts[0] as XY;
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p = pts[i] as XY;
    const q = pts[i + 1] as XY;
    d += `Q${p[0]} ${p[1]} ${(p[0] + q[0]) / 2} ${(p[1] + q[1]) / 2}`;
  }
  const last = pts[pts.length - 1] as XY;
  return `${d}L${last[0]} ${last[1]}`;
}

export const polyline = (pts: readonly XY[]): string => `M${pts.map((q) => `${q[0]} ${q[1]}`).join("L")}`;

/** Centred lines of text, 16 apart, around `cy`. */
function lines(texts: readonly string[], x: number, cy: number): Prim[] {
  const y0 = cy - (texts.length - 1) * 8 + 4.5;
  return texts.map((text, i) => ({ el: "text", role: "label", x, y: y0 + i * 16, text, anchor: "middle" }));
}

/** An element, in its own coordinates (its top left at 0, 0). */
export function paintNode(n: DiagramNode, measure: Measure): Prim[] {
  const { w, h } = sizeOf(n, measure);
  const mid = w / 2;
  const name = n.name ?? "";
  if (INK.has(n.t)) {
    const pts = n.pts ?? [];
    return [{ el: "path", role: "ink", d: n.t === "stroke" ? inkPath(pts) : polyline(pts) }];
  }
  if (SHAPES.has(n.t)) {
    const shape: Prim =
      n.t === "circle" || n.t === "ellipse"
        ? { el: "ellipse", role: "shape", cx: mid, cy: h / 2, rx: mid, ry: h / 2 }
        : n.t === "triangle"
          ? { el: "path", role: "shape", d: `M${mid} 0L${w} ${h}L0 ${h}Z` }
          : { el: "rect", role: "shape", w, h };
    return [shape, ...(name ? lines([name], mid, n.t === "triangle" ? h * 0.66 : h / 2) : [])];
  }
  if (n.t === "initial") return [{ el: "circle", role: "dot", cx: PSEUDO / 2, cy: PSEUDO / 2, r: INITIAL_RADIUS }];
  if (n.t === "final") {
    return [
      { el: "circle", role: "outline", cx: PSEUDO / 2, cy: PSEUDO / 2, r: FINAL_RADIUS },
      { el: "circle", role: "dot", cx: PSEUDO / 2, cy: PSEUDO / 2, r: FINAL_RADIUS - 4.5 },
    ];
  }
  if (CIRCLES.has(n.t)) {
    return [
      { el: "circle", role: "shape", cx: mid, cy: h / 2, r: mid },
      ...(n.accept ? [{ el: "circle", role: "outline", cx: mid, cy: h / 2, r: mid - 4 } as const] : []),
      ...(n.initial
        ? [
            { el: "path", role: "line", d: `M-30 ${h / 2}H-2` } as const,
            ...paintHead("arrowF", [
              [-30, h / 2],
              [0, h / 2],
            ]),
          ]
        : []),
      ...lines([name], mid, h / 2),
    ];
  }
  if (n.t === "actor") {
    return [
      { el: "path", role: "ink", d: "M20 17V38M8 24H32M20 38L10 54M20 38L30 54" },
      { el: "circle", role: "ink", cx: 20, cy: 10, r: 7 },
      { el: "text", role: "label", x: mid, y: 72, text: name, anchor: "middle" },
    ];
  }
  if (n.t === "usecase") {
    return [{ el: "ellipse", role: "shape", cx: mid, cy: h / 2, rx: mid, ry: h / 2 }, ...lines(wrapName(name, wrapWidth(n), measure), mid, h / 2)];
  }
  if (n.t === "system") {
    return [
      { el: "rect", role: "frame", w, h },
      { el: "text", role: "frameName", x: 12, y: 20, text: name },
    ];
  }
  if (FLOW_NODES.has(n.t)) {
    const shape: Prim =
      n.t === "decision"
        ? { el: "path", role: "shape", d: `M${mid} 0L${w} ${h / 2}L${mid} ${h}L0 ${h / 2}Z` }
        : { el: "rect", role: "shape", w, h, rx: n.t === "terminal" ? h / 2 : 3 };
    return [shape, ...lines(wrapName(name, wrapWidth(n), measure), mid, h / 2)];
  }
  if (n.t === "state") {
    const body = n.body ?? [];
    return [
      { el: "rect", role: "shape", w, h, rx: 10 },
      { el: "text", role: "label", x: mid, y: 25, text: name, anchor: "middle" },
      ...(body.length > 0 ? [{ el: "path", role: "thin", d: `M0 ${HEAD}H${w}` } as const] : []),
      ...body.map((text, i): Prim => ({ el: "text", role: "member", x: 10, y: HEAD + PAD / 2 + i * ROW + 14, text })),
    ];
  }
  return paintBox(n, w, h);
}

/** A class or an entity: a header, then compartments. */
function paintBox(n: DiagramNode, w: number, h: number): Prim[] {
  const entity = n.t === "entity";
  let y = HEAD;
  const seps: string[] = [];
  const texts: Prim[] = [];
  for (const compartment of bodyCompartments(n)) {
    seps.push(`M0 ${y}H${w}`);
    compartment.forEach((raw, i) => {
      const m = member(raw, entity);
      texts.push({ el: "text", role: "member", x: 10, y: y + PAD / 2 + i * ROW + 14, text: m.text, underline: m.underline, italic: m.italic });
    });
    y += compartment.length * ROW + PAD;
  }
  return [
    { el: "rect", role: "card", w, h },
    { el: "rect", role: "header", w, h: HEAD },
    ...(seps.length > 0 ? [{ el: "path", role: "thin", d: seps.join("") } as const] : []),
    { el: "rect", role: "outline", w, h },
    ...(n.stereo ? [{ el: "text", role: "stereo", x: w / 2, y: 16, text: `«${n.stereo}»`, anchor: "middle" } as const] : []),
    { el: "text", role: "name", x: w / 2, y: n.stereo ? 33 : 25, text: n.name ?? "", anchor: "middle", italic: n.abstract === true },
    ...texts,
  ];
}

export type HeadKind = NonNullable<(typeof LINK_STYLE)[LinkType]["head"]>;

/** The head at a line's end, aimed along the two points; nothing for two equal points. */
export function paintHead(kind: HeadKind, aim: readonly [XY, XY]): Prim[] {
  const [p, b] = aim;
  const len = Math.hypot(b[0] - p[0], b[1] - p[1]);
  if (len === 0) return [];
  const ux = (b[0] - p[0]) / len;
  const uy = (b[1] - p[1]) / len;
  const at = (a: number, s: number): string => `${b[0] - ux * a - uy * s} ${b[1] - uy * a + ux * s}`;
  if (kind === "open") return [{ el: "path", role: "headOpen", d: `M${at(12, 6)}L${at(0, 0)}L${at(12, -6)}` }];
  if (kind === "arrowF") return [{ el: "path", role: "headSolid", d: `M${at(0, 0)}L${at(11, 5)}L${at(11, -5)}Z` }];
  if (kind === "tri") return [{ el: "path", role: "headHollow", d: `M${at(0, 0)}L${at(15, 8)}L${at(15, -8)}Z` }];
  return [{ el: "path", role: kind === "diaF" ? "headSolid" : "headHollow", d: `M${at(0, 0)}L${at(10, 6)}L${at(20, 0)}L${at(10, -6)}Z` }];
}

/** Crow's foot at an entity end; `end.d` points away from the entity. */
export function paintCrowFoot(card: string | undefined, end: End): Prim[] {
  if (!card || end.d < 0) return [];
  const u = DIRS[end.d] ?? [1, 0];
  const at = (a: number, s: number): string => `${end.x + u[0] * a - u[1] * s} ${end.y + u[1] * a + u[0] * s}`;
  const bar = (t: number): string => `M${at(t, -6)}L${at(t, 6)}`;
  const many = `M${at(12, 0)}L${at(0, -7)}M${at(12, 0)}L${at(0, 7)}`;
  const ring = (t: number): Prim => ({ el: "circle", role: "headHollow", cx: end.x + u[0] * t, cy: end.y + u[1] * t, r: 4 });
  const c = card as Cardinality;
  const [d, r] = c === "1" ? [bar(7) + bar(13), null] : c === "0..1" ? [bar(7), ring(18)] : c === "1..*" ? [many + bar(16), null] : [many, ring(18)];
  return [{ el: "path", role: "headOpen", d }, ...(r ? [r] : [])];
}

/** Where a label sits off an end leaving right, down, left or up. */
const END_LABEL: Readonly<Record<0 | 1 | 2 | 3, readonly [number, number, "start" | "end"]>> = {
  0: [5, -11, "start"],
  1: [11, 15, "start"],
  2: [-5, -11, "end"],
  3: [11, -6, "start"],
};

const labelRole = (mono: boolean): TextRole => (mono ? "lineLabelMono" : "lineLabel");

/** A multiplicity, or a flowchart's label, set just off an end. */
function endLabel(text: string | undefined, end: End, mono: boolean): Prim[] {
  if (!text || end.d < 0) return [];
  const [dx, dy, anchor] = END_LABEL[end.d as 0 | 1 | 2 | 3];
  return [{ el: "text", role: labelRole(mono), x: end.x + dx, y: end.y + dy, text, anchor }];
}

/** A name on the longest segment of an orthogonal line. */
function midLabel(text: string, pts: readonly XY[], mono: boolean): Prim {
  let best = 0;
  let at = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i] as XY;
    const b = pts[i + 1] as XY;
    const len = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
    if (len > best) {
      best = len;
      at = i;
    }
  }
  const a = pts[at] as XY;
  const b = (pts[at + 1] ?? a) as XY;
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const role = labelRole(mono);
  return a[1] === b[1] ? { el: "text", role, x: mx, y: my - 7, text, anchor: "middle" } : { el: "text", role, x: mx + 8, y: my + 4, text };
}

export type PaintedLink = Pick<DiagramLink, "type"> & Partial<Pick<DiagramLink, "name" | "ma" | "mb">>;

/**
 * A link along its route, in canvas coordinates: the line (its `d` is the
 * route's), the head, the crow's feet, then the labels unless `labels` is
 * false (a toolbox icon).
 */
export function paintLink(link: PaintedLink, route: Route, labels = true): Prim[] {
  const style = LINK_STYLE[link.type];
  const last = route.pts[route.pts.length - 1] as XY;
  const before = route.pts[route.pts.length - 2] ?? last;
  const aim = route.aim ?? ([before, last] as const);
  const mono = style.mono === true;
  const text = style.label ?? link.name;
  const out: Prim[] = [{ el: "path", role: "line", d: linkPath(route), dashed: style.dash }];
  if (style.head) out.push(...paintHead(style.head, aim));
  if (style.crow) out.push(...paintCrowFoot(link.ma, route.a), ...paintCrowFoot(link.mb, route.b));
  if (!labels) return out;
  if (!style.crow) out.push(...endLabel(link.ma, route.a, true), ...endLabel(link.mb, route.b, true));
  if (text) {
    if (route.label) out.push({ el: "text", role: labelRole(mono), x: route.label.x, y: route.label.y + 4, text, anchor: "middle" });
    else if (style.labelAtStart) out.push(...endLabel(text, route.a, mono));
    else out.push(midLabel(text, route.pts, mono));
  }
  return out;
}

/** The SVG path of a route: its curve, or its polyline. */
export const linkPath = (route: Route): string => route.path ?? polyline(route.pts);
