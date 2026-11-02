/**
 * The checks of a circuit (issue #459, ADR-123): a combinational one
 * exhaustively against one expression per output, a sequential one step by
 * step against test vectors.
 */
import { evaluate, type Expr } from "./expression.js";
import { LOGIC_LIMITS, LogicError, type Bit, type Netlist, type Value } from "./netlist.js";
import { compileNetlist, type Simulator } from "./simulator.js";
import { checksOutput, type TestVectors, type VectorInput, type VectorOutput } from "./vectors.js";

export interface CombinationalRow {
  readonly inputs: Bit[];
  /** Per output, in the order of `CombinationalCheck.outputs`. */
  readonly expected: Bit[];
  readonly actual: Value[];
  readonly ok: boolean[];
}

export interface CombinationalCheck {
  readonly inputs: string[];
  readonly outputs: string[];
  /** 2^n rows, counting in binary with `inputs[0]` as the most significant bit. */
  readonly rows: CombinationalRow[];
  /** Every output right on every row. */
  readonly passed: boolean;
}

/**
 * Checks a circuit against one expression per output over all 2^n rows of
 * `inputs` (at most `LOGIC_LIMITS.inputs`). The netlist is compiled once and
 * each row simulated by a FRESH simulator (every net `X`), so no row inherits
 * another's state. An output reading `X` or `Z`, or missing from the
 * netlist, is wrong.
 */
export function checkCombinational(
  netlist: Netlist,
  exprs: Readonly<Record<string, Expr>>,
  inputs: readonly string[],
): CombinationalCheck {
  if (inputs.length > LOGIC_LIMITS.inputs) throw new LogicError("logic.too_many_inputs", null, String(inputs.length));
  const compiled = compileNetlist(netlist);
  const outputs = Object.keys(exprs);
  const rows = Array.from({ length: 2 ** inputs.length }, (_, row): CombinationalRow => {
    const bits = inputs.map((_, j) => ((row >> (inputs.length - 1 - j)) & 1) as Bit);
    const env = Object.fromEntries(inputs.map((name, j) => [name, bits[j]!]));
    const sim = compiled.createSimulator();
    sim.set(env);
    sim.settle();
    const expected = outputs.map((o) => evaluate(exprs[o]!, env));
    const actual = readOutputs(sim, outputs);
    return { inputs: bits, expected, actual, ok: actual.map((v, k) => v === expected[k]) };
  });
  return { inputs: [...inputs], outputs, rows, passed: rows.every((r) => r.ok.every(Boolean)) };
}

/** The outputs' values; one missing from the netlist reads `Z`. */
function readOutputs(sim: Simulator, outputs: readonly string[]): Value[] {
  const read = sim.read();
  return outputs.map((o): Value => (Object.hasOwn(read, o) ? read[o]! : "Z"));
}

export interface SequentialRow {
  readonly inputs: VectorInput[];
  readonly expected: VectorOutput[];
  readonly actual: Value[];
  /** Per output; an `X` expected (don't care) is always right. */
  readonly ok: boolean[];
}

export interface SequentialCheck {
  readonly inputs: string[];
  readonly outputs: string[];
  /** One per step that checks an output, in order: a step of don't cares only is stimulus, not a row. */
  readonly rows: SequentialRow[];
  /** Every checked output right on every step. */
  readonly passed: boolean;
}

/**
 * Runs test vectors on ONE simulator, from its initial state (every net `X`,
 * every latch and flip-flop at 0), so each step inherits the state the
 * previous ones left. A step drives its levels with its clocks (`C`) at 0
 * and settles; with a clock, it raises every clock together and settles,
 * then lowers them and settles: three settles at most. Then it reads the
 * outputs; an `X` or `Z` read is wrong unless the step does not care.
 */
export function checkSequential(netlist: Netlist, vectors: TestVectors): SequentialCheck {
  const sim = compileNetlist(netlist).createSimulator();
  const { inputs, outputs } = vectors;
  const drive = (levels: readonly VectorInput[], clock: Bit): void => {
    sim.set(Object.fromEntries(inputs.map((name, j) => [name, levels[j] === "C" ? clock : levels[j]!])));
    sim.settle();
  };
  const rows = vectors.rows.flatMap((row): SequentialRow[] => {
    drive(row.inputs, 0);
    if (row.inputs.includes("C")) {
      drive(row.inputs, 1);
      drive(row.inputs, 0);
    }
    if (!checksOutput(row)) return [];
    const actual = readOutputs(sim, outputs);
    return [{ inputs: row.inputs, expected: row.outputs, actual, ok: actual.map((v, k) => row.outputs[k] === "X" || v === row.outputs[k]) }];
  });
  return { inputs: [...inputs], outputs: [...outputs], rows, passed: rows.every((r) => r.ok.every(Boolean)) };
}
