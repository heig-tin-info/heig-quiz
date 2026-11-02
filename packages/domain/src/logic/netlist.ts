/**
 * The netlist of a logic circuit (issue #459, ADR-123): the
 * graph the engine simulates, modeled on the Yosys JSON netlist. It is
 * rebuilt server-side from a schematic and never stored.
 *
 * A NET is a wire, named by any string; it exists because a port or a cell
 * connection names it, there is no separate declaration. A net nobody drives
 * floats: it reads `Z`, and a gate input reading `Z` reads `X`. That keeps an
 * unfinished schematic simulable (play mode); its outputs simply read `X`.
 *
 * Several drivers on one net are legal, tri-state or not: a `Z` driver
 * yields, equal values agree, a conflict reads `X`. Two plain gates wired
 * together therefore read `X` whenever they disagree, as on the bench.
 *
 * Every name (port, cell, net) comes from a user: it is only ever a `Map`
 * key or checked with `Object.hasOwn`, so `__proto__` or `constructor` is an
 * ordinary name.
 */

/** A logic level: 0, 1, unknown (`X`) or high impedance (`Z`). */
export type Value = 0 | 1 | "X" | "Z";
export type Bit = 0 | 1;
export type NetId = string;

export interface NetlistPort {
  readonly direction: "input" | "output";
  readonly net: NetId;
}

export interface NetlistCell {
  readonly type: CellType;
  /** Port name of the cell (`A0`, `EN`, `Y`, `Q`…) → the net it is wired to. An unconnected input reads `X`. */
  readonly connections: Readonly<Record<string, NetId>>;
  /** `width` is the fan-in of a variadic gate (`$and`…`$xnor`), `MIN_WIDTH` by default. */
  readonly params?: { readonly width?: number };
}

/** Circuit ports (the teacher's inputs and outputs) by name, and cells by id. */
export interface Netlist {
  readonly ports: Readonly<Record<string, NetlistPort>>;
  readonly cells: Readonly<Record<string, NetlistCell>>;
}

/**
 * How a cell computes. `comb`: its output `Y` from its inputs. `latch`: a
 * state that follows its inputs while they say so (level-sensitive). `flop`:
 * a state that changes on a rising edge (exactly 0 → 1) of its LAST input,
 * `CLK`; a transition through `X` is not an edge. A latch or a flip-flop
 * drives its state on `Q` and its complement on `QN`, and starts at 0.
 */
export type CellKind = "comb" | "latch" | "flop";

export interface CellSpec {
  readonly kind: CellKind;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** The inputs are `A0`…`A3`, of which `params.width` are used. */
  readonly variadic: boolean;
  /**
   * The function over known bits. `comb`: the inputs → `Y` (may be `Z`, a
   * tri-state off). `latch`/`flop`: the data inputs (without `CLK`), then the
   * current state → the next state. Unknown inputs are lifted by the engine.
   */
  readonly fn: (bits: readonly Bit[]) => Value;
}

const VARIADIC = ["A0", "A1", "A2", "A3"] as const;
/** The fan-in of a variadic gate ranges from `MIN_WIDTH` (the default) to `VARIADIC.length`. */
const MIN_WIDTH = 2;
const parity = (bits: readonly Bit[]): Bit => bits.reduce<number>((a, b) => a ^ b, 0) as Bit;
const bit = (b: boolean): Bit => (b ? 1 : 0);
const gate = (fn: (bits: readonly Bit[]) => Bit): CellSpec => ({ kind: "comb", inputs: VARIADIC, outputs: ["Y"], variadic: true, fn });
const fixed = (inputs: readonly string[], fn: CellSpec["fn"]): CellSpec => ({ kind: "comb", inputs, outputs: ["Y"], variadic: false, fn });
const memory = (kind: "latch" | "flop", inputs: readonly string[], fn: CellSpec["fn"]): CellSpec => ({
  kind,
  inputs,
  outputs: ["Q", "QN"],
  variadic: false,
  fn,
});
const toggle = (q: Bit): Bit => (1 - q) as Bit;

/** Every cell type, its ports and its behaviour: the single source of truth. */
export const CELL_SPECS = {
  $and: gate((b) => bit(b.every((x) => x === 1))),
  $or: gate((b) => bit(b.some((x) => x === 1))),
  $nand: gate((b) => bit(!b.every((x) => x === 1))),
  $nor: gate((b) => bit(!b.some((x) => x === 1))),
  $xor: gate(parity),
  $xnor: gate((b) => (1 - parity(b)) as Bit),
  $not: fixed(["A"], ([a]) => (1 - a!) as Bit),
  $buf: fixed(["A"], ([a]) => a!),
  /** Drives `A` while `EN` is 1, releases the net (`Z`) while it is 0. */
  $tribuf: fixed(["A", "EN"], ([a, en]) => (en ? a! : "Z")),
  $const0: fixed([], () => 0),
  $const1: fixed([], () => 1),
  /** Set-reset latch; S = R = 1 is forbidden and makes the state `X`. */
  $sr: memory("latch", ["S", "R"], ([s, r, q]) => (s && r ? "X" : s ? 1 : r ? 0 : q!)),
  /** Transparent while `EN` is 1. */
  $dlatch: memory("latch", ["D", "EN"], ([d, en, q]) => (en ? d! : q!)),
  $dff: memory("flop", ["D", "CLK"], ([d]) => d!),
  $jkff: memory("flop", ["J", "K", "CLK"], ([j, k, q]) => (j && k ? toggle(q!) : j ? 1 : k ? 0 : q!)),
  $tff: memory("flop", ["T", "CLK"], ([t, q]) => (t ? toggle(q!) : q!)),
} satisfies Record<string, CellSpec>;

export type CellType = keyof typeof CELL_SPECS;

/**
 * The caps of a logic question, enforced here: a netlist over them is
 * invalid, an expression or test vectors over them do not parse, a check
 * over `inputs` is refused. `eventsPerRow` is the hard event budget of one
 * settle. `wires` and `verticesPerWire` bound the schematic, whose schema
 * lives elsewhere. `vectorRows` keeps a sequential check (three settles a
 * row at most) under the combinational one (1 024 rows of one settle).
 */
export const LOGIC_LIMITS = {
  inputs: 10,
  outputs: 8,
  components: 60,
  /** The gates an answer or a reference holds: a round number for the people, under `components` by the two constant cells' margin. */
  gates: 50,
  wires: 120,
  verticesPerWire: 64,
  eventsPerRow: 2_000,
  expressionLength: 500,
  expressionDepth: 32,
  vectorRows: 256,
  vectorLength: 16_000,
} as const;

/** The input ports a cell actually has: a variadic gate uses `width` of `A0`…`A3`. */
export function cellInputs(cell: NetlistCell): readonly string[] {
  const spec = CELL_SPECS[cell.type];
  return spec.variadic ? spec.inputs.slice(0, cell.params?.width ?? MIN_WIDTH) : spec.inputs;
}

export type NetlistIssueCode =
  | "malformed"
  | "bad_direction"
  | "too_many_components"
  | "too_many_inputs"
  | "too_many_outputs"
  | "unknown_cell_type"
  | "bad_width"
  | "unknown_port";

export interface NetlistIssue {
  readonly code: NetlistIssueCode;
  readonly cell?: string;
  readonly port?: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * The structural problems of a netlist, possibly built from hostile JSON;
 * empty when it can be simulated. It never throws. Undriven nets and several
 * drivers on a net are NOT issues (see the header).
 */
export function validateNetlist(netlist: unknown): NetlistIssue[] {
  if (!isRecord(netlist) || !isRecord(netlist.ports) || !isRecord(netlist.cells)) return [{ code: "malformed" }];
  const issues: NetlistIssue[] = [];
  const count = { input: 0, output: 0 };
  for (const [port, p] of Object.entries(netlist.ports)) {
    if (!isRecord(p) || typeof p.net !== "string") issues.push({ code: "malformed", port });
    else if (p.direction !== "input" && p.direction !== "output") issues.push({ code: "bad_direction", port });
    else count[p.direction]++;
  }
  if (Object.keys(netlist.cells).length > LOGIC_LIMITS.components) issues.push({ code: "too_many_components" });
  if (count.input > LOGIC_LIMITS.inputs) issues.push({ code: "too_many_inputs" });
  if (count.output > LOGIC_LIMITS.outputs) issues.push({ code: "too_many_outputs" });
  for (const [id, cell] of Object.entries(netlist.cells)) {
    const shaped =
      isRecord(cell) &&
      isRecord(cell.connections) &&
      Object.values(cell.connections).every((net) => typeof net === "string") &&
      (cell.params === undefined || isRecord(cell.params));
    if (!shaped) {
      issues.push({ code: "malformed", cell: id });
      continue;
    }
    if (typeof cell.type !== "string" || !Object.hasOwn(CELL_SPECS, cell.type)) {
      issues.push({ code: "unknown_cell_type", cell: id });
      continue;
    }
    const spec = CELL_SPECS[cell.type as CellType];
    const width = (cell.params as Record<string, unknown> | undefined)?.width;
    const widthOk =
      width === undefined ||
      (spec.variadic && typeof width === "number" && Number.isInteger(width) && width >= MIN_WIDTH && width <= VARIADIC.length);
    if (!widthOk) {
      issues.push({ code: "bad_width", cell: id });
      continue;
    }
    const ports = [...cellInputs(cell as unknown as NetlistCell), ...spec.outputs];
    for (const port of Object.keys(cell.connections as Record<string, string>)) {
      if (!ports.includes(port)) issues.push({ code: "unknown_port", cell: id, port });
    }
  }
  return issues;
}

/**
 * The codes a user may see (an i18n key): `logic.expression_invalid` and
 * `logic.unknown_identifier`, with a 0-based character `position`, and the
 * `logic.vector_*` codes, whose `position` is the 1-based LINE, and
 * `logic.reference_undefined`, whose `position` is a truth-table row. The others
 * are programmer errors: a caller passed something the contract excludes.
 */
export type LogicErrorCode =
  | "logic.expression_invalid"
  | "logic.unknown_identifier"
  | VectorErrorCode
  | "logic.reference_undefined"
  | "logic.netlist_invalid"
  | "logic.unknown_input"
  | "logic.bad_value"
  | "logic.too_many_inputs";

/** What is wrong with test vectors (`vectors.ts`). */
export type VectorErrorCode =
  | "logic.vector_empty"
  | "logic.vector_too_long"
  | "logic.vector_header"
  | "logic.vector_columns"
  | "logic.vector_value";

export class LogicError extends Error {
  constructor(
    readonly code: LogicErrorCode,
    readonly position: number | null = null,
    detail = "",
  ) {
    super(`${code}${position === null ? "" : ` at ${position}`}${detail ? `: ${detail}` : ""}`);
    this.name = "LogicError";
  }
}
