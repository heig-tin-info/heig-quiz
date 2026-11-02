/**
 * Test vectors, the specification of a sequential circuit (issue #459,
 * ADR-123), in the style of hneemann's Digital:
 *
 * ```
 * # a comment, and blank lines, are skipped
 * clk d  q
 * 0   0  0
 * C   1  1
 * C   0  0
 * 0   1  X
 * ```
 *
 * The first line names the signals: every declared input and every declared
 * output, each once, in any order. Each further line is one step, a value
 * per column: an input reads `0`, `1` or `C` (a clock pulse), an output `0`,
 * `1` or `X` (don't care). `c` and `x` are read as `C` and `X`. The steps run
 * in order on one simulator (`checkSequential`). At least one step checks an
 * output, and `LOGIC_LIMITS` caps the steps and the text.
 */
import { LOGIC_LIMITS, LogicError, type Bit, type Value, type VectorErrorCode } from "./netlist.js";

/** An input's value at a step: a level, or `C`, a clock pulse 0 → 1 → 0. */
export type VectorInput = Bit | "C";
/** An output's expected value at a step: a level, or `X`, not checked. */
export type VectorOutput = Bit | "X";

export interface VectorRow {
  /** In the order of `TestVectors.inputs`. */
  readonly inputs: VectorInput[];
  /** In the order of `TestVectors.outputs`. */
  readonly outputs: VectorOutput[];
}

export interface TestVectors {
  /** The inputs' names, in the header's order. */
  readonly inputs: string[];
  /** The outputs' names, in the header's order. */
  readonly outputs: string[];
  readonly rows: VectorRow[];
}

/** Whether a step checks at least one output. */
export const checksOutput = (row: VectorRow): boolean => row.outputs.some((v) => v !== "X");

/** Each line of the text, 1-based, with its tokens (a comment stripped) and its comment. */
function lex(source: string): { line: number; tokens: string[]; comment: string }[] {
  return source.split(/\r?\n/).map((text, i) => ({
    line: i + 1,
    tokens: text.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean),
    comment: /#.*/.exec(text)?.[0] ?? "",
  }));
}

/** An input's token: a level or a clock pulse, `null` for anything else. */
function inputValue(token: string): VectorInput | null {
  const value = token.toUpperCase();
  return value === "0" ? 0 : value === "1" ? 1 : value === "C" ? "C" : null;
}

const fail = (code: VectorErrorCode, line: number | null): never => {
  throw new LogicError(code, line);
};

/**
 * Parses test vectors over the declared signals. Throws a `LogicError` whose
 * `position` is the 1-based line at fault (`null` for the text as a whole).
 */
export function parseVectors(
  source: string,
  declared: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
): TestVectors {
  if (source.length > LOGIC_LIMITS.vectorLength) fail("logic.vector_too_long", null);
  const lines = lex(source).filter((l) => l.tokens.length > 0);
  const [header, ...steps] = lines;
  if (header === undefined) return fail("logic.vector_empty", null);

  const names = header.tokens;
  const isInput = names.map((name) => declared.inputs.includes(name));
  const signals = [...declared.inputs, ...declared.outputs];
  const exact =
    new Set(names).size === names.length &&
    names.length === signals.length &&
    signals.every((name) => names.includes(name));
  if (!exact) fail("logic.vector_header", header.line);
  if (steps.length > LOGIC_LIMITS.vectorRows) fail("logic.vector_too_long", steps[LOGIC_LIMITS.vectorRows]!.line);

  const rows = steps.map(({ line, tokens }): VectorRow => {
    if (tokens.length !== names.length) fail("logic.vector_columns", line);
    const inputs: VectorInput[] = [];
    const outputs: VectorOutput[] = [];
    tokens.forEach((token, k) => {
      const value = token.toUpperCase();
      if (isInput[k]) inputs.push(inputValue(token) ?? fail("logic.vector_value", line));
      else outputs.push(value === "0" ? 0 : value === "1" ? 1 : value === "X" ? "X" : fail("logic.vector_value", line));
    });
    return { inputs, outputs };
  });
  if (!rows.some(checksOutput)) fail("logic.vector_empty", null);
  return { inputs: names.filter((_, k) => isInput[k]), outputs: names.filter((_, k) => !isInput[k]), rows };
}

/**
 * The vectors with every step's outputs written from a run of the steps —
 * the reference circuit's, through `runSteps` (the editor's "Use as
 * reference"). The teacher writes the stimulus: a header naming every input
 * once (an output it leaves out is added at its end), then each step's
 * inputs; a step's output columns may hold anything, or be left off the end
 * of the line. A level read is written as is, an `X` or `Z` as `X` (not
 * checked). Comments and blank lines stay; columns are padded to their name.
 * Throws the `logic.vector_*` errors of {@link parseVectors}, by line.
 */
export function fillVectors(
  source: string,
  declared: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
  run: (inputs: string[], outputs: string[], steps: VectorInput[][]) => Value[][],
): string {
  if (source.length > LOGIC_LIMITS.vectorLength) fail("logic.vector_too_long", null);
  const lines = lex(source);
  const header = lines.find((l) => l.tokens.length > 0);
  if (header === undefined) return fail("logic.vector_empty", null);
  const named = header.tokens;
  const known = (name: string) => declared.inputs.includes(name) || declared.outputs.includes(name);
  const headerOk =
    new Set(named).size === named.length && named.every(known) && declared.inputs.every((name) => named.includes(name));
  if (!headerOk) fail("logic.vector_header", header.line);
  const names = [...named, ...declared.outputs.filter((name) => !named.includes(name))];
  const isInput = names.map((name) => declared.inputs.includes(name));

  const steps = lines.filter((l) => l.line > header.line && l.tokens.length > 0);
  if (steps.length === 0) fail("logic.vector_empty", null);
  if (steps.length > LOGIC_LIMITS.vectorRows) fail("logic.vector_too_long", steps[LOGIC_LIMITS.vectorRows]!.line);
  const levels = steps.map(({ line, tokens }) => {
    // Too many values, or an input column left off the end of the line.
    if (tokens.length > named.length || isInput.slice(tokens.length).some(Boolean)) fail("logic.vector_columns", line);
    return names.flatMap((_, k) => (isInput[k] ? [inputValue(tokens[k]!) ?? fail("logic.vector_value", line)] : []));
  });
  const inputs = names.filter((_, k) => isInput[k]);
  const outputs = names.filter((_, k) => !isInput[k]);
  const read = run(inputs, outputs, levels);

  const widths = names.map((name) => name.length);
  const row = (cells: readonly string[], comment: string) =>
    [cells.map((cell, k) => cell.padEnd(widths[k]!)).join(" ").trimEnd(), comment].filter(Boolean).join(" ");
  const stepOf = new Map(steps.map((s, i) => [s.line, i]));
  const text = lines.map(({ line, comment }) => {
    if (line === header.line) return row(names, comment);
    const step = stepOf.get(line);
    // Blank or a comment alone: kept as its comment.
    if (step === undefined) return comment;
    let i = 0;
    let o = 0;
    return row(
      names.map((_, k) => (isInput[k] ? String(levels[step]![i++]) : levelOf(read[step]![o++]))),
      comment,
    );
  });
  const filled = text.join("\n");
  if (filled.length > LOGIC_LIMITS.vectorLength) fail("logic.vector_too_long", null);
  return filled;
}

/** A level read, as an expected output: `X` for anything that is not 0 or 1. */
const levelOf = (value: Value | undefined): string => (value === 0 || value === 1 ? String(value) : "X");
