/**
 * Shared fixtures: one schematic and one config per shape the tests need.
 *
 * The schematics are built from the library's own pin geometry rather than
 * from literal coordinates, so a symbol whose pins move takes the fixtures
 * with it instead of silently unwiring them.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RunnerOutcome } from "@quiz/core/server";

import { BOX, LIBRARY, PORTS, type ComponentKind } from "../library.js";
import {
  CircuitConfig,
  type CircuitAnswer,
  type Orientation,
  type Schematic,
  type SchematicComponent,
  type SeriesSet,
  type Wire,
} from "../schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The exact stdout of `ngspice -b` on `rc-lowpass.cir`, captured on ngspice 42. */
export const readStdoutFixture = (): string =>
  readFileSync(join(HERE, "ngspice-rc-lowpass.stdout.txt"), "utf8");

/** The hand-verified deck the stdout fixture came from. */
export const readDeckFixture = (): string => readFileSync(join(HERE, "rc-lowpass.cir"), "utf8");

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
// The RC low-pass of `rc-lowpass.cir`
// ---------------------------------------------------------------------------

/**
 * R between `in+` and `out+`, C from `out+` down to a `GND` symbol.
 *
 * The same circuit as the verified deck: 1.59 kΩ and 100 nF, i.e. a corner at
 * one kilohertz, which is what `spice.int.test.ts` measures.
 */
export function rcLowPass(
  values: { r?: string; c?: string } = {},
): { schematic: Schematic; r: SchematicComponent; c: SchematicComponent } {
  resetIds();
  const r = component("R", "R1", 400, RAIL, { value: values.r ?? "1.59k" });
  const cap = component("C", "C1", 600, RAIL + 80, { value: values.c ?? "100n", m: ROT90 });
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
        // A free end landing on the middle of w2: the T-junction.
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

export const rcAnswer = (): CircuitAnswer => ({ schematic: rcLowPass().schematic });

// ---------------------------------------------------------------------------
// The fully populated config of the leak test
// ---------------------------------------------------------------------------

/** Distinctive enough that a substring search over the student view cannot miss it. */
export const SECRET_REFERENCE_NAME = "Rsecret";
export const SECRET_REFERENCE_VALUE = "123.4k";
export const SECRET_HIDDEN_STIMULUS = "hidden-secret-stimulus";
export const SECRET_RUBRIC = "SECRET_RUBRIC: the filter must roll off at 20 dB per decade";
export const SECRET_TOLERANCE = 0.0777;

/** The teacher's own circuit: the key. */
export function referenceSchematic(): Schematic {
  resetIds();
  const r = component("R", SECRET_REFERENCE_NAME, 400, RAIL, { value: SECRET_REFERENCE_VALUE });
  const cap = component("C", "Csecret", 600, RAIL + 80, { value: "100n", m: ROT90 });
  const gnd = component("GND", "GND", 600, RAIL + 140);
  const [rx0, ry0] = at(r, 0);
  const [rx1, ry1] = at(r, 1);
  const [cx0, cy0] = at(cap, 0);
  const [cx1, cy1] = at(cap, 1);
  const [gx, gy] = at(gnd, 0);
  return {
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
  };
}

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
    grading: { mode: "simulation", tolerance: SECRET_TOLERANCE, rubric: SECRET_RUBRIC },
    showExpected: false,
    simulationsPerMinute: 10,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Runner outcomes
// ---------------------------------------------------------------------------

/** A `wrdata` table, as ngspice would print it. */
export function spiceTable(series: SeriesSet): string {
  const header = " time            v(in)           v(out)          i(Vmeas)       ";
  const rows = series.t.map((t, i) =>
    [t, series.vin[i] ?? 0, series.vout[i] ?? 0, series.iout[i] ?? 0]
      .map((v) => v.toExponential(8))
      .join("  "),
  );
  return ["\nNote: No compatibility mode selected!\n", header, ...rows, "", "No. of Data Rows : 8"].join(
    "\n",
  );
}

/** `n` samples of a sine of the given amplitude and frequency, on `vout` and `vin` alike. */
export function sineSeries(
  options: { n?: number; amplitude?: number; frequencyHz?: number; phase?: number; stopS?: number } = {},
): SeriesSet {
  const n = options.n ?? 64;
  const amplitude = options.amplitude ?? 1;
  const frequencyHz = options.frequencyHz ?? 1000;
  const phase = options.phase ?? 0;
  const stopS = options.stopS ?? 5e-3;
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const time = (i * stopS) / (n - 1);
    t.push(time);
    v.push(amplitude * Math.sin(2 * Math.PI * frequencyHz * time + phase));
  }
  return { t, vin: [...v], vout: [...v], iout: v.map(() => 0) };
}

export type CaseOutcome = RunnerOutcome["cases"][number];

export function okCase(series: SeriesSet): CaseOutcome {
  return {
    exitCode: 0,
    stdout: spiceTable(series),
    stderr: "",
    ms: 40,
    timedOut: false,
    oom: false,
    truncated: false,
  };
}

export function failedCase(stderr = "Error on line 3 : R1 in out\n"): CaseOutcome {
  return {
    exitCode: 1,
    stdout: "",
    stderr,
    ms: 12,
    timedOut: false,
    oom: false,
    truncated: false,
  };
}

export function outcome(cases: CaseOutcome[]): RunnerOutcome {
  return { compile: { ok: true, stdout: "", stderr: "", ms: 0 }, cases };
}
