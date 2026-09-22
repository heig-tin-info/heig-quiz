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
 * schema stores: `0..BOX.width` × `0..BOX.height`. The router works in grid
 * steps internally and converts back before anything is stored.
 */
import {
  BOX,
  DIRECTIONS,
  GRID,
  LIBRARY,
  PORTS,
  type ComponentKind,
  type PinDirection,
  type PortId,
} from "../library.js";
import type { Orientation, SchematicComponent, WireEnd } from "../schema.js";

// ---------------------------------------------------------------------------
// Orientations
// ---------------------------------------------------------------------------

/**
 * The eight symmetries of the grid, as SVG matrices `[a, b, c, d]`. They are
 * the closed set the schema accepts, and the products of {@link ROTATE},
 * {@link MIRROR_X} and {@link MIRROR_Y} never leave it.
 */
export const ORIENT_0: Orientation = [1, 0, 0, 1];
export const ORIENT_90: Orientation = [0, 1, -1, 0];
export const ORIENT_180: Orientation = [-1, 0, 0, -1];
export const ORIENT_270: Orientation = [0, -1, 1, 0];
export const ORIENT_MIRROR_0: Orientation = [-1, 0, 0, 1];
export const ORIENT_MIRROR_90: Orientation = [0, -1, -1, 0];
export const ORIENT_MIRROR_180: Orientation = [1, 0, 0, -1];
export const ORIENT_MIRROR_270: Orientation = [0, 1, 1, 0];

/** The eight, in a stable order: four rotations, then the four reflections. */
export const ORIENTATIONS: readonly Orientation[] = [
  ORIENT_0,
  ORIENT_90,
  ORIENT_180,
  ORIENT_270,
  ORIENT_MIRROR_0,
  ORIENT_MIRROR_90,
  ORIENT_MIRROR_180,
  ORIENT_MIRROR_270,
];

/** The three generators the toolbar applies: a quarter turn and two mirrors. */
export const ROTATE: Orientation = ORIENT_90;
export const MIRROR_X: Orientation = ORIENT_MIRROR_0;
export const MIRROR_Y: Orientation = ORIENT_MIRROR_180;

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
export type Placement = Pick<SchematicComponent, "kind" | "x" | "y" | "m">;

/** Where pin `index` of `component` sits, and which way its wire leaves. `null` for an unknown pin. */
export function pinPosition(component: Placement, index: number): PinPoint | null {
  const pin = LIBRARY[component.kind].pins[index];
  if (pin === undefined) return null;
  const [x, y] = transform(component.m, pin.x, pin.y);
  const away = DIRECTIONS[pin.d];
  if (away === undefined) return null;
  const [dx, dy] = transform(component.m, away[0], away[1]);
  return { x: component.x + x, y: component.y + y, d: directionOf(dx, dy) };
}

/** Where a port sits on the box border; its direction points INTO the box. */
export function portPosition(port: PortId): PinPoint {
  const spec = PORTS[port];
  return { x: spec.x, y: spec.y, d: spec.d };
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
export function rectOf(component: Placement): Rect {
  return turnedRect(component, LIBRARY[component.kind].body);
}

/** Body ∪ pins, in LOCAL coordinates. Cached: it only depends on the kind. */
const localExtents = new Map<ComponentKind, readonly [number, number, number, number]>();
function localExtent(kind: ComponentKind): readonly [number, number, number, number] {
  const cached = localExtents.get(kind);
  if (cached !== undefined) return cached;
  const spec = LIBRARY[kind];
  const [bx, by, bw, bh] = spec.body;
  const xs = [bx, bx + bw, ...spec.pins.map((p) => p.x)];
  const ys = [by, by + bh, ...spec.pins.map((p) => p.y)];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const extent = [x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0] as const;
  localExtents.set(kind, extent);
  return extent;
}

/**
 * Body ∪ pins, in world coordinates. This — not the body alone — is what the
 * box clamps: a pin pushed outside the border is a pin no wire can reach,
 * because the router never leaves the box.
 */
export function extentOf(component: Placement): Rect {
  return turnedRect(component, localExtent(component.kind));
}

/** The extent, grown by 4, as the mouse target of a component. */
export function hitRectOf(component: Placement): Rect {
  const r = extentOf(component);
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
  kind: ComponentKind,
  m: Orientation,
  x: number,
  y: number,
): { x: number; y: number } {
  const e = turnedRect({ kind, m, x: 0, y: 0 }, localExtent(kind));
  /* `Math.ceil(-0 / 20) * 20` is −0, which is not a value worth storing. */
  const zero = (v: number): number => (v === 0 ? 0 : v);
  const clampAxis = (v: number, lo: number, hi: number, span: number): number => {
    const min = zero(Math.ceil(-lo / GRID) * GRID);
    const max = zero(Math.floor((span - hi) / GRID) * GRID);
    if (max < min) return zero(Math.min(span, Math.max(0, snap(v))));
    return zero(Math.min(max, Math.max(min, snap(v))));
  };
  return {
    x: clampAxis(x, e.x0, e.x1, BOX.width),
    y: clampAxis(y, e.y0, e.y1, BOX.height),
  };
}

/** A free point or a waypoint, snapped and kept inside the box. */
export function clampPoint(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.min(BOX.width, Math.max(0, snap(x))),
    y: Math.min(BOX.height, Math.max(0, snap(y))),
  };
}

/** Where a wire end actually is. `null` when it names a component that is gone. */
export function resolveEnd(end: WireEnd, byId: ReadonlyMap<string, Placement>): PinPoint | null {
  if (end.kind === "pin") {
    const c = byId.get(end.c);
    return c === undefined ? null : pinPosition(c, end.p);
  }
  if (end.kind === "port") return portPosition(end.port);
  return { x: end.x, y: end.y, d: -1 };
}

/** Index of the components of a schematic, for the resolvers above. */
export function indexOf(components: readonly SchematicComponent[]): Map<string, SchematicComponent> {
  return new Map(components.map((c) => [c.id, c]));
}

/**
 * The pin or port under `(x, y)`, within `radius` canvas units. Ports win ties
 * only when no pin is closer: a component dropped on a port must still be
 * grabbable by its own pin.
 */
export type PinTarget =
  | { readonly kind: "pin"; readonly c: string; readonly p: number }
  | { readonly kind: "port"; readonly port: PortId };

export function pinAt(
  components: readonly SchematicComponent[],
  x: number,
  y: number,
  radius: number,
): PinTarget | null {
  let best: PinTarget | null = null;
  let bestD = radius * radius;
  for (const c of components) {
    const pins = LIBRARY[c.kind].pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i);
      if (q === null) continue;
      const d = (q.x - x) ** 2 + (q.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { kind: "pin", c: c.id, p: i };
      }
    }
  }
  for (const port of Object.keys(PORTS) as PortId[]) {
    const q = portPosition(port);
    const d = (q.x - x) ** 2 + (q.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { kind: "port", port };
    }
  }
  return best;
}

/** Whether two ends name the same attachment point. */
export function sameEnd(a: WireEnd, b: WireEnd): boolean {
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
 * `R3` after `R1`, `R2`. A terminal has no number: there is one ground, one
 * VCC rail and one VEE rail, however many symbols name them.
 */
export function nextName(prefix: string, components: readonly SchematicComponent[]): string {
  if (prefix === "GND" || prefix === "VCC" || prefix === "VEE") return prefix;
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
  kind: ComponentKind,
  x: number,
  y: number,
  m: Orientation,
  existing: readonly SchematicComponent[],
): SchematicComponent {
  const spec = LIBRARY[kind];
  const at = clampToBox(kind, m, x, y);
  return {
    id: nextId(
      "c",
      existing.map((c) => c.id),
    ),
    kind,
    x: at.x,
    y: at.y,
    m: [...m] as Orientation,
    name: nextName(spec.prefix, existing),
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

/** A little air around the box, so its outline and the ports are not clipped. */
export const BLEED = 12;

/** The whole box, centred: the view on mount and on "fit". */
export const FIT_VIEW: ViewBox = {
  x: -BLEED,
  y: -BLEED,
  w: BOX.width + 2 * BLEED,
  h: BOX.height + 2 * BLEED,
};

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

/** The smallest and largest the view may get: 25 % to 400 % of "fit". */
const MIN_W = FIT_VIEW.w / 4;
const MAX_W = FIT_VIEW.w * 4;

/** Zoom by `factor` about the world point `(ax, ay)`, which stays put. */
export function zoomAt(view: ViewBox, factor: number, ax: number, ay: number): ViewBox {
  const w = Math.min(MAX_W, Math.max(MIN_W, view.w / factor));
  const k = w / view.w;
  return { x: ax - (ax - view.x) * k, y: ay - (ay - view.y) * k, w, h: view.h * k };
}
