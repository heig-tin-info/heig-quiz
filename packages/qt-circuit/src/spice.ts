/**
 * The SPICE emitter and the ngspice output parser.
 *
 * The netlist is NEVER stored and never travels from a browser: it is built
 * here, server-side, from the stored schematic and the teacher's stimulus
 * (invariant 14). A student can therefore not smuggle a `.include`, a
 * `.model` of their own or a `shell` line into the deck — the only thing they
 * control is which symbols sit on which nets, and the names they chose are
 * sanitized on the way out.
 *
 * The recipe below is not theoretical: every element line, every model card
 * and the control block are the ones `src/spice.int.test.ts` runs through a
 * real ngspice 42, and `src/test/rc-lowpass.cir` is a deck verified by hand.
 * Change one of them and run that suite.
 */
import {
  LIBRARY,
  parseValue,
  type ComponentKind,
  type PinSpec,
} from "./library.js";
import { extractNets, pinKey, type NetlistIssue } from "./netlist.js";
import {
  SERIES_MAX_POINTS,
  type Analysis,
  type Load,
  type Schematic,
  type SchematicComponent,
  type SeriesSet,
  type Source,
  type Stimulus,
  type Supplies,
} from "./schema.js";

/** What the teacher wraps around the box: the rails, and how the two sides reference each other. */
export interface Harness {
  supplies: Supplies;
  commonGround: boolean;
}

/**
 * The op-amp rails when the teacher declared none.
 *
 * An ideal op-amp still has to saturate somewhere or a comparator question
 * has no answer, so a config with no supplies gets the textbook ±15 V. One
 * declared rail pulls the other to 0 V, which is the single-supply case.
 */
export const DEFAULT_OPAMP_RAIL = 15;

/** An "open" load is a very large resistor: ngspice has no floating node, and 1 TΩ draws nothing. */
export const OPEN_LOAD_OHMS = 1e12;

/** The fixed names of the harness; a student designator may never take one. */
const RESERVED_NAMES = ["Vin", "Rs", "Rload", "Cload", "Vmeas", "Vcc", "Vee"] as const;

/**
 * The SPICE element letter per kind.
 *
 * It is the library `prefix` everywhere but the op-amp: `U1` is what the
 * student reads on the canvas, while the device is emitted as a voltage
 * controlled source, so its element letter is `E`.
 */
const SPICE_PREFIX: Readonly<Record<ComponentKind, string>> = {
  R: "R",
  C: "C",
  L: "L",
  D: "D",
  DS: "D",
  DZ: "D",
  NPN: "Q",
  PNP: "Q",
  NMOS: "M",
  PMOS: "M",
  NMOSD: "M",
  PMOSD: "M",
  OPAMP: "E",
  GND: "",
  VCC: "",
  VEE: "",
};

// ---------------------------------------------------------------------------
// Numbers and names
// ---------------------------------------------------------------------------

/**
 * A value as SPICE must read it: a plain number in exponent notation.
 *
 * NEVER the student's text. SPICE reads `1M` as one MILLI, so `formatValue`'s
 * engineering notation — which a first-year student writes and reads
 * correctly — would silently become a millionth of the intended resistance.
 */
export function spiceNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  // `100 * 1e-9` is `1.0000000000000001e-7` in binary floating point, and a
  // deck a teacher reads should not say that. Twelve significant digits keep
  // every value the schema accepts and drop the noise.
  return Number(value.toPrecision(12)).toExponential();
}

/** The value of a component, in SI units; an unusable one falls back to the library default. */
export function componentValue(component: SchematicComponent): number {
  const parsed = parseValue(component.value);
  if (parsed !== null) return parsed;
  // The value is already reported as `missing_value` / `invalid_value`; the
  // deck stays runnable so the teacher sees a plot beside the diagnostic
  // rather than a wall of ngspice errors.
  return parseValue(LIBRARY[component.kind].defaultValue) ?? 1;
}

/**
 * The element name of a placed component.
 *
 * The first letter is always the element letter SPICE expects, so no
 * designator can turn a resistor into something else: `R1` stays `R1`,
 * `Rload` stays `Rload`, and `foo` on a resistor becomes `Rfoo`. Everything
 * outside `[A-Za-z0-9_]` is dropped, and a collision — including one with a
 * harness name — takes a numeric suffix.
 */
export function elementName(kind: ComponentKind, designator: string, used: Set<string>): string {
  const prefix = SPICE_PREFIX[kind];
  const clean = designator.replace(/[^A-Za-z0-9_]/g, "");
  const tail = clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
  const base = `${prefix}${tail}` === prefix ? `${prefix}1` : `${prefix}${tail}`;
  let name = base;
  let n = 1;
  while (used.has(name.toLowerCase())) {
    n += 1;
    name = `${base}${n}`;
  }
  used.add(name.toLowerCase());
  return name;
}

// ---------------------------------------------------------------------------
// The harness lines
// ---------------------------------------------------------------------------

/** The SPICE transient spec of a source, `SIN(...)` / `PULSE(...)` / `PWL(...)` / `DC v`. */
export function sourceSpec(source: Source): string {
  const n = spiceNumber;
  switch (source.kind) {
    case "dc":
      return `DC ${n(source.volts)}`;
    case "sine":
      return `SIN(${n(source.offset)} ${n(source.amplitude)} ${n(source.frequencyHz)})`;
    case "pulse": {
      const period = 1 / source.frequencyHz;
      return `PULSE(${n(source.low)} ${n(source.high)} 0 1n 1n ${n(source.dutyCycle * period)} ${n(period)})`;
    }
    case "step": {
      const at = source.atMs / 1000;
      // Two points at t = 0 would be a non-increasing PWL table, which
      // ngspice refuses; a step at t = 0 is simply the edge on its own.
      if (at <= 0) return `PWL(0 ${n(source.from)} 1e-9 ${n(source.to)})`;
      return `PWL(0 ${n(source.from)} ${n(at)} ${n(source.from)} ${n(at + 1e-9)} ${n(source.to)})`;
    }
    default:
      return "DC 0";
  }
}

/** The load between `out` and the measuring source: `Rload` or `Cload`. */
function loadLine(load: Load): string {
  switch (load.kind) {
    case "open":
      return `Rload out outl ${spiceNumber(OPEN_LOAD_OHMS)}`;
    case "resistor":
      return `Rload out outl ${spiceNumber(load.ohms)}`;
    case "capacitor":
      return `Cload out outl ${spiceNumber(load.farads)}`;
    default:
      return `Rload out outl ${spiceNumber(OPEN_LOAD_OHMS)}`;
  }
}

/** `.tran step stop skip`: `points` samples are kept between `skip` and `stop`. */
export function tranLine(analysis: Analysis): string {
  const stop = analysis.stopMs / 1000;
  const skip = analysis.skipMs / 1000;
  const step = (stop - skip) / analysis.points;
  return `.tran ${spiceNumber(step)} ${spiceNumber(stop)} ${spiceNumber(skip)}`;
}

/** The rails an op-amp saturates at, with the ±15 V fallback of {@link DEFAULT_OPAMP_RAIL}. */
export function opampRails(supplies: Supplies): { vcc: number; vee: number } {
  if (supplies.vcc === null && supplies.vee === null) {
    return { vcc: DEFAULT_OPAMP_RAIL, vee: -DEFAULT_OPAMP_RAIL };
  }
  return { vcc: supplies.vcc ?? 0, vee: supplies.vee ?? 0 };
}

/**
 * The control block, verbatim from the verified fixture.
 *
 * `wr_vecnames` prints the header line the parser keys on, `wr_singlescale`
 * collapses the scale to one `time` column, and `linearize` resamples the
 * variable-step transient onto the `.tran` step so two runs of two different
 * circuits come back on comparable grids.
 */
const CONTROL_BLOCK = [
  ".control",
  "set wr_vecnames",
  "set wr_singlescale",
  "run",
  "linearize v(in) v(out) i(Vmeas)",
  "wrdata /dev/stdout v(in) v(out) i(Vmeas)",
  ".endc",
  ".end",
];

// ---------------------------------------------------------------------------
// buildNetlist
// ---------------------------------------------------------------------------

/** A model card and the name the element lines refer to it by. */
interface Model {
  name: string;
  card: string;
}

/** What an emitter needs to know about one placed component. */
interface EmitContext {
  component: SchematicComponent;
  /** The sanitized element name, from {@link elementName}. */
  name: string;
  /** The net of pin `i`, in the library's ELECTRICAL pin order. */
  at: (i: number) => string;
  rails: { vcc: number; vee: number };
}

/** One component's element line and, when it needs one, its model card. */
interface Emitted {
  line: string;
  model?: Model;
}

type Emitter = (context: EmitContext) => Emitted;

/** R, C, L: two nodes and the value. */
const passive: Emitter = ({ component, name, at }) => ({
  line: `${name} ${at(0)} ${at(1)} ${spiceNumber(componentValue(component))}`,
});

/** Anode, cathode, and a model card shared by every instance of the kind. */
const diode =
  (model: Model): Emitter =>
  ({ name, at }) => ({ line: `${name} ${at(0)} ${at(1)} ${model.name}`, model });

/** Collector, base, emitter. */
const bjt =
  (model: Model): Emitter =>
  ({ name, at }) => ({ line: `${name} ${at(0)} ${at(1)} ${at(2)} ${model.name}`, model });

/**
 * Drain, gate, source — and the bulk tied to the source: a discrete MOSFET is
 * built that way and the student has no fourth pin to wire it with.
 */
const mosfet =
  (model: Model): Emitter =>
  ({ name, at }) => ({ line: `${name} ${at(0)} ${at(1)} ${at(2)} ${at(2)} ${model.name}`, model });

/** A zener's breakdown voltage is per instance, so is its model card. */
const zener: Emitter = ({ component, name, at }) => {
  const modelName = `DZ_${name}`;
  return {
    line: `${name} ${at(0)} ${at(1)} ${modelName}`,
    model: {
      name: modelName,
      card: `.model ${modelName} D(IS=1e-14 BV=${spiceNumber(componentValue(component))} IBV=1e-3)`,
    },
  };
};

// An ideal op-amp with rails: a VCVS whose transfer table saturates.
// The 100 µV knee is the open-loop gain (150 000 with ±15 V rails),
// high enough for a virtual short and low enough to converge — both
// an inverting amplifier and a comparator are in the integration
// suite because of this line.
const opamp: Emitter = ({ name, at, rails }) => ({
  line: `${name} ${at(2)} 0 TABLE {V(${at(1)},${at(0)})} = (-1e-4, ${spiceNumber(rails.vee)}) (1e-4, ${spiceNumber(rails.vcc)})`,
});

/**
 * How each kind becomes SPICE, with its shared model card where it has one;
 * `null` for the terminals, which name a net and emit no element. Kept here
 * and not in `library.ts`: the library is imported by the canvas and must not
 * learn SPICE.
 */
const EMITTERS: Readonly<Record<ComponentKind, Emitter | null>> = {
  R: passive,
  C: passive,
  L: passive,
  D: diode({ name: "DSI", card: ".model DSI D(IS=1e-14 N=1)" }),
  DS: diode({ name: "DSCH", card: ".model DSCH D(IS=1e-8 N=1.05)" }),
  DZ: zener,
  NPN: bjt({ name: "QNPN", card: ".model QNPN NPN(BF=100)" }),
  PNP: bjt({ name: "QPNP", card: ".model QPNP PNP(BF=100)" }),
  NMOS: mosfet({ name: "NMOSE", card: ".model NMOSE NMOS(LEVEL=1 VTO=1 KP=1e-3)" }),
  PMOS: mosfet({ name: "PMOSE", card: ".model PMOSE PMOS(LEVEL=1 VTO=-1 KP=1e-3)" }),
  NMOSD: mosfet({ name: "NMOSD", card: ".model NMOSD NMOS(LEVEL=1 VTO=-1 KP=1e-3)" }),
  PMOSD: mosfet({ name: "PMOSD", card: ".model PMOSD PMOS(LEVEL=1 VTO=1 KP=1e-3)" }),
  OPAMP: opamp,
  GND: null,
  VCC: null,
  VEE: null,
};

interface Devices {
  elements: string[];
  models: string[];
  issues: NetlistIssue[];
}

/** The device lines and the model cards of a schematic: the part no stimulus changes. */
function emitDevices(schematic: Schematic, harness: Harness): Devices {
  const netlist = extractNets(schematic, {
    commonGround: harness.commonGround,
    supplies: harness.supplies,
  });

  const netOf = (componentId: string, pin: number): string =>
    netlist.netOfPin.get(pinKey({ c: componentId, p: pin }))?.name ?? "0";

  const used = new Set<string>(RESERVED_NAMES.map((n) => n.toLowerCase()));
  const elements: string[] = [];
  const models = new Map<string, string>();
  const rails = opampRails(harness.supplies);

  for (const component of schematic.components) {
    const emit = EMITTERS[component.kind];
    if (emit === null) continue;
    const name = elementName(component.kind, component.name, used);
    // The pins come out of the library in ELECTRICAL order, which is exactly
    // the order SPICE wants (anode/cathode, collector/base/emitter…).
    const nets = LIBRARY[component.kind].pins.map((_pin: PinSpec, i: number) => netOf(component.id, i));
    const { line, model } = emit({ component, name, at: (i) => nets[i] ?? "0", rails });
    if (model !== undefined) models.set(model.name, model.card);
    elements.push(line);
  }

  return {
    elements,
    models: [...models.keys()].sort().map((k) => models.get(k) ?? ""),
    issues: netlist.issues,
  };
}

/** The title line plus one comment per extraction issue: a deck says what is wrong with it. */
function header(issues: readonly NetlistIssue[]): string[] {
  return [
    "* quiz circuit",
    ...issues.map((issue) => `* issue: ${issue.code} ${issue.ref}`.trimEnd()),
  ];
}

/**
 * A complete ngspice deck for one schematic under one stimulus.
 *
 * It ALWAYS returns text, even when the schematic is broken: the grader owns
 * the verdict, and a deck that ngspice refuses is a more useful diagnostic
 * for the teacher than a missing file. The extraction issues travel beside
 * the text and are also written into the deck as comments, so a netlist
 * copied out of a grading panel says what was wrong with it.
 */
export function buildNetlist(
  schematic: Schematic,
  stimulus: Stimulus,
  harness: Harness,
): { text: string; issues: NetlistIssue[] } {
  const devices = emitDevices(schematic, harness);
  const lines: string[] = [...header(devices.issues), ...devices.elements, ...devices.models];

  if (harness.supplies.vcc !== null) lines.push(`Vcc vcc 0 DC ${spiceNumber(harness.supplies.vcc)}`);
  if (harness.supplies.vee !== null) lines.push(`Vee vee 0 DC ${spiceNumber(harness.supplies.vee)}`);

  const inRef = harness.commonGround ? "0" : "inn";
  const outRef = harness.commonGround ? "0" : "outn";
  const spec = sourceSpec(stimulus.source);
  if (stimulus.sourceOhms > 0) {
    lines.push(`Vin src ${inRef} ${spec}`);
    lines.push(`Rs src in ${spiceNumber(stimulus.sourceOhms)}`);
  } else {
    lines.push(`Vin in ${inRef} ${spec}`);
  }

  lines.push(loadLine(stimulus.load));
  // A 0 V source in series with the load: `i(Vmeas)` is the load current,
  // which is the only current the student's plot ever shows.
  lines.push(`Vmeas outl ${outRef} 0`);

  lines.push(tranLine(stimulus.analysis));
  lines.push(...CONTROL_BLOCK);

  return { text: `${lines.join("\n")}\n`, issues: devices.issues };
}

/**
 * The same devices with NO harness: no source, no load, no analysis.
 *
 * The `llm` mode sends the student's circuit and the teacher's to a model
 * side by side, and a question with no stimulus has no harness to wrap them
 * in — this is the netlist a human would read, and nothing else needs it.
 */
export function buildBareNetlist(
  schematic: Schematic,
  harness: Harness,
): { text: string; issues: NetlistIssue[] } {
  const devices = emitDevices(schematic, harness);
  const lines = [...header(devices.issues), ...devices.elements, ...devices.models, ".end"];
  return { text: `${lines.join("\n")}\n`, issues: devices.issues };
}

// ---------------------------------------------------------------------------
// Parsing ngspice's batch output
// ---------------------------------------------------------------------------

/** The four columns `wrdata` prints, lowercased: the header the parser keys on. */
export const OUTPUT_COLUMNS: readonly string[] = ["time", "v(in)", "v(out)", "i(vmeas)"];

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Reads the table out of `ngspice -b`'s stdout.
 *
 * Batch mode prints a banner, the operating point and assorted notes around
 * the table, so the parser looks for the `wr_vecnames` header line and then
 * takes every following line that is four numbers. `null` when there is no
 * header or no row at all — which is how a failed run is recognised, since
 * ngspice may exit 0 after refusing a deck.
 */
export function parseSpiceOutput(stdout: string): SeriesSet | null {
  const lines = stdout.split("\n");
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length !== OUTPUT_COLUMNS.length) continue;
    if (tokens.every((t, i) => t.toLowerCase() === OUTPUT_COLUMNS[i])) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return null;

  const t: number[] = [];
  const vin: number[] = [];
  const vout: number[] = [];
  const iout: number[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) break;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length !== 4 || !tokens.every((tok) => NUMBER_RE.test(tok))) {
      if (t.length > 0) break;
      continue;
    }
    t.push(Number(tokens[0]));
    vin.push(Number(tokens[1]));
    vout.push(Number(tokens[2]));
    iout.push(Number(tokens[3]));
  }
  if (t.length === 0) return null;
  return { t, vin, vout, iout };
}

/**
 * Keeps at most `max` samples, first and last among them.
 *
 * A 2000-point transient is stored in `gradings.details` and sent to a
 * browser; the plot cannot show more than a few hundred points anyway, and
 * the row must stay small enough to be read back with the grading.
 */
export function decimate(series: SeriesSet, max: number = SERIES_MAX_POINTS): SeriesSet {
  const n = series.t.length;
  if (n <= max || max < 2) return series;
  const pick = <T>(a: readonly T[], i: number): T | undefined => a[i];
  const t: number[] = [];
  const vin: number[] = [];
  const vout: number[] = [];
  const iout: number[] = [];
  for (let k = 0; k < max; k += 1) {
    const i = Math.round((k * (n - 1)) / (max - 1));
    t.push(pick(series.t, i) ?? 0);
    vin.push(pick(series.vin, i) ?? 0);
    vout.push(pick(series.vout, i) ?? 0);
    iout.push(pick(series.iout, i) ?? 0);
  }
  return { t, vin, vout, iout };
}
