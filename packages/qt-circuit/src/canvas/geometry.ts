/**
 * The pure geometry of the schematic canvas: orientations, pin positions,
 * bounding boxes, clamping and the screen ↔ world mapping.
 *
 * Nothing here touches React or the DOM, on purpose. jsdom has no layout, so
 * every pointer computation the editor makes is a function of a
 * `DOMRect`-shaped record and the current view box — which is exactly what a
 * unit test can hand it.
 *
 * Coordinates are CANVAS UNITS on the {@link GRID} of 20, the same units the
 * schema stores: `0..box.width` × `0..box.height`, the box of the
 * {@link SchematicLibrary} in use. The router works in grid steps internally
 * and converts back before anything is stored.
 *
 * Every function that reads a part, a port or the box takes the library last.
 * `pinPosition` and `portPosition` default it to `circuit`'s: the router's
 * golden cases (`router.golden.test.ts`) are written against them unchanged.
 */
import { DIRS } from "@quiz/domain/gridRouter";

import { GRID, type PinDirection } from "../library.js";
import type { Orientation } from "../schema.js";

import { CIRCUIT_LIBRARY } from "./circuitLibrary.js";
import type { CanvasComponent, CanvasWireEnd, PartSpec, SchematicLibrary } from "./schematicLibrary.js";

// ---------------------------------------------------------------------------
// Orientations
// ---------------------------------------------------------------------------

/**
 * The eight symmetries of the grid, as SVG matrices `[a, b, c, d]`. They are
 * the closed set the schema accepts, and the products of the three the
 * toolbar applies — the quarter turn {@link ORIENT_90} and the two mirrors
 * {@link MIRROR_X} and {@link MIRROR_Y} — never leave it.
 */
export const ORIENT_0: Orientation = [1, 0, 0, 1];
export const ORIENT_90: Orientation = [0, 1, -1, 0];
export const ORIENT_180: Orientation = [-1, 0, 0, -1];
const ORIENT_270: Orientation = [0, -1, 1, 0];
export const MIRROR_X: Orientation = [-1, 0, 0, 1];
const ORIENT_MIRROR_90: Orientation = [0, -1, -1, 0];
export const MIRROR_Y: Orientation = [1, 0, 0, -1];
const ORIENT_MIRROR_270: Orientation = [0, 1, 1, 0];

/** The eight, in a stable order: four rotations, then the four reflections. */
export const ORIENTATIONS: readonly Orientation[] = [
  ORIENT_0,
  ORIENT_90,
  ORIENT_180,
  ORIENT_270,
  MIRROR_X,
  ORIENT_MIRROR_90,
  MIRROR_Y,
  ORIENT_MIRROR_270,
];

/** Every product of two grid symmetries has entries in {−1, 0, 1} — this narrows it. */
const unit = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** `multiply(T, m)`: apply `T` on top of `m`, in SVG matrix order. */
export function multiply(a: Orientation, b: Orientation): Orientation {
  return [
    unit(a[0] * b[0] + a[2] * b[1]),
    unit(a[1] * b[0] + a[3] * b[1]),
    unit(a[0] * b[2] + a[2] * b[3]),
    unit(a[1] * b[2] + a[3] * b[3]),
  ];
}

/** The local point `(x, y)` turned by `m`, still relative to the origin. */
export function transform(m: Orientation, x: number, y: number): readonly [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

/** The nearest grid multiple. */
export const snap = (v: number): number => Math.round(v / GRID) * GRID;

/** Which of the four axes a (dx, dy) points along; the mockup's convention. */
export function directionOf(dx: number, dy: number): PinDirection {
  if (dx > 0) return 0;
  if (dy > 0) return 1;
  if (dx < 0) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// Pins, ports, rectangles
// ---------------------------------------------------------------------------

/** A wire attachment point: where it is, and which way a wire leaves it. */
export interface PinPoint {
  readonly x: number;
  readonly y: number;
  /** A pin's or a port's outgoing direction; `-1` for a free point or a waypoint. */
  readonly d: PinDirection | -1;
}

/** The placement of a component: everything the geometry needs, nothing more. */
export type Placement = Pick<CanvasComponent, "kind" | "x" | "y" | "m">;

/** Where pin `index` of `component` sits, and which way its wire leaves. `null` for an unknown pin. */
export function pinPosition(
  component: Placement,
  index: number,
  library: SchematicLibrary = CIRCUIT_LIBRARY,
): PinPoint | null {
  const pin = library.part(component.kind).pins[index];
  if (pin === undefined) return null;
  const [x, y] = transform(component.m, pin.x, pin.y);
  const away = DIRS[pin.d];
  if (away === undefined) return null;
  const [dx, dy] = transform(component.m, away[0], away[1]);
  return { x: component.x + x, y: component.y + y, d: directionOf(dx, dy) };
}

/** Where a port sits on the box border; `null` for a port the library does not declare. */
function portAt(port: string, library: SchematicLibrary): PinPoint | null {
  const spec = library.ports.find((p) => p.name === port);
  return spec === undefined ? null : { x: spec.x, y: spec.y, d: spec.d };
}

/** Where a port sits on the box border; its direction points INTO the box. An undeclared port throws. */
export function portPosition(port: string, library: SchematicLibrary = CIRCUIT_LIBRARY): PinPoint {
  const q = portAt(port, library);
  if (q === null) throw new Error(`canvas: unknown port ${port}`);
  return q;
}

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function turnedRect(component: Placement, r: readonly [number, number, number, number]): Rect {
  const [x, y, w, h] = r;
  const a = transform(component.m, x, y);
  const b = transform(component.m, x + w, y + h);
  return {
    x0: component.x + Math.min(a[0], b[0]),
    y0: component.y + Math.min(a[1], b[1]),
    x1: component.x + Math.max(a[0], b[0]),
    y1: component.y + Math.max(a[1], b[1]),
  };
}

/** The component's BODY in world coordinates: what a wire must route around. */
export function rectOf(component: Placement, library: SchematicLibrary): Rect {
  return turnedRect(component, library.part(component.kind).body);
}

/** Body ∪ pins, in LOCAL coordinates. Cached: it only depends on the part. */
const localExtents = new WeakMap<PartSpec, readonly [number, number, number, number]>();
function localExtent(spec: PartSpec): readonly [number, number, number, number] {
  const cached = localExtents.get(spec);
  if (cached !== undefined) return cached;
  const [bx, by, bw, bh] = spec.body;
  const xs = [bx, bx + bw, ...spec.pins.map((p) => p.x)];
  const ys = [by, by + bh, ...spec.pins.map((p) => p.y)];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const extent = [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0] as const;
  localExtents.set(spec, extent);
  return extent;
}

/**
 * Body ∪ pins, in world coordinates. This — not the body alone — is what the
 * box clamps: a pin pushed outside the border is a pin no wire can reach,
 * because the router never leaves the box.
 */
export function extentOf(component: Placement, library: SchematicLibrary): Rect {
  return turnedRect(component, localExtent(library.part(component.kind)));
}

/** The extent, grown by 4, as the mouse target of a component. */
export function hitRectOf(component: Placement, library: SchematicLibrary): Rect {
  const r = extentOf(component, library);
  return { x0: r.x0 - 4, y0: r.y0 - 4, x1: r.x1 + 4, y1: r.y1 + 4 };
}

/** Whether two rectangles overlap at all — the box-selection test. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x1 >= b.x0 && a.x0 <= b.x1 && a.y1 >= b.y0 && a.y0 <= b.y1;
}

/**
 * The nearest on-grid origin that keeps the whole symbol inside the box.
 * Used on place, on move and on rotate, so a schematic never stores a
 * component the schema would reject or the router could not reach.
 */
export function clampToBox(
  kind: string,
  m: Orientation,
  x: number,
  y: number,
  library: SchematicLibrary,
): { x: number; y: number } {
  const box = library.box;
  const e = turnedRect({ kind, m, x: 0, y: 0 }, localExtent(library.part(kind)));
  /* `Math.ceil(-0 / 20) * 20` is −0, which is not a value worth storing. */
  const zero = (v: number): number => (v === 0 ? 0 : v);
  const clampAxis = (v: number, lo: number, hi: number, span: number): number => {
    const min = zero(Math.ceil(-lo / GRID) * GRID);
    const max = zero(Math.floor((span - hi) / GRID) * GRID);
    if (max < min) return zero(Math.min(span, Math.max(0, snap(v))));
    return zero(Math.min(max, Math.max(min, snap(v))));
  };
  return {
    x: clampAxis(x, e.x0, e.x1, box.width),
    y: clampAxis(y, e.y0, e.y1, box.height),
  };
}

/** A free point or a waypoint, snapped and kept inside the box. */
export function clampPoint(
  x: number,
  y: number,
  library: SchematicLibrary,
): { x: number; y: number } {
  return {
    x: Math.min(library.box.width, Math.max(0, snap(x))),
    y: Math.min(library.box.height, Math.max(0, snap(y))),
  };
}

/** Where a wire end actually is. `null` when it names a component that is gone, or a port the library lacks. */
export function resolveEnd(
  end: CanvasWireEnd,
  byId: ReadonlyMap<string, Placement>,
  library: SchematicLibrary,
): PinPoint | null {
  if (end.kind === "pin") {
    const c = byId.get(end.c);
    return c === undefined ? null : pinPosition(c, end.p, library);
  }
  if (end.kind === "port") return portAt(end.port, library);
  return { x: end.x, y: end.y, d: -1 };
}

/** Index of the components of a schematic, for the resolvers above. */
export function indexOf<C extends { id: string }>(components: readonly C[]): Map<string, C> {
  return new Map(components.map((c) => [c.id, c]));
}

/**
 * The pin or port under `(x, y)`, within `radius` canvas units. Ports win ties
 * only when no pin is closer: a component dropped on a port must still be
 * grabbable by its own pin.
 */
export type PinTarget =
  | { readonly kind: "pin"; readonly c: string; readonly p: number }
  | { readonly kind: "port"; readonly port: string };

export function pinAt(
  components: readonly CanvasComponent[],
  x: number,
  y: number,
  radius: number,
  library: SchematicLibrary,
): PinTarget | null {
  let best: PinTarget | null = null;
  let bestD = radius * radius;
  for (const c of components) {
    const pins = library.part(c.kind).pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i, library);
      if (q === null) continue;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { kind: "pin", c: c.id, p: i };
      }
    }
  }
  for (const q of library.ports) {
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { kind: "port", port: q.name };
    }
  }
  return best;
}

/** Whether two ends name the same attachment point. */
export function sameEnd(a: CanvasWireEnd, b: CanvasWireEnd): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "pin" && b.kind === "pin") return a.c === b.c && a.p === b.p;
  if (a.kind === "port" && b.kind === "port") return a.port === b.port;
  if (a.kind === "free" && b.kind === "free") return a.x === b.x && a.y === b.y;
  return false;
}

// ---------------------------------------------------------------------------
// Identity: ids, names, fresh instances
// ---------------------------------------------------------------------------

/**
 * `c4` after `c1`, `c3`. The schema has no counter, so the next id is read
 * from the ones already there — which also survives a schematic that arrived
 * from somewhere else.
 */
export function nextId(prefix: "c" | "w", ids: readonly string[]): string {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let n = 0;
  for (const id of ids) {
    const m = re.exec(id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${n + 1}`;
}

/**
 * `R3` after `R1`, `R2`. A terminal has no number: in `circuit` there is one
 * ground, one VCC rail and one VEE rail, however many symbols name them.
 */
export function nextName(
  prefix: string,
  components: readonly CanvasComponent[],
  library: SchematicLibrary,
): string {
  const terminal = library.kinds.some((k) => {
    const part = library.part(k);
    return part.terminal && part.prefix === prefix;
  });
  if (terminal) return prefix;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let n = 0;
  for (const c of components) {
    const m = re.exec(c.name);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  return `${prefix}${n + 1}`;
}

/** A fresh instance: the next free id, the next free name, the kind's default value. */
export function newComponent(
  kind: string,
  x: number,
  y: number,
  m: Orientation,
  existing: readonly CanvasComponent[],
  library: SchematicLibrary,
): CanvasComponent {
  const spec = library.part(kind);
  const at = clampToBox(kind, m, x, y, library);
  return {
    id: nextId(
      "c",
      existing.map((c) => c.id),
    ),
    kind,
    x: at.x,
    y: at.y,
    m: [...m] as Orientation,
    name: nextName(spec.prefix, existing, library),
    value: spec.defaultValue,
  };
}

// ---------------------------------------------------------------------------
// The view box, and the screen ↔ world mapping
// ---------------------------------------------------------------------------

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * The air kept around the box when the view is fitted: EXACTLY one grid cell,
 * on every side. It is what makes the frame read as filling the canvas rather
 * than floating in it, and it is wide enough for the outline, the port glyphs
 * and their labels.
 */
export const BLEED = GRID;

/**
 * The whole box plus its one-cell margin. Three things at once: the view on
 * mount, the view the "fit" button returns to, and the FLOOR of zooming out —
 * which is why the indicator calls it 100 %. One object per box, so a hook
 * may depend on it.
 */
const fitViews = new WeakMap<SchematicLibrary["box"], ViewBox>();
export function fitView(box: SchematicLibrary["box"]): ViewBox {
  const cached = fitViews.get(box);
  if (cached !== undefined) return cached;
  const view = { x: -BLEED, y: -BLEED, w: box.width + 2 * BLEED, h: box.height + 2 * BLEED };
  fitViews.set(box, view);
  return view;
}

/**
 * The height, in CSS pixels, at which a canvas `width` pixels wide shows
 * the fitted view `fit` with no letterbox at all — the frame then sits one grid
 * cell from every edge of the drawing area, which is rule 1.
 *
 * `maxHeight` caps it: past that the area is wider than the fitted view and
 * `xMidYMid meet` letterboxes left and right, the one case where the margin
 * is wider than a cell. A width of zero (jsdom, a hidden tab) means "not
 * measured yet" and keeps the cap.
 */
export function fitCanvasHeight(width: number, maxHeight: number, fit: ViewBox): number {
  if (!Number.isFinite(width) || width <= 0) return maxHeight;
  return Math.min(maxHeight, Math.round(width / (fit.w / fit.h)));
}

export const viewBoxAttr = (v: ViewBox): string => `${v.x} ${v.y} ${v.w} ${v.h}`;

/** Rectangle shape of the element, as `getBoundingClientRect` gives it. */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Canvas units per CSS pixel, under `preserveAspectRatio="xMidYMid meet"`. */
export function viewScale(rect: ScreenRect, view: ViewBox): number {
  if (rect.width <= 0 || rect.height <= 0) return 1;
  return Math.min(rect.width / view.w, rect.height / view.h);
}

/**
 * A client point in world coordinates. `meet` letterboxes the smaller axis, so
 * half of the slack is subtracted before dividing — get this wrong and every
 * click lands a few units off, which is invisible until a pin misses.
 */
export function screenToWorld(
  rect: ScreenRect,
  view: ViewBox,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const scale = viewScale(rect, view);
  const ox = (rect.width - view.w * scale) / 2;
  const oy = (rect.height - view.h * scale) / 2;
  return {
    x: view.x + (clientX - rect.left - ox) / scale,
    y: view.y + (clientY - rect.top - oy) / scale,
  };
}

/** The tightest the view may get: 400 % of "fit". */
export const MAX_ZOOM = 4;

/** What the indicator shows: 100 % is the fitted view, more is zoomed in. */
export const zoomPercent = (view: ViewBox, fit: ViewBox): number => Math.round((fit.w / view.w) * 100);

/**
 * The view moved back inside the fitted view `fit`. Panning may not push the
 * frame off the canvas: whatever the pointer asked for, what is on screen
 * stays a part of the box and of its one-cell margin.
 */
export function clampView(view: ViewBox, fit: ViewBox): ViewBox {
  const slackX = fit.w - view.w;
  const slackY = fit.h - view.h;
  return {
    ...view,
    x: slackX <= 0 ? fit.x : Math.min(fit.x + slackX, Math.max(fit.x, view.x)),
    y: slackY <= 0 ? fit.y : Math.min(fit.y + slackY, Math.max(fit.y, view.y)),
  };
}

/**
 * Zoom by `factor` about the world point `(ax, ay)`, which stays put. Zooming
 * OUT stops at the fitted view: below it the frame would only get smaller
 * inside an already-empty canvas, so 100 % is both the floor and what the
 * whole frame looks like; zooming in stops at {@link MAX_ZOOM}.
 */
export function zoomAt(view: ViewBox, factor: number, ax: number, ay: number, fit: ViewBox): ViewBox {
  const w = Math.min(fit.w, Math.max(fit.w / MAX_ZOOM, view.w / factor));
  const k = w / view.w;
  return clampView({ x: ax - (ax - view.x) * k, y: ay - (ay - view.y) * k, w, h: view.h * k }, fit);
}
