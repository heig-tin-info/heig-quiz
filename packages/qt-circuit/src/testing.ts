/**
 * `@quiz/qt-circuit/testing` — the full configuration of the leak test
 * (invariant 4, docs/spec/05 §5.7), and the schematic builders it is drawn
 * with. TEST-ONLY: nothing in `apps/*` imports it.
 *
 * The schematics are built from the library's own pin geometry rather than
 * from literal coordinates, so a symbol whose pins move takes the fixtures
 * with it instead of silently unwiring them.
 */
import type { StudentLeakFixture } from "@quiz/core/testing";

import { BOX, LIBRARY, PORTS, type ComponentKind } from "./library.js";
import { LOGIC_PARTS } from "./logicLibrary.js";
import { pinLocation } from "./netlist.js";
import { LogicConfig, type LogicComponent, type LogicSchematic, type LogicWire } from "./logicSchema.js";
import {
  CircuitConfig,
  type Orientation,
  type Schematic,
  type SchematicComponent,
  type Wire,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export const IDENTITY_M: Orientation = [1, 0, 0, 1];
/** 90° clockwise: a two-terminal symbol stands up, pin 0 on top. */
export const ROT90: Orientation = [0, 1, -1, 0];

let counter = 0;

export function resetIds(): void {
  counter = 0;
}

export function component(
  kind: ComponentKind,
  name: string,
  x: number,
  y: number,
  options: { value?: string; m?: Orientation; id?: string } = {},
): SchematicComponent {
  counter += 1;
  return {
    id: options.id ?? `c${counter}`,
    kind,
    x,
    y,
    m: options.m ?? IDENTITY_M,
    name,
    value: options.value ?? "",
  };
}

/** Where a pin of a built component sits; the fixtures wire to this, never to a literal. */
export function at(c: SchematicComponent, pin: number): [number, number] {
  const spec = LIBRARY[c.kind].pins[pin];
  if (spec === undefined) throw new Error(`no pin ${pin} on ${c.kind}`);
  const [a, b, cc, d] = c.m;
  return [c.x + a * spec.x + cc * spec.y, c.y + b * spec.x + d * spec.y];
}

export function wire(
  id: string,
  a: Wire["a"],
  b: Wire["b"],
  points: ReadonlyArray<readonly [number, number]>,
): Wire {
  return { id, a, b, via: [], points: points.map(([x, y]) => [x, y] as [number, number]) };
}

export const pinEnd = (c: SchematicComponent, p: number): Wire["a"] =>
  ({ kind: "pin", c: c.id, p }) as const;
export const portEnd = (port: "in+" | "in-" | "out+" | "out-"): Wire["a"] =>
  ({ kind: "port", port }) as const;
export const freeEnd = (x: number, y: number): Wire["a"] => ({ kind: "free", x, y }) as const;

/**
 * The two rails the fixtures wire along, read from the port table rather than
 * written down: `in+`/`out+` sit on one, `in-`/`out-` on the other, and moving
 * them in `library.ts` moves every fixture with them.
 */
export const RAIL = PORTS["in+"].y;
export const RAIL_LOW = PORTS["in-"].y;
/** The x of the left and right box borders, where the four ports are. */
export const LEFT = 0;
export const RIGHT = BOX.width;

// ---------------------------------------------------------------------------
// The fully populated config of the leak test
// ---------------------------------------------------------------------------

/** Distinctive enough that a substring search over the student view cannot miss it. */
export const SECRET_REFERENCE_NAME = "Rsecret";
const SECRET_REFERENCE_VALUE = "123.4k";
export const SECRET_HIDDEN_STIMULUS = "hidden-secret-stimulus";
export const SECRET_RUBRIC = "SECRET_RUBRIC: the filter must roll off at 20 dB per decade";
export const SECRET_TOLERANCE = 0.0777;
/** The Bode envelope: three knobs a student must not learn either (invariant 4). */
const SECRET_BODE = { magDb: 1.37, floorDb: 47.5, phaseDeg: 13.25 };

/** One part of the RC low-pass: its name and its value. */
interface RcPart {
  readonly name: string;
  readonly value: string;
}

/**
 * The RC low-pass: R between `in+` and `out+`, C from `out+` down to a `GND`
 * symbol, the free end of C's wire landing on the middle of w2 (a T-junction).
 */
export function rcSchematic(rp: RcPart, cp: RcPart): { schematic: Schematic; r: SchematicComponent; c: SchematicComponent } {
  resetIds();
  const r = component("R", rp.name, 400, RAIL, { value: rp.value });
  const cap = component("C", cp.name, 600, RAIL + 80, { value: cp.value, m: ROT90 });
  const gnd = component("GND", "GND", 600, RAIL + 140);
  const [rx0, ry0] = at(r, 0);
  const [rx1, ry1] = at(r, 1);
  const [cx0, cy0] = at(cap, 0);
  const [cx1, cy1] = at(cap, 1);
  const [gx, gy] = at(gnd, 0);
  return {
    schematic: {
      components: [r, cap, gnd],
      wires: [
        wire("w1", portEnd("in+"), pinEnd(r, 0), [
          [LEFT, RAIL],
          [rx0, ry0],
        ]),
        wire("w2", pinEnd(r, 1), portEnd("out+"), [
          [rx1, ry1],
          [RIGHT, RAIL],
        ]),
        wire("w3", pinEnd(cap, 0), freeEnd(cx0, RAIL), [
          [cx0, cy0],
          [cx0, RAIL],
        ]),
        wire("w4", pinEnd(cap, 1), pinEnd(gnd, 0), [
          [cx1, cy1],
          [gx, gy],
        ]),
      ],
    },
    r,
    c: cap,
  };
}

/** The teacher's own circuit: the key. */
export const referenceSchematic = (): Schematic =>
  rcSchematic({ name: SECRET_REFERENCE_NAME, value: SECRET_REFERENCE_VALUE }, { name: "Csecret", value: "100n" }).schematic;

/**
 * Two visible stimuli and one hidden one, a reference, a rubric and a
 * tolerance: everything `toStudent` has to leave behind.
 */
export function circuitConfig(overrides: Record<string, unknown> = {}): CircuitConfig {
  return CircuitConfig.parse({
    configVersion: 1,
    prompt: "Wire a first-order low-pass filter with a corner at 1 kHz.",
    palette: { kinds: ["R", "C", "L", "GND"], maxComponents: 6 },
    supplies: { vcc: null, vee: null },
    commonGround: true,
    stimuli: [
      {
        name: "1 kHz sine",
        source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
        sourceOhms: 0,
        load: { kind: "open" },
        analysis: { stopMs: 5, skipMs: 0, points: 500 },
        points: 1,
        visible: true,
      },
      {
        name: "10 kHz sine",
        source: { kind: "sine", amplitude: 1, frequencyHz: 10_000, offset: 0 },
        sourceOhms: 50,
        load: { kind: "resistor", ohms: 10_000 },
        analysis: { stopMs: 1, skipMs: 0, points: 500 },
        points: 1,
        visible: true,
      },
      {
        name: SECRET_HIDDEN_STIMULUS,
        source: { kind: "step", from: 0, to: 5, atMs: 1 },
        sourceOhms: 0,
        load: { kind: "open" },
        analysis: { stopMs: 10, skipMs: 0, points: 500 },
        points: 2,
        visible: false,
      },
    ],
    reference: referenceSchematic(),
    grading: { mode: "simulation", tolerance: SECRET_TOLERANCE, bode: SECRET_BODE, rubric: SECRET_RUBRIC },
    showExpected: false,
    simulationsPerMinute: 10,
    ...overrides,
  });
}

/*
 * The reference schematic, the grading block it lives beside, and the `mode`
 * of that block — which tells the student whether a simulation or an LLM
 * reads the answer.
 */
export const circuitLeakFixture: StudentLeakFixture<CircuitConfig> = {
  // Built at import, which moves the id counter: every builder of a
  // schematic starts with `resetIds()`, so none depends on where it stands.
  config: circuitConfig(),
  forbiddenKeys: [
    // Out of the floor since R-06 (only `code` publishes it, on purpose); here
    // it still names nothing this type may publish.
    "compare",
    "expected",
    "grading",
    "mode",
    "policy",
    "reference",
    "tolerance",
    // The Bode envelope (ADR-083) sits beside the tolerance, and leaves with it.
    "bode",
    "magDb",
    "floorDb",
    "phaseDeg",
  ],
  secrets: [
    SECRET_REFERENCE_NAME,
    SECRET_REFERENCE_VALUE,
    SECRET_HIDDEN_STIMULUS,
    SECRET_RUBRIC,
    String(SECRET_TOLERANCE),
    ...Object.values(SECRET_BODE).map(String),
    "Csecret",
    // The hidden stimulus is a 5 V step at 1 ms: its shape is part of the key.
    '"step"',
  ],
};

// ---------------------------------------------------------------------------
// `logic` (ADR-123)
// ---------------------------------------------------------------------------

/**
 * Compound expressions only: a single-name key (`y = a`) would be the name
 * of an input, which the student view publishes on purpose, and the value
 * search would cry wolf (§4.18).
 */
export const SECRET_MAJORITY = "a*b + a*c + b*c";
export const SECRET_PARITY = "a ^ b ^ c";

/** A logic part, upright. */
export function logicPart(id: string, kind: LogicComponent["kind"], x: number, y: number, name: string = kind): LogicComponent {
  return { id, kind, x, y, m: [1, 0, 0, 1], name, value: "" };
}

/** The names of a reference circuit's gates: no student view could hold them by chance. */
export const SECRET_REFERENCE_GATES = ["Uref41", "Uref42"];

/** A half adder, `c = a*b` from an AND, `s = a^b` from an XOR, its gates named `gates`. */
export function halfAdderSchematic(gates: readonly [string, string] = ["U1", "U2"]): LogicSchematic {
  const a = logicPart("c1", "IN", 100, 100, "a");
  const b = logicPart("c2", "IN", 100, 300, "b");
  const and = logicPart("c3", "AND2", 300, 140, gates[0]);
  const xor = logicPart("c4", "XOR2", 300, 300, gates[1]);
  const c = logicPart("c5", "OUT", 500, 140, "c");
  const s = logicPart("c6", "OUT", 500, 300, "s");
  return {
    components: [a, b, and, xor, c, s],
    wires: [
      logicWire("w1", [a, 0], [and, 0]),
      logicWire("w2", [a, 0], [xor, 0]),
      logicWire("w3", [b, 0], [and, 1]),
      logicWire("w4", [b, 0], [xor, 1]),
      logicWire("w5", [and, 2], [c, 0]),
      logicWire("w6", [xor, 2], [s, 0]),
    ],
  };
}

/** The majority's reference, begun: its terminals and two gates, stored but unread while the expressions are the key. */
function majorityReference(): LogicSchematic {
  const terminals = ["a", "b", "c"].map((name, i) => logicPart(`c${i + 1}`, "IN", 100, 100 + 100 * i, name));
  const outputs = ["m", "p"].map((name, i) => logicPart(`c${i + 4}`, "OUT", 600, 100 + 200 * i, name));
  const and = logicPart("c6", "AND2", 300, 140, SECRET_REFERENCE_GATES[0]);
  const xor = logicPart("c7", "XOR3", 300, 300, SECRET_REFERENCE_GATES[1]);
  return { components: [...terminals, ...outputs, and, xor], wires: [logicWire("w1", [terminals[0]!, 0], [and, 0])] };
}

/** A majority and a parity over three inputs, two outputs, a restricted palette, a reference begun. */
export function logicConfig(overrides: Record<string, unknown> = {}): LogicConfig {
  return LogicConfig.parse({
    configVersion: 1,
    prompt: "Build the majority and the parity of three inputs.",
    symbols: "iec",
    inputs: ["a", "b", "c"],
    outputs: [
      { name: "m", expression: SECRET_MAJORITY },
      { name: "p", expression: SECRET_PARITY },
    ],
    palette: { kinds: ["AND", "OR", "XOR"], maxGates: 8 },
    reference: majorityReference(),
    ...overrides,
  });
}

export const logicLeakFixture: StudentLeakFixture<LogicConfig> = {
  config: logicConfig(),
  forbiddenKeys: ["expression", "expressions", "expected", "rows", "vectors", "mode", "keyFrom", "reference", "wires"],
  secrets: [SECRET_MAJORITY, SECRET_PARITY, ...SECRET_REFERENCE_GATES],
};

/** A half adder whose key is its reference circuit, the gates named {@link SECRET_REFERENCE_GATES}. */
export function logicReferenceConfig(overrides: Record<string, unknown> = {}): LogicConfig {
  return LogicConfig.parse({
    configVersion: 1,
    prompt: "Build a half adder.",
    inputs: ["a", "b"],
    outputs: [{ name: "c" }, { name: "s" }],
    keyFrom: "reference",
    reference: halfAdderSchematic(SECRET_REFERENCE_GATES as [string, string]),
    palette: { kinds: ["AND", "XOR"], maxGates: 4 },
    ...overrides,
  });
}

export const logicReferenceLeakFixture: StudentLeakFixture<LogicConfig> = {
  config: logicReferenceConfig(),
  forbiddenKeys: logicLeakFixture.forbiddenKeys,
  secrets: SECRET_REFERENCE_GATES,
};

/** A D flip-flop's test vectors: each step a line no student view could hold by chance. */
export const SECRET_VECTOR_STEPS = ["C 1 1", "C 0 0", "0 1 0"];
export const SECRET_VECTORS = `clk d q\n0 0 0\n${SECRET_VECTOR_STEPS.join("\n")}\n`;

/** A sequential question: a D flip-flop, specified by test vectors. */
export function logicSequentialConfig(overrides: Record<string, unknown> = {}): LogicConfig {
  return logicConfig({
    prompt: "Build a D flip-flop's behaviour.",
    mode: "sequential",
    inputs: ["clk", "d"],
    outputs: [{ name: "q" }],
    vectors: SECRET_VECTORS,
    palette: { kinds: ["DFF"], maxGates: 2 },
    reference: null,
    ...overrides,
  });
}

export const logicSequentialLeakFixture: StudentLeakFixture<LogicConfig> = {
  config: logicSequentialConfig(),
  forbiddenKeys: logicLeakFixture.forbiddenKeys,
  secrets: SECRET_VECTOR_STEPS,
};

/**
 * A wire between two placed pins, routed as one horizontal then one vertical
 * then one horizontal run (the grader reads the polyline, never routes).
 */
export function logicWire(id: string, from: [LogicComponent, number], to: [LogicComponent, number]): LogicWire {
  const at = ([c, p]: [LogicComponent, number]) => pinLocation(c, LOGIC_PARTS.part(c.kind).pins[p]!);
  const { x: x0, y: y0 } = at(from);
  const { x: x1, y: y1 } = at(to);
  const mid = Math.round((x0 + x1) / 40) * 20;
  const points: [number, number][] = y0 === y1 ? [[x0, y0], [x1, y1]] : [[x0, y0], [mid, y0], [mid, y1], [x1, y1]];
  return {
    id,
    a: { kind: "pin", c: from[0].id, p: from[1] },
    b: { kind: "pin", c: to[0].id, p: to[1] },
    via: [],
    points,
  };
}
