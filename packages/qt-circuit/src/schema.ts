/**
 * The `circuit` question type: schemas (docs/spec/04 §4.11, brought forward).
 *
 * A two-port ("quadripole") box with four ports — `in+`/`in-` on the left,
 * `out+`/`out-` on the right — inside which the student places components
 * from a restricted palette and wires them. The teacher decides what excites
 * the input, what loads the output, and how the answer is graded:
 *
 * - `manual`: the teacher looks at the schematic (and at a simulation when
 *   the question has stimuli) and grades by hand;
 * - `simulation`: the student's netlist and the teacher's reference are run
 *   through ngspice (`apps/runner`, language `spice`) under every stimulus,
 *   and the output waveforms are compared;
 * - `llm`: phase 2 — the netlist and the rubric go to the LLM service.
 *
 * Five shapes, one schema each, exactly as `qt-code` does:
 * - {@link CircuitConfig}   what the teacher authors (the reference lives here);
 * - {@link CircuitAnswer}   what the student sends back: the schematic;
 * - {@link CircuitStudent}  what `toStudent` may hand to a student;
 * - {@link CircuitSolution} the key, served only when the feedback policy allows it;
 * - {@link CircuitDetails}  the breakdown stored in `gradings.details`.
 *
 * The SPICE netlist is NEVER stored and never sent by the browser: it is
 * rebuilt server-side from the stored schematic and the stimulus (invariant 14).
 */
import { z } from "zod";

import {
  BOX,
  COMPONENT_KINDS,
  DEFAULT_PALETTE,
  GRID,
  PORT_IDS,
  type ComponentKind,
} from "./library.js";

export const CIRCUIT_CONFIG_VERSION = 1;

// ---------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------

export const ComponentKindSchema = z.enum(COMPONENT_KINDS);

/** A coordinate on the canvas grid, inside the box (a wire vertex may sit on the border). */
const Coord = z.number().int().multipleOf(GRID);
const X = Coord.min(0).max(BOX.width);
const Y = Coord.min(0).max(BOX.height);

/**
 * The orientation of a symbol: a 2×2 matrix in SVG order `[a, b, c, d]`,
 * restricted to the eight rotations and reflections of the grid (every entry
 * in {−1, 0, 1}, determinant ±1). `[1, 0, 0, 1]` is the identity.
 */
const Unit = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
export const Orientation = z
  .tuple([Unit, Unit, Unit, Unit])
  .refine((m) => Math.abs(m[0] * m[3] - m[1] * m[2]) === 1, { message: "circuit.orientation" });
export type Orientation = z.infer<typeof Orientation>;

/** A component instance: what the student placed, where, how it is turned, and its value. */
export const SchematicComponent = z.object({
  /** Unique inside the schematic: `c1`, `c2`… (the editor's counter). */
  id: z.string().regex(/^c\d{1,6}$/),
  kind: ComponentKindSchema,
  x: X,
  y: Y,
  m: Orientation.default([1, 0, 0, 1]),
  /** The designator drawn beside the symbol and used in the netlist: `R1`, `Q2`. */
  name: z.string().min(1).max(12).regex(/^[A-Za-z][A-Za-z0-9_+-]*$/),
  /** Engineering notation (`4.7k`, `100n`); empty for a kind with no value. */
  value: z.string().max(24).default(""),
});
export type SchematicComponent = z.infer<typeof SchematicComponent>;

/**
 * One end of a wire: a component's pin, one of the four ports, or a free
 * point — which is how a wire branches off another wire (a T-junction) and
 * how a dangling wire is stored.
 */
export const WireEnd = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pin"), c: z.string().regex(/^c\d{1,6}$/), p: z.number().int().min(0).max(7) }),
  z.object({ kind: z.literal("port"), port: z.enum(PORT_IDS) }),
  z.object({ kind: z.literal("free"), x: X, y: Y }),
]);
export type WireEnd = z.infer<typeof WireEnd>;

export const Point = z.tuple([X, Y]);
export type Point = z.infer<typeof Point>;

/**
 * A wire, with the polyline the editor routed for it.
 *
 * `points` is the GEOMETRY of record: orthogonal, on the grid, first point at
 * `a`, last at `b`. Connectivity is read from it alone (`netlist.ts`) — an
 * end that lies on another wire's segment is a junction — so the server
 * never routes and the netlist is a pure function of the stored answer.
 * `via` are the user's waypoints, kept so the editor can re-route the wire
 * when a component moves.
 */
export const Wire = z.object({
  id: z.string().regex(/^w\d{1,6}$/),
  a: WireEnd,
  b: WireEnd,
  via: z.array(z.object({ x: X, y: Y })).max(16).default([]),
  points: z.array(Point).min(2).max(64),
});
export type Wire = z.infer<typeof Wire>;

export const Schematic = z.object({
  components: z.array(SchematicComponent).max(40),
  wires: z.array(Wire).max(80),
});
export type Schematic = z.infer<typeof Schematic>;

export const EMPTY_SCHEMATIC: Schematic = { components: [], wires: [] };

/** The components that count toward `palette.maxComponents`: everything but a terminal. */
export function countedComponents(schematic: Schematic, isTerminal: (k: ComponentKind) => boolean): number {
  return schematic.components.filter((c) => !isTerminal(c.kind)).length;
}

// ---------------------------------------------------------------------------
// Harness: what the teacher wraps around the box
// ---------------------------------------------------------------------------

/** What drives `in+` against `in-`. Volts, hertz, milliseconds. */
export const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dc"), volts: z.number().min(-100).max(100) }),
  z.object({
    kind: z.literal("sine"),
    amplitude: z.number().min(0).max(100),
    frequencyHz: z.number().min(0.01).max(1e7),
    offset: z.number().min(-100).max(100).default(0),
  }),
  z.object({
    kind: z.literal("pulse"),
    low: z.number().min(-100).max(100),
    high: z.number().min(-100).max(100),
    frequencyHz: z.number().min(0.01).max(1e7),
    dutyCycle: z.number().min(0.01).max(0.99).default(0.5),
  }),
  z.object({
    kind: z.literal("step"),
    from: z.number().min(-100).max(100),
    to: z.number().min(-100).max(100),
    atMs: z.number().min(0).max(1000),
  }),
]);
export type Source = z.infer<typeof Source>;

/** What hangs between `out+` and `out-`. */
export const Load = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open") }),
  z.object({ kind: z.literal("resistor"), ohms: z.number().min(1e-3).max(1e12) }),
  z.object({ kind: z.literal("capacitor"), farads: z.number().min(1e-15).max(1) }),
]);
export type Load = z.infer<typeof Load>;

/** A transient: the time-domain window a waveform is compared over. */
export const TranAnalysis = z.object({
  kind: z.literal("tran"),
  /** End of the transient, in milliseconds. */
  stopMs: z.number().min(0.001).max(1000).default(5),
  /** Samples before this instant are dropped (the transient the teacher wants to skip). */
  skipMs: z.number().min(0).max(1000).default(0),
  /** Samples kept between `skipMs` and `stopMs`. */
  points: z.number().int().min(50).max(2000).default(500),
});
export type TranAnalysis = z.infer<typeof TranAnalysis>;

/**
 * A small-signal AC sweep (ADR-040): the Bode plot of `v(out)` against the
 * source's EMF, linearised around the DC bias of a `dc` source, at
 * `pointsPerDecade` log-spaced frequencies from `fStartHz` to `fStopHz`.
 */
export const AcAnalysis = z.object({
  kind: z.literal("ac"),
  fStartHz: z.number().min(0.01).max(1e9),
  fStopHz: z.number().min(0.01).max(1e9),
  pointsPerDecade: z.number().int().min(5).max(200).default(20),
});
export type AcAnalysis = z.infer<typeof AcAnalysis>;

/**
 * The analysis of a stimulus. Every config written before the AC sweep
 * existed has no `kind`, and all of them are transients: the missing tag is
 * filled in BEFORE the discriminated union reads it, so they parse unchanged
 * — and `canonical.ts` leaves it out again for a transient.
 */
export const Analysis = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" && !("kind" in value)
      ? { ...value, kind: "tran" }
      : value,
  z.discriminatedUnion("kind", [TranAnalysis, AcAnalysis]),
);
export type Analysis = z.infer<typeof Analysis>;

export const DEFAULT_ANALYSIS: TranAnalysis = { kind: "tran", stopMs: 5, skipMs: 0, points: 500 };

/** What the editor switches a stimulus to: four decades around 1 kHz. */
export const DEFAULT_AC_ANALYSIS: AcAnalysis = {
  kind: "ac",
  fStartHz: 10,
  fStopHz: 100_000,
  pointsPerDecade: 20,
};

/** The ceiling of ADR-019 on one simulation, which an AC sweep observes too. */
export const MAX_ANALYSIS_POINTS = 2000;

/** How many frequencies `.ac dec` produces: `pointsPerDecade` per decade, both ends included. */
export function acPointCount(analysis: AcAnalysis): number {
  const decades = Math.log10(analysis.fStopHz / analysis.fStartHz);
  return Math.floor(decades * analysis.pointsPerDecade + 1e-9) + 1;
}

/**
 * One excitation of the box. Like a test case of `code`: it has a name,
 * points, and may be hidden from the student (docs/06 Q8 applies).
 *
 * Under an AC sweep the source is the DC BIAS the circuit is linearised
 * around, so only a `dc` source means anything there: a sine, a pulse or a
 * step has no single operating point (`circuit.ac_needs_dc_source`).
 */
export const Stimulus = z
  .object({
    name: z.string().min(1).max(40),
    source: Source,
    /** Series resistance of the source, in ohms; 0 for an ideal source. */
    sourceOhms: z.number().min(0).max(1e9).default(0),
    load: Load,
    analysis: Analysis.default(DEFAULT_ANALYSIS),
    points: z.number().min(0).max(100).default(1),
    visible: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    const a = s.analysis;
    const fail = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    if (a.kind === "tran") {
      if (a.skipMs >= a.stopMs) fail("circuit.skip_after_stop", ["analysis", "skipMs"]);
      return;
    }
    if (s.source.kind !== "dc") fail("circuit.ac_needs_dc_source", ["source"]);
    if (a.fStartHz >= a.fStopHz) fail("circuit.ac_start_after_stop", ["analysis", "fStartHz"]);
    else if (acPointCount(a) > MAX_ANALYSIS_POINTS) {
      fail("circuit.ac_too_many_points", ["analysis", "pointsPerDecade"]);
    }
  });
export type Stimulus = z.infer<typeof Stimulus>;

export const Supplies = z.object({
  /** The `VCC` rail the palette offers, in volts; `null` hides the symbol. */
  vcc: z.number().min(0).max(100).nullable().default(null),
  /** The `VEE` rail, in volts (negative or zero); `null` hides the symbol. */
  vee: z.number().min(-100).max(0).nullable().default(null),
});
export type Supplies = z.infer<typeof Supplies>;

export const Palette = z.object({
  kinds: z.array(ComponentKindSchema).min(1).max(COMPONENT_KINDS.length),
  /** How many non-terminal components the student may place. */
  maxComponents: z.number().int().min(1).max(30).default(10),
});
export type Palette = z.infer<typeof Palette>;

export const GradingMode = z.enum(["manual", "simulation", "llm"]);
export type GradingMode = z.infer<typeof GradingMode>;

/**
 * The envelope an AC stimulus is judged by (ADR-040, `compareBode`). It lives
 * in the grading block and never in the analysis: the analysis travels to the
 * student, the pass rule does not (invariant 4).
 */
export const BodeTolerance = z.object({
  /** Where the reference is above the floor: the largest gap allowed, in dB. */
  magDb: z.number().min(0.01).max(40).default(1),
  /** The floor sits this many dB under the reference's own peak; below it only an upper bound holds. */
  floorDb: z.number().min(1).max(200).default(60),
  /** The largest phase gap allowed above the floor, in degrees; `null` compares no phase. */
  phaseDeg: z.number().min(0.1).max(180).nullable().default(10),
});
export type BodeTolerance = z.infer<typeof BodeTolerance>;

export const DEFAULT_BODE: BodeTolerance = { magDb: 1, floorDb: 60, phaseDeg: 10 };

/*
 * A config is re-parsed only when its `configVersion` changes (`reparseMigrate`),
 * and the AC sweep came without a bump: a config stored before it is read
 * back AS STORED, with no `analysis.kind` and no `grading.bode`. Every reader
 * therefore tells a sweep by `kind === "ac"` — anything else is a transient —
 * and reads the envelope through `bodeOf`.
 */

/** The Bode envelope of a grading block, the default one when it was stored before the AC sweep. */
export function bodeOf(grading: Grading): BodeTolerance {
  return (grading.bode as BodeTolerance | undefined) ?? DEFAULT_BODE;
}

export const Grading = z.object({
  mode: GradingMode.default("manual"),
  /**
   * `simulation`, transient stimuli: a stimulus passes when the normalised
   * RMS distance between the student's and the reference's output voltage is
   * at or under this fraction of the reference's peak-to-peak swing
   * (`grade.ts`).
   */
  tolerance: z.number().min(0.001).max(1).default(0.05),
  /** `simulation`, AC stimuli: the envelope around the reference's Bode plot. */
  bode: BodeTolerance.default(() => ({ ...DEFAULT_BODE })),
  /** `llm` and `manual`: the criteria, for the model or for the teacher's own eyes. */
  rubric: z.string().max(8000).default(""),
});
export type Grading = z.infer<typeof Grading>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CircuitConfig = z
  .object({
    configVersion: z.literal(CIRCUIT_CONFIG_VERSION),
    prompt: z.string().min(1).max(20_000),
    palette: Palette.default({ kinds: [...DEFAULT_PALETTE], maxComponents: 10 }),
    supplies: Supplies.default({ vcc: null, vee: null }),
    /**
     * `in-` and `out-` are the reference node (SPICE `0`). Off, they are two
     * free nets the student must wire, and a `GND` symbol names node 0.
     */
    commonGround: z.boolean().default(true),
    stimuli: z.array(Stimulus).max(4).default([]),
    /** The teacher's own circuit: the key. Never in `toStudent`; a student receives it only under a shown key (ADR-037). */
    reference: Schematic.nullable().default(null),
    grading: Grading.default({ mode: "manual", tolerance: 0.05, bode: { ...DEFAULT_BODE }, rubric: "" }),
    /** Overlay the reference's output on the student's plot, for the visible stimuli. */
    showExpected: z.boolean().default(false),
    /** N-SEC-07: the budget of the student's Simulate button, per attempt. */
    simulationsPerMinute: z.number().int().min(1).max(30).default(10),
  })
  .refine((c) => c.grading.mode !== "simulation" || c.reference !== null, {
    message: "circuit.simulation_needs_reference",
    path: ["reference"],
  })
  .refine((c) => c.grading.mode !== "simulation" || c.stimuli.length > 0, {
    message: "circuit.simulation_needs_stimulus",
    path: ["stimuli"],
  })
  .refine((c) => !c.showExpected || c.reference !== null, {
    message: "circuit.expected_needs_reference",
    path: ["showExpected"],
  });
export type CircuitConfig = z.infer<typeof CircuitConfig>;

/** A fresh draft: the shape, the defaults, no content (decision D16 — it need not validate). */
export function emptyCircuitConfig(): CircuitConfig {
  return {
    configVersion: CIRCUIT_CONFIG_VERSION,
    prompt: "",
    palette: { kinds: [...DEFAULT_PALETTE], maxComponents: 10 },
    supplies: { vcc: null, vee: null },
    commonGround: true,
    stimuli: [],
    reference: null,
    grading: { mode: "manual", tolerance: 0.05, bode: { ...DEFAULT_BODE }, rubric: "" },
    showExpected: false,
    simulationsPerMinute: 10,
  };
}

/** A fresh stimulus with every default spelled out (the editor adds them one by one). */
export function emptyStimulus(overrides: Partial<Stimulus> = {}): Stimulus {
  return {
    name: "",
    source: { kind: "sine", amplitude: 1, frequencyHz: 1000, offset: 0 },
    sourceOhms: 0,
    load: { kind: "open" },
    analysis: { ...DEFAULT_ANALYSIS },
    points: 1,
    visible: true,
    ...overrides,
  };
}

export function totalStimulusPoints(config: CircuitConfig): number {
  return config.stimuli.reduce((sum, s) => sum + s.points, 0);
}

// ---------------------------------------------------------------------------
// Answer
// ---------------------------------------------------------------------------

export const CircuitAnswer = z.object({
  schematic: Schematic,
});
export type CircuitAnswer = z.infer<typeof CircuitAnswer>;

/**
 * Whether the answer holds something (issue #89): the ONE predicate behind
 * both `isAnswered` hooks, server and client, so the student's list and the
 * teacher's grid can never disagree about it.
 */
export function isCircuitAnswered(answer: CircuitAnswer): boolean {
  return answer.schematic.components.length > 0 || answer.schematic.wires.length > 0;
}

// ---------------------------------------------------------------------------
// Student view
// ---------------------------------------------------------------------------

/** A visible stimulus, as the student sees it: everything but its points weight is needed to simulate it. */
export const StudentStimulus = z.object({
  name: z.string(),
  source: Source,
  sourceOhms: z.number(),
  load: Load,
  analysis: Analysis,
  points: z.number(),
});
export type StudentStimulus = z.infer<typeof StudentStimulus>;

/**
 * What a student receives. Gone: the reference, the hidden stimuli, the
 * tolerance, the rubric, the grading mode.
 */
export const CircuitStudent = z.object({
  prompt: z.string(),
  palette: Palette,
  supplies: Supplies,
  commonGround: z.boolean(),
  visibleStimuli: z.array(StudentStimulus),
  hiddenCount: z.number().int(),
  hiddenPoints: z.number(),
  /** Whether the Simulate button exists: at least one visible stimulus. */
  canSimulate: z.boolean(),
  /** Whether a simulation also returns the reference's output, to overlay. */
  showExpected: z.boolean(),
  simulationsPerMinute: z.number().int(),
});
export type CircuitStudent = z.infer<typeof CircuitStudent>;

// ---------------------------------------------------------------------------
// Solution
// ---------------------------------------------------------------------------

/** The key: the reference schematic alone (ADR-037). */
export const CircuitSolution = z.object({
  reference: Schematic.nullable(),
});
export type CircuitSolution = z.infer<typeof CircuitSolution>;

// ---------------------------------------------------------------------------
// Grading details
// ---------------------------------------------------------------------------

/**
 * One transient's waveforms. It carries no `kind`: every row stored before
 * the AC sweep existed is one of these, and they must keep parsing as is.
 */
export const TranSeries = z.object({
  kind: z.literal("tran").optional(),
  /** Seconds. */
  t: z.array(z.number()),
  vin: z.array(z.number()),
  vout: z.array(z.number()),
  /** Amperes, through the load; zeros for an open load. */
  iout: z.array(z.number()),
});
export type TranSeries = z.infer<typeof TranSeries>;

/** One AC sweep's Bode plot: `v(out)` against the source's EMF. */
export const AcSeries = z.object({
  kind: z.literal("ac"),
  /** Hertz, log-spaced. */
  f: z.array(z.number()),
  /** `20·log10|v(out)|`, floored at {@link DB_FLOOR} so a dead output stays a number. */
  magDb: z.array(z.number()),
  /** Degrees, ngspice's continuous phase (`cph`), unwrapped along the sweep. */
  phaseDeg: z.array(z.number()),
});
export type AcSeries = z.infer<typeof AcSeries>;

/** The magnitude a zero output is written as: JSON has no −∞. */
export const DB_FLOOR = -300;

/** One simulated series set, decimated to at most {@link SERIES_MAX_POINTS} samples when stored. */
export const SeriesSet = z.union([AcSeries, TranSeries]);
export type SeriesSet = z.infer<typeof SeriesSet>;

export const SERIES_MAX_POINTS = 250;

export const StimulusDetail = z.object({
  name: z.string(),
  visible: z.boolean(),
  points: z.number(),
  ok: z.boolean(),
  /** Transient: normalised RMS distance to the reference; `null` when nothing could be compared, and always under AC. */
  error: z.number().nullable(),
  /** AC: how the student's Bode plot sat in the reference's envelope (`compareBode`). */
  envelope: z
    .object({
      /** The largest magnitude gap, in dB, measured the way the rule measures it. */
      worstDb: z.number(),
      /** The largest phase gap above the floor, in degrees; `null` when the phase is not compared. */
      worstDeg: z.number().nullable(),
      /** How many frequencies fell outside the envelope. */
      outside: z.number().int(),
    })
    .optional(),
  /** Machine reason when `ok` is false for a cause other than the distance: `floating_pin`, `spice_failed`… */
  reason: z.string().optional(),
  /** The student's waveforms; `null` when the simulation did not run. */
  series: SeriesSet.nullable(),
  /** The reference's waveforms, for the teacher and — under the policy — the student. */
  expected: SeriesSet.nullable(),
  /** The tail of ngspice's stderr when it failed, for the teacher. */
  log: z.string().max(4000).optional(),
});
export type StimulusDetail = z.infer<typeof StimulusDetail>;

export const CircuitDetails = z.object({
  mode: GradingMode,
  runner: z.enum(["ok", "unavailable", "busy", "error", "none"]),
  /** What the extractor read in the student's schematic. */
  netlist: z.object({
    components: z.number().int(),
    nets: z.number().int(),
    /** Extraction diagnostics: `floating:R1.2`, `unconnected_port:out+`… */
    issues: z.array(z.string()),
  }),
  stimuli: z.array(StimulusDetail),
  earned: z.number(),
  total: z.number(),
  /**
   * Echo of `config.showExpected`: `studentDetails` only ever sees the
   * details, and it has to know whether the reference's curve was published
   * on the visible stimuli before it lets one through (`grade.ts`).
   */
  showExpected: z.boolean().optional(),
  /** Machine reason when `runner !== "ok"` or nothing was graded. */
  reason: z.string().optional(),
});
export type CircuitDetails = z.infer<typeof CircuitDetails>;
