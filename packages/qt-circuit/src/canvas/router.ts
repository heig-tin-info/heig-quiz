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
import { astar, cellKey, markUsed, simplify, type Obstacles, type SearchOptions } from "@quiz/domain/gridRouter";

import { BOX, GRID, LIBRARY } from "../library.js";
import { PORTS, type PortId } from "../library.js";
import type { Point, Schematic, SchematicComponent, Wire } from "../schema.js";

import { type PinPoint, pinPosition, rectOf, resolveEnd, indexOf } from "./geometry.js";

/** The grid is the box, and nothing routes outside it. */
const GW = BOX.width / GRID;
const GH = BOX.height / GRID;

/** A tight window first, which is what an ordinary wire needs, then the whole box for the ones that go around something. */
const SEARCH: SearchOptions = { margins: [6, GW + GH], clip: { x0: 0, y0: 0, x1: GW, y1: GH } };

/** The schema caps a polyline at 64 vertices; a route that long is a bug, not a wire. */
const MAX_POINTS = 64;

export type { Obstacles };

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
          blocked.add(cellKey(gx, gy));
        }
      }
    }
    const pins = LIBRARY[c.kind].pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i);
      if (q !== null) blocked.add(cellKey(q.x / GRID, q.y / GRID));
    }
  }
  for (const port of Object.keys(PORTS) as PortId[]) {
    const spec = PORTS[port];
    blocked.add(cellKey(spec.x / GRID, spec.y / GRID));
  }
  return blocked;
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
      SEARCH,
    );
    if (grid.length > 0) leg.pts.shift();
    grid.push(...leg.pts);
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

/** Every component pin, as a `cellKey(x, y)` in canvas units. */
function terminalKeys(components: readonly SchematicComponent[]): Set<string> {
  const terminals = new Set<string>();
  for (const c of components) {
    const pins = LIBRARY[c.kind].pins;
    for (let i = 0; i < pins.length; i += 1) {
      const q = pinPosition(c, i);
      if (q !== null) terminals.add(cellKey(q.x, q.y));
    }
  }
  return terminals;
}

/** How many wire ends sit on each point. */
function endCounts(routes: Iterable<ReadonlyArray<readonly [number, number]>>): Map<string, number> {
  const count = new Map<string, number>();
  for (const points of routes) {
    for (const e of [points[0], points[points.length - 1]]) {
      if (e === undefined) continue;
      const k = cellKey(e[0], e[1]);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
  }
  return count;
}

const endsAt = (points: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean => {
  const f = points[0];
  const l = points[points.length - 1];
  return (f !== undefined && f[0] === x && f[1] === y) || (l !== undefined && l[0] === x && l[1] === y);
};

/** Whether `(x, y)` lies on some wire that does NOT end there: the stem of a T. */
function landsMidWire(
  routes: Iterable<ReadonlyArray<readonly [number, number]>>,
  x: number,
  y: number,
): boolean {
  for (const points of routes) {
    if (!endsAt(points, x, y) && onPolyline(points, x, y, 0)) return true;
  }
  return false;
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
  const terminals = terminalKeys(schematic.components);
  const dots: Array<[number, number]> = [];
  for (const [k, n] of endCounts(routes.values())) {
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const total = n + (terminals.has(k) ? 1 : 0) + (landsMidWire(routes.values(), x, y) ? 2 : 0);
    if (total >= 3) dots.push([x, y]);
  }
  return dots;
}

/** The `d` of an orthogonal polyline. */
export const pathOf = (points: ReadonlyArray<readonly [number, number]>): string =>
  `M${points.map((p) => `${p[0]} ${p[1]}`).join("L")}`;

/**
 * Whether `(x, y)` falls inside the bounding box of one of the polyline's
 * segments, grown by `slack`: a hit-test. For the orthogonal polylines the
 * router draws, `slack = 0` is exact; it is NOT the netlist's connectivity
 * test (`liesOnPolyline` in `netlist.ts`), which is exact collinearity on any
 * segment and the only one a grade depends on.
 */
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
