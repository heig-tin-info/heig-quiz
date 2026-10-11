import { describe, expect, it } from "vitest";

import {
  BATTERY_MAX,
  formatMap,
  HEADINGS,
  MapError,
  MAP_SIZE,
  parseMap,
  programEquals,
  programStats,
  runProgram,
  simulate,
  stepBudget,
  usedKinds,
  type Stmt,
} from "./blocks.js";

const F: Stmt = { kind: "forward" };
const L: Stmt = { kind: "turn", dir: "left" };
const R: Stmt = { kind: "turn", dir: "right" };
const rep = (times: number, ...body: Stmt[]): Stmt => ({ kind: "repeat", times, body });
const until = (...body: Stmt[]): Stmt => ({ kind: "repeat_until_dock", body });
const ifs = (
  sensor: "free" | "blocked",
  where: "front" | "left" | "right",
  then: Stmt[],
  otherwise: Stmt[] = [],
): Stmt => ({ kind: "if_sensor", sensor, where, then, else: otherwise });

/** Three cells east of the start, the dock. */
const corridor = parseMap(["....", ">..D", "...."]);

describe("stepBudget", () => {
  it("derives the budget from the battery: 50 steps a move, 100 to spare", () => {
    expect(stepBudget(0)).toBe(100);
    expect(stepBudget(40)).toBe(2100);
    expect(stepBudget(BATTERY_MAX)).toBe(10_100);
  });

  it("clamps whatever battery it is given to a whole number in 0..BATTERY_MAX", () => {
    expect(stepBudget(1e9)).toBe(10_100);
    expect(stepBudget(2.7)).toBe(200);
    for (const battery of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(stepBudget(battery)).toBe(100);
    }
  });
});

describe("runProgram: forward and the dock", () => {
  it("reaches the dock, counting the moves and the cells", () => {
    const run = runProgram([F, F, F], corridor, 10);
    expect(run).toMatchObject({ ok: true, reason: "dock", moves: 3 });
    expect(run.trail).toEqual([
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
    expect(run.events.map((e) => e.path)).toEqual([[0], [1], [2]]);
    expect(run.events[2]).toEqual({ op: "forward", path: [2], pose: { x: 3, y: 1, heading: 1 } });
  });

  it("ends the run the moment the dock is reached", () => {
    const run = runProgram([F, F, F, F, L], corridor, 10);
    expect(run).toMatchObject({ ok: true, reason: "dock", moves: 3 });
    expect(run.events).toHaveLength(3);
  });

  it("ends short anywhere but the dock, an empty program included", () => {
    expect(runProgram([F], corridor, 10)).toMatchObject({ ok: false, reason: "short", moves: 1 });
    expect(runProgram([], corridor, 10)).toEqual({
      ok: false,
      reason: "short",
      moves: 0,
      trail: [{ x: 0, y: 1 }],
      events: [],
    });
  });

  it("stops on a rack without counting the move; the failed forward is the last event", () => {
    const run = runProgram([F, F, F], parseMap(["....", ">.#D", "...."]), 10);
    expect(run).toMatchObject({ ok: false, reason: "collision", moves: 1 });
    expect(run.trail).toHaveLength(2);
    expect(run.events.at(-1)).toEqual({ op: "forward", path: [1], pose: { x: 1, y: 1, heading: 1 } });
  });

  it("stops at the edge of the map", () => {
    expect(runProgram([F], parseMap(["^..", "...", "..D"]), 10)).toMatchObject({
      ok: false,
      reason: "collision",
      moves: 0,
    });
  });

  it("stops when the battery is empty; the failed forward is the last event", () => {
    const run = runProgram([F, F, F], corridor, 2);
    expect(run).toMatchObject({ ok: false, reason: "battery", moves: 2 });
    expect(run.events.at(-1)).toEqual({ op: "forward", path: [2], pose: { x: 2, y: 1, heading: 1 } });
  });

  it("checks the collision before the battery", () => {
    expect(runProgram([F], parseMap(["....", ">#.D", "...."]), 0).reason).toBe("collision");
  });
});

describe("runProgram: turns and loops", () => {
  it("turns a quarter either way, wrapping around north, for no battery", () => {
    const run = runProgram([L, R, R, R, R, L], parseMap(["^..", "...", "..D"]), 0);
    expect(run.events.map((e) => e.pose.heading)).toEqual([3, 0, 1, 2, 3, 2]);
    expect(run).toMatchObject({ reason: "short", moves: 0 });
  });

  it("repeats a body `times` times, never when `times` is 0", () => {
    const run = runProgram([rep(3, F)], corridor, 10);
    expect(run).toMatchObject({ ok: true, reason: "dock", moves: 3 });
    expect(run.events.map((e) => e.path)).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(runProgram([rep(0, F)], corridor, 10)).toMatchObject({ reason: "short", events: [] });
  });

  it("re-tests before every iteration of repeat_until_dock", () => {
    const run = runProgram([until(F)], corridor, 10);
    expect(run).toMatchObject({ ok: true, reason: "dock", moves: 3 });
    expect(run.events.map((e) => `${e.op}@${e.path.join(".")}`)).toEqual([
      "test@0",
      "forward@0.0",
      "test@0",
      "forward@0.0",
      "test@0",
      "forward@0.0",
    ]);
  });

  it("follows the wall to the dock with sensors only", () => {
    // The program a student is expected to write: forward while the front is
    // free, otherwise turn towards the free side.
    const program = [until(ifs("free", "front", [F], [ifs("free", "left", [L], [R])]))];
    const map = parseMap(["....#", ">..#.", "...#.", "....D"]);
    expect(runProgram(program, map, 20)).toMatchObject({ ok: true, reason: "dock" });
  });
});

describe("runProgram: sensors", () => {
  /**
   * The robot at (1,1) facing north: a rack in front (1,0) and to the left
   * (0,1), the right (2,1) free.
   */
  const boxed = parseMap([".#.", "#^.", "..D"]);
  /** Which branch an `if_sensor` took: `then` turns left, `else` turns right. */
  const branch = (sensor: "free" | "blocked", where: "front" | "left" | "right", map = boxed) => {
    const run = runProgram([ifs(sensor, where, [L], [R])], map, 5);
    expect(run.events[0]).toMatchObject({ op: "test", path: [0] });
    expect(run.events[1]!.path).toEqual([0, run.events[1]!.pose.heading === (map.start.heading + 3) % 4 ? 0 : 1, 0]);
    return run.events[1]!.pose.heading === (map.start.heading + 3) % 4 ? "then" : "else";
  };

  it("reads the three directions relative to the heading", () => {
    expect(branch("free", "front")).toBe("else");
    expect(branch("free", "left")).toBe("else");
    expect(branch("free", "right")).toBe("then");
  });

  it("`blocked` is the negation of `free`", () => {
    expect(branch("blocked", "front")).toBe("then");
    expect(branch("blocked", "left")).toBe("then");
    expect(branch("blocked", "right")).toBe("else");
  });

  it("reads off the map as blocked and the dock as free", () => {
    // Facing south at (0,0): its right is west, off the map; its left is east, free.
    const corner = parseMap(["v..", "...", "D.."]);
    expect(branch("blocked", "right", corner)).toBe("then");
    expect(branch("free", "left", corner)).toBe("then");
    // Facing east, the dock just ahead.
    expect(branch("free", "front", parseMap(["...", ">D.", "..."]))).toBe("then");
  });

  it("names the branch in a path: 0 for then, 1 for else", () => {
    // Repeated twice: the front is free (then: forward), then blocked by the rack (else: turn).
    const run = runProgram([rep(2, ifs("free", "front", [F], [L]))], parseMap(["....", ">.#D", "...."]), 5);
    expect(run.events.map((e) => `${e.op}@${e.path.join(".")}`)).toEqual([
      "test@0.0",
      "forward@0.0.0.0",
      "test@0.0",
      "turn@0.0.1.0",
    ]);
  });

  it("an empty branch runs nothing", () => {
    expect(runProgram([ifs("free", "front", [])], boxed, 5)).toMatchObject({ reason: "short", events: [{ op: "test" }] });
  });
});

describe("runProgram: the step budget (ADR-103, D4)", () => {
  it("ends nested empty repeats with `loop`, though they emit nothing", () => {
    // 40³ empty iterations would end `short`: the iterations themselves are charged.
    expect(runProgram([rep(40, rep(40, rep(40)))], corridor, 40)).toMatchObject({ reason: "loop", events: [] });
    // 40⁶ iterations would never end without the budget.
    const deep = rep(40, rep(40, rep(40, rep(40, rep(40, rep(40))))));
    expect(runProgram([deep], corridor, 40).reason).toBe("loop");
  });

  it("charges every node visit and every iteration, up to the budget exactly", () => {
    // Battery 0: a budget of 100 steps.
    expect(runProgram([rep(99)], corridor, 0).reason).toBe("short");
    expect(runProgram([rep(100)], corridor, 0).reason).toBe("loop");
    expect(runProgram(Array<Stmt>(100).fill(L), corridor, 0).reason).toBe("short");
    expect(runProgram(Array<Stmt>(101).fill(L), corridor, 0).reason).toBe("loop");
  });

  it("ends a robot turning in place, and never holds more events than the budget", () => {
    const run = runProgram([until(L)], corridor, 1);
    expect(run.reason).toBe("loop");
    expect(run.events.length).toBeLessThanOrEqual(stepBudget(1));
  });

  it("ends an empty repeat_until_dock", () => {
    expect(runProgram([until()], corridor, 5)).toMatchObject({ ok: false, reason: "loop", moves: 0 });
  });

  it("ends whatever battery the caller passes, a hostile one included", () => {
    for (const battery of [Number.NaN, Number.POSITIVE_INFINITY, 1e9, -1]) {
      const run = runProgram([until(L)], corridor, battery);
      expect(run.reason).toBe("loop");
      expect(run.events.length).toBeLessThanOrEqual(stepBudget(BATTERY_MAX));
    }
  });

  it("spends the battery as clamped: a huge one is BATTERY_MAX, a non-finite one is empty", () => {
    expect(runProgram([F, F, F], corridor, 1e9).reason).toBe("dock");
    expect(runProgram([F], corridor, Number.POSITIVE_INFINITY).reason).toBe("battery");
    expect(runProgram([F, F], corridor, 1.9)).toMatchObject({ reason: "battery", moves: 1 });
  });
});

describe("runProgram without events", () => {
  it("keeps the verdict and the trail, drops the trace", () => {
    const run = runProgram([until(F)], corridor, 10, { events: false });
    expect(run).toEqual({
      ok: true,
      reason: "dock",
      moves: 3,
      trail: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 3, y: 1 },
      ],
      events: [],
    });
  });
});

describe("simulate", () => {
  it("yields event by event, then returns the verdict", () => {
    const run = simulate([F, L], corridor, 10);
    expect(run.next()).toEqual({ done: false, value: { op: "forward", path: [0], pose: { x: 1, y: 1, heading: 1 } } });
    expect(run.next()).toEqual({ done: false, value: { op: "turn", path: [1], pose: { x: 1, y: 1, heading: 0 } } });
    expect(run.next()).toEqual({ done: true, value: { ok: false, reason: "short", moves: 1 } });
  });
});

describe("parseMap and formatMap", () => {
  it("writes each heading with the glyph HEADINGS gives it", () => {
    expect([0, 1, 2, 3].map((h) => parseMap([`${HEADINGS[h]}.D`, "...", "..."]).start.heading)).toEqual([0, 1, 2, 3]);
  });

  it("reads the cells, the start and its heading, the dock", () => {
    const map = parseMap(["..#.", ">..D", "#..."]);
    expect(map).toMatchObject({ width: 4, height: 3, start: { x: 0, y: 1, heading: 1 }, dock: { x: 3, y: 1 } });
    expect([...map.racks].sort()).toEqual(["0,2", "2,0"]);
    expect(["^", ">", "v", "<"].map((h) => parseMap([`${h}.D`, "...", "..."]).start.heading)).toEqual([0, 1, 2, 3]);
  });

  it("accepts MAP_SIZE.min to MAP_SIZE.max cells a side", () => {
    expect(parseMap([">.D", "...", "..."]).width).toBe(MAP_SIZE.min);
    const big = parseMap([`>${".".repeat(10)}D`, ...Array<string>(11).fill(".".repeat(12))]);
    expect([big.width, big.height]).toEqual([MAP_SIZE.max, MAP_SIZE.max]);
  });

  it.each([
    [[">.D", "..."], "blocks.map_too_small"],
    [[">D", "..", ".."], "blocks.map_too_small"],
    [[">.D", ...Array<string>(12).fill("...")], "blocks.map_too_large"],
    [[`>.D${".".repeat(10)}`, ".".repeat(13), ".".repeat(13)], "blocks.map_too_large"],
    [[">.D", ".x.", "..."], "blocks.map_bad_char"],
    [[">.D", ". .", "..."], "blocks.map_bad_char"],
    [[">.D", "....", "..."], "blocks.map_not_rectangular"],
    [["..D", "...", "..."], "blocks.map_no_start"],
    [[">.D", "..<", "..."], "blocks.map_two_starts"],
    [[">..", "...", "..."], "blocks.map_no_dock"],
    [[">.D", "...", "D.."], "blocks.map_two_docks"],
  ])("refuses %j with %s", (rows, key) => {
    let thrown: unknown;
    try {
      parseMap(rows);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MapError);
    expect(thrown).toMatchObject({ key, message: key, name: "MapError" });
  });

  it("round-trips: formatMap writes back the rows parseMap read", () => {
    for (const rows of [["..#.", ">..D", "#..."], ["v..", "...", "D.."], ["#####", "#<..#", "#.#D#", "#####"]]) {
      const map = parseMap(rows);
      expect(formatMap(map)).toEqual(rows);
      expect(parseMap(formatMap(map))).toEqual(map);
    }
  });
});

describe("program analysis", () => {
  const program: Stmt[] = [F, rep(3, L, until(ifs("free", "front", [F], [R, F]))), R];

  it("counts the statements and the nesting levels", () => {
    expect(programStats([])).toEqual({ nodes: 0, depth: 0 });
    expect(programStats([F, L])).toEqual({ nodes: 2, depth: 1 });
    expect(programStats(program)).toEqual({ nodes: 9, depth: 4 });
  });

  it("measures a program far beyond the limits without overflowing the stack", () => {
    let deep: Stmt = F;
    for (let i = 0; i < 20_000; i++) deep = rep(2, deep);
    expect(programStats([deep])).toEqual({ nodes: 20_001, depth: 20_001 });
  });

  it("measures raw input: a malformed node or body counts as a statement without a body", () => {
    const raw = [
      { kind: "repeat" },
      { kind: "if_sensor", then: "not a list", else: [{ kind: "forward" }] },
      { kind: "toString", body: [{ kind: "forward" }] },
      null,
    ] as unknown as Stmt[];
    expect(programStats(raw)).toEqual({ nodes: 5, depth: 2 });
    expect(programStats({ kind: "forward" } as unknown as Stmt[])).toEqual({ nodes: 0, depth: 0 });
  });

  it("lists the kinds a program uses", () => {
    expect(usedKinds([])).toEqual(new Set());
    expect(usedKinds(program)).toEqual(new Set(["forward", "repeat", "turn", "repeat_until_dock", "if_sensor"]));
    expect(usedKinds([rep(2, L)])).toEqual(new Set(["repeat", "turn"]));
  });

  it("compares programs by their statements, not by their key order or extra keys", () => {
    const same = JSON.parse(JSON.stringify(program)) as Stmt[];
    expect(programEquals(program, same)).toBe(true);
    expect(programEquals([{ dir: "left", kind: "turn", id: "b7" } as Stmt], [L])).toBe(true);
    expect(programEquals([], [])).toBe(true);
    expect(programEquals([F], [F, F])).toBe(false);
    expect(programEquals([L], [R])).toBe(false);
    expect(programEquals([rep(2, F)], [rep(3, F)])).toBe(false);
    expect(programEquals([until(F)], [until(L)])).toBe(false);
    expect(programEquals([ifs("free", "front", [F])], [ifs("blocked", "front", [F])])).toBe(false);
    expect(programEquals([ifs("free", "front", [F])], [ifs("free", "left", [F])])).toBe(false);
    expect(programEquals([ifs("free", "front", [F])], [ifs("free", "front", [], [F])])).toBe(false);
  });
});
