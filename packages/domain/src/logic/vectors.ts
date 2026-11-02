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
  const lines = source
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, tokens: text.replace(/#.*/, "").trim().split(/\s+/).filter(Boolean) }))
    .filter((l) => l.tokens.length > 0);
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
      const level = value === "0" ? 0 : value === "1" ? 1 : null;
      if (isInput[k]) inputs.push(level ?? (value === "C" ? "C" : fail("logic.vector_value", line)));
      else outputs.push(level ?? (value === "X" ? "X" : fail("logic.vector_value", line)));
    });
    return { inputs, outputs };
  });
  if (!rows.some(checksOutput)) fail("logic.vector_empty", null);
  return { inputs: names.filter((_, k) => isInput[k]), outputs: names.filter((_, k) => !isInput[k]), rows };
}
