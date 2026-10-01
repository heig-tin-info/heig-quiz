/**
 * The vocabulary of parameterized questions, without the evaluator (ADR-056).
 *
 * What a variable may be named, which formats exist, how long an expression
 * may be: facts the API's evaluator (`./parameters.ts`), the contracts' schema
 * and the editor all need. This module imports nothing, in particular not
 * mathjs, so it is re-exported from the package's index and is safe in the
 * web bundle. The evaluator reads its allowlists from here: one list, one
 * place.
 */

/** The mathjs functions an expression may call. */
export const FUNCTIONS: ReadonlySet<string> = new Set([
  "sqrt", "cbrt", "abs", "exp", "log", "log10", "log2",
  "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh",
  "round", "floor", "ceil", "fix", "sign", "min", "max", "hypot", "mod",
]);

/** Ours, drawn from the platform's generator; allowed only in a variable row. */
export const RANDOM_FUNCTIONS: ReadonlySet<string> = new Set(["randint", "uniform", "choice"]);

export const CONSTANTS: ReadonlySet<string> = new Set(["pi", "e"]);

/**
 * Words of the mathjs grammar, its values, and `__proto__` (a key a plain
 * object cannot hold as data), which no variable may be named.
 */
const RESERVED: ReadonlySet<string> = new Set([
  "and", "or", "not", "xor", "mod", "to", "in", "end",
  "true", "false", "null", "undefined", "NaN", "Infinity", "__proto__",
  // The table's own word: an issue of the condition is filed under it.
  "condition",
]);

/** An identifier, as a regex source: what a variable's name is spelled with. */
export const IDENTIFIER_SOURCE = "[A-Za-z_][A-Za-z0-9_]*";
const IDENTIFIER = new RegExp(`^${IDENTIFIER_SOURCE}$`);

/** A name a variable row may take: an identifier that shadows nothing. */
export function isVariableName(name: string): boolean {
  return (
    IDENTIFIER.test(name) &&
    !FUNCTIONS.has(name) &&
    !RANDOM_FUNCTIONS.has(name) &&
    !CONSTANTS.has(name) &&
    !RESERVED.has(name)
  );
}

/**
 * The formats a variable may take, in the order an editor lists them:
 * `""` (up to 6 significant figures), `int`, `.1`–`.6` decimals, or
 * `1s`–`6s` significant figures (ADR-056 §6). The one list: the pattern
 * below and {@link formatStep} are read from it.
 */
export const FORMATS = [
  "", "int",
  ".1", ".2", ".3", ".4", ".5", ".6",
  "1s", "2s", "3s", "4s", "5s", "6s",
] as const;
export type Format = (typeof FORMATS)[number];

/** Whether `format` is one of {@link FORMATS}. */
export const isFormat = (format: string): format is Format => (FORMATS as readonly string[]).includes(format);

/** {@link FORMATS} as a pattern, for a schema or a validator that wants one. */
export const FORMAT_PATTERN = new RegExp(`^(?:${FORMATS.map((f) => f.replace(".", "\\.")).join("|")})$`);

/** Longest expression accepted, in characters (a row, the condition, a `[[…]]`). */
export const MAX_EXPRESSION_LENGTH = 300;

/** The question types whose texts may interpolate variables in v1 (ADR-056 §10). */
export const PARAMETERIZED_TYPES: ReadonlySet<string> = new Set(["mcq", "short", "cloze"]);

/**
 * The parameterized types whose class debrief still groups answers: by
 * choice, never by what was written — choice B is the same formula, with the
 * same verdict, on every paper (ADR-056 §9). The others group by verdict only.
 */
export const GROUPED_BY_CHOICE: ReadonlySet<string> = new Set(["mcq"]);

/**
 * The step of a format at `value`: the gap between two numbers the format
 * can write (ADR-056 §6). `int` steps by 1, `.n` by 10⁻ⁿ, and `ns` by an
 * amount that follows the magnitude (9.81 at `3s` steps by 0.01, 981 by 1).
 * `null` for the empty format, which keeps a value whole, and at `ns` for 0
 * or a non-finite value, which have no magnitude.
 */
export function formatStep(format: string, value: number): number | null {
  if (!isFormat(format) || format === "") return null;
  if (format === "int") return 1;
  if (format.startsWith(".")) return 10 ** -Number(format.slice(1));
  if (value === 0 || !Number.isFinite(value)) return null;
  return 10 ** (Math.floor(Math.log10(Math.abs(value))) - Number(format.slice(0, -1)) + 1);
}
