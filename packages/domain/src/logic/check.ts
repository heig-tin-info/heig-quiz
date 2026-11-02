/**
 * The exhaustive check of a combinational circuit against one expression per
 * output (issue #459, ADR-123).
 */
import { evaluate, type Expr } from "./expression.js";
import { LOGIC_LIMITS, LogicError, type Bit, type Netlist, type Value } from "./netlist.js";
import { compileNetlist } from "./simulator.js";

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
    const read = sim.read();
    const expected = outputs.map((o) => evaluate(exprs[o]!, env));
    const actual = outputs.map((o): Value => (Object.hasOwn(read, o) ? read[o]! : "Z"));
    return { inputs: bits, expected, actual, ok: actual.map((v, k) => v === expected[k]) };
  });
  return { inputs: [...inputs], outputs, rows, passed: rows.every((r) => r.ok.every(Boolean)) };
}
