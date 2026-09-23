/**
 * Golden tests for the router: the exact polylines `route` returns for a set
 * of (ends, obstacles) cases, and the exact routes and junction dots of whole
 * schematics — fixtures and a seeded random family.
 *
 * Written against the router BEFORE a complexity refactor, to prove the
 * refactor kept the heuristic and the tie-breaking: a polyline that changes
 * here is a wire that moves on a student's canvas.
 */
import { describe, it } from "vitest";

import { BOX, COMPONENT_KINDS, GRID, LIBRARY } from "../library.js";
import type { Orientation, Schematic, SchematicComponent, Wire } from "../schema.js";
import { rcLowPass, referenceSchematic } from "../test/fixtures.js";
import { expectGolden } from "../test/golden.js";

import { ORIENT_0, ORIENT_90, ORIENT_180, pinPosition, portPosition, type PinPoint } from "./geometry.js";
import { blockedCells, computeRoutes, junctionPoints, route, withRoutes, type Obstacles } from "./router.js";

const part = (
  id: string,
  kind: SchematicComponent["kind"],
  x: number,
  y: number,
  m: Orientation = ORIENT_0,
): SchematicComponent => ({ id, kind, x, y, m, name: id.toUpperCase(), value: "10k" });

const free = (x: number, y: number): PinPoint => ({ x, y, d: -1 });
const none = (): Obstacles => ({ blocked: new Set(), used: new Map() });
const around = (components: SchematicComponent[]): Obstacles => ({
  blocked: blockedCells(components),
  used: new Map(),
});

/** A vertical wall of blocked cells at grid column `gx`, open only between `gapFrom..gapTo`. */
function wall(gx: number, gapFrom: number, gapTo: number): Obstacles {
  const blocked = new Set<string>();
  for (let gy = 0; gy <= BOX.height / GRID; gy += 1) {
    if (gy < gapFrom || gy > gapTo) blocked.add(`${gx},${gy}`);
  }
  return { blocked, used: new Map() };
}

type Case = [string, () => { ends: PinPoint[]; obstacles: Obstacles }];

const CASES: Case[] = [
  ["straight", () => ({ ends: [{ x: 100, y: 200, d: 2 }, { x: 20, y: 200, d: 0 }], obstacles: none() })],
  ["one corner", () => ({ ends: [free(100, 100), free(300, 300)], obstacles: none() })],
  ["same point", () => ({ ends: [free(200, 200), free(200, 200)], obstacles: none() })],
  ["single end", () => ({ ends: [free(200, 200)], obstacles: none() })],
  ["off-grid ends", () => ({ ends: [free(107, 93), free(311, 289)], obstacles: none() })],
  ["box corners", () => ({ ends: [free(0, 0), free(BOX.width, BOX.height)], obstacles: none() })],
  [
    "around an op-amp body",
    () => ({ ends: [free(300, 240), free(520, 240)], obstacles: around([part("c1", "OPAMP", 400, 240)]) }),
  ],
  [
    "leaves a pin the way it points",
    () => {
      const r = part("c1", "R", 200, 160);
      return { ends: [pinPosition(r, 1) as PinPoint, { x: 0, y: 160, d: 0 }], obstacles: around([r]) };
    },
  ],
  [
    "arrives at a pin from the wrong side",
    () => {
      const r = part("c1", "R", 400, 200, ORIENT_180);
      return { ends: [free(600, 200), pinPosition(r, 0) as PinPoint], obstacles: around([r]) };
    },
  ],
  [
    "port to port with waypoints",
    () => ({
      ends: [portPosition("in+"), free(100, 400), free(400, 400), free(600, 60), portPosition("out-")],
      obstacles: none(),
    }),
  ],
  [
    "prefers not to run on another wire",
    () => {
      const used = new Map<string, number>();
      for (let gx = 2; gx <= 20; gx += 1) used.set(`${gx},10`, 1);
      for (let gy = 5; gy <= 15; gy += 1) used.set(`12,${gy}`, 2);
      return { ends: [free(40, 200), free(400, 200)], obstacles: { blocked: new Set(), used } };
    },
  ],
  [
    "a wall forces the second, whole-box pass",
    () => ({ ends: [free(200, 200), free(400, 200)], obstacles: wall(15, 22, 23) }),
  ],
  [
    "the goal walled in: the fallback L",
    () => {
      const blocked = new Set<string>();
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        blocked.add(`${20 + dx},${12 + dy}`);
      }
      return { ends: [free(100, 60), free(400, 240)], obstacles: { blocked, used: new Map() } };
    },
  ],
  [
    "through a crowd of parts",
    () => {
      const parts = [
        part("c1", "R", 300, 200, ORIENT_90),
        part("c2", "NPN", 400, 260),
        part("c3", "OPAMP", 500, 180),
        part("c4", "C", 360, 340),
        part("c5", "NMOS", 240, 120, ORIENT_180),
      ];
      return { ends: [portPosition("in+"), portPosition("out-")], obstacles: around(parts) };
    },
  ],
];

// ---------------------------------------------------------------------------
// Whole schematics
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ORIENTS: Orientation[] = [
  [1, 0, 0, 1],
  [0, 1, -1, 0],
  [-1, 0, 0, -1],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [1, 0, 0, -1],
];
const PORT_LIST = ["in+", "in-", "out+", "out-"] as const;

/** Parts spread over the box, wires between pins, ports and free points, with waypoints. */
function randomSchematic(seed: number): Schematic {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  const components: SchematicComponent[] = [];
  const count = 2 + int(7);
  for (let i = 0; i < count; i += 1) {
    components.push(part(`c${i + 1}`, pick(COMPONENT_KINDS), 80 + int(16) * 40, 60 + int(10) * 40, pick(ORIENTS)));
  }
  const end = (): Wire["a"] => {
    const roll = rnd();
    if (roll < 0.6) {
      const c = pick(components);
      return { kind: "pin", c: c.id, p: int(LIBRARY[c.kind].pins.length) };
    }
    if (roll < 0.8) return { kind: "port", port: pick(PORT_LIST) };
    return { kind: "free", x: 40 + int(18) * 40, y: 40 + int(11) * 40 };
  };
  const wires: Wire[] = [];
  const nWires = 1 + int(8);
  for (let i = 0; i < nWires; i += 1) {
    const via = rnd() < 0.3 ? [{ x: 40 + int(18) * 40, y: 40 + int(11) * 40 }] : [];
    wires.push({ id: `w${i + 1}`, a: end(), b: end(), via, points: [[0, 0], [0, 0]] });
  }
  return { components, wires };
}

function wholeSchematic(schematic: Schematic): unknown {
  const routes = computeRoutes(schematic);
  const routed = withRoutes(schematic);
  return {
    routes: [...routes.entries()],
    withRoutes: routed.wires.map((w) => [w.id, w.points]),
    // The dots of the stored polylines AND of the recomputed ones.
    storedDots: junctionPoints(schematic, new Map(schematic.wires.map((w) => [w.id, w.points]))),
    routedDots: junctionPoints(schematic, routes),
  };
}

describe("golden: route", () => {
  for (const [label, build] of CASES) {
    it(label, () => {
      const { ends, obstacles } = build();
      expectGolden(`router/case-${label.replace(/[^A-Za-z0-9]+/g, "-")}`, route(ends, obstacles));
    });
  }
});

describe("golden: computeRoutes, withRoutes, junctionPoints", () => {
  it("fixture rcLowPass", () => {
    expectGolden("router/fixture-rcLowPass", wholeSchematic(rcLowPass().schematic));
  });
  it("fixture referenceSchematic", () => {
    expectGolden("router/fixture-referenceSchematic", wholeSchematic(referenceSchematic()));
  });
  for (let seed = 1; seed <= 16; seed += 1) {
    it(`random schematic #${seed}`, () => {
      expectGolden(`router/random-${seed}`, wholeSchematic(randomSchematic(seed)));
    });
  }
});
