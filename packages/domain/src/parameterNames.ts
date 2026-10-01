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
]);

/** A name a variable row may take: an identifier that shadows nothing. */
export function isVariableName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !FUNCTIONS.has(name) &&
    !RANDOM_FUNCTIONS.has(name) &&
    !CONSTANTS.has(name) &&
    !RESERVED.has(name)
  );
}

/**
 * A variable's format: `""` (up to 6 significant figures), `int`, `.1`–`.6`
 * decimals, or `1s`–`6s` significant figures (ADR-056 §6).
 */
export const FORMAT_PATTERN = /^(?:|int|\.[1-6]|[1-6]s)$/;

/** Longest expression accepted, in characters (a row, the condition, a `[[…]]`). */
export const MAX_EXPRESSION_LENGTH = 300;
