/**
 * The rules of the `blocks` question type (docs/04 §4.17, ADR-103): a
 * program of blocks drives a warehouse robot from its start cell to the dock.
 * This module is the REFERENCE for what a program means; the spec and the ADR
 * point here. It is the ONE interpreter: the browser animates its trace, the
 * server grades with its verdict. It never evaluates code: no `eval`, no
 * `new Function`, no Blockly — the program is our own syntax tree (`Stmt`).
 *
 * THE WORLD. A map is a grid of ASCII rows (`parseMap`): `.` floor, `#` rack,
 * one of `^ > v <` the start cell and the robot's heading (north, east, south,
 * west), `D` the dock. `x` counts columns from the left, `y` rows from the
 * top: north is `y − 1`.
 *
 * THE RUN, for one map and one battery:
 *
 *   forward             moves one cell ahead. Into a rack or off the map the
 *                       run stops with `collision` and the move is not
 *                       counted; with no battery left it stops with `battery`
 *                       (a collision is checked first). Reaching the dock ends
 *                       the run at once with `dock`.
 *   turn                turns a quarter left or right, costs no battery.
 *   repeat              runs its body `times` times.
 *   repeat_until_dock   runs its body again and again; the re-test before each
 *                       iteration never sees the dock, since reaching it has
 *                       already ended the run.
 *   if_sensor           tests the cell in front, to the left or to the right
 *                       of the robot: `free` is inside the map and not a rack
 *                       (the dock is free), `blocked` is its negation.
 *
 * A program that ends anywhere but the dock ends with `short`. Each event
 * names its statement by a `NodePath`; inside an `if_sensor` the path names
 * the branch too (0 `then`, 1 `else`), so a client highlights the very block.
 *
 * THE BUDGET (ADR-103 §4). Every node visit and every loop iteration costs
 * one step, so nested empty loops are as bounded as anything else. Beyond
 * `stepBudget(battery)` steps the run stops with `loop`. The battery is
 * clamped here to 0..`BATTERY_MAX` whatever the caller passes (NaN and the
 * infinities count as 0), so this module alone bounds a run. Each event is
 * emitted by a step, so a trace never holds more events than the budget.
 *
 * THE LIMITS. `simulate`, `runProgram`, `usedKinds` and `programEquals`
 * recurse and assume a program within `PROGRAM_LIMITS`; `programStats` is the
 * guard every schema runs first, on raw input, before any recursive parse.
 */

export type TurnDir = "left" | "right";
/** North, east, south, west. */
export type Heading = 0 | 1 | 2 | 3;

/** One statement of a program: the stored answer, English kinds, no positions. */
export type Stmt =
  | { kind: "forward" }
  | { kind: "turn"; dir: TurnDir }
  | { kind: "repeat"; times: number; body: Stmt[] }
  | { kind: "repeat_until_dock"; body: Stmt[] }
  | {
      kind: "if_sensor";
      sensor: "free" | "blocked";
      where: "front" | "left" | "right";
      then: Stmt[];
      else: Stmt[];
    };

export type BlockKind = Stmt["kind"];

/** Every kind, in the toolbox's order: the default toolbox. */
export const BLOCK_KINDS: readonly BlockKind[] = ["forward", "turn", "repeat", "repeat_until_dock", "if_sensor"];

/**
 * The caps of every program a schema accepts — an answer, a starter, a
 * reference: statements, nesting levels, iterations of a `repeat`.
 */
export const PROGRAM_LIMITS = { nodes: 200, depth: 16, repeatMax: 40 } as const;

/** The largest battery of a case: a 12 × 12 map has 144 cells. It bounds every run (`stepBudget`). */
export const BATTERY_MAX = 200;

/** Every statement of a program with its level (top level 1), depth first, in order. */
function* walk(program: Stmt[]): Generator<{ stmt: Stmt; level: number }> {
  // An explicit stack, so that `programStats` measures a program of any depth
  // and a schema can refuse one too deep BEFORE any recursive parse.
  const stack = (Array.isArray(program) ? program : []).map((stmt) => ({ stmt, level: 1 })).reverse();
  for (let top = stack.pop(); top; top = stack.pop()) {
    yield top;
    const children = bodies(top.stmt).flat();
    for (let i = children.length - 1; i >= 0; i--) stack.push({ stmt: children[i]!, level: top.level + 1 });
  }
}

/** Where each kind keeps its bodies. */
const BODIES = new Map<unknown, readonly string[]>([
  ["repeat", ["body"]],
  ["repeat_until_dock", ["body"]],
  ["if_sensor", ["then", "else"]],
]);

/** The bodies of a statement; on raw input a missing or malformed body counts as empty. */
function bodies(stmt: Stmt): Stmt[][] {
  const node = (stmt ?? {}) as unknown as Record<string, unknown>;
  return (BODIES.get(node.kind) ?? []).map((key) => node[key]).filter((body): body is Stmt[] => Array.isArray(body));
}

/**
 * How many statements a program holds and how deeply it nests (an empty
 * program: 0 and 0). Iterative and tolerant of malformed nodes: the guard a
 * schema runs on raw input against `PROGRAM_LIMITS`.
 */
export function programStats(program: Stmt[]): { nodes: number; depth: number } {
  let nodes = 0;
  let depth = 0;
  for (const { level } of walk(program)) {
    nodes++;
    depth = Math.max(depth, level);
  }
  return { nodes, depth };
}

/** The kinds a program uses: a kind the toolbox does not offer is a misfit answer. */
export function usedKinds(program: Stmt[]): Set<BlockKind> {
  return new Set(Array.from(walk(program), ({ stmt }) => stmt.kind));
}

/** A statement reduced to its meaning: fields in a fixed order, anything else dropped. */
function canonical(stmt: Stmt): unknown[] {
  switch (stmt.kind) {
    case "forward":
      return [stmt.kind];
    case "turn":
      return [stmt.kind, stmt.dir];
    case "repeat":
      return [stmt.kind, stmt.times, stmt.body.map(canonical)];
    case "repeat_until_dock":
      return [stmt.kind, stmt.body.map(canonical)];
    case "if_sensor":
      return [stmt.kind, stmt.sensor, stmt.where, stmt.then.map(canonical), stmt.else.map(canonical)];
  }
}

/** True when two programs are the same statements: whether an answer still is the starter. */
export function programEquals(a: Stmt[], b: Stmt[]): boolean {
  return JSON.stringify(a.map(canonical)) === JSON.stringify(b.map(canonical));
}

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------

export interface GridMap {
  width: number;
  height: number;
  /** The racks' cells, as `"x,y"`. */
  racks: ReadonlySet<string>;
  start: { x: number; y: number; heading: Heading };
  dock: { x: number; y: number };
}

/** The message keys of a refused map (`issue.blocks.*` on the web). */
export type MapErrorKey =
  | "blocks.map_too_small"
  | "blocks.map_too_large"
  | "blocks.map_bad_char"
  | "blocks.map_not_rectangular"
  | "blocks.map_no_start"
  | "blocks.map_two_starts"
  | "blocks.map_no_dock"
  | "blocks.map_two_docks";

/** A refused map; its message is its key. */
export class MapError extends Error {
  constructor(readonly key: MapErrorKey) {
    super(key);
    this.name = "MapError";
  }
}

/** Sides of a map, in cells. */
export const MAP_SIZE = { min: 3, max: 12 } as const;
/** The start cell's glyph for each heading: `HEADINGS[heading]`. */
export const HEADINGS = "^>v<";
const CELL = /^[.#^>v<D]*$/;

const cellKey = (x: number, y: number) => `${x},${y}`;

/** Reads a map from its rows; throws a `MapError` on anything but a valid one. */
export function parseMap(rows: readonly string[]): GridMap {
  const height = rows.length;
  if (height < MAP_SIZE.min) throw new MapError("blocks.map_too_small");
  if (height > MAP_SIZE.max) throw new MapError("blocks.map_too_large");
  if (!rows.every((row) => CELL.test(row))) throw new MapError("blocks.map_bad_char");
  const width = rows[0]!.length;
  if (rows.some((row) => row.length !== width)) throw new MapError("blocks.map_not_rectangular");
  if (width < MAP_SIZE.min) throw new MapError("blocks.map_too_small");
  if (width > MAP_SIZE.max) throw new MapError("blocks.map_too_large");
  const racks = new Set<string>();
  const starts: GridMap["start"][] = [];
  const docks: GridMap["dock"][] = [];
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      if (char === "#") racks.add(cellKey(x, y));
      else if (char === "D") docks.push({ x, y });
      else if (char !== ".") starts.push({ x, y, heading: HEADINGS.indexOf(char) as Heading });
    });
  });
  if (starts.length === 0) throw new MapError("blocks.map_no_start");
  if (starts.length > 1) throw new MapError("blocks.map_two_starts");
  if (docks.length === 0) throw new MapError("blocks.map_no_dock");
  if (docks.length > 1) throw new MapError("blocks.map_two_docks");
  return { width, height, racks, start: starts[0]!, dock: docks[0]! };
}

/** Writes a map back to its rows, the inverse of `parseMap`. */
export function formatMap(map: GridMap): string[] {
  const grid = Array.from({ length: map.height }, () => Array<string>(map.width).fill("."));
  for (const rack of map.racks) {
    const [x, y] = rack.split(",").map(Number);
    grid[y!]![x!] = "#";
  }
  grid[map.dock.y]![map.dock.x] = "D";
  grid[map.start.y]![map.start.x] = HEADINGS[map.start.heading]!;
  return grid.map((row) => row.join(""));
}

// ---------------------------------------------------------------------------
// The interpreter
// ---------------------------------------------------------------------------

/**
 * Where a statement sits: indices into the program and its bodies. `[2, 0]`
 * is the first statement of the body of the third statement (a `repeat` or a
 * `repeat_until_dock`). An `if_sensor` has two bodies, so a statement inside
 * one gains the branch first: `[...ifPath, 0, n]` is the n-th statement of
 * `then`, `[...ifPath, 1, n]` the n-th of `else`.
 */
export type NodePath = readonly number[];

/**
 * One thing the robot did, with its pose after it. On `collision` and
 * `battery` the last event is the `forward` that failed, its pose unchanged:
 * the block to highlight. A `test` is a sensor read or a loop's re-test.
 */
export type RunEvent = {
  op: "forward" | "turn" | "test";
  path: NodePath;
  pose: { x: number; y: number; heading: Heading };
};

/** How a run can end: the one list of the reasons. */
export const RUN_REASONS = ["dock", "collision", "battery", "loop", "short"] as const;
export type RunReason = (typeof RUN_REASONS)[number];

/** How a run ended. */
export interface RunVerdict {
  ok: boolean;
  reason: RunReason;
  /** Forward moves made, which is the battery spent. */
  moves: number;
}

export interface RunResult extends RunVerdict {
  /** The cells the robot stood on, start first. */
  trail: { x: number; y: number }[];
  /** Every event, unless the caller asked for none (`events: false`). */
  events: RunEvent[];
}

/** A battery as the run uses it: a whole number in 0..`BATTERY_MAX`, 0 when not finite. */
function clampBattery(battery: number): number {
  return Number.isFinite(battery) ? Math.min(Math.max(Math.floor(battery), 0), BATTERY_MAX) : 0;
}

/** The steps a run may take on a map whose battery is `battery` (clamped, see the header). */
export function stepBudget(battery: number): number {
  return 50 * clampBattery(battery) + 100;
}

/** Cell offsets of the four headings: north, east, south, west. */
const AHEAD = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;
/** Quarter turns from the heading to the side a sensor reads. */
const SIDE = { front: 0, right: 1, left: 3 } as const;

/** Runs a program step by step: yields what the robot does, returns how the run ended. */
export function* simulate(
  program: Stmt[],
  map: GridMap,
  battery: number,
): Generator<RunEvent, RunVerdict> {
  const charge = clampBattery(battery);
  const budget = stepBudget(charge);
  let steps = 0;
  let moves = 0;
  let { x, y, heading } = map.start;

  const free = (cx: number, cy: number) =>
    cx >= 0 && cy >= 0 && cx < map.width && cy < map.height && !map.racks.has(cellKey(cx, cy));
  const ahead = (turns: number) => {
    const [dx, dy] = AHEAD[((heading + turns) % 4) as Heading];
    return { x: x + dx, y: y + dy };
  };
  const event = (op: RunEvent["op"], path: NodePath): RunEvent => ({ op, path, pose: { x, y, heading } });
  /** Spends one step; true once the budget is gone. */
  const exhausted = () => ++steps > budget;

  /** Runs a body; returns the reason the run ended, or null to carry on. */
  function* block(body: Stmt[], at: NodePath): Generator<RunEvent, RunReason | null> {
    for (const [i, stmt] of body.entries()) {
      if (exhausted()) return "loop";
      const ended = yield* visit(stmt, [...at, i]);
      if (ended) return ended;
    }
    return null;
  }

  function* visit(stmt: Stmt, path: NodePath): Generator<RunEvent, RunReason | null> {
    switch (stmt.kind) {
      case "forward": {
        const next = ahead(0);
        const refused: RunReason | null = !free(next.x, next.y) ? "collision" : moves >= charge ? "battery" : null;
        if (refused === null) {
          ({ x, y } = next);
          moves++;
        }
        yield event("forward", path);
        if (refused) return refused;
        return x === map.dock.x && y === map.dock.y ? "dock" : null;
      }
      case "turn":
        heading = ((heading + (stmt.dir === "right" ? 1 : 3)) % 4) as Heading;
        yield event("turn", path);
        return null;
      case "repeat":
        for (let i = 0; i < stmt.times; i++) {
          if (exhausted()) return "loop";
          const ended = yield* block(stmt.body, path);
          if (ended) return ended;
        }
        return null;
      case "repeat_until_dock":
        for (;;) {
          if (exhausted()) return "loop";
          yield event("test", path);
          const ended = yield* block(stmt.body, path);
          if (ended) return ended;
        }
      case "if_sensor": {
        const cell = ahead(SIDE[stmt.where]);
        yield event("test", path);
        const taken = free(cell.x, cell.y) === (stmt.sensor === "free") ? 0 : 1;
        return yield* block(taken === 0 ? stmt.then : stmt.else, [...path, taken]);
      }
    }
  }

  const reason = (yield* block(program, [])) ?? "short";
  return { ok: reason === "dock", reason, moves };
}

/**
 * Runs a program to its end: the verdict, the trail and the trace. The server
 * grades with `events: false`: the trace is for the browser's animation.
 */
export function runProgram(
  program: Stmt[],
  map: GridMap,
  battery: number,
  options: { events?: boolean } = {},
): RunResult {
  const keep = options.events ?? true;
  const run = simulate(program, map, battery);
  const events: RunEvent[] = [];
  const trail = [{ x: map.start.x, y: map.start.y }];
  for (let next = run.next(); ; next = run.next()) {
    if (next.done) return { ...next.value, trail, events };
    const { op, pose } = next.value;
    const last = trail[trail.length - 1]!;
    // A failed forward is an event whose pose did not change: no new cell.
    if (op === "forward" && (pose.x !== last.x || pose.y !== last.y)) trail.push({ x: pose.x, y: pose.y });
    if (keep) events.push(next.value);
  }
}
