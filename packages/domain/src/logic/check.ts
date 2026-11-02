/**
 * The checks of a circuit (issue #459, ADR-123): a combinational one
 * exhaustively against one expression per output or a reference circuit, a
 * sequential one step by step against test vectors.
 */
import { evaluate, type Expr } from "./expression.js";
import { LOGIC_LIMITS, LogicError, type Bit, type Netlist, type Value } from "./netlist.js";
import { compileNetlist, type Simulator } from "./simulator.js";
import { checksOutput, readStimulus, type TestVectors, type VectorInput, type VectorOutput } from "./vectors.js";

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
 * What a combinational check compares a circuit with: the outputs it names,
 * and their expected levels on a row. Expressions ({@link expressionKey}) or
 * a reference circuit ({@link circuitKey}): one check path for both.
 */
export interface CombinationalKey {
  readonly outputs: readonly string[];
  expected(env: Readonly<Record<string, Bit>>): Bit[];
}

/** The key of one expression per output. */
export function expressionKey(exprs: Readonly<Record<string, Expr>>): CombinationalKey {
  const outputs = Object.keys(exprs);
  return { outputs, expected: (env) => outputs.map((o) => evaluate(exprs[o]!, env)) };
}

/**
 * The key of a reference circuit: its truth table, computed once here, each
 * row by a FRESH simulator, as the circuit under check is; `expected` is a
 * lookup. A row on which the reference reads `X` or `Z` has no expected
 * level: it throws `logic.reference_undefined`, its `position` the first
 * such row's number (`inputs[0]` the most significant bit).
 */
export function circuitKey(netlist: Netlist, inputs: readonly string[], outputs: readonly string[]): CombinationalKey {
  const compiled = compileNetlist(netlist);
  const table = truthRows(inputs).map((bits, row) => {
    const values = settledOutputs(compiled.createSimulator(), envOf(inputs, bits), outputs);
    if (values.every((v): v is Bit => v === 0 || v === 1)) return values;
    throw new LogicError("logic.reference_undefined", row);
  });
  return {
    outputs,
    expected: (env) => [...table[inputs.reduce((n, name) => 2 * n + (env[name] ?? 0), 0)]!],
  };
}

const envOf = (inputs: readonly string[], bits: readonly Bit[]): Record<string, Bit> =>
  Object.fromEntries(inputs.map((name, j) => [name, bits[j]!]));

/** The 2^n rows of `inputs`, counting in binary with `inputs[0]` as the most significant bit. */
export function truthRows(inputs: readonly string[]): Bit[][] {
  if (inputs.length > LOGIC_LIMITS.inputs) throw new LogicError("logic.too_many_inputs", null, String(inputs.length));
  return Array.from({ length: 2 ** inputs.length }, (_, row) =>
    inputs.map((_, j) => ((row >> (inputs.length - 1 - j)) & 1) as Bit),
  );
}

/**
 * Checks a circuit against a key over all 2^n rows of `inputs` (at most
 * `LOGIC_LIMITS.inputs`). The netlist is compiled once and each row
 * simulated by a FRESH simulator (every net `X`), so no row inherits
 * another's state. An output reading `X` or `Z`, or missing from the
 * netlist, is wrong.
 */
export function checkCombinational(netlist: Netlist, key: CombinationalKey, inputs: readonly string[]): CombinationalCheck {
  const bitsOf = truthRows(inputs);
  const compiled = compileNetlist(netlist);
  const outputs = [...key.outputs];
  const rows = bitsOf.map((bits): CombinationalRow => {
    const env = envOf(inputs, bits);
    const expected = key.expected(env);
    const actual = settledOutputs(compiled.createSimulator(), env, outputs);
    return { inputs: bits, expected, actual, ok: actual.map((v, k) => v === expected[k]) };
  });
  return { inputs: [...inputs], outputs, rows, passed: rows.every((r) => r.ok.every(Boolean)) };
}

/** A fresh simulator driven with `env` and settled: its outputs. */
function settledOutputs(sim: Simulator, env: Readonly<Record<string, Bit>>, outputs: readonly string[]): Value[] {
  sim.set(env);
  sim.settle();
  return readOutputs(sim, outputs);
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
 * Runs steps on ONE simulator, from its initial state (every net `X`, every
 * latch and flip-flop at 0), so each step inherits the state the previous
 * ones left. A step drives its levels with its clocks (`C`) at 0 and
 * settles; with a clock, it raises every clock together and settles, then
 * lowers them and settles: three settles at most. Then it reads the
 * outputs: one row of values per step. The vectors' check and the editor's
 * "Use as reference" both run through it.
 */
export function runSteps(
  netlist: Netlist,
  inputs: readonly string[],
  outputs: readonly string[],
  steps: readonly (readonly VectorInput[])[],
): Value[][] {
  const sim = compileNetlist(netlist).createSimulator();
  const drive = (levels: readonly VectorInput[], clock: Bit): void => {
    sim.set(Object.fromEntries(inputs.map((name, j) => [name, levels[j] === "C" ? clock : levels[j]!])));
    sim.settle();
  };
  return steps.map((levels) => {
    drive(levels, 0);
    if (levels.includes("C")) {
      drive(levels, 1);
      drive(levels, 0);
    }
    return readOutputs(sim, outputs);
  });
}

/**
 * Runs test vectors ({@link runSteps}) and checks every step that checks an
 * output; an `X` or `Z` read is wrong unless the step does not care.
 */
export function checkSequential(netlist: Netlist, vectors: TestVectors): SequentialCheck {
  const { inputs, outputs } = vectors;
  const read = runSteps(netlist, inputs, outputs, vectors.rows.map((row) => row.inputs));
  const rows = vectors.rows.flatMap((row, i): SequentialRow[] => {
    if (!checksOutput(row)) return [];
    const actual = read[i]!;
    return [{ inputs: row.inputs, expected: row.outputs, actual, ok: actual.map((v, k) => row.outputs[k] === "X" || v === row.outputs[k]) }];
  });
  return { inputs: [...inputs], outputs: [...outputs], rows, passed: rows.every((r) => r.ok.every(Boolean)) };
}

/**
 * The vectors with every step's outputs written by the reference circuit run
 * on the teacher's stimulus ({@link runSteps}, the grade's own stepper): the
 * editor's "Use as reference". The stimulus is test vectors whose output
 * columns may hold anything or be left off the end of a line
 * (`readStimulus`); the header names every input and output. A step on which
 * the reference reads `X` or `Z` is refused, as a combinational row is:
 * `logic.reference_undefined`, its `position` the step's line. Comments and
 * blank lines stay; columns are padded to their name.
 */
export function fillVectors(
  source: string,
  declared: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
  reference: Netlist,
): string {
  const { lines, header, names, isInput, steps } = readStimulus(source, declared, { outputsOptional: true });
  if (steps.length === 0) throw new LogicError("logic.vector_empty", null);
  const read = runSteps(
    reference,
    names.filter((_, k) => isInput[k]),
    names.filter((_, k) => !isInput[k]),
    steps.map((step) => step.inputs),
  );
  const row = (cells: readonly string[], comment: string) =>
    [cells.map((cell, k) => cell.padEnd(names[k]!.length)).join(" ").trimEnd(), comment].filter(Boolean).join(" ");
  const stepOf = new Map(steps.map((step, i) => [step.line, i]));
  const filled = lines
    .map(({ line, comment }) => {
      if (line === header) return row(names, comment);
      const i = stepOf.get(line);
      // Blank, or a comment alone: kept as its comment.
      if (i === undefined) return comment;
      const values = read[i]!;
      if (!values.every((v) => v === 0 || v === 1)) throw new LogicError("logic.reference_undefined", line);
      let input = 0;
      let output = 0;
      return row(
        names.map((_, k) => String(isInput[k] ? steps[i]!.inputs[input++] : values[output++])),
        comment,
      );
    })
    .join("\n");
  if (filled.length > LOGIC_LIMITS.vectorLength) throw new LogicError("logic.vector_too_long", null);
  return filled;
}
