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
import { LOGIC_LIMITS, LogicError, type Bit, type VectorErrorCode } from "./netlist.js";

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

/** One step of a stimulus: its line, its inputs in header order, its output tokens as typed (`null`: left off). */
export interface StimulusStep {
  readonly line: number;
  readonly inputs: VectorInput[];
  readonly outputs: (string | null)[];
}

/** Test vectors read up to their outputs: the lines, the header's names, the steps. */
export interface Stimulus {
  /** Every line, 1-based, a comment stripped from its tokens and kept apart. */
  readonly lines: { line: number; tokens: string[]; comment: string }[];
  readonly header: number;
  /** The header's names, in its order. */
  readonly names: string[];
  readonly isInput: boolean[];
  readonly steps: StimulusStep[];
}

/**
 * The rules test vectors and a stimulus share: the length, a header naming
 * every declared input and output once, the step cap, one value per column
 * and each input `0`, `1` or `C`. With `outputsOptional`, a step may leave
 * its output columns off the end of the line (a stimulus "Use as reference"
 * fills); otherwise every column is there. Output tokens are not read here.
 */
export function readStimulus(
  source: string,
  declared: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
  { outputsOptional = false }: { outputsOptional?: boolean } = {},
): Stimulus {
  if (source.length > LOGIC_LIMITS.vectorLength) fail("logic.vector_too_long", null);
  const lines = lex(source);
  const [header, ...rest] = lines.filter((l) => l.tokens.length > 0);
  if (header === undefined) return fail("logic.vector_empty", null);

  const names = header.tokens;
  const isInput = names.map((name) => declared.inputs.includes(name));
  const signals = [...declared.inputs, ...declared.outputs];
  const exact =
    new Set(names).size === names.length &&
    names.length === signals.length &&
    signals.every((name) => names.includes(name));
  if (!exact) fail("logic.vector_header", header.line);
  if (rest.length > LOGIC_LIMITS.vectorRows) fail("logic.vector_too_long", rest[LOGIC_LIMITS.vectorRows]!.line);

  const steps = rest.map(({ line, tokens }): StimulusStep => {
    // Too many values, too few, or (a stimulus) an input column left off the end of the line.
    const short = tokens.length < names.length && (!outputsOptional || isInput.slice(tokens.length).some(Boolean));
    if (tokens.length > names.length || short) fail("logic.vector_columns", line);
    const inputs: VectorInput[] = [];
    const outputs: (string | null)[] = [];
    names.forEach((_, k) => {
      const token = tokens[k];
      if (isInput[k]) inputs.push(inputValue(token!) ?? fail("logic.vector_value", line));
      else outputs.push(token ?? null);
    });
    return { line, inputs, outputs };
  });
  return { lines, header: header.line, names, isInput, steps };
}

/**
 * Parses test vectors over the declared signals ({@link readStimulus}, then
 * each output `0`, `1` or `X`, and one step that checks an output). Throws a
 * `LogicError` whose `position` is the 1-based line at fault (`null` for the
 * text as a whole).
 */
export function parseVectors(
  source: string,
  declared: { readonly inputs: readonly string[]; readonly outputs: readonly string[] },
): TestVectors {
  const { names, isInput, steps } = readStimulus(source, declared);
  const rows = steps.map(({ line, inputs, outputs }): VectorRow => ({
    inputs,
    outputs: outputs.map((token) => {
      const value = token!.toUpperCase();
      return value === "0" ? 0 : value === "1" ? 1 : value === "X" ? "X" : fail("logic.vector_value", line);
    }),
  }));
  if (!rows.some(checksOutput)) fail("logic.vector_empty", null);
  return { inputs: names.filter((_, k) => isInput[k]), outputs: names.filter((_, k) => !isInput[k]), rows };
}
