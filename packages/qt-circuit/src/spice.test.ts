import { describe, expect, it } from "vitest";

import { COMPONENT_KINDS, type ComponentKind } from "./library.js";
import {
  OUTPUT_COLUMNS,
  buildBareNetlist,
  buildNetlist,
  decimate,
  elementName,
  opampRails,
  parseSpiceOutput,
  sourceSpec,
  spiceNumber,
  tranLine,
  type Harness,
} from "./spice.js";
import { SERIES_MAX_POINTS, type Schematic, type Stimulus, type Supplies } from "./schema.js";
import {
  at,
  component,
  pinEnd,
  portEnd,
  rcLowPass,
  readStdoutFixture,
  resetIds,
  sineSeries,
  wire,
} from "./test/fixtures.js";

const NO_SUPPLIES: Supplies = { vcc: null, vee: null };
const GROUNDED: Harness = { supplies: NO_SUPPLIES, commonGround: true };

const sine = (overrides: Partial<Stimulus> = {}): Stimulus => ({
  name: "1 kHz sine",
  source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
  sourceOhms: 0,
  load: { kind: "open" },
  analysis: { stopMs: 5, skipMs: 0, points: 500 },
  points: 1,
  visible: true,
  ...overrides,
});

const lines = (text: string): string[] => text.trimEnd().split("\n");

describe("spiceNumber", () => {
  it("writes a plain number, never the student's suffix", () => {
    expect(spiceNumber(1590)).toBe("1.59e+3");
    expect(spiceNumber(1e-7)).toBe("1e-7");
    expect(spiceNumber(0)).toBe("0");
    expect(spiceNumber(100 * 1e-9)).toBe("1e-7");
    expect(spiceNumber(Number.NaN)).toBe("0");
  });
});

describe("elementName", () => {
  it("always starts with the element letter SPICE expects", () => {
    const used = new Set<string>();
    expect(elementName("R", "R1", used)).toBe("R1");
    expect(elementName("R", "Rload", used)).toBe("Rload");
    expect(elementName("R", "foo", used)).toBe("Rfoo");
    expect(elementName("NPN", "Q3", used)).toBe("Q3");
    expect(elementName("NMOS", "M1", used)).toBe("M1");
    // The op-amp reads `U1` on the canvas and is emitted as a VCVS.
    expect(elementName("OPAMP", "U1", used)).toBe("EU1");
  });

  it("never lets a designator take a harness name", () => {
    // `Rload`, `Vin`, `Vmeas`… are emitted by the harness itself, so a
    // student resistor called `Rload` has to move out of the way.
    resetIds();
    const clash = component("R", "Rload", 400, 200, { value: "1k" });
    const text = buildNetlist({ components: [clash], wires: [] }, sine(), GROUNDED).text;
    expect(text).toMatch(/^Rload2 \S+ \S+ 1e\+3$/m);
    expect(text).toContain("Rload out outl 1e+12");
  });

  it("sanitizes and disambiguates", () => {
    const used = new Set<string>();
    expect(elementName("R", "R+1", used)).toBe("R1");
    expect(elementName("R", "R1", used)).toBe("R12");
    expect(elementName("C", "", used)).toBe("C1");
  });
});

describe("sourceSpec", () => {
  it("writes the four excitations", () => {
    expect(sourceSpec({ kind: "dc", volts: -5 })).toBe("DC -5e+0");
    expect(sourceSpec({ kind: "sine", amplitude: 2, frequencyHz: 50, offset: 1 })).toBe(
      "SIN(1e+0 2e+0 5e+1)",
    );
    expect(sourceSpec({ kind: "pulse", low: 0, high: 5, frequencyHz: 1000, dutyCycle: 0.25 })).toBe(
      "PULSE(0 5e+0 0 1n 1n 2.5e-4 1e-3)",
    );
    expect(sourceSpec({ kind: "step", from: 0, to: 5, atMs: 1 })).toBe(
      "PWL(0 0 1e-3 0 1.000001e-3 5e+0)",
    );
  });

  it("keeps a PWL table strictly increasing when the step is at t = 0", () => {
    expect(sourceSpec({ kind: "step", from: 1, to: 2, atMs: 0 })).toBe("PWL(0 1e+0 1e-9 2e+0)");
  });
});

describe("tranLine", () => {
  it("splits the kept window into `points` steps", () => {
    expect(tranLine({ stopMs: 5, skipMs: 0, points: 500 })).toBe(".tran 1e-5 5e-3 0");
    expect(tranLine({ stopMs: 10, skipMs: 5, points: 500 })).toBe(".tran 1e-5 1e-2 5e-3");
  });
});

describe("buildNetlist: the RC low-pass", () => {
  const { text, issues } = buildNetlist(rcLowPass().schematic, sine(), GROUNDED);

  it("extracts cleanly", () => {
    expect(issues).toEqual([]);
  });

  it("emits the deck of the verified fixture", () => {
    expect(lines(text)).toEqual([
      "* quiz circuit",
      "R1 in out 1.59e+3",
      "C1 out 0 1e-7",
      "Vin in 0 SIN(0 1e+0 1e+3)",
      "Rload out outl 1e+12",
      "Vmeas outl 0 0",
      ".tran 1e-5 5e-3 0",
      ".control",
      "set wr_vecnames",
      "set wr_singlescale",
      "run",
      "linearize v(in) v(out) i(Vmeas)",
      "wrdata /dev/stdout v(in) v(out) i(Vmeas)",
      ".endc",
      ".end",
    ]);
  });

  it("never lets `1M` through as SPICE's milli", () => {
    const mega = buildNetlist(rcLowPass({ r: "1M" }).schematic, sine(), GROUNDED).text;
    expect(mega).toContain("R1 in out 1e+6");
    expect(mega).not.toMatch(/R1 in out .*1M/);
  });

  it("inserts a source resistance only when the teacher asked for one", () => {
    const withRs = buildNetlist(rcLowPass().schematic, sine({ sourceOhms: 50 }), GROUNDED).text;
    expect(withRs).toContain("Vin src 0 SIN(0 1e+0 1e+3)");
    expect(withRs).toContain("Rs src in 5e+1");
  });

  it("references the negative ports when there is no common ground", () => {
    const floating = buildNetlist(rcLowPass().schematic, sine(), {
      supplies: NO_SUPPLIES,
      commonGround: false,
    }).text;
    expect(floating).toContain("Vin in inn SIN(");
    expect(floating).toContain("Vmeas outl outn 0");
  });

  it("writes the load the teacher chose, an open one as a teraohm", () => {
    expect(buildNetlist(rcLowPass().schematic, sine(), GROUNDED).text).toContain(
      "Rload out outl 1e+12",
    );
    expect(
      buildNetlist(rcLowPass().schematic, sine({ load: { kind: "resistor", ohms: 1000 } }), GROUNDED)
        .text,
    ).toContain("Rload out outl 1e+3");
    expect(
      buildNetlist(
        rcLowPass().schematic,
        sine({ load: { kind: "capacitor", farads: 1e-9 } }),
        GROUNDED,
      ).text,
    ).toContain("Cload out outl 1e-9");
  });

  it("carries the supply rails when the harness declares them", () => {
    const supplied = buildNetlist(rcLowPass().schematic, sine(), {
      supplies: { vcc: 12, vee: -12 },
      commonGround: true,
    }).text;
    expect(supplied).toContain("Vcc vcc 0 DC 1.2e+1");
    expect(supplied).toContain("Vee vee 0 DC -1.2e+1");
  });

  it("writes the extraction issues into the deck as comments", () => {
    resetIds();
    const r = component("R", "R1", 400, 160, { value: "1k" });
    const [x, y] = at(r, 0);
    const half: Schematic = {
      components: [r],
      wires: [
        wire("w1", portEnd("in+"), pinEnd(r, 0), [
          [0, 160],
          [x, y],
        ]),
      ],
    };
    const built = buildNetlist(half, sine(), GROUNDED);
    expect(built.text).toContain("* issue: floating_pin R1.2");
    expect(built.issues.map((i) => i.code)).toContain("unconnected_port");
    // A broken schematic still produces a deck: the grader decides, not this.
    expect(built.text).toContain(".end");
  });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/** One instance of every kind, all pins on ground: enough to read the element lines. */
function oneOfEach(kinds: readonly ComponentKind[]): Schematic {
  resetIds();
  return {
    components: kinds.map((kind, i) =>
      component(kind, `X${i}`, 100 + i * 40, 200, {
        value: kind === "DZ" ? "5.1" : kind === "R" ? "1k" : kind === "C" ? "100n" : kind === "L" ? "10m" : "",
      }),
    ),
    wires: [],
  };
}

describe("buildNetlist: the devices", () => {
  it("emits the element line of every kind, pins in library order", () => {
    resetIds();
    const npn = component("NPN", "Q1", 200, 200);
    const nmos = component("NMOS", "M1", 400, 200);
    const diode = component("D", "D1", 600, 200);
    const text = buildNetlist({ components: [npn, nmos, diode], wires: [] }, sine(), GROUNDED).text;
    // Collector, base, emitter — and the MOSFET's bulk tied to its source.
    expect(text).toMatch(/^Q1 \S+ \S+ \S+ QNPN$/m);
    expect(text).toMatch(/^M1 (\S+) (\S+) (\S+) \3 NMOSE$/m);
    expect(text).toMatch(/^D1 \S+ \S+ DSI$/m);
  });

  it("emits each shared model card once, and only the ones it uses", () => {
    const text = buildNetlist(oneOfEach(COMPONENT_KINDS), sine(), GROUNDED).text;
    for (const card of [
      ".model DSI D(IS=1e-14 N=1)",
      ".model DSCH D(IS=1e-8 N=1.05)",
      ".model QNPN NPN(BF=100)",
      ".model QPNP PNP(BF=100)",
      ".model NMOSE NMOS(LEVEL=1 VTO=1 KP=1e-3)",
      ".model PMOSE PMOS(LEVEL=1 VTO=-1 KP=1e-3)",
      ".model NMOSD NMOS(LEVEL=1 VTO=-1 KP=1e-3)",
      ".model PMOSD PMOS(LEVEL=1 VTO=1 KP=1e-3)",
    ]) {
      expect(text.split(card).length - 1, card).toBe(1);
    }
    const rcOnly = buildNetlist(rcLowPass().schematic, sine(), GROUNDED).text;
    expect(rcOnly).not.toContain(".model");
  });

  it("gives every zener its own model card, keyed on its breakdown voltage", () => {
    resetIds();
    const a = component("DZ", "D1", 200, 200, { value: "5.1" });
    const b = component("DZ", "D2", 400, 200, { value: "12" });
    const text = buildNetlist({ components: [a, b], wires: [] }, sine(), GROUNDED).text;
    expect(text).toContain(".model DZ_D1 D(IS=1e-14 BV=5.1e+0 IBV=1e-3)");
    expect(text).toContain(".model DZ_D2 D(IS=1e-14 BV=1.2e+1 IBV=1e-3)");
    expect(text).toMatch(/^D1 \S+ \S+ DZ_D1$/m);
  });

  it("clamps the op-amp at the declared rails, and at ±15 V when none are", () => {
    expect(opampRails({ vcc: null, vee: null })).toEqual({ vcc: 15, vee: -15 });
    expect(opampRails({ vcc: 5, vee: null })).toEqual({ vcc: 5, vee: 0 });
    expect(opampRails({ vcc: null, vee: -9 })).toEqual({ vcc: 0, vee: -9 });
    expect(opampRails({ vcc: 12, vee: -12 })).toEqual({ vcc: 12, vee: -12 });

    resetIds();
    const amp = component("OPAMP", "U1", 400, 200);
    const schematic: Schematic = { components: [amp], wires: [] };
    expect(buildNetlist(schematic, sine(), GROUNDED).text).toMatch(
      /^EU1 \S+ 0 TABLE \{V\(\S+,\S+\)\} = \(-1e-4, -1\.5e\+1\) \(1e-4, 1\.5e\+1\)$/m,
    );
    expect(
      buildNetlist(schematic, sine(), { supplies: { vcc: 5, vee: null }, commonGround: true }).text,
    ).toContain("(-1e-4, 0) (1e-4, 5e+0)");
  });

  it("falls back to the library default rather than emitting an unusable value", () => {
    resetIds();
    const r = component("R", "R1", 400, 200, { value: "nonsense" });
    const built = buildNetlist({ components: [r], wires: [] }, sine(), GROUNDED);
    expect(built.issues.map((i) => i.code)).toContain("invalid_value");
    expect(built.text).toContain("R1 n1 n2 1e+4");
  });
});

describe("buildBareNetlist", () => {
  it("drops the harness: no source, no load, no analysis", () => {
    const text = buildBareNetlist(rcLowPass().schematic, GROUNDED).text;
    expect(lines(text)).toEqual(["* quiz circuit", "R1 in out 1.59e+3", "C1 out 0 1e-7", ".end"]);
  });
});

// ---------------------------------------------------------------------------
// Reading ngspice back
// ---------------------------------------------------------------------------

describe("parseSpiceOutput", () => {
  const parsed = parseSpiceOutput(readStdoutFixture());

  it("reads the captured ngspice 42 run", () => {
    expect(parsed).not.toBeNull();
    // `linearize` resamples onto the `.tran` step: 0 … 5 ms by 10 µs.
    expect(parsed?.t.length).toBe(501);
    expect(parsed?.vin.length).toBe(501);
    expect(parsed?.t[0]).toBe(0);
    expect(parsed?.t[500]).toBeCloseTo(5e-3, 9);
  });

  it("reads a low-pass at its corner: the output swings ~0.707 of the input", () => {
    const vout = parsed?.vout ?? [];
    const vin = parsed?.vin ?? [];
    // Steady state only: the first period carries the turn-on transient.
    const steady = (a: number[]): number => Math.max(...a.slice(200).map(Math.abs));
    expect(steady(vout) / steady(vin)).toBeCloseTo(0.707, 2);
  });

  it("knows the four columns it asked for", () => {
    expect(OUTPUT_COLUMNS).toEqual(["time", "v(in)", "v(out)", "i(vmeas)"]);
  });

  it("returns null when ngspice printed no table", () => {
    expect(parseSpiceOutput("")).toBeNull();
    expect(parseSpiceOutput("Error on line 4 : R1 in out\nsimulation aborted\n")).toBeNull();
    // A header with nothing under it is not a result either.
    expect(parseSpiceOutput(" time            v(in)           v(out)          i(Vmeas)\n")).toBeNull();
  });

  it("stops at the trailing notes ngspice prints after the table", () => {
    const set = parseSpiceOutput(
      [
        " time            v(in)           v(out)          i(Vmeas)",
        " 0.0  1.0  2.0  3.0",
        " 1.0  2.0  3.0  4.0",
        "",
        "No. of Data Rows : 2",
      ].join("\n"),
    );
    expect(set?.t).toEqual([0, 1]);
    expect(set?.vout).toEqual([2, 3]);
  });
});

describe("decimate", () => {
  it("leaves a short series alone", () => {
    const short = sineSeries({ n: 10 });
    expect(decimate(short)).toBe(short);
  });

  it("keeps the first and the last sample", () => {
    const long = sineSeries({ n: 2000 });
    const small = decimate(long);
    expect(small.t.length).toBe(SERIES_MAX_POINTS);
    expect(small.t[0]).toBe(long.t[0]);
    expect(small.t[SERIES_MAX_POINTS - 1]).toBe(long.t[1999]);
    expect(small.vout[SERIES_MAX_POINTS - 1]).toBe(long.vout[1999]);
  });

  it("honours a smaller budget", () => {
    expect(decimate(sineSeries({ n: 500 }), 10).t.length).toBe(10);
  });
});
