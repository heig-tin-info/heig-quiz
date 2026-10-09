/**
 * The orthogonal A* router on a grid, from `mockups/circuit.html`: a turn
 * penalty, blocked cells as obstacles and a small cost for running along a
 * line already there. One search shared by the circuit's wires
 * (`@quiz/qt-circuit`, clipped to its box) and the diagram's lines
 * (`@quiz/diagram`, unbounded); what blocks a cell stays with each of them.
 *
 * Everything here is in GRID STEPS, and a cell is keyed `"x,y"`. A route that
 * changes here is a wire that moves on a student's canvas, so both callers
 * pin their output with golden tests.
 */

/** A grid point, in grid steps. */
export type Cell = [number, number];

/** Right, down, left, up: a direction's index is what `d` holds, `-1` being "none". */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** What a corner costs, in grid steps. Four keeps a route from zig-zagging for nothing. */
const TURN = 4;

/** Running along a line already there, in the same orientation. */
const OVERLAP = 2.5;

export const cellKey = (x: number, y: number): string => `${x},${y}`;

/** Cells a route may not cross, and the orientations already running through each cell (bit 1 horizontal, 2 vertical). */
export interface Obstacles {
  readonly blocked: ReadonlySet<string>;
  readonly used: Map<string, number>;
}

/** One routed leg, in grid steps, and the direction it arrived in. */
export interface Leg {
  pts: Cell[];
  dir: number;
}

/** The inclusive grid rectangle no search may leave. */
export interface GridBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface SearchOptions {
  /** The margins of the successive search windows around the two ends, tightest first. */
  readonly margins: readonly number[];
  /** Where every window is clipped, when the route must stay inside a box. */
  readonly clip?: GridBox;
}

/** Where a leg must end: `d` is the end's direction, `need` the one to arrive from (`-1`: any). */
interface Goal {
  readonly x: number;
  readonly y: number;
  readonly d: number;
  readonly need: number;
}

/**
 * The grid rectangle one pass explores. A search node is a (cell, arrival
 * direction) pair, flattened to one integer: five slots per cell, `d + 1`,
 * so that "no direction yet" (−1) has one too.
 */
interface SearchWindow {
  readonly x0: number;
  readonly y0: number;
  readonly W: number;
  readonly H: number;
}

/** No bound at all: the diagram's canvas. */
const UNBOUNDED: GridBox = { x0: -Infinity, y0: -Infinity, x1: Infinity, y1: Infinity };

/**
 * The window `m` cells around both ends, clipped. Its size is the span of the
 * ends plus the margins, LESS what the clip cut off: written so, an unclipped
 * window is `|a − b| + 2m + 1` to the bit even on off-grid (fractional)
 * coordinates, where `x1 − x0 + 1` can differ by an ulp and move a route.
 */
function windowAround(ax: number, ay: number, bx: number, by: number, m: number, clip: GridBox = UNBOUNDED): SearchWindow {
  const x0 = Math.max(clip.x0, Math.min(ax, bx) - m);
  const y0 = Math.max(clip.y0, Math.min(ay, by) - m);
  const cutX = x0 - (Math.min(ax, bx) - m) + (Math.max(ax, bx) + m - Math.min(clip.x1, Math.max(ax, bx) + m));
  const cutY = y0 - (Math.min(ay, by) - m) + (Math.max(ay, by) + m - Math.min(clip.y1, Math.max(ay, by) + m));
  return { x0, y0, W: Math.abs(ax - bx) + 2 * m + 1 - cutX, H: Math.abs(ay - by) + 2 * m + 1 - cutY };
}

const nodeAt = (w: SearchWindow, x: number, y: number, d: number): number => ((y - w.y0) * w.W + (x - w.x0)) * 5 + (d + 1);

function cellOf(w: SearchWindow, node: number): Cell {
  const c = (node / 5) | 0;
  return [(c % w.W) + w.x0, ((c / w.W) | 0) + w.y0];
}

/** The path that reached `node`, start first, from the parent links. */
function reconstruct(w: SearchWindow, parent: Int32Array, node: number): Cell[] {
  const out: Cell[] = [];
  for (let k = node; k >= 0; k = parent[k] ?? -1) out.push(cellOf(w, k));
  return out.reverse();
}

/** The steps out of `(x, y)` when arriving in direction `d`: never doubling back, never leaving the window. */
function neighbours(w: SearchWindow, x: number, y: number, d: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  DIRS.forEach(([sx, sy], nd) => {
    if (d >= 0 && nd === (d + 2) % 4) return;
    const nx = x + sx;
    const ny = y + sy;
    if (nx >= w.x0 && ny >= w.y0 && nx < w.x0 + w.W && ny < w.y0 + w.H) out.push([nd, nx, ny]);
  });
  return out;
}

/** What the step in direction `nd` onto `(nx, ny)` costs; `null` when the cell is blocked. */
function stepCost(d: number, nd: number, nx: number, ny: number, goal: Goal, { blocked, used }: Obstacles): number | null {
  const atGoal = nx === goal.x && ny === goal.y;
  const cell = cellKey(nx, ny);
  if (!atGoal && blocked.has(cell)) return null;
  let c = 1 + (d >= 0 && nd !== d ? TURN : 0);
  /* arriving at the end from the wrong side costs more than a detour */
  if (atGoal && goal.need >= 0 && nd !== goal.need) c += nd === goal.d ? TURN * 3 : TURN;
  const u = used.get(cell);
  if (u !== undefined && (u & (nd % 2 ? 2 : 1)) !== 0) c += OVERLAP;
  return c;
}

/**
 * One A* pass inside a window: the leg, or `null` when the goal cannot be
 * reached within it. The heuristic is the Manhattan distance, and the heap
 * is deterministic (same pushes, same pops), which makes a route reproducible.
 */
function searchWindow(w: SearchWindow, ax: number, ay: number, ad: number, goal: Goal, obstacles: Obstacles): Leg | null {
  const n = w.W * w.H * 5;
  const cost = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap();
  const start = nodeAt(w, ax, ay, ad);
  cost[start] = 0;
  heap.push(Math.abs(ax - goal.x) + Math.abs(ay - goal.y), start);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (done[cur] === 1) continue;
    done[cur] = 1;
    const d = (cur % 5) - 1;
    const [x, y] = cellOf(w, cur);
    if (x === goal.x && y === goal.y) return { pts: reconstruct(w, parent, cur), dir: d };
    const g = cost[cur] ?? Infinity;
    for (const [nd, nx, ny] of neighbours(w, x, y, d)) {
      const c = stepCost(d, nd, nx, ny, goal, obstacles);
      if (c === null) continue;
      const ni = nodeAt(w, nx, ny, nd);
      const g2 = g + c;
      if (g2 < (cost[ni] ?? Infinity)) {
        cost[ni] = g2;
        parent[ni] = cur;
        heap.push(g2 + Math.abs(nx - goal.x) + Math.abs(ny - goal.y), ni);
      }
    }
  }
  return null;
}

/**
 * One leg from `(ax, ay)`, leaving in direction `ad`, to `(bx, by)`, met
 * head on from direction `bd` (`-1`: free). One pass per margin, tightest
 * first; when none gets through, the plain L, still orthogonal and on grid.
 */
export function astar(ax: number, ay: number, ad: number, bx: number, by: number, bd: number, obstacles: Obstacles, options: SearchOptions): Leg {
  if (ax === bx && ay === by) return { pts: [[ax, ay]], dir: ad };
  const goal: Goal = { x: bx, y: by, d: bd, need: bd >= 0 ? (bd + 2) % 4 : -1 };
  for (const margin of options.margins) {
    const leg = searchWindow(windowAround(ax, ay, bx, by, margin, options.clip), ax, ay, ad, goal, obstacles);
    if (leg !== null) return leg;
  }
  return { pts: [[ax, ay], [bx, ay], [bx, by]], dir: by !== ay ? (by > ay ? 1 : 3) : bx > ax ? 0 : 2 };
}

/** Drops the collinear vertices, so a straight run is two points and not twenty. */
export function simplify(points: ReadonlyArray<readonly [number, number]>): Cell[] {
  if (points.length < 3) return points.map((p) => [p[0], p[1]]);
  const first = points[0] as readonly [number, number];
  const out: Cell[] = [[first[0], first[1]]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = out[out.length - 1] as Cell;
    const b = points[i] as readonly [number, number];
    const c = points[i + 1] as readonly [number, number];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    if (Math.sign(b[0] - a[0]) === Math.sign(c[0] - b[0]) && Math.sign(b[1] - a[1]) === Math.sign(c[1] - b[1])) continue;
    out.push([b[0], b[1]]);
  }
  const last = points[points.length - 1] as readonly [number, number];
  out.push([last[0], last[1]]);
  return out;
}

/** Records the cells a finished route occupies, in grid steps, so the next one prefers to go elsewhere. */
export function markUsed(points: ReadonlyArray<readonly [number, number]>, used: Map<string, number>): void {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] as readonly [number, number];
    const b = points[i + 1] as readonly [number, number];
    const bit = a[1] === b[1] ? 1 : 2;
    for (const q of [a, b]) {
      const k = cellKey(q[0], q[1]);
      used.set(k, (used.get(k) ?? 0) | bit);
    }
  }
}

/**
 * A binary heap of (priority, node). `Array.sort` on every push made the
 * router the slowest thing on the canvas while a component was dragged.
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
