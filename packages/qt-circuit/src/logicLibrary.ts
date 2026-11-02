/**
 * The part table of the `logic` question type (docs/spec/04 §4.18, ADR-123):
 * what each kind IS — its pins in netlist order, its body, its cell of
 * `@quiz/domain/logic` — independent of how it is drawn. Read by the canvas
 * (through `canvas/logicLibrary.ts`, which adds the IEC and ANSI drawings),
 * the netlist builder and the grader, so it imports nothing that draws.
 *
 * A gate's family is what the teacher allows (`palette.kinds`); its kinds
 * are that family at a fan-in of 2, 3 or 4 (`AND2`…`AND4`), the range of the
 * domain's variadic cells. The memory families (an SR latch, a D latch, D,
 * JK and T flip-flops) are one kind each, with two outputs, `Q` and `QN`. `IN` and `OUT` are the declared terminals, LOCKED:
 * the question places them, the student moves them. `LOW` and `HIGH` are the
 * constants, always offered and never counted, as `maxGates` reads (§4.18).
 *
 * Geometry is on the canvas grid ({@link GRID}): inputs on the left at
 * x = −40, the output on the right at x = 40, a terminal's pin at its origin.
 */
import { CELL_SPECS, type CellType } from "@quiz/domain/logic";

import { BOX, GRID, type PinSpec } from "./library.js";
import { countedParts, type PartSpec, type ValueRole } from "./parts.js";

/** The gates, in the order the editor and the palette show them. */
export const GATES = ["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"] as const;
/** The latches and the flip-flops; their pins are their domain cell's (`CELL_SPECS`). */
export const MEMORY_FAMILIES = ["SR", "DLATCH", "DFF", "JKFF", "TFF"] as const;
type MemoryFamily = (typeof MEMORY_FAMILIES)[number];

/** The parts a teacher may allow: the gates, then the memories. */
export const GATE_FAMILIES = [...GATES, ...MEMORY_FAMILIES] as const;
export type GateFamily = (typeof GATE_FAMILIES)[number];

/** The families with a fan-in, and the fan-ins the domain's variadic cells take. */
const VARIADIC = ["AND", "OR", "NAND", "NOR", "XOR", "XNOR"] as const satisfies readonly GateFamily[];
const WIDTHS = [2, 3, 4] as const;

const CELL: Readonly<Record<GateFamily, CellType>> = {
  AND: "$and",
  OR: "$or",
  NAND: "$nand",
  NOR: "$nor",
  XOR: "$xor",
  XNOR: "$xnor",
  NOT: "$not",
  BUF: "$buf",
  SR: "$sr",
  DLATCH: "$dlatch",
  DFF: "$dff",
  JKFF: "$jkff",
  TFF: "$tff",
};

/** The families whose output is negated: the bubble on the symbol. */
export const NEGATED: ReadonlySet<GateFamily> = new Set(["NAND", "NOR", "XNOR", "NOT"]);

export const LOGIC_KINDS = [
  ...VARIADIC.flatMap((family) => WIDTHS.map((width) => `${family}${width}` as const)),
  "NOT",
  "BUF",
  ...MEMORY_FAMILIES,
  "LOW",
  "HIGH",
  "IN",
  "OUT",
] as const;
export type LogicKind = (typeof LOGIC_KINDS)[number];

/** One kind of the logic library: the canvas's part plus what the netlist reads. */
export interface LogicPartSpec extends PartSpec {
  /** The gate family, `null` for a terminal or a constant. */
  readonly family: GateFamily | null;
  /** The domain cell, `null` for a declared terminal (it is a port, not a cell). */
  readonly cell: CellType | null;
  /** A variadic gate's fan-in (`params.width` of its cell), 1 for any other part with inputs. */
  readonly width: number;
  /** Half the body's height: where a drawing's outline runs. */
  readonly half: number;
}

const NONE: ValueRole = { kind: "none" };

/** The inputs' heights by fan-in: on the grid, symmetric about the output. */
const INPUT_YS: Readonly<Record<number, readonly number[]>> = {
  1: [0],
  2: [-GRID, GRID],
  3: [-GRID, 0, GRID],
  4: [-2 * GRID, -GRID, GRID, 2 * GRID],
};

/** The longest name a terminal's pill holds; the config refuses a longer one. */
export const TERMINAL_NAME_MAX = 6;
/** The pill's height, and its width for the longest name: what the router keeps clear. */
export const PILL_HEIGHT = 28;
export const PILL_MAX = 4 * GRID;

function gate(family: GateFamily, width: number): LogicPartSpec {
  const half = width === 4 ? 50 : width === 1 ? 20 : 30;
  const pins: PinSpec[] = [
    ...(INPUT_YS[width] ?? []).map((y, i): PinSpec => ({ name: width === 1 ? "A" : `A${i}`, x: -2 * GRID, y, d: 2 })),
    { name: "Y", x: 2 * GRID, y: 0, d: 0 },
  ];
  return {
    family,
    cell: CELL[family],
    width,
    half,
    prefix: "U",
    defaultValue: "",
    value: NONE,
    pins,
    body: [-24, -half, 52, 2 * half],
    label_at: [0, -half - 5],
    terminal: false,
  };
}

/** A terminal or a constant: one pin at the origin, the body on one side of it. */
function oneSided(kind: "IN" | "OUT" | "LOW" | "HIGH"): LogicPartSpec {
  const out = kind === "OUT";
  const width = kind === "LOW" || kind === "HIGH" ? PILL_HEIGHT : PILL_MAX;
  const half = PILL_HEIGHT / 2;
  return {
    family: null,
    cell: kind === "LOW" ? "$const0" : kind === "HIGH" ? "$const1" : null,
    width: 0,
    half,
    prefix: kind,
    defaultValue: "",
    value: NONE,
    pins: [{ name: out ? "A" : "Y", x: 0, y: 0, d: out ? 2 : 0 }],
    body: out ? [0, -half, width, PILL_HEIGHT] : [-width, -half, width, PILL_HEIGHT],
    label_at: null,
    terminal: true,
    ...(kind === "IN" || kind === "OUT" ? { locked: true } : {}),
  };
}

/**
 * A latch or a flip-flop: its inputs down the left, the clock in the middle
 * of three; `Q` at the right of the first, `QN` at the right of the last.
 */
function memory(family: MemoryFamily): LogicPartSpec {
  const names = CELL_SPECS[CELL[family]].inputs;
  const order = names.length === 3 ? [names[0]!, names[2]!, names[1]!] : names;
  const ys = INPUT_YS[order.length]!;
  return {
    family,
    cell: CELL[family],
    width: 1,
    // Off the grid lines, as a gate's: a wire routed beside the box never runs on its outline.
    half: 30,
    prefix: "U",
    defaultValue: "",
    value: NONE,
    pins: [
      ...order.map((name, i): PinSpec => ({ name, x: -2 * GRID, y: ys[i]!, d: 2 })),
      { name: "Q", x: 2 * GRID, y: -GRID, d: 0 },
      { name: "QN", x: 2 * GRID, y: GRID, d: 0 },
    ],
    body: [-24, -30, 52, 60],
    label_at: [0, -35],
    terminal: false,
  };
}

const PARTS: ReadonlyMap<string, LogicPartSpec> = new Map<string, LogicPartSpec>([
  ...VARIADIC.flatMap((family) => WIDTHS.map((width) => [`${family}${width}`, gate(family, width)] as const)),
  ["NOT", gate("NOT", 1)],
  ["BUF", gate("BUF", 1)],
  ...MEMORY_FAMILIES.map((family) => [family, memory(family)] as const),
  ...(["LOW", "HIGH", "IN", "OUT"] as const).map((kind) => [kind, oneSided(kind)] as const),
]);

/** The part lookup, without the drawings; an undeclared kind is a bug, and throws. */
export const LOGIC_PARTS: { part(kind: string): LogicPartSpec } = {
  part(kind: string): LogicPartSpec {
    const spec = PARTS.get(kind);
    if (spec === undefined) throw new Error(`logic: unknown kind ${kind}`);
    return spec;
  },
};

/** The kinds the student is offered: every fan-in of the allowed families, then the constants (cells, not ports). */
export function offeredLogicKinds(families: readonly GateFamily[]): LogicKind[] {
  return LOGIC_KINDS.filter((kind) => {
    const { family, cell } = LOGIC_PARTS.part(kind);
    return family === null ? cell !== null : families.includes(family);
  });
}

/**
 * THE budget rule: what `maxGates`, the canvas's count, the grader and the
 * dashboard all count — every part that is not a terminal, i.e. every gate.
 * A constant is a terminal: all the `LOW` parts are one net driven by one
 * cell, all the `HIGH` parts another (`logicNetlist.ts`).
 */
export const gateCount = (schematic: { components: readonly { kind: string }[] }): number =>
  countedParts(schematic.components, LOGIC_PARTS);

/**
 * One dashboard cell, server and client alike: the gates against the budget
 * (`4/6`), or the gates alone without one. Numbers only, so no language.
 */
export function logicSummary(schematic: { components: readonly { kind: string }[] }, maxGates: number | null): string {
  const gates = gateCount(schematic);
  return maxGates === null ? String(gates) : `${gates}/${maxGates}`;
}


/**
 * Where the declared terminals start: the inputs down the left edge, the
 * outputs down the right, two cells apart and centred — the student moves
 * them where the circuit wants them.
 */
export function initialTerminals(
  inputs: readonly string[],
  outputs: readonly string[],
): { id: string; kind: "IN" | "OUT"; x: number; y: number; m: [1, 0, 0, 1]; name: string; value: string }[] {
  const column = (names: readonly string[], kind: "IN" | "OUT", x: number, first: number) =>
    names.map((name, i) => ({
      id: `c${first + i}`,
      kind,
      x,
      y: Math.round((BOX.height / 2 - (names.length - 1) * GRID + i * 2 * GRID) / GRID) * GRID,
      m: [1, 0, 0, 1] as [1, 0, 0, 1],
      name,
      value: "",
    }));
  return [
    ...column(inputs, "IN", PILL_MAX + 2 * GRID, 1),
    ...column(outputs, "OUT", BOX.width - PILL_MAX - 2 * GRID, inputs.length + 1),
  ];
}
