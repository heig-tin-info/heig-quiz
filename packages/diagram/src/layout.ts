/**
 * Where every line goes, recomputed on display (ADR-041 §2): nothing here is
 * stored.
 *
 * Two layouts, chosen by the kind:
 *
 * - ORTHOGONAL (UML, entity-relationship, flowchart): the A* router of
 *   `mockups/circuit.html` on the grid of 20, a turn penalty, the boxes as
 *   obstacles and a small cost for running along another line. An end
 *   attaches to a SIDE of its element: the side that best faces the other
 *   end while it has a free grid point, the ends that face most clearly
 *   choosing first; a decision's diamond takes one end per vertex. The ends
 *   sharing a side spread along it in the order of their targets, so they do
 *   not cross, and an end on an ellipse, a diamond or a circle slides onto
 *   the shape.
 * - STRAIGHT (automaton, graph): centre to centre between circles, several
 *   lines of one pair fanned into curves, a loop over an element that points
 *   to itself.
 */
import { KINDS, type DiagramKind } from "./kinds.js";
import { GRID, centerOf, rectOf, snap, type Measure, type Rect } from "./geometry.js";
import type { DiagramLink, DiagramNode, Point, Scene } from "./scene.js";

type XY = [number, number];

/** An end of a line: where it is, and which way it leaves its element (−1: a free point). */
export interface End {
  readonly x: number;
  readonly y: number;
  readonly d: -1 | 0 | 1 | 2 | 3;
}

export interface Route {
  /** The polyline, or the three points a curve is hit-tested and boxed by. */
  readonly pts: readonly XY[];
  readonly a: End;
  readonly b: End;
  /** An SVG path when the line is a curve; the polyline otherwise. */
  readonly path?: string;
  /** The two points the head at `b` is aimed along, when not the last segment. */
  readonly aim?: readonly [XY, XY];
  /** Where the label goes, for a straight line. */
  readonly label?: { readonly x: number; readonly y: number };
}

/** A link being drawn: its far end may still be a point under the pointer. */
export type LinkLike = Pick<DiagramLink, "id" | "type" | "a"> & { b: string | Point; via: readonly Point[] };

export interface Layout {
  readonly rects: ReadonlyMap<string, Rect>;
  readonly routes: ReadonlyMap<string, Route>;
}

/** Right, down, left, up: the direction an end leaves by. */
export const DIRS: readonly XY[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

const TURN = 4;

export function layout(scene: Scene, kind: DiagramKind, measure: Measure, draft?: LinkLike): Layout {
  const rects = new Map(scene.nodes.map((n) => [n.id, rectOf(n, measure)] as const));
  const links: LinkLike[] = scene.links.map((l) => ({ ...l, via: l.via ?? [] }));
  if (draft) links.push(draft);
  const routes = KINDS[kind].lines === "straight" ? straight(links, rects) : orthogonal(scene.nodes, links, rects);
  return { rects, routes };
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

interface Want {
  key: string;
  toward: { x: number; y: number };
  fixed: "t" | "r" | "b" | "l" | null;
  pref: Array<"t" | "r" | "b" | "l">;
  strength: number;
}

function anchors(nodes: readonly DiagramNode[], links: readonly LinkLike[], rects: ReadonlyMap<string, Rect>): Map<string, End> {
  const wants = new Map<string, Want[]>();
  const add = (id: string, w: Omit<Want, "pref" | "strength">): void => {
    const list = wants.get(id) ?? [];
    list.push({ ...w, pref: [], strength: 0 });
    wants.set(id, list);
  };
  for (const l of links) {
    const ra = rects.get(l.a);
    if (!ra) continue;
    const rb = typeof l.b === "string" ? rects.get(l.b) : undefined;
    if (typeof l.b === "string" && !rb) continue;
    const self = l.a === l.b && l.via.length === 0;
    const first = l.via[0];
    const last = l.via[l.via.length - 1];
    add(l.a, { key: `${l.id}:a`, toward: first ?? (rb ? centerOf(rb) : (l.b as Point)), fixed: self ? "r" : null });
    if (rb) add(l.b as string, { key: `${l.id}:b`, toward: last ?? centerOf(ra), fixed: self ? "t" : null });
  }

  const types = new Map(nodes.map((n) => [n.id, n.t] as const));
  const slots = new Map<string, Want[]>();
  for (const [id, list] of wants) {
    const r = rects.get(id);
    if (!r) continue;
    const c = centerOf(r);
    /* a side holds as many ends as it has inner grid points; a diamond one per vertex */
    const cap = (len: number): number => (types.get(id) === "decision" ? 1 : Math.max(1, len / GRID - 1));
    const room = { t: cap(r.w), b: cap(r.w), l: cap(r.h), r: cap(r.h) };
    const used = { t: 0, b: 0, l: 0, r: 0 };
    for (const w of list) {
      const dx = (w.toward.x - c.x) / (r.w / 2);
      const dy = (w.toward.y - c.y) / (r.h / 2);
      const scores: Array<["t" | "r" | "b" | "l", number]> = [
        ["r", dx],
        ["b", dy],
        ["l", -dx],
        ["t", -dy],
      ];
      scores.sort((p, q) => q[1] - p[1]);
      w.pref = scores.map((s) => s[0]);
      w.strength = w.fixed ? Infinity : (scores[0]?.[1] ?? 0);
    }
    list.sort((p, q) => q.strength - p.strength);
    for (const w of list) {
      const side = w.fixed ?? w.pref.find((s) => used[s] < room[s]) ?? w.pref[0] ?? "r";
      used[side] += 1;
      const k = `${id}:${side}`;
      slots.set(k, [...(slots.get(k) ?? []), w]);
    }
  }

  const out = new Map<string, End>();
  for (const [k, list] of slots) {
    const [id, side] = k.split(":") as [string, "t" | "r" | "b" | "l"];
    const r = rects.get(id);
    if (!r) continue;
    const horizontal = side === "t" || side === "b";
    list.sort((p, q) => (horizontal ? p.toward.x - q.toward.x : p.toward.y - q.toward.y));
    const len = horizontal ? r.w : r.h;
    list.forEach((w, i) => {
      const off = Math.min(len - GRID, Math.max(GRID, snap((len * (i + 1)) / (list.length + 1))));
      out.set(
        w.key,
        side === "t"
          ? { x: r.x0 + off, y: r.y0, d: 3 }
          : side === "b"
            ? { x: r.x0 + off, y: r.y1, d: 1 }
            : side === "l"
              ? { x: r.x0, y: r.y0 + off, d: 2 }
              : { x: r.x1, y: r.y0 + off, d: 0 },
      );
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The A* router, from mockups/circuit.html
// ---------------------------------------------------------------------------

/** A binary heap of (priority, node): deterministic, same pushes, same pops. */
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

interface Leg {
  pts: XY[];
  dir: number;
}

/** One leg in grid steps: a tight window first, then wider ones, then a plain L. */
function astar(ax: number, ay: number, ad: number, bx: number, by: number, bd: number, blocked: ReadonlySet<string>, used: Map<string, number>): Leg {
  if (ax === bx && ay === by) return { pts: [[ax, ay]], dir: ad };
  const need = bd >= 0 ? (bd + 2) % 4 : -1;
  for (const m of [6, 20, 60]) {
    const x0 = Math.min(ax, bx) - m;
    const y0 = Math.min(ay, by) - m;
    const W = Math.abs(ax - bx) + 2 * m + 1;
    const H = Math.abs(ay - by) + 2 * m + 1;
    const N = W * H * 5;
    const cost = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    const idx = (x: number, y: number, d: number): number => ((y - y0) * W + (x - x0)) * 5 + (d + 1);
    const heap = new Heap();
    const s = idx(ax, ay, ad);
    cost[s] = 0;
    heap.push(Math.abs(ax - bx) + Math.abs(ay - by), s);
    while (heap.size > 0) {
      const cur = heap.pop();
      if (done[cur] === 1) continue;
      done[cur] = 1;
      const d = (cur % 5) - 1;
      const cell = (cur / 5) | 0;
      const x = (cell % W) + x0;
      const y = ((cell / W) | 0) + y0;
      if (x === bx && y === by) {
        const pts: XY[] = [];
        for (let k = cur; k >= 0; k = parent[k] ?? -1) {
          const c2 = (k / 5) | 0;
          pts.push([(c2 % W) + x0, ((c2 / W) | 0) + y0]);
        }
        return { pts: pts.reverse(), dir: d };
      }
      const g = cost[cur] ?? Infinity;
      for (let nd = 0; nd < 4; nd += 1) {
        if (d >= 0 && nd === (d + 2) % 4) continue;
        const step = DIRS[nd] ?? [0, 0];
        const nx = x + step[0];
        const ny = y + step[1];
        if (nx < x0 || ny < y0 || nx >= x0 + W || ny >= y0 + H) continue;
        const goal = nx === bx && ny === by;
        const key = `${nx},${ny}`;
        if (!goal && blocked.has(key)) continue;
        let c = 1 + (d >= 0 && nd !== d ? TURN : 0);
        if (goal && need >= 0 && nd !== need) c += nd === bd ? TURN * 3 : TURN;
        const u = used.get(key);
        if (u !== undefined && (u & (nd % 2 ? 2 : 1)) !== 0) c += 2.5;
        const ni = idx(nx, ny, nd);
        const g2 = g + c;
        if (g2 < (cost[ni] ?? Infinity)) {
          cost[ni] = g2;
          parent[ni] = cur;
          heap.push(g2 + Math.abs(nx - bx) + Math.abs(ny - by), ni);
        }
      }
    }
  }
  return { pts: [[ax, ay], [bx, ay], [bx, by]], dir: by !== ay ? (by > ay ? 1 : 3) : bx > ax ? 0 : 2 };
}

/** Drops the collinear vertices, so a straight run is two points. */
export function simplify(points: readonly XY[]): XY[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const first = points[0] as XY;
  const out: XY[] = [[first[0], first[1]]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1] as XY;
    const b = points[i] as XY;
    const c = points[i + 1] as XY;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (Math.sign(b[0] - a[0]) === Math.sign(c[0] - b[0]) && Math.sign(b[1] - a[1]) === Math.sign(c[1] - b[1])) continue;
    out.push([b[0], b[1]]);
  }
  const last = points[points.length - 1] as XY;
  out.push([last[0], last[1]]);
  return out;
}

function markUsed(p: readonly XY[], used: Map<string, number>): void {
  for (let i = 0; i < p.length - 1; i += 1) {
    const a = p[i] as XY;
    const b = p[i + 1] as XY;
    const bit = a[1] === b[1] ? 1 : 2;
    for (const q of [a, b]) {
      const k = `${q[0]},${q[1]}`;
      used.set(k, (used.get(k) ?? 0) | bit);
    }
  }
}

/** A box blocks its border too; a system boundary and a freehand element block nothing. */
function blockedCells(nodes: readonly DiagramNode[], rects: ReadonlyMap<string, Rect>): Set<string> {
  const blocked = new Set<string>();
  for (const n of nodes) {
    if (n.t === "system" || n.t === "stroke" || n.t === "line") continue;
    const r = rects.get(n.id);
    if (!r) continue;
    for (let gx = Math.ceil(r.x0 / GRID); gx <= Math.floor(r.x1 / GRID); gx += 1)
      for (let gy = Math.ceil(r.y0 / GRID); gy <= Math.floor(r.y1 / GRID); gy += 1) blocked.add(`${gx},${gy}`);
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Onto the shape: an ellipse, a diamond, a circle
// ---------------------------------------------------------------------------

type Onto = (p: XY, r: Rect, d: number) => XY;

const ontoEllipse: Onto = (p, r, d) => {
  const a = r.w / 2;
  const b = r.h / 2;
  const cx = r.x0 + a;
  const cy = r.y0 + b;
  if (d === 1 || d === 3) {
    const k = Math.sqrt(Math.max(0, 1 - ((p[0] - cx) / a) ** 2));
    return [p[0], d === 3 ? cy - b * k : cy + b * k];
  }
  const k = Math.sqrt(Math.max(0, 1 - ((p[1] - cy) / b) ** 2));
  return [d === 2 ? cx - a * k : cx + a * k, p[1]];
};

const ontoDiamond: Onto = (p, r, d) => {
  const a = r.w / 2;
  const b = r.h / 2;
  const cx = r.x0 + a;
  const cy = r.y0 + b;
  if (d === 1 || d === 3) {
    const k = 1 - Math.abs(p[0] - cx) / a;
    return [p[0], d === 3 ? cy - b * k : cy + b * k];
  }
  const k = 1 - Math.abs(p[1] - cy) / b;
  return [d === 2 ? cx - a * k : cx + a * k, p[1]];
};

const ontoCircle =
  (radius: number): Onto =>
  (p, r, d) => {
    const cx = r.x0 + r.w / 2;
    const cy = r.y0 + r.h / 2;
    if (d === 1 || d === 3) {
      const k = Math.sqrt(Math.max(0, radius * radius - (p[0] - cx) ** 2));
      return [p[0], d === 3 ? cy - k : cy + k];
    }
    const k = Math.sqrt(Math.max(0, radius * radius - (p[1] - cy) ** 2));
    return [d === 2 ? cx - k : cx + k, p[1]];
  };

const ONTO: Partial<Record<DiagramNode["t"], Onto>> = {
  usecase: ontoEllipse,
  decision: ontoDiamond,
  initial: ontoCircle(9),
  final: ontoCircle(11),
};

function orthogonal(nodes: readonly DiagramNode[], links: readonly LinkLike[], rects: ReadonlyMap<string, Rect>): Map<string, Route> {
  const ends = anchors(nodes, links, rects);
  const blocked = blockedCells(nodes, rects);
  const used = new Map<string, number>();
  const types = new Map(nodes.map((n) => [n.id, n.t] as const));
  const out = new Map<string, Route>();
  for (const l of links) {
    let a = ends.get(`${l.id}:a`);
    let b: End | undefined =
      typeof l.b === "string" ? ends.get(`${l.id}:b`) : { x: snap(l.b.x), y: snap(l.b.y), d: -1 };
    if (!a || !b) continue;
    const stops: End[] = [a, ...l.via.map((v): End => ({ x: v.x, y: v.y, d: -1 })), b];
    const grid: XY[] = [];
    let dir: number = a.d;
    for (let i = 0; i < stops.length - 1; i += 1) {
      const s = stops[i] as End;
      const t = stops[i + 1] as End;
      const leg = astar(s.x / GRID, s.y / GRID, dir, t.x / GRID, t.y / GRID, i === stops.length - 2 ? t.d : -1, blocked, used);
      if (grid.length > 0) leg.pts.shift();
      grid.push(...leg.pts);
      if (leg.dir >= 0) dir = leg.dir;
    }
    markUsed(grid, used);
    const pts = simplify(grid).map(([x, y]): XY => [x * GRID, y * GRID]);
    const ta = types.get(l.a);
    const tb = typeof l.b === "string" ? types.get(l.b) : undefined;
    const ontoA = ta ? ONTO[ta] : undefined;
    const ontoB = tb ? ONTO[tb] : undefined;
    const ra = rects.get(l.a);
    const rb = typeof l.b === "string" ? rects.get(l.b) : undefined;
    if (ontoA && ra && pts[0]) {
      pts[0] = ontoA(pts[0], ra, a.d);
      a = { ...a, x: pts[0][0], y: pts[0][1] };
    }
    const k = pts.length - 1;
    if (ontoB && rb && pts[k]) {
      pts[k] = ontoB(pts[k], rb, b.d);
      b = { ...b, x: pts[k][0], y: pts[k][1] };
    }
    out.set(l.id, { pts, a, b });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Straight lines between circles
// ---------------------------------------------------------------------------

function straight(links: readonly LinkLike[], rects: ReadonlyMap<string, Rect>): Map<string, Route> {
  const circle = (id: string): { x: number; y: number; r: number } | undefined => {
    const r = rects.get(id);
    return r && { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, r: r.w / 2 };
  };
  const rim = (p: { x: number; y: number; r: number }, t: { x: number; y: number }): XY => {
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    return [p.x + (dx / len) * p.r, p.y + (dy / len) * p.r];
  };
  const pair = (l: LinkLike): string => [l.a, l.b as string].sort().join("|");
  const groups = new Map<string, string[]>();
  for (const l of links)
    if (typeof l.b === "string" && l.a !== l.b && l.via.length === 0) groups.set(pair(l), [...(groups.get(pair(l)) ?? []), l.id]);

  const loops = new Map<string, number>();
  const out = new Map<string, Route>();
  for (const l of links) {
    const A = circle(l.a);
    const B = typeof l.b === "string" ? circle(l.b) : { x: l.b.x, y: l.b.y, r: 0 };
    if (!A || !B) continue;
    let route: Omit<Route, "a" | "b">;
    if (l.a === l.b && l.via.length === 0) {
      /* a loop over the top, the next one a size larger */
      const i = loops.get(l.a) ?? 0;
      loops.set(l.a, i + 1);
      const k = 1 + 0.45 * i;
      const at = (deg: number): XY => [A.x + A.r * Math.cos((deg * Math.PI) / 180), A.y + A.r * Math.sin((deg * Math.PI) / 180)];
      const a = at(-120);
      const b = at(-60);
      const c1: XY = [A.x - A.r * 1.3 * k, A.y - A.r * 2.5 * k];
      const c2: XY = [A.x + A.r * 1.3 * k, A.y - A.r * 2.5 * k];
      const top = 0.125 * a[1] + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * b[1];
      route = { path: `M${a[0]} ${a[1]}C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${b[0]} ${b[1]}`, aim: [c2, b], pts: [a, [A.x, top], b], label: { x: A.x, y: top - 7 } };
    } else if (l.via.length > 0) {
      const first = l.via[0] as Point;
      const last = l.via[l.via.length - 1] as Point;
      const pts: XY[] = [rim(A, first), ...l.via.map((v): XY => [v.x, v.y]), rim(B, last)];
      const i = Math.floor((pts.length - 1) / 2);
      const p0 = pts[i] as XY;
      const p1 = pts[i + 1] as XY;
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      route = { pts, label: { x: (p0[0] + p1[0]) / 2 - ((p1[1] - p0[1]) / len) * 12, y: (p0[1] + p1[1]) / 2 + ((p1[0] - p0[0]) / len) * 12 } };
    } else {
      /* the lines of one pair fan out around the straight one; the normal is
         taken in a fixed order of the pair, so a→b and b→a bend apart */
      const g = typeof l.b === "string" ? groups.get(pair(l)) : undefined;
      const n = g ? g.length : 1;
      const k = g ? (g.indexOf(l.id) - (n - 1) / 2) * 30 : 0;
      const [p, q] = typeof l.b === "string" && l.b < l.a ? [B, A] : [A, B];
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      const nx = -(q.y - p.y) / len;
      const ny = (q.x - p.x) / len;
      if (k === 0) {
        const a = rim(A, B);
        const b = rim(B, A);
        route = { pts: [a, b], label: { x: (a[0] + b[0]) / 2 + nx * 12, y: (a[1] + b[1]) / 2 + ny * 12 } };
      } else {
        const c = { x: (A.x + B.x) / 2 + nx * 2 * k, y: (A.y + B.y) / 2 + ny * 2 * k };
        const a = rim(A, c);
        const b = rim(B, c);
        const s = Math.sign(k);
        const mid: XY = [0.25 * a[0] + 0.5 * c.x + 0.25 * b[0], 0.25 * a[1] + 0.5 * c.y + 0.25 * b[1]];
        route = { path: `M${a[0]} ${a[1]}Q${c.x} ${c.y} ${b[0]} ${b[1]}`, aim: [[c.x, c.y], b], pts: [a, mid, b], label: { x: mid[0] + nx * s * 12, y: mid[1] + ny * s * 12 } };
      }
    }
    const f = route.pts[0] as XY;
    const z = route.pts[route.pts.length - 1] as XY;
    out.set(l.id, { ...route, a: { x: f[0], y: f[1], d: -1 }, b: { x: z[0], y: z[1], d: -1 } });
  }
  return out;
}

