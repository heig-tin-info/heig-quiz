import { describe, expect, it } from "vitest";

import { BOX, GRID } from "../library.js";
import { Schematic, type Orientation, type SchematicComponent, type Wire } from "../schema.js";

import { ORIENT_0, ORIENT_90, pinPosition, portPosition, rectOf } from "./geometry.js";
import { blockedCells, computeRoutes, junctionPoints, route, simplify, withRoutes } from "./router.js";

const component = (
  id: string,
  kind: SchematicComponent["kind"],
  x: number,
  y: number,
  m: Orientation = ORIENT_0,
): SchematicComponent => ({ id, kind, x, y, m, name: id.toUpperCase(), value: "10k" });

const wire = (id: string, a: Wire["a"], b: Wire["b"], via: Wire["via"] = []): Wire => ({
  id,
  a,
  b,
  via,
  points: [
    [0, 0],
    [0, 0],
  ],
});

/** Every property the schema and the netlist reader depend on. */
function expectWellFormed(points: ReadonlyArray<readonly [number, number]>): void {
  expect(points.length).toBeGreaterThanOrEqual(2);
  expect(points.length).toBeLessThanOrEqual(64);
  for (const [x, y] of points) {
    expect(x % GRID).toBe(0);
    expect(y % GRID).toBe(0);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(BOX.width);
    expect(y).toBeLessThanOrEqual(BOX.height);
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
  }
}

describe("route", () => {
  it("draws a straight line as two points", () => {
    const points = route([
      { x: 100, y: 200, d: 2 },
      { x: 20, y: 200, d: 0 },
    ]);
    expect(points).toEqual([
      [100, 200],
      [20, 200],
    ]);
  });

  it("is orthogonal, on the grid and inside the box, wherever the ends are", () => {
    const corners = [
      [0, 0],
      [BOX.width, 0],
      [0, BOX.height],
      [BOX.width, BOX.height],
      [200, 160],
      [620, 320],
    ] as const;
    for (const a of corners) {
      for (const b of corners) {
        if (a === b) continue;
        expectWellFormed(
          route([
            { x: a[0], y: a[1], d: -1 },
            { x: b[0], y: b[1], d: -1 },
          ]),
        );
      }
    }
  });

  it("starts at the first end and finishes at the last", () => {
    const points = route([
      { x: 160, y: 160, d: 2 },
      { x: 0, y: 320, d: 0 },
    ]);
    expect(points[0]).toEqual([160, 160]);
    expect(points[points.length - 1]).toEqual([0, 320]);
  });

  it("prefers fewer turns: one corner where a corner is needed", () => {
    const points = route([
      { x: 100, y: 100, d: -1 },
      { x: 300, y: 300, d: -1 },
    ]);
    expect(points).toHaveLength(3);
  });

  it("goes through the waypoints it is given", () => {
    const points = route([
      { x: 100, y: 100, d: -1 },
      { x: 100, y: 400, d: -1 },
      { x: 400, y: 400, d: -1 },
    ]);
    expect(points[0]).toEqual([100, 100]);
    expect(points).toContainEqual([100, 400]);
    expect(points[points.length - 1]).toEqual([400, 400]);
  });

  it("routes around a component body rather than through it", () => {
    const blocker = component("c1", "OPAMP", 400, 240);
    const obstacles = { blocked: blockedCells([blocker]), used: new Map<string, number>() };
    const points = route(
      [
        { x: 300, y: 240, d: -1 },
        { x: 520, y: 240, d: -1 },
      ],
      obstacles,
    );
    expectWellFormed(points);
    const body = rectOf(blocker);
    /* No vertex, and no segment, crosses the inside of the body. */
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      for (let t = 0; t <= 1; t += 0.05) {
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        const inside = x > body.x0 && x < body.x1 && y > body.y0 && y < body.y1;
        expect(inside).toBe(false);
      }
    }
  });

  it("leaves a pin the way the pin points, never backwards into its own body", () => {
    const r = component("c1", "R", 200, 160);
    const a = pinPosition(r, 1)!; // right pin, pointing +x
    const obstacles = { blocked: blockedCells([r]), used: new Map<string, number>() };
    const points = route([a, { x: 0, y: 160, d: 0 }], obstacles);
    expect(points[0]).toEqual([240, 160]);
    const second = points[1]!;
    expect(second[0]).toBeGreaterThanOrEqual(240);
  });
});

describe("simplify", () => {
  it("drops the collinear vertices", () => {
    expect(
      simplify([
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

  it("leaves a two-point line alone", () => {
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

describe("withRoutes", () => {
  const schematic: Schematic = {
    components: [component("c1", "R", 200, 160), component("c2", "R", 440, 160, ORIENT_90)],
    wires: [
      wire("w1", { kind: "pin", c: "c1", p: 0 }, { kind: "port", port: "in+" }),
      wire("w2", { kind: "pin", c: "c1", p: 1 }, { kind: "pin", c: "c2", p: 0 }),
      wire("w3", { kind: "pin", c: "c2", p: 1 }, { kind: "port", port: "out+" }),
    ],
  };

  it("writes a polyline the schema accepts, for every wire", () => {
    const routed = withRoutes(schematic);
    expect(() => Schematic.parse(routed)).not.toThrow();
    for (const w of routed.wires) expectWellFormed(w.points);
  });

  it("starts each polyline at `a` and ends it at `b`", () => {
    const routed = withRoutes(schematic);
    const w1 = routed.wires[0]!;
    const into = portPosition("in+");
    expect(w1.points[0]).toEqual([160, 160]);
    expect(w1.points[w1.points.length - 1]).toEqual([into.x, into.y]);
    const w3 = routed.wires[2]!;
    const out = portPosition("out+");
    expect(w3.points[w3.points.length - 1]).toEqual([out.x, out.y]);
  });

  it("re-routes after a component moves", () => {
    const before = withRoutes(schematic);
    const moved: Schematic = {
      ...schematic,
      components: schematic.components.map((c) => (c.id === "c1" ? { ...c, y: 320 } : c)),
    };
    const after = withRoutes(moved);
    expect(after.wires[0]?.points[0]).toEqual([160, 320]);
    expect(after.wires[0]?.points).not.toEqual(before.wires[0]?.points);
  });

  it("keeps a wire whose component vanished rather than crashing", () => {
    const orphan: Schematic = {
      components: [],
      wires: [wire("w1", { kind: "pin", c: "gone", p: 0 }, { kind: "port", port: "in+" })],
    };
    expect(() => withRoutes(orphan)).not.toThrow();
  });
});

describe("junctions", () => {
  it("marks a point where three branches meet", () => {
    const schematic: Schematic = {
      components: [component("c1", "R", 200, 160)],
      wires: [
        wire("w1", { kind: "pin", c: "c1", p: 0 }, { kind: "port", port: "in+" }),
        wire("w2", { kind: "pin", c: "c1", p: 0 }, { kind: "port", port: "in-" }),
      ],
    };
    const routes = computeRoutes(schematic);
    const dots = junctionPoints(schematic, routes);
    expect(dots).toContainEqual([160, 160]);
  });

  it("leaves a plain corner alone", () => {
    const schematic: Schematic = {
      components: [component("c1", "R", 200, 160)],
      wires: [wire("w1", { kind: "pin", c: "c1", p: 0 }, { kind: "port", port: "in+" })],
    };
    expect(junctionPoints(schematic, computeRoutes(schematic))).toEqual([]);
  });
});
