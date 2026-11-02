/**
 * The part table of the `logic` question type (docs/spec/04 §4.18, ADR-123):
 * what each kind IS — its pins in netlist order, its body, its cell of
 * `@quiz/domain/logic` — independent of how it is drawn. Read by the canvas
 * (through `canvas/logicLibrary.ts`, which adds the IEC and ANSI drawings),
 * the netlist builder and the grader, so it imports nothing that draws.
 *
 * A gate's family is what the teacher allows (`palette.kinds`); its kinds
 * are that family at a fan-in of 2, 3 or 4 (`AND2`…`AND4`), the range of the
 * domain's variadic cells. `IN` and `OUT` are the declared terminals, LOCKED:
 * the question places them, the student moves them. `LOW` and `HIGH` are the
 * constants, always offered and never counted, as `maxGates` reads (§4.18).
 *
 * Geometry is on the canvas grid ({@link GRID}): inputs on the left at
 * x = −40, the output on the right at x = 40, a terminal's pin at its origin.
 */
import type { CellType } from "@quiz/domain/logic";

import { BOX, GRID, type PinSpec } from "./library.js";
import type { PartSpec, ValueRole } from "./parts.js";

/** The gates a teacher may allow, in the order the editor and the palette show them. */
export const GATE_FAMILIES = ["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"] as const;
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
};

/** The families whose output is negated: the bubble on the symbol. */
export const NEGATED: ReadonlySet<GateFamily> = new Set(["NAND", "NOR", "XNOR", "NOT"]);

/** The declared terminals, then the constants. */
export const TERMINAL_KINDS = ["IN", "OUT"] as const;
export const CONSTANT_KINDS = ["LOW", "HIGH"] as const;

export const LOGIC_KINDS = [
  ...VARIADIC.flatMap((family) => WIDTHS.map((width) => `${family}${width}` as const)),
  "NOT",
  "BUF",
  ...CONSTANT_KINDS,
  ...TERMINAL_KINDS,
] as const;
export type LogicKind = (typeof LOGIC_KINDS)[number];

/** One kind of the logic library: the canvas's part plus what the netlist reads. */
export interface LogicPartSpec extends PartSpec {
  /** The gate family, `null` for a terminal or a constant. */
  readonly family: GateFamily | null;
  /** The domain cell, `null` for a declared terminal (it is a port, not a cell). */
  readonly cell: CellType | null;
  /** The fan-in: the first `width` pins are the cell's inputs, the last its output. */
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
export const PILL_HEIGHT = 24;
export const PILL_MAX = 3 * GRID;

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

const PARTS: ReadonlyMap<string, LogicPartSpec> = new Map<string, LogicPartSpec>([
  ...VARIADIC.flatMap((family) => WIDTHS.map((width) => [`${family}${width}`, gate(family, width)] as const)),
  ["NOT", gate("NOT", 1)],
  ["BUF", gate("BUF", 1)],
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

/** The kinds the student is offered: every fan-in of the allowed families, then the constants. */
export function offeredLogicKinds(families: readonly GateFamily[]): LogicKind[] {
  return LOGIC_KINDS.filter((kind) => {
    const family = LOGIC_PARTS.part(kind).family;
    return family === null ? (CONSTANT_KINDS as readonly string[]).includes(kind) : families.includes(family);
  });
}

/** The box the student wires inside: `circuit`'s, with no port on its border. */
export const LOGIC_BOX = BOX;

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
      y: Math.round((LOGIC_BOX.height / 2 - (names.length - 1) * GRID + i * 2 * GRID) / GRID) * GRID,
      m: [1, 0, 0, 1] as [1, 0, 0, 1],
      name,
      value: "",
    }));
  return [
    ...column(inputs, "IN", PILL_MAX + 2 * GRID, 1),
    ...column(outputs, "OUT", LOGIC_BOX.width - PILL_MAX - 2 * GRID, inputs.length + 1),
  ];
}
