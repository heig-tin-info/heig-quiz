import { describe, expect, it } from "vitest";

import { DIRS, astar, cellKey, markUsed, simplify, type Obstacles } from "./gridRouter.js";

const none = (): Obstacles => ({ blocked: new Set(), used: new Map() });
const blocking = (...cells: Array<[number, number]>): Obstacles => ({ blocked: new Set(cells.map(([x, y]) => cellKey(x, y))), used: new Map() });
const WIDE = { margins: [6] };

describe("astar", () => {
  it("returns the start alone when the leg is empty, keeping its direction", () => {
    expect(astar(2, 3, 1, 2, 3, 0, none(), WIDE)).toEqual({ pts: [[2, 3]], dir: 1 });
  });

  it("runs straight when nothing is in the way", () => {
    expect(astar(0, 0, -1, 3, 0, -1, none(), WIDE)).toEqual({
      pts: [
        [0, 0],
        [1, 0],
        [2, 0],
        [3, 0],
      ],
      dir: 0,
    });
  });

  it("meets an end head on, turning once rather than arriving from the side", () => {
    // The end leaves upward (3): the line must arrive moving down (1).
    const leg = astar(0, 0, 0, 2, 2, 3, none(), WIDE);
    expect(simplify(leg.pts)).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
    ]);
    expect(leg.dir).toBe(1);
  });

  it("prefers arriving from the side to arriving from behind the end", () => {
    // The end leaves right (0), so it wants a line moving left (2). Coming
    // from behind (moving right) costs three turns, from the side one.
    const leg = astar(0, 0, -1, 2, 2, 0, none(), WIDE);
    expect(leg.dir).toBe(1);
    expect(leg.pts.at(-2)).toEqual([2, 1]);
  });

  it("goes around a blocked cell, yet may step onto a blocked goal", () => {
    const leg = astar(0, 0, -1, 4, 0, -1, blocking([2, 0], [4, 0]), WIDE);
    expect(leg.pts).not.toContainEqual([2, 0]);
    expect(leg.pts.at(-1)).toEqual([4, 0]);
  });

  it("steers off a line already running the same way, not off one crossing it", () => {
    const along = none();
    markUsed(
      Array.from({ length: 11 }, (_, x): [number, number] => [x, 0]),
      along.used,
    );
    const detour = astar(0, 0, -1, 10, 0, -1, along, WIDE);
    expect(detour.pts.some(([, y]) => y !== 0)).toBe(true);

    const across = none();
    for (let x = 1; x <= 10; x += 1) markUsed([[x, 0], [x, 1]], across.used);
    expect(simplify(astar(0, 0, -1, 10, 0, -1, across, WIDE).pts)).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it("stays inside the clip box, where an unbounded search would leave it", () => {
    const wall = (): Obstacles => blocking([0, 1], [1, 1]);
    expect(simplify(astar(0, 0, -1, 0, 3, -1, wall(), WIDE).pts)).toEqual([
      [0, 0],
      [-1, 0],
      [-1, 3],
      [0, 3],
    ]);
    expect(simplify(astar(0, 0, -1, 0, 3, -1, wall(), { margins: [6], clip: { x0: 0, y0: 0, x1: 2, y1: 3 } }).pts)).toEqual([
      [0, 0],
      [2, 0],
      [2, 3],
      [0, 3],
    ]);
  });

  it("tries the wider windows in turn", () => {
    // A wall two steps past the tight window: only the second margin gets round it.
    const wall = new Set<string>();
    for (let y = -4; y <= 4; y += 1) wall.add(cellKey(2, y));
    const leg = astar(0, 0, -1, 4, 0, -1, { blocked: wall, used: new Map() }, { margins: [2, 8] });
    expect(leg.pts.at(-1)).toEqual([4, 0]);
    expect(leg.pts.some(([, y]) => Math.abs(y) > 4)).toBe(true);
  });

  it("falls back to the plain L when the goal is walled in", () => {
    const walled = (): Obstacles => blocking([3, 2], [5, 2], [4, 1], [4, 3]);
    expect(astar(0, 0, -1, 4, 2, -1, walled(), WIDE)).toEqual({
      pts: [
        [0, 0],
        [4, 0],
        [4, 2],
      ],
      dir: 1,
    });
    expect(astar(0, 3, -1, 4, 2, -1, walled(), { margins: [1, 3], clip: { x0: 0, y0: 0, x1: 9, y1: 9 } }).dir).toBe(3);
    expect(astar(9, 2, -1, 4, 2, -1, walled(), WIDE).dir).toBe(2);
    expect(astar(0, 2, -1, 4, 2, -1, walled(), WIDE).dir).toBe(0);
  });
});

describe("simplify", () => {
  it("drops the collinear and the repeated vertices", () => {
    expect(
      simplify([
        [0, 0],
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
      ]),
    ).toEqual([
      [0, 0],
      [2, 0],
      [2, 1],
    ]);
  });

  it("copies a line of fewer than three points as it is", () => {
    expect(simplify([])).toEqual([]);
    expect(
      simplify([
        [0, 0],
        [4, 0],
      ]),
    ).toEqual([
      [0, 0],
      [4, 0],
    ]);
  });
});

describe("markUsed", () => {
  it("records each vertex's orientations as bits, horizontal 1 and vertical 2", () => {
    const used = new Map<string, number>();
    markUsed(
      [
        [0, 0],
        [2, 0],
        [2, 1],
      ],
      used,
    );
    expect(Object.fromEntries(used)).toEqual({ "0,0": 1, "2,0": 3, "2,1": 2 });
  });
});

it("lists the directions right, down, left, up", () => {
  expect(DIRS).toEqual([
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ]);
});
