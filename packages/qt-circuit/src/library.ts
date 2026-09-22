/**
 * The component library of the `circuit` question type (docs/spec/04 §4.11).
 *
 * ONE table, read by both halves of the package: the editor draws from it
 * (pins, body, label anchor), the netlist extractor reads it (pin count and
 * order, which pins are terminals), and the SPICE emitter maps it (element
 * prefix, model card). Geometry is in canvas units on a {@link GRID} of 20,
 * exactly as `mockups/circuit.html` lays it out, so that a symbol authored
 * there drops in unchanged.
 *
 * Pin ORDER is the electrical contract: the emitter writes the SPICE element
 * line in that order (`Q<name> collector base emitter`), so it is fixed here
 * and documented per kind. Reordering a pin list is a schema-breaking change.
 *
 * Nothing here draws: the SVG paths live beside the components
 * (`symbols.ts`), because an emitter running in the API must not carry them.
 */

/** Canvas grid step, in canvas units. Every pin, every wire vertex sits on it. */
export const GRID = 20;

/**
 * Every fifth grid line is drawn thicker. The box and the four port anchors
 * are laid out on that coarser lattice, so the outline and the anchors always
 * land ON a major line instead of between two of them.
 */
export const MAJOR = 5;

/**
 * The two-port box the student wires inside: the "quadripole" container.
 * Four ports on its border, two on each side; everything else is placed
 * inside. Fixed size, so a saved schematic always fits the same canvas.
 *
 * Both sides are a whole number of MAJOR cells (40 × 25), which is what puts
 * the border itself on a thick line.
 */
export const BOX = { width: 40 * GRID, height: 25 * GRID } as const;

/**
 * How far from the top edge — and, mirrored, from the bottom edge — the port
 * anchors sit, in cells. A multiple of {@link MAJOR}, on a thick line.
 */
export const PORT_INSET = MAJOR;

/** Direction a wire leaves a pin: 0 → +x, 1 → +y, 2 → −x, 3 → −y (mockup convention). */
export type PinDirection = 0 | 1 | 2 | 3;

export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export interface PinSpec {
  /** Electrical name, stable: the emitter and the tests refer to it. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly d: PinDirection;
}

/** The four ports of the box, in the order they are drawn and referred to. */
export const PORT_IDS = ["in+", "in-", "out+", "out-"] as const;
export type PortId = (typeof PORT_IDS)[number];

/** The `+` rail, five cells below the top edge; the `−` rail, five cells above the bottom one. */
const PORT_TOP = PORT_INSET * GRID;
const PORT_BOTTOM = BOX.height - PORT_INSET * GRID;

/** Where each port sits on the box border; the wire leaves it INTO the box. */
export const PORTS: Readonly<Record<PortId, PinSpec>> = {
  "in+": { name: "in+", x: 0, y: PORT_TOP, d: 0 },
  "in-": { name: "in-", x: 0, y: PORT_BOTTOM, d: 0 },
  "out+": { name: "out+", x: BOX.width, y: PORT_TOP, d: 2 },
  "out-": { name: "out-", x: BOX.width, y: PORT_BOTTOM, d: 2 },
};

/**
 * Every kind of component a student may place. `GND`, `VCC` and `VEE` are
 * TERMINALS: symbols that name a global net rather than parts with a value,
 * and they do not count toward `palette.maxComponents`.
 */
export const COMPONENT_KINDS = [
  "R",
  "C",
  "L",
  "D",
  "DS",
  "DZ",
  "NPN",
  "PNP",
  "NMOS",
  "PMOS",
  "NMOSD",
  "PMOSD",
  "OPAMP",
  "GND",
  "VCC",
  "VEE",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export function isComponentKind(kind: string): kind is ComponentKind {
  return (COMPONENT_KINDS as readonly string[]).includes(kind);
}

/** What a component's single parameter means, when it has one. */
export type ValueRole =
  | { readonly kind: "none" }
  /** A SPICE quantity: resistance, capacitance, inductance, a breakdown voltage. */
  | { readonly kind: "quantity"; readonly unit: "Ω" | "F" | "H" | "V"; readonly min: number; readonly max: number };

export interface ComponentSpec {
  readonly kind: ComponentKind;
  /** The name prefix of an instance: `R` → R1, R2… `GND` names every instance `GND`. */
  readonly prefix: string;
  /** English label; the host translates by `qt.circuit.kind.<kind>`. */
  readonly label: string;
  /** Default `value` of a fresh instance, in engineering notation (`10k`, `100n`). */
  readonly defaultValue: string;
  readonly value: ValueRole;
  /** Pins in ELECTRICAL order (see the header). */
  readonly pins: readonly PinSpec[];
  /** Body rectangle `[x, y, w, h]` in local coordinates: what a wire must route around. */
  readonly body: readonly [number, number, number, number];
  /** Label anchor in local coordinates; `null` for a symbol with no label. */
  readonly label_at: readonly [number, number] | null;
  /** True for GND / VCC / VEE. */
  readonly terminal: boolean;
}

const quantity = (unit: "Ω" | "F" | "H" | "V", min: number, max: number): ValueRole => ({
  kind: "quantity",
  unit,
  min,
  max,
});

const NONE: ValueRole = { kind: "none" };

/** Left pin, right pin: every two-terminal symbol of width 80. */
const twoTerminal = (a: string, b: string, half = 40): readonly PinSpec[] => [
  { name: a, x: -half, y: 0, d: 2 },
  { name: b, x: half, y: 0, d: 0 },
];

/** Base/gate on the left, collector/drain above, emitter/source below. */
const threeTerminal = (top: string, left: string, bottom: string): readonly PinSpec[] => [
  { name: top, x: 0, y: -40, d: 3 },
  { name: left, x: -40, y: 0, d: 2 },
  { name: bottom, x: 0, y: 40, d: 1 },
];

export const LIBRARY: Readonly<Record<ComponentKind, ComponentSpec>> = {
  R: {
    kind: "R",
    prefix: "R",
    label: "Resistor",
    defaultValue: "10k",
    value: quantity("Ω", 1e-3, 1e12),
    pins: twoTerminal("1", "2"),
    body: [-30, -10, 60, 20],
    label_at: [0, -17],
    terminal: false,
  },
  C: {
    kind: "C",
    prefix: "C",
    label: "Capacitor",
    defaultValue: "100n",
    value: quantity("F", 1e-15, 1),
    pins: twoTerminal("1", "2", 20),
    body: [-10, -16, 20, 32],
    label_at: [0, -21],
    terminal: false,
  },
  L: {
    kind: "L",
    prefix: "L",
    label: "Inductor",
    defaultValue: "10m",
    value: quantity("H", 1e-12, 1e3),
    pins: twoTerminal("1", "2"),
    body: [-30, -10, 60, 20],
    label_at: [0, -15],
    terminal: false,
  },
  /* Diodes: anode first, cathode second — the SPICE order. */
  D: {
    kind: "D",
    prefix: "D",
    label: "Diode (silicon)",
    defaultValue: "",
    value: NONE,
    pins: twoTerminal("A", "K"),
    body: [-16, -14, 32, 28],
    label_at: [0, -19],
    terminal: false,
  },
  DS: {
    kind: "DS",
    prefix: "D",
    label: "Schottky diode",
    defaultValue: "",
    value: NONE,
    pins: twoTerminal("A", "K"),
    body: [-16, -14, 32, 28],
    label_at: [0, -19],
    terminal: false,
  },
  DZ: {
    kind: "DZ",
    prefix: "D",
    label: "Zener diode",
    defaultValue: "5.1",
    value: quantity("V", 1, 200),
    pins: twoTerminal("A", "K"),
    body: [-16, -14, 32, 28],
    label_at: [0, -19],
    terminal: false,
  },
  /* Bipolars: collector, base, emitter — the SPICE order. */
  NPN: {
    kind: "NPN",
    prefix: "Q",
    label: "NPN transistor",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("C", "B", "E"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  PNP: {
    kind: "PNP",
    prefix: "Q",
    label: "PNP transistor",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("C", "B", "E"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  /* MOSFETs: drain, gate, source; the bulk is tied to the source by the emitter. */
  NMOS: {
    kind: "NMOS",
    prefix: "M",
    label: "N-MOSFET (enhancement)",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("D", "G", "S"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  PMOS: {
    kind: "PMOS",
    prefix: "M",
    label: "P-MOSFET (enhancement)",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("D", "G", "S"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  NMOSD: {
    kind: "NMOSD",
    prefix: "M",
    label: "N-MOSFET (depletion)",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("D", "G", "S"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  PMOSD: {
    kind: "PMOSD",
    prefix: "M",
    label: "P-MOSFET (depletion)",
    defaultValue: "",
    value: NONE,
    pins: threeTerminal("D", "G", "S"),
    body: [-20, -30, 40, 60],
    label_at: [24, 0],
    terminal: false,
  },
  /* Ideal op-amp: inverting input (top), non-inverting input (bottom), output. */
  OPAMP: {
    kind: "OPAMP",
    prefix: "U",
    label: "Ideal op-amp",
    defaultValue: "",
    value: NONE,
    pins: [
      { name: "-", x: -40, y: -20, d: 2 },
      { name: "+", x: -40, y: 20, d: 2 },
      { name: "out", x: 40, y: 0, d: 0 },
    ],
    body: [-28, -36, 60, 72],
    label_at: [0, -41],
    terminal: false,
  },
  /* Terminals: one pin, and the symbol hangs off it. */
  GND: {
    kind: "GND",
    prefix: "GND",
    label: "Ground",
    defaultValue: "",
    value: NONE,
    pins: [{ name: "1", x: 0, y: 0, d: 3 }],
    body: [-12, 6, 24, 24],
    label_at: null,
    terminal: true,
  },
  VCC: {
    kind: "VCC",
    prefix: "VCC",
    label: "Positive supply",
    defaultValue: "",
    value: NONE,
    pins: [{ name: "1", x: 0, y: 0, d: 1 }],
    body: [-12, -30, 24, 24],
    label_at: [0, -34],
    terminal: true,
  },
  VEE: {
    kind: "VEE",
    prefix: "VEE",
    label: "Negative supply",
    defaultValue: "",
    value: NONE,
    pins: [{ name: "1", x: 0, y: 0, d: 3 }],
    body: [-12, 6, 24, 24],
    label_at: [0, 34],
    terminal: true,
  },
};

/** The kinds a fresh question offers: everything but the supplies, which the harness decides. */
export const DEFAULT_PALETTE: readonly ComponentKind[] = COMPONENT_KINDS.filter(
  (k) => k !== "VCC" && k !== "VEE",
);

// ---------------------------------------------------------------------------
// Engineering notation
// ---------------------------------------------------------------------------

/**
 * SPICE reads `1M` as one MILLI and `1MEG` as one mega, which is exactly the
 * trap a first-year student falls into. So a value is parsed HERE, case
 * sensitively (`M` mega, `m` milli, `u`/`µ` micro), and the emitter writes a
 * plain number to SPICE, never the text.
 */
const SUFFIXES: Readonly<Record<string, number>> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  "µ": 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

const VALUE_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([pnuµμmkKMGT])?\s*(?:Ω|ohm|ohms|F|H|V)?\s*$/;

/** `"4.7k"` → 4700, `"100n"` → 1e-7, `"1M"` → 1e6; `null` when it is not a value. */
export function parseValue(text: string): number | null {
  const m = VALUE_RE.exec(text);
  if (m === null) return null;
  const mantissa = Number(m[1]);
  if (!Number.isFinite(mantissa)) return null;
  const suffix = m[2];
  return suffix === undefined ? mantissa : mantissa * (SUFFIXES[suffix] ?? 1);
}

/** 4700 → `"4.7k"`, 1e-7 → `"100n"`: what the label shows and what the parser reads back. */
export function formatValue(value: number): string {
  if (value === 0) return "0";
  const steps: ReadonlyArray<readonly [number, string]> = [
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
  ];
  const abs = Math.abs(value);
  for (const [scale, suffix] of steps) {
    if (abs >= scale * 0.9999) {
      const scaled = value / scale;
      const text = Number(scaled.toPrecision(4)).toString();
      return `${text}${suffix}`;
    }
  }
  return value.toExponential(3);
}

/**
 * Whether `value` is acceptable for a component of that kind: parseable and
 * inside the kind's range, or empty for a kind that carries no value.
 */
export function valueIssue(kind: ComponentKind, value: string): "missing" | "invalid" | "range" | null {
  const role = LIBRARY[kind].value;
  if (role.kind === "none") return null;
  if (value.trim() === "") return "missing";
  const parsed = parseValue(value);
  if (parsed === null) return "invalid";
  if (parsed < role.min || parsed > role.max) return "range";
  return null;
}
