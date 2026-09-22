/**
 * The integration suite: the decks this package emits, through a REAL ngspice.
 *
 * Everything else in the package is arithmetic on strings, and a model card
 * that ngspice rejects looks exactly like one it accepts until something runs
 * it. This is where the recipe of `spice.ts` is actually validated — the
 * op-amp's `TABLE` clamp, every `.model` card, the harness, the control
 * block — so a change to the emitter is not finished until this suite has
 * run.
 *
 * It needs the `quiz-runner-spice` image and a Podman socket, and skips
 * itself cleanly without them: `pnpm test` on a laptop with no container
 * engine still passes, and CI on the runner host covers it. Podman is driven
 * in `--remote` as everywhere else in this repository (invariant 13):
 * without it the binary silently falls back to local rootless mode and the
 * image is not even visible.
 */
import { execFile, execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { buildNetlist, parseSpiceOutput, type Harness } from "./spice.js";
import type { Orientation, Schematic, SchematicComponent, SeriesSet, Stimulus, Supplies } from "./schema.js";
import { ROT90, at, component, freeEnd, pinEnd, portEnd, resetIds, wire } from "./test/fixtures.js";

const IMAGE = "localhost/quiz-runner-spice:latest";
const TIMEOUT_MS = 60_000;

function imageAvailable(): boolean {
  try {
    execFileSync("podman", ["--remote", "image", "exists", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const available = imageAvailable();

/** One deck, one container: `--remote`, no pull, the deck on stdin. */
function ngspice(deck: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      "podman",
      ["--remote", "run", "--rm", "-i", "--pull=never", IMAGE, "ngspice", "-b"],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (_error, stdout, stderr) => resolve({ stdout, stderr }),
    );
    child.stdin?.end(deck);
  });
}

// ---------------------------------------------------------------------------
// The circuits
// ---------------------------------------------------------------------------

/** 270°: a two-terminal symbol stands up with pin 0 at the BOTTOM. */
const ROT270: Orientation = [0, -1, 1, 0];

const NO_SUPPLIES: Supplies = { vcc: null, vee: null };
const GROUNDED: Harness = { supplies: NO_SUPPLIES, commonGround: true };

const stimulus = (overrides: Partial<Stimulus> = {}): Stimulus => ({
  name: "case",
  source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
  sourceOhms: 0,
  load: { kind: "open" },
  analysis: { stopMs: 5, skipMs: 0, points: 500 },
  points: 1,
  visible: true,
  ...overrides,
});

/** A straight two-point wire between two pins; connectivity reads the ends only. */
function link(id: string, a: SchematicComponent, ap: number, b: SchematicComponent, bp: number) {
  return wire(id, pinEnd(a, ap), pinEnd(b, bp), [at(a, ap), at(b, bp)]);
}

function rcLowPassSchematic(): Schematic {
  resetIds();
  const r = component("R", "R1", 400, 160, { value: "1.59k" });
  const cap = component("C", "C1", 600, 240, { value: "100n", m: ROT90 });
  const gnd = component("GND", "GND", 600, 300);
  return {
    components: [r, cap, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(r, 0), [[0, 160], at(r, 0)]),
      wire("w2", pinEnd(r, 1), portEnd("out+"), [at(r, 1), [800, 160]]),
      wire("w3", pinEnd(cap, 0), freeEnd(600, 160), [at(cap, 0), [600, 160]]),
      link("w4", cap, 1, gnd, 0),
    ],
  };
}

/** R1 from the input to the inverting node, R2 back from the output: gain −R2/R1. */
function invertingAmplifier(): Schematic {
  resetIds();
  const r1 = component("R", "R1", 160, 160, { value: "1k" });
  const r2 = component("R", "R2", 400, 60, { value: "10k" });
  const amp = component("OPAMP", "U1", 400, 160);
  const gnd = component("GND", "GND", 360, 260);
  return {
    components: [r1, r2, amp, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(r1, 0), [[0, 160], at(r1, 0)]),
      wire("w2", pinEnd(r1, 1), pinEnd(amp, 0), [at(r1, 1), [200, 140], at(amp, 0)]),
      link("w3", r2, 0, amp, 0),
      link("w4", r2, 1, amp, 2),
      wire("w5", pinEnd(amp, 2), portEnd("out+"), [at(amp, 2), [800, 160]]),
      link("w6", amp, 1, gnd, 0),
    ],
  };
}

/** The non-inverting input follows the source, the inverting one sits at 0 V. */
function comparator(): Schematic {
  resetIds();
  const amp = component("OPAMP", "U1", 400, 160);
  const gnd = component("GND", "GND", 360, 60);
  return {
    components: [amp, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(amp, 1), [[0, 160], [0, 180], at(amp, 1)]),
      link("w2", amp, 0, gnd, 0),
      wire("w3", pinEnd(amp, 2), portEnd("out+"), [at(amp, 2), [800, 160]]),
    ],
  };
}

/** A base resistor, a collector load, the emitter on ground: it only has to converge. */
function commonEmitter(): Schematic {
  resetIds();
  const rb = component("R", "R1", 160, 160, { value: "100k" });
  const rc = component("R", "R2", 400, 80, { value: "1k", m: ROT90 });
  const q = component("NPN", "Q1", 400, 200);
  const vcc = component("VCC", "VCC", 400, 40);
  const gnd = component("GND", "GND", 400, 300);
  return {
    components: [rb, rc, q, vcc, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(rb, 0), [[0, 160], at(rb, 0)]),
      wire("w2", pinEnd(rb, 1), pinEnd(q, 1), [at(rb, 1), [200, 200], at(q, 1)]),
      link("w3", rc, 1, q, 0),
      link("w4", q, 2, gnd, 0),
      wire("w5", pinEnd(q, 0), portEnd("out+"), [at(q, 0), [800, 160]]),
    ],
  };
}

/** The gate is driven by the pulse, the drain pulled to VCC: an inverter. */
function mosfetSwitch(): Schematic {
  resetIds();
  const rd = component("R", "R1", 400, 80, { value: "1k", m: ROT90 });
  const m = component("NMOS", "M1", 400, 200);
  const vcc = component("VCC", "VCC", 400, 40);
  const gnd = component("GND", "GND", 400, 300);
  return {
    components: [rd, m, vcc, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(m, 1), [[0, 160], [0, 200], at(m, 1)]),
      link("w2", rd, 1, m, 0),
      link("w3", m, 2, gnd, 0),
      wire("w4", pinEnd(m, 0), portEnd("out+"), [at(m, 0), [800, 160]]),
    ],
  };
}

/** A series resistor and a 5.1 V zener to ground: the output is clipped both ways. */
function zenerClamp(): Schematic {
  resetIds();
  const r = component("R", "R1", 160, 160, { value: "1k" });
  // Cathode up (on the output), anode down (on ground).
  const dz = component("DZ", "D1", 400, 240, { value: "5.1", m: ROT270 });
  const gnd = component("GND", "GND", 400, 340);
  return {
    components: [r, dz, gnd],
    wires: [
      wire("w1", portEnd("in+"), pinEnd(r, 0), [[0, 160], at(r, 0)]),
      wire("w2", pinEnd(r, 1), portEnd("out+"), [at(r, 1), [800, 160]]),
      wire("w3", pinEnd(dz, 1), freeEnd(400, 160), [at(dz, 1), [400, 160]]),
      link("w4", dz, 0, gnd, 0),
    ],
  };
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

const peak = (values: readonly number[], from = 0): number =>
  Math.max(...values.slice(from).map(Math.abs));

async function simulate(
  schematic: Schematic,
  stim: Stimulus,
  harness: Harness = GROUNDED,
): Promise<SeriesSet> {
  const { text, issues } = buildNetlist(schematic, stim, harness);
  expect(issues, text).toEqual([]);
  const { stdout, stderr } = await ngspice(text);
  const series = parseSpiceOutput(stdout);
  expect(series, `${text}\n--- stderr ---\n${stderr}`).not.toBeNull();
  return series as SeriesSet;
}

describe.skipIf(!available)("the emitted decks on a real ngspice", () => {
  it(
    "an RC low-pass is at −3 dB on its corner frequency",
    async () => {
      const series = await simulate(rcLowPassSchematic(), stimulus());
      // Steady state only: the first period carries the turn-on transient.
      const from = Math.floor(series.t.length / 2);
      expect(peak(series.vout, from) / peak(series.vin, from)).toBeCloseTo(0.707, 2);
    },
    TIMEOUT_MS,
  );

  it(
    "an inverting amplifier has a gain of −10 on the default ±15 V rails",
    async () => {
      const series = await simulate(invertingAmplifier(), stimulus({ source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 } }));
      const from = Math.floor(series.t.length / 2);
      expect(peak(series.vout, from) / peak(series.vin, from)).toBeCloseTo(10, 0);
      // Inverting: the two curves have opposite signs wherever the input is
      // far enough from zero to mean something.
      const opposite = series.t
        .map((_t, i) => [series.vin[i] ?? 0, series.vout[i] ?? 0] as const)
        .filter(([vin]) => Math.abs(vin) > 0.5)
        .every(([vin, vout]) => vin * vout < 0);
      expect(opposite).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "a comparator saturates at the rails",
    async () => {
      const series = await simulate(comparator(), stimulus());
      expect(Math.max(...series.vout)).toBeCloseTo(15, 3);
      expect(Math.min(...series.vout)).toBeCloseTo(-15, 3);
    },
    TIMEOUT_MS,
  );

  it(
    "a common-emitter stage converges",
    async () => {
      const series = await simulate(
        commonEmitter(),
        stimulus({ source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 1 } }),
        { supplies: { vcc: 15, vee: null }, commonGround: true },
      );
      expect(series.t.length).toBeGreaterThan(100);
      expect(series.vout.every((v) => Number.isFinite(v) && v >= -1 && v <= 16)).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    "a MOSFET switch pulls its drain down when the gate is high",
    async () => {
      const series = await simulate(
        mosfetSwitch(),
        stimulus({
          source: { kind: "pulse", low: 0, high: 5, frequencyHz: 1000, dutyCycle: 0.5 },
        }),
        { supplies: { vcc: 5, vee: null }, commonGround: true },
      );
      const high = series.t.filter((_t, i) => (series.vin[i] ?? 0) > 4.5);
      expect(high.length).toBeGreaterThan(10);
      const onValues = series.vout.filter((_v, i) => (series.vin[i] ?? 0) > 4.5);
      const offValues = series.vout.filter((_v, i) => (series.vin[i] ?? 0) < 0.5);
      expect(Math.max(...onValues)).toBeLessThan(3);
      expect(Math.min(...offValues)).toBeGreaterThan(4.5);
    },
    TIMEOUT_MS,
  );

  it(
    "a zener clamps the positive half at its breakdown and the negative at a diode drop",
    async () => {
      const series = await simulate(
        zenerClamp(),
        stimulus({ source: { kind: "sine", amplitude: 10, frequencyHz: 1000, offset: 0 } }),
      );
      expect(Math.max(...series.vout)).toBeGreaterThan(4.5);
      expect(Math.max(...series.vout)).toBeLessThan(6);
      expect(Math.min(...series.vout)).toBeGreaterThan(-1.2);
      expect(Math.min(...series.vout)).toBeLessThan(-0.4);
    },
    TIMEOUT_MS,
  );
});
