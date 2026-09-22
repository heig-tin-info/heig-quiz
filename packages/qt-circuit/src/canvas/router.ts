/**
 * The orthogonal wire router: A* on the grid, with a turn penalty, component
 * bodies as obstacles and a small cost for running on top of another wire.
 * A faithful port of `mockups/circuit.html`, with one difference that matters:
 * the search is CLAMPED TO THE BOX, so a routed polyline is always a value the
 * schema accepts (`0..BOX.width` × `0..BOX.height`, every vertex on the grid).
 *
 * The result is stored in `wire.points`, which is the geometry of record: the
 * server reads connectivity from it and never routes anything itself
 * (`schema.ts`, `Wire`). So every committed edit passes through
 * {@link withRoutes}.
 */
import { BOX, DIRECTIONS, GRID, LIBRARY } from "../library.js";
import { PORTS, type PortId } from "../library.js";
import type { Point, Schematic, SchematicComponent, Wire } from "../schema.js";

import { type PinPoint, pinPosition, rectOf, resolveEnd, indexOf } from "./geometry.js";

/** What a corner costs, in grid steps. Four keeps a route from zig-zagging for nothing. */
const TURN = 4;

/** The grid is the box, and nothing routes outside it. */
const GW = BOX.width / GRID;
const GH = BOX.height / GRID;

/** The schema caps a polyline at 64 vertices; a route that long is a bug, not a wire. */
const MAX_POINTS = 64;

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * A binary heap of (priority, node). `Array.sort` on every push turned the
 * router into the slowest thing on the canvas while a component was dragged.
 */
class Heap {
  private readonly p: number[] = [];
  private readonly v: number[] = [];

  get size(): number {
    return this.v.length;
  }

  push(priority: number, value: number): void {
    let i = this.v.length;
    this.p.push(priority);
    this.v.push(value);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if ((this.p[j] ?? 0) <= priority) break;
      this.p[i] = this.p[j] ?? 0;
      this.v[i] = this.v[j] ?? 0;
      i = j;
    }
    this.p[i] = priority;
    this.v[i] = value;
  }

  pop(): number {
    const top = this.v[0] ?? -1;
    const lp = this.p.pop() ?? 0;
    const lv = this.v.pop() ?? 0;
    const n = this.v.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && (this.p[r] ?? 0) < (this.p[l] ?? 0)) l = r;
        if ((this.p[l] ?? 0) >= lp) break;
        this.p[i] = this.p[l] ?? 0;
        this.v[i] = this.v[l] ?? 0;
        i = l;
      }
      this.p[i] = lp;
      this.v[i] = lv;
    }
    return top;
  }
}

/** Grid cells a wire may not cross, and how many wires already run through each cell. */
export interface Obstacles {
  readonly blocked: ReadonlySet<string>;
  readonly used: Map<string, number>;
}

/**
 * The cells under a component body (strictly inside, so a pin on the edge
 * stays reachable) plus every pin and every port: a wire routes AROUND parts
 * and never cuts across a terminal that is not its own end.
 */
export function blockedCells(components: readonly SchematicComponent[]): Set<string> {
  const blocked = new Set<string>();
  for (const c of components) {
    const r = rectOf(c);
    for (let gx = Math.ceil(r.x0 / GRID); gx <= Math.floor(r.x1 / GRID); gx += 1) {
      for (let gy = Math.ceil(r.y0 / GRID); gy <= Math.floor(r.y1 / GRID); gy += 1) {
        if (gx * GRID > r.x0 && gx * GRID < r.x1 && gy * GRID > r.y0 && gy * GRID < r.y1) {
          blocked.add(key(gx, gy));
        }
      }
    }
    const pins = LIBRARY[c.kind].pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i);
      if (q !== null) blocked.add(key(q.x / GRID, q.y / GRID));
    }
  }
  for (const port of Object.keys(PORTS) as PortId[]) {
    const spec = PORTS[port];
    blocked.add(key(spec.x / GRID, spec.y / GRID));
  }
  return blocked;
}

/**
 * One leg, in grid steps. Two passes: a tight window first, which is what an
 * ordinary wire needs, then the whole box for the ones that have to go around
 * something. Both are clipped to the box, so no vertex can escape it.
 */
function astar(
  ax: number,
  ay: number,
  ad: number,
  bx: number,
  by: number,
  bd: number,
  obstacles: Obstacles,
): { points: Array<[number, number]>; dir: number } {
  if (ax === bx && ay === by) return { points: [[ax, ay]], dir: ad };
  /* The direction the wire must ARRIVE from to meet the end pin head on. */
  const need = bd >= 0 ? (bd + 2) % 4 : -1;

  for (const margin of [6, GW + GH]) {
    const x0 = Math.max(0, Math.min(ax, bx) - margin);
    const y0 = Math.max(0, Math.min(ay, by) - margin);
    const x1 = Math.min(GW, Math.max(ax, bx) + margin);
    const y1 = Math.min(GH, Math.max(ay, by) + margin);
    const W = x1 - x0 + 1;
    const H = y1 - y0 + 1;
    const n = W * H * 5;
    const cost = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    const at = (x: number, y: number, d: number): number => ((y - y0) * W + (x - x0)) * 5 + (d + 1);

    const heap = new Heap();
    const start = at(ax, ay, ad);
    cost[start] = 0;
    heap.push(Math.abs(ax - bx) + Math.abs(ay - by), start);

    while (heap.size > 0) {
      const cur = heap.pop();
      if (done[cur] === 1) continue;
      done[cur] = 1;
      const d = (cur % 5) - 1;
      const cell = (cur / 5) | 0;
      const x = (cell % W) + x0;
      const y = ((cell / W) | 0) + y0;
      if (x === bx && y === by) {
        const out: Array<[number, number]> = [];
        let k = cur;
        while (k >= 0) {
          const c = (k / 5) | 0;
          out.push([(c % W) + x0, ((c / W) | 0) + y0]);
          k = parent[k] ?? -1;
        }
        return { points: out.reverse(), dir: d };
      }
      const g = cost[cur] ?? Infinity;
      for (let nd = 0; nd < 4; nd += 1) {
        if (d >= 0 && nd === (d + 2) % 4) continue; // never double back
        const step = DIRECTIONS[nd];
        if (step === undefined) continue;
        const nx = x + step[0];
        const ny = y + step[1];
        if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const goal = nx === bx && ny === by;
        const k = key(nx, ny);
        if (!goal && obstacles.blocked.has(k)) continue;
        let c = 1 + (d >= 0 && nd !== d ? TURN : 0);
        /* Arriving from the wrong side of the end pin costs more than a detour. */
        if (goal && need >= 0 && nd !== need) c += nd === bd ? TURN * 3 : TURN;
        const u = obstacles.used.get(k);
        if (u !== undefined && (u & (nd % 2 ? 2 : 1)) !== 0) c += 2.5;
        const ni = at(nx, ny, nd);
        const g2 = g + c;
        if (g2 < (cost[ni] ?? Infinity)) {
          cost[ni] = g2;
          parent[ni] = cur;
          heap.push(g2 + Math.abs(nx - bx) + Math.abs(ny - by), ni);
        }
      }
    }
  }
  /* Nothing got through: the plain L, which is still orthogonal and on grid. */
  return {
    points: [
      [ax, ay],
      [bx, ay],
      [bx, by],
    ],
    dir: by !== ay ? (by > ay ? 1 : 3) : bx > ax ? 0 : 2,
  };
}

/** Drops the collinear vertices, so a straight run is two points and not twenty. */
export function simplify(points: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return [];
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const out: Array<[number, number]> = [[first[0], first[1]]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    if (a === undefined || b === undefined || c === undefined) continue;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (
      Math.sign(b[0] - a[0]) === Math.sign(c[0] - b[0]) &&
      Math.sign(b[1] - a[1]) === Math.sign(c[1] - b[1])
    ) {
      continue;
    }
    out.push([b[0], b[1]]);
  }
  out.push([last[0], last[1]]);
  return out;
}

/** Records the cells a finished route occupies, so the next one prefers to go elsewhere. */
export function markUsed(points: ReadonlyArray<readonly [number, number]>, used: Map<string, number>): void {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    const bit = a[1] === b[1] ? 1 : 2;
    for (const q of [a, b]) {
      const k = key(q[0], q[1]);
      used.set(k, (used.get(k) ?? 0) | bit);
    }
  }
}

const NO_OBSTACLES: Obstacles = { blocked: new Set(), used: new Map() };

/**
 * The polyline through `ends` — the wire's two attachment points with its
 * waypoints in between — in CANVAS units, orthogonal, on the grid and inside
 * the box.
 */
export function route(ends: readonly PinPoint[], obstacles: Obstacles = NO_OBSTACLES): Array<[number, number]> {
  const first = ends[0];
  if (first === undefined) return [];
  if (ends.length === 1) {
    return [
      [first.x, first.y],
      [first.x, first.y],
    ];
  }
  let dir: number = first.d;
  const grid: Array<[number, number]> = [];
  for (let i = 0; i < ends.length - 1; i += 1) {
    const a = ends[i];
    const b = ends[i + 1];
    if (a === undefined || b === undefined) continue;
    const last = i === ends.length - 2;
    const leg = astar(
      Math.round(a.x / GRID),
      Math.round(a.y / GRID),
      dir,
      Math.round(b.x / GRID),
      Math.round(b.y / GRID),
      last ? b.d : -1,
      obstacles,
    );
    if (grid.length > 0) leg.points.shift();
    grid.push(...leg.points);
    if (leg.dir >= 0) dir = leg.dir;
  }
  const simple = simplify(grid);
  const points: Array<[number, number]> =
    simple.length >= 2
      ? simple.map(([x, y]) => [x * GRID, y * GRID])
      : [
          [first.x, first.y],
          [first.x, first.y],
        ];
  if (points.length <= MAX_POINTS) return points;
  /* A polyline the schema would refuse: fall back to the L through the ends. */
  const a = points[0] as [number, number];
  const b = points[points.length - 1] as [number, number];
  return [a, [b[0], a[1]], b];
}

/** Every wire's polyline, routed in order, each one avoiding the ones before it. */
export function computeRoutes(schematic: Schematic): Map<string, Array<[number, number]>> {
  const byId = indexOf(schematic.components);
  const obstacles: Obstacles = { blocked: blockedCells(schematic.components), used: new Map() };
  const routes = new Map<string, Array<[number, number]>>();
  for (const w of schematic.wires) {
    const a = resolveEnd(w.a, byId);
    const b = resolveEnd(w.b, byId);
    if (a === null || b === null) continue;
    const points = route([a, ...w.via.map((v) => ({ x: v.x, y: v.y, d: -1 as const })), b], obstacles);
    markUsed(
      points.map(([x, y]) => [x / GRID, y / GRID] as [number, number]),
      obstacles.used,
    );
    routes.set(w.id, points);
  }
  return routes;
}

/**
 * The schematic with every `points` recomputed. Called on EVERY committed edit
 * — place, move, rotate, wire, delete — because the stored polyline is what
 * the server reads, and a stale one is a wrong netlist.
 */
export function withRoutes(schematic: Schematic): Schematic {
  const routes = computeRoutes(schematic);
  const wires: Wire[] = schematic.wires.map((w) => {
    const points = routes.get(w.id);
    return points === undefined ? w : { ...w, points: points as Point[] };
  });
  return { components: schematic.components, wires };
}

/**
 * The points that carry a junction dot: where three or more branches meet.
 * An endpoint counts once, a pin under it once more, and an endpoint landing
 * in the MIDDLE of another wire counts twice — that is a T, and a T is a node.
 */
export function junctionPoints(
  schematic: Schematic,
  routes: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>,
): Array<[number, number]> {
  const terminals = new Set<string>();
  for (const c of schematic.components) {
    const pins = LIBRARY[c.kind].pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i);
      if (q !== null) terminals.add(key(q.x, q.y));
    }
  }
  const count = new Map<string, number>();
  for (const points of routes.values()) {
    for (const e of [points[0], points[points.length - 1]]) {
      if (e === undefined) continue;
      const k = key(e[0], e[1]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  const dots: Array<[number, number]> = [];
  for (const [k, n] of count) {
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    let total = n + (terminals.has(k) ? 1 : 0);
    outer: for (const points of routes.values()) {
      const f = points[0];
      const l = points[points.length - 1];
      if (f === undefined || l === undefined) continue;
      if ((f[0] === x && f[1] === y) || (l[0] === x && l[1] === y)) continue;
      for (let i = 0; i < points.length - 1; i += 1) {
        const a = points[i];
        const b = points[i + 1];
        if (a === undefined || b === undefined) continue;
        if (
          x >= Math.min(a[0], b[0]) &&
          x <= Math.max(a[0], b[0]) &&
          y >= Math.min(a[1], b[1]) &&
          y <= Math.max(a[1], b[1])
        ) {
          total += 2;
          break outer;
        }
      }
    }
    if (total >= 3) dots.push([x, y]);
  }
  return dots;
}

/** The `d` of an orthogonal polyline. */
export const pathOf = (points: ReadonlyArray<readonly [number, number]>): string =>
  `M${points.map((p) => `${p[0]} ${p[1]}`).join("L")}`;

/** Whether `(x, y)` lies on one of the polyline's segments, within `slack`. */
export function onPolyline(
  points: ReadonlyArray<readonly [number, number]>,
  x: number,
  y: number,
  slack: number,
): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a === undefined || b === undefined) continue;
    if (
      x >= Math.min(a[0], b[0]) - slack &&
      x <= Math.max(a[0], b[0]) + slack &&
      y >= Math.min(a[1], b[1]) - slack &&
      y <= Math.max(a[1], b[1]) + slack
    ) {
      return true;
    }
  }
  return false;
}
