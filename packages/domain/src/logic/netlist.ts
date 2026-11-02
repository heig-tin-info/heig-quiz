/**
 * The netlist of a combinational logic circuit (issue #459, ADR-123): the
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
  /** Port name of the cell (`A0`, `EN`, `Y`…) → the net it is wired to. An unconnected input reads `X`. */
  readonly connections: Readonly<Record<string, NetId>>;
  /** `width` is the fan-in of a variadic gate (`$and`…`$xnor`), `MIN_WIDTH` by default. */
  readonly params?: { readonly width?: number };
}

/** Circuit ports (the teacher's inputs and outputs) by name, and cells by id. */
export interface Netlist {
  readonly ports: Readonly<Record<string, NetlistPort>>;
  readonly cells: Readonly<Record<string, NetlistCell>>;
}

export interface CellSpec {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** The inputs are `A0`…`A3`, of which `params.width` are used. */
  readonly variadic: boolean;
  /** The output over known bits (may be `Z`, a tri-state off); unknown inputs are lifted by the engine. */
  readonly fn: (bits: readonly Bit[]) => Value;
}

const VARIADIC = ["A0", "A1", "A2", "A3"] as const;
/** The fan-in of a variadic gate ranges from `MIN_WIDTH` (the default) to `VARIADIC.length`. */
const MIN_WIDTH = 2;
const parity = (bits: readonly Bit[]): Bit => bits.reduce<number>((a, b) => a ^ b, 0) as Bit;
const bit = (b: boolean): Bit => (b ? 1 : 0);
const gate = (fn: (bits: readonly Bit[]) => Bit): CellSpec => ({ inputs: VARIADIC, outputs: ["Y"], variadic: true, fn });
const fixed = (inputs: readonly string[], fn: CellSpec["fn"]): CellSpec => ({ inputs, outputs: ["Y"], variadic: false, fn });

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
} satisfies Record<string, CellSpec>;

export type CellType = keyof typeof CELL_SPECS;

/**
 * The caps of a logic question, enforced here: a netlist over them is
 * invalid, an expression over them does not parse, a check over `inputs` is
 * refused. `eventsPerRow` is the hard event budget of one settle.
 * `wires` and `verticesPerWire` bound the schematic, whose schema lives
 * elsewhere.
 */
export const LOGIC_LIMITS = {
  inputs: 10,
  outputs: 8,
  components: 60,
  wires: 120,
  verticesPerWire: 64,
  eventsPerRow: 2_000,
  expressionLength: 500,
  expressionDepth: 32,
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
 * The codes a user may see (an i18n key, with a 0-based `position`):
 * `logic.expression_invalid` and `logic.unknown_identifier`. The others are
 * programmer errors: a caller passed something the contract excludes.
 */
export type LogicErrorCode =
  | "logic.expression_invalid"
  | "logic.unknown_identifier"
  | "logic.netlist_invalid"
  | "logic.unknown_input"
  | "logic.bad_value"
  | "logic.too_many_inputs";

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
