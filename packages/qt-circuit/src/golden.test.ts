/**
 * Golden tests: the exact output of `extractNets` and of the SPICE emitter,
 * pinned for every fixture schematic plus a set of deliberately awkward ones
 * (T-junctions on wire mid-points, overlapping collinear wires, a crossing
 * with no junction, every orientation, floating pins, broken values) and a
 * seeded family of random schematics.
 *
 * They were written against the code BEFORE a complexity refactor and exist
 * to prove the refactor changed nothing: same nets, same node numbering, same
 * deck text byte for byte. A snapshot that changes means the behaviour did.
 */
import { describe, it } from "vitest";

import { COMPONENT_KINDS, LIBRARY, type ComponentKind } from "./library.js";
import { extractNets, type ExtractOptions, type Netlist } from "./netlist.js";
import type { Orientation, Schematic, SchematicComponent, Stimulus, Wire } from "./schema.js";
import { buildBareNetlist, buildNetlist, type Harness } from "./spice.js";
import {
  LEFT,
  RAIL,
  RAIL_LOW,
  RIGHT,
  ROT90,
  at,
  circuitConfig,
  component,
  freeEnd,
  pinEnd,
  portEnd,
  rcLowPass,
  referenceSchematic,
  resetIds,
  wire,
} from "./test/fixtures.js";
import { expectGolden } from "./test/golden.js";

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** A netlist as plain data: the Map becomes a sorted-by-insertion list of `[pin, netId]`. */
function plain(netlist: Netlist): unknown {
  return {
    nets: netlist.nets,
    netOfPin: [...netlist.netOfPin.entries()].map(([k, n]) => [k, n.id]),
    issues: netlist.issues,
    counted: netlist.counted,
  };
}

const OPTION_SETS: ReadonlyArray<[string, ExtractOptions]> = [
  ["common", { commonGround: true }],
  ["floating", { commonGround: false }],
  [
    "palette+supplies",
    {
      commonGround: true,
      palette: { kinds: ["R", "C", "GND", "VCC", "NPN", "OPAMP"], maxComponents: 3 },
      supplies: { vcc: 12, vee: null },
    },
  ],
  ["no-rails", { commonGround: false, supplies: { vcc: null, vee: null } }],
];

const HARNESSES: ReadonlyArray<[string, Harness]> = [
  ["common-default-rails", { commonGround: true, supplies: { vcc: null, vee: null } }],
  ["split-dual-rails", { commonGround: false, supplies: { vcc: 15, vee: -15 } }],
  ["common-single-rail", { commonGround: true, supplies: { vcc: 5, vee: null } }],
];

const STIMULI: readonly Stimulus[] = [
  {
    name: "sine",
    source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0.5 },
    sourceOhms: 0,
    load: { kind: "open" },
    analysis: { stopMs: 5, skipMs: 0, points: 500 },
    points: 1,
    visible: true,
  },
  {
    name: "step",
    source: { kind: "step", from: 0, to: 5, atMs: 1 },
    sourceOhms: 50,
    load: { kind: "resistor", ohms: 10_000 },
    analysis: { stopMs: 10, skipMs: 1, points: 200 },
    points: 1,
    visible: true,
  },
  {
    name: "pulse",
    source: { kind: "pulse", low: -1, high: 1, frequencyHz: 5000, dutyCycle: 0.25 },
    sourceOhms: 0,
    load: { kind: "capacitor", farads: 1e-9 },
    analysis: { stopMs: 1, skipMs: 0, points: 100 },
    points: 1,
    visible: true,
  },
];

function golden(schematic: Schematic): unknown {
  const nets = Object.fromEntries(
    OPTION_SETS.map(([label, options]) => [label, plain(extractNets(schematic, options))]),
  );
  const decks = Object.fromEntries(
    HARNESSES.flatMap(([label, harness], h) => {
      const stimulus = STIMULI[h % STIMULI.length] as Stimulus;
      return [
        [`${label}/${stimulus.name}`, buildNetlist(schematic, stimulus, harness).text],
        [`${label}/bare`, buildBareNetlist(schematic, harness).text],
      ];
    }),
  );
  return { nets, decks };
}

// ---------------------------------------------------------------------------
// Hand-built awkward schematics
// ---------------------------------------------------------------------------

const MIRROR: Orientation = [-1, 0, 0, 1];
const ROT180: Orientation = [-1, 0, 0, -1];
const ROT270: Orientation = [0, -1, 1, 0];
const FLIP_V: Orientation = [1, 0, 0, -1];
const TRANSPOSE: Orientation = [0, 1, 1, 0];

/**
 * T-junctions on the middle of a wire and on the middle of the SECOND segment
 * of an L, two wires whose ends coincide (a dot), two collinear wires that
 * overlap, and a vertical wire that crosses the rail with neither end on it.
 */
function junctions(): Schematic {
  resetIds();
  const r1 = component("R", "R1", 200, RAIL, { value: "1k" });
  const r2 = component("R", "R2", 500, RAIL + 120, { value: "2.2k", m: ROT90 });
  const c1 = component("C", "C1", 300, RAIL + 200, { value: "10n", m: ROT270 });
  const l1 = component("L", "L1", 640, RAIL + 60, { value: "1m", m: ROT180 });
  const gnd = component("GND", "GND", 500, RAIL_LOW);
  const [r1a, r1b] = [at(r1, 0), at(r1, 1)];
  const [r2a, r2b] = [at(r2, 0), at(r2, 1)];
  const [c1a, c1b] = [at(c1, 0), at(c1, 1)];
  const [l1a, l1b] = [at(l1, 0), at(l1, 1)];
  return {
    components: [r1, r2, c1, l1, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(r1, 0), [[LEFT, RAIL], r1a]),
      // A long rail with a bend: in the middle of its second segment lands w4.
      wire("w2", pinEnd(r1, 1), portEnd("out+"), [r1b, [r1b[0], RAIL], [RIGHT, RAIL]]),
      // Overlapping collinear wire on the same rail: its ends lie on w2.
      wire("w3", freeEnd(r1b[0] + 60, RAIL), freeEnd(r1b[0] + 200, RAIL), [
        [r1b[0] + 60, RAIL],
        [r1b[0] + 200, RAIL],
      ]),
      // R2 hangs off the rail through an L whose free end is a T.
      wire("w4", pinEnd(r2, 0), freeEnd(r2a[0], RAIL), [r2a, [r2a[0], RAIL]]),
      // R2's bottom and C1's top meet at one end point: a junction dot.
      wire("w5", pinEnd(r2, 1), freeEnd(r2b[0], r2b[1] + 40), [r2b, [r2b[0], r2b[1] + 40]]),
      wire("w6", pinEnd(c1, 0), freeEnd(r2b[0], r2b[1] + 40), [c1a, [c1a[0], r2b[1] + 40], [r2b[0], r2b[1] + 40]]),
      wire("w7", pinEnd(c1, 1), portEnd("in-"), [c1b, [c1b[0], RAIL_LOW], [LEFT, RAIL_LOW]]),
      // Crosses the rail, neither end on it: NOT a connection.
      wire("w8", freeEnd(420, RAIL - 60), freeEnd(420, RAIL + 60), [
        [420, RAIL - 60],
        [420, RAIL + 60],
      ]),
      // L1 from the crossing wire's bottom end to nowhere near its pin.
      wire("w9", freeEnd(420, RAIL + 60), pinEnd(l1, 1), [[420, RAIL + 60], [l1b[0], RAIL + 60], l1b]),
      // A dangling wire: its `b` says L1.1 but the polyline stops short.
      wire("w10", pinEnd(l1, 0), pinEnd(l1, 0), [l1a, [l1a[0] + 20, l1a[1]]]),
      wire("w11", portEnd("out-"), pinEnd(gnd, 0), [[RIGHT, RAIL_LOW], at(gnd, 0)]),
    ],
  };
}

/** One of every kind, in every orientation, some touching pin to pin, some floating. */
function everyKind(): Schematic {
  resetIds();
  const orientations: Orientation[] = [
    [1, 0, 0, 1],
    ROT90,
    ROT180,
    ROT270,
    MIRROR,
    FLIP_V,
    TRANSPOSE,
    [0, -1, -1, 0],
  ];
  const values: Partial<Record<ComponentKind, string>> = {
    R: "4.7k",
    C: "",
    L: "abc",
    DZ: "5.1",
    D: "",
  };
  const components: SchematicComponent[] = COMPONENT_KINDS.map((kind, i) =>
    component(kind, kind === "GND" ? "GND" : `${kind}${i % 3}`, 100 + (i % 6) * 120, 120 + Math.floor(i / 6) * 140, {
      value: values[kind] ?? "",
      m: orientations[i % orientations.length] as Orientation,
    }),
  );
  const byKind = (k: ComponentKind): SchematicComponent =>
    components.find((c) => c.kind === k) as SchematicComponent;
  const q = byKind("NPN");
  const u = byKind("OPAMP");
  const vcc = byKind("VCC");
  const vee = byKind("VEE");
  const m = byKind("NMOS");
  const wires: Wire[] = [
    wire("w1", portEnd("in+"), pinEnd(u, 1), [[LEFT, RAIL], [at(u, 1)[0], RAIL], at(u, 1)]),
    wire("w2", pinEnd(u, 2), portEnd("out+"), [at(u, 2), [RIGHT, at(u, 2)[1]]]),
    wire("w3", pinEnd(u, 0), pinEnd(u, 2), [at(u, 0), [at(u, 0)[0], at(u, 2)[1]], at(u, 2)]),
    wire("w4", pinEnd(q, 0), pinEnd(vcc, 0), [at(q, 0), [at(q, 0)[0], at(vcc, 0)[1]], at(vcc, 0)]),
    wire("w5", pinEnd(q, 2), pinEnd(vee, 0), [at(q, 2), [at(vee, 0)[0], at(q, 2)[1]], at(vee, 0)]),
    wire("w6", pinEnd(m, 1), pinEnd(q, 1), [at(m, 1), [at(q, 1)[0], at(m, 1)[1]], at(q, 1)]),
  ];
  return { components, wires };
}

/** Names that collide with each other and with the harness, and values out of range. */
function badNames(): Schematic {
  resetIds();
  const a = component("R", "Rload", 200, RAIL, { value: "1e20" });
  const b = component("R", "rload", 280, RAIL, { value: "1k" });
  const c = component("R", "R", 360, RAIL, { value: "2k" });
  const d = component("C", "Vin", 440, RAIL, { value: "1u" });
  const e = component("DZ", "Z-1+", 520, RAIL, { value: "3.3" });
  const f = component("PMOSD", "M1", 640, RAIL + 100, { m: ROT90 });
  const g = component("PNP", "Q_1", 300, RAIL + 180);
  return {
    components: [a, b, c, d, e, f, g],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(a, 0), [[LEFT, RAIL], at(a, 0)]),
      wire("w2", pinEnd(e, 1), portEnd("out+"), [at(e, 1), [RIGHT, RAIL]]),
    ],
  };
}

// ---------------------------------------------------------------------------
// A seeded family of random schematics
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

const ALL_ORIENTATIONS: Orientation[] = [
  [1, 0, 0, 1],
  [0, 1, -1, 0],
  [-1, 0, 0, -1],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [1, 0, 0, -1],
  [0, 1, 1, 0],
  [0, -1, -1, 0],
];
const RANDOM_VALUES = ["", "1k", "abc", "1e20", "100n", "5.1", "10", "4.7u"];
const RANDOM_NAMES = ["R1", "R2", "Q1", "U1", "x", "Rload", "M1", "D1", "C1", "L1"];
const PORT_LIST = ["in+", "in-", "out+", "out-"] as const;

/**
 * Components on a coarse grid in a small area, so that pins coincide by
 * accident; wires between pins, ports and free points, with orthogonal and
 * occasionally diagonal polylines, some ending in the middle of another wire.
 */
function randomSchematic(seed: number): Schematic {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)] as T;
  const snap = (v: number): number => Math.round(v / 20) * 20;
  resetIds();
  const components: SchematicComponent[] = [];
  const count = 3 + int(8);
  for (let i = 0; i < count; i += 1) {
    const kind = pick(COMPONENT_KINDS);
    components.push(
      component(kind, kind === "GND" ? "GND" : pick(RANDOM_NAMES), 80 + int(8) * 40, 60 + int(8) * 40, {
        value: pick(RANDOM_VALUES),
        m: pick(ALL_ORIENTATIONS),
      }),
    );
  }
  type Anchor = { end: Wire["a"]; p: [number, number] };
  const anchor = (): Anchor => {
    const roll = rnd();
    if (roll < 0.55 && components.length > 0) {
      const c = pick(components);
      const p = int(LIBRARY[c.kind].pins.length);
      return { end: pinEnd(c, p), p: at(c, p) };
    }
    if (roll < 0.7) {
      const port = pick(PORT_LIST);
      const p: [number, number] = port.startsWith("in") ? [LEFT, port.endsWith("+") ? RAIL : RAIL_LOW] : [RIGHT, port.endsWith("+") ? RAIL : RAIL_LOW];
      return { end: portEnd(port), p };
    }
    const p: [number, number] = [snap(40 + int(16) * 40), snap(40 + int(10) * 40)];
    return { end: freeEnd(p[0], p[1]), p };
  };
  const wires: Wire[] = [];
  const nWires = 2 + int(10);
  for (let i = 0; i < nWires; i += 1) {
    const a = anchor();
    let b = anchor();
    // Sometimes land b on the midpoint of an existing wire's first segment.
    const host = wires.length > 0 && rnd() < 0.3 ? pick(wires) : undefined;
    if (host !== undefined) {
      const [s, e] = [host.points[0], host.points[1]] as [[number, number], [number, number]];
      const mid: [number, number] = [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2];
      b = { end: freeEnd(mid[0], mid[1]), p: mid };
    }
    const shape = rnd();
    let points: Array<[number, number]>;
    if (shape < 0.15) points = [a.p, b.p]; // possibly diagonal
    else if (shape < 0.6) points = [a.p, [b.p[0], a.p[1]], b.p];
    else points = [a.p, [a.p[0], b.p[1]], b.p];
    // Sometimes the stored end disagrees with the polyline.
    const bEnd = rnd() < 0.1 ? anchor().end : b.end;
    wires.push(wire(`w${i + 1}`, a.end, bEnd, points));
  }
  return { components, wires };
}

// ---------------------------------------------------------------------------

const SCHEMATICS: ReadonlyArray<[string, () => Schematic]> = [
  ["fixture rcLowPass", () => rcLowPass().schematic],
  ["fixture rcLowPass (odd values)", () => rcLowPass({ r: "", c: "1e9" }).schematic],
  ["fixture referenceSchematic", () => referenceSchematic()],
  ["fixture circuitConfig reference", () => circuitConfig().reference as Schematic],
  ["empty", () => ({ components: [], wires: [] })],
  ["junctions", junctions],
  ["every kind, every orientation", everyKind],
  ["bad names and values", badNames],
];

describe("golden: extractNets and the SPICE emitter", () => {
  for (const [label, build] of SCHEMATICS) {
    it(label, () => {
      expectGolden(`netlist/${label.replace(/[^A-Za-z0-9]+/g, "-")}`, golden(build()));
    });
  }

  for (let seed = 1; seed <= 24; seed += 1) {
    it(`random schematic #${seed}`, () => {
      expectGolden(`netlist/random-${seed}`, golden(randomSchematic(seed)));
    });
  }
});
