/**
 * The rules of a mathematical-expression answer (docs/spec/04 §4.16,
 * ADR-102): how a LaTeX expression is READ against the symbols a question
 * declares, and how two expressions are compared.
 *
 * There is no computer algebra system here, on purpose. Two expressions are
 * "the same" when they take the same values at a handful of points drawn in
 * the domains the teacher declared — what Numbas does by default, and the
 * rule the circuit type already follows: behaviour is compared, never form
 * (ADR-019). The points are derived from the QUESTION, never from an
 * attempt: two students who wrote the same thing get the same verdict, and
 * a regrade reads the same points (ADR-044 §2).
 *
 * Compute Engine (MathLive's sibling, pure JavaScript) PARSES the LaTeX the
 * math field produces and canonicalises it: `\frac{1}{x}`, `x^{-1}` and
 * `1/x` are one tree, `2x` is a product, `\sin^2 x` a power of a sine. It
 * never EVALUATES anything here: its arithmetic is exact and unbounded,
 * and one answer of thirteen characters (`x+10^{10^{6}}`) would hold the
 * API's thread for minutes. The values come from a small float interpreter
 * of the canonical tree ({@link OPERATORS}), whose cost is the size of the
 * tree, which the length cap bounds. An operator the interpreter does not
 * know — a sum, a derivative, a factorial — is a read problem, never a
 * value. Nothing compiles to JavaScript, so the browser's CSP, which
 * refuses `eval`, is never in the way (ADR-069).
 *
 * The PARSE itself is bounded too, the way ADR-099 bounds a regex before it
 * costs anything: two shapes measured exponential in the engine's parser —
 * a run of adjacent signs (`------x`, 18 of them: 250 ms, doubling with
 * each) and absolute-value bars nested deep — are refused lexically before
 * the parser sees them, and the cap on the text is 300 characters, under
 * which every other shape measured stays within ~120 ms (an answer written
 * by a person parses in 1 to 3 ms). The engine declares every symbol name
 * it meets in its own scope, which a stream of fresh names grows without
 * end, so it is recycled every {@link ENGINE_READS} reads.
 */
import { ComputeEngine } from "@cortex-js/compute-engine";
import { hashSeed, rng } from "@quiz/core/rng";

/** The functions a teacher may forbid, by the name students know. */
export const MATH_FUNCTIONS = [
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "sqrt",
  "exp",
  "ln",
  "log",
  "abs",
  "power",
] as const;
export type MathFunction = (typeof MATH_FUNCTIONS)[number];

interface Operator {
  /** The function it counts as for the teacher's rules; none for arithmetic. */
  fn?: MathFunction;
  apply(args: readonly number[]): number;
}

const one = (f: (a: number) => number): Operator["apply"] => (args) => (args.length === 1 ? f(args[0]!) : NaN);
const two = (f: (a: number, b: number) => number): Operator["apply"] => (args) => (args.length === 2 ? f(args[0]!, args[1]!) : NaN);

/**
 * The canonical operators the interpreter knows, and the function each
 * counts as. `e^x` is `Power(ExponentialE, x)`, counted as `exp` by
 * {@link functionsOf}; `Log` with a base is `\log_b`. Everything else
 * Compute Engine can produce (`Sum`, `D`, `Factorial`, `Complex`, `Min`…)
 * is refused at read time.
 */
const OPERATORS: Readonly<Record<string, Operator>> = {
  // No `Subtract`: the canonical tree writes `x-1` as `Add(x, -1)`.
  Add: { apply: (args) => args.reduce((sum, a) => sum + a, 0) },
  Negate: { apply: one((a) => -a) },
  Multiply: { apply: (args) => args.reduce((product, a) => product * a, 1) },
  Divide: { apply: two((a, b) => a / b) },
  Rational: { apply: two((a, b) => a / b) },
  Power: { fn: "power", apply: two((a, b) => Math.pow(a, b)) },
  Sqrt: { fn: "sqrt", apply: one(Math.sqrt) },
  Root: { fn: "sqrt", apply: two((a, n) => Math.pow(a, 1 / n)) },
  Abs: { fn: "abs", apply: one(Math.abs) },
  Ln: { fn: "ln", apply: one(Math.log) },
  Log: {
    fn: "log",
    apply: (args) => (args.length === 1 ? Math.log10(args[0]!) : args.length === 2 ? Math.log(args[0]!) / Math.log(args[1]!) : NaN),
  },
  Sin: { fn: "sin", apply: one(Math.sin) },
  Cos: { fn: "cos", apply: one(Math.cos) },
  Tan: { fn: "tan", apply: one(Math.tan) },
  Arcsin: { fn: "asin", apply: one(Math.asin) },
  Arccos: { fn: "acos", apply: one(Math.acos) },
  Arctan: { fn: "atan", apply: one(Math.atan) },
  Sinh: { fn: "sinh", apply: one(Math.sinh) },
  Cosh: { fn: "cosh", apply: one(Math.cosh) },
  Tanh: { fn: "tanh", apply: one(Math.tanh) },
};

/** The symbols the tree may name besides the question's. */
const CONSTANTS: Readonly<Record<string, number>> = { Pi: Math.PI, ExponentialE: Math.E };

/**
 * A symbol a question declares: `x`, `R1`, `R_1`, `omega` (what `\omega`
 * parses to). One letter, then letters and digits, then an optional
 * subscript of letters and digits.
 */
export const MATH_SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)?$/;
/** The names the parser reads as constants or the imaginary unit, never as a symbol. */
export const MATH_RESERVED_SYMBOLS: readonly string[] = ["e", "i", "pi"];
/** Longest LaTeX read, a key or an answer, in characters: what keeps the parse under ~120 ms whatever the shape. */
export const MATH_MAX_LATEX = 300;

export interface MathSymbol {
  name: string;
  /** The interval the sample points are drawn in. */
  min: number;
  max: number;
}

export type MathProblem =
  | { code: "empty" }
  | { code: "too_long"; max: number }
  | { code: "syntax" }
  | { code: "unknown_symbol"; names: string[] }
  /** A construct the interpreter has no value for: a sum, a derivative, a factorial, a complex number. */
  | { code: "unsupported"; names: string[] }
  | { code: "forbidden_function"; names: MathFunction[] };

/** An expression read against a question: what the grader and the plot evaluate. */
export interface MathReading {
  /** The expression as the parser understood it, re-serialised: the echo under the field. */
  latex: string;
  functions: MathFunction[];
  /** The real value at `env`, or `null` where it is undefined or infinite. Never throws. */
  evaluate(env: Readonly<Record<string, number>>): number | null;
}

/** What an expression is read with: the question's symbols and the field's rules. */
export interface ReadOptions {
  symbols: readonly string[];
  maxLength?: number;
  forbidden?: readonly MathFunction[];
}

/** MathJSON as the canonical tree holds it: a number, a symbol, a boxed numeral, or an operator with its arguments. */
type Json = number | string | { num: string } | Json[];

/**
 * What this module reads of a parsed expression. The package's own type
 * does not reach its public typings (an unresolved re-export reads as
 * `any` under `skipLibCheck`), so the four members used are named
 * structurally and `parse` is cast once.
 */
interface Expression {
  readonly isValid: boolean;
  readonly unknowns: ReadonlyArray<string>;
  readonly json: Json;
  readonly latex: string;
}

/** Reads per engine before a fresh one replaces it (~40 ms to build): the symbol names it met go with it. */
const ENGINE_READS = 1000;
let engine: ComputeEngine | undefined;
let reads = 0;

/** The engine of the moment: it holds no value a read could see, and it is replaced before what it met weighs. */
function ce(): ComputeEngine {
  if (engine === undefined || reads >= ENGINE_READS) {
    engine = new ComputeEngine();
    reads = 0;
  }
  reads += 1;
  return engine;
}

/** Three signs in a row: the parser's time doubles with each one past the second. Nobody writes it. */
const SIGN_RUN = /[+-]{3,}/;
/** The absolute-value delimiters; the parser's time grows exponentially with their nesting. */
const BAR = /\||\\[lr]?vert\b|\\mid\b/g;
/** Enough bars for four nested absolute values, which keeps the parse under a few milliseconds. */
const MAX_BARS = 8;

/** Whether the parser may see this text at all: the shapes it takes exponential time on are refused first. */
function parsesInBoundedTime(source: string): boolean {
  if (SIGN_RUN.test(source.replace(/\s+/g, ""))) return false;
  return (source.match(BAR) ?? []).length <= MAX_BARS;
}

/** The parsed expression, or `null` when the engine refuses the text outright (a numeral too long to hold). */
function parse(source: string): Expression | null {
  try {
    return ce().parse(source) as Expression;
  } catch {
    return null;
  }
}

/**
 * The engine's serialisation names the constants by macros of its own,
 * which KaTeX does not know; the echo under the field says `e` and `i`.
 */
const ECHO_MACROS: readonly [RegExp, string][] = [
  [/\\exponentialE\b/g, "e"],
  [/\\imaginaryI\b/g, "i"],
];

function echoLatex(latex: string): string {
  return ECHO_MACROS.reduce((out, [macro, plain]) => out.replace(macro, plain), latex);
}

/** The operators of the tree the interpreter does not know, and the symbols that are neither declared nor constants. */
function unsupportedIn(json: Json, declared: ReadonlySet<string>, out = new Set<string>()): Set<string> {
  if (typeof json === "string") {
    if (!(json in CONSTANTS) && !declared.has(json)) out.add(json);
  } else if (Array.isArray(json)) {
    const [operator, ...args] = json;
    if (typeof operator !== "string" || !(operator in OPERATORS)) out.add(typeof operator === "string" ? operator : "?");
    for (const arg of args) unsupportedIn(arg, declared, out);
  }
  return out;
}

/** The functions of the tree, `e^x` counted as `exp`; the arithmetic counts as nothing. */
function functionsOf(json: Json, out = new Set<MathFunction>()): Set<MathFunction> {
  if (!Array.isArray(json)) return out;
  const [operator, ...args] = json;
  if (operator === "Power" && args[0] === "ExponentialE") out.add("exp");
  else {
    const fn = typeof operator === "string" ? OPERATORS[operator]?.fn : undefined;
    if (fn !== undefined) out.add(fn);
  }
  for (const arg of args) functionsOf(arg, out);
  return out;
}

/** The float interpreter: the tree's value at `env`, NaN or infinite where there is none. */
function valueOf(json: Json, env: Readonly<Record<string, number>>): number {
  if (typeof json === "number") return json;
  if (typeof json === "string") return env[json] ?? CONSTANTS[json] ?? NaN;
  if (!Array.isArray(json)) return Number(json.num);
  const [operator, ...args] = json;
  const op = typeof operator === "string" ? OPERATORS[operator] : undefined;
  return op === undefined ? NaN : op.apply(args.map((arg) => valueOf(arg, env)));
}

/**
 * Reads a LaTeX expression against the question: refused when empty, too
 * long, malformed, naming a symbol the question does not declare, using a
 * construct that has no value here, or using a function the teacher
 * forbade. The problems are reported in that order, one at a time — the
 * first thing to fix.
 */
export function readMath(latex: string, options: ReadOptions): { ok: true; reading: MathReading } | { ok: false; problem: MathProblem } {
  const max = Math.min(options.maxLength ?? MATH_MAX_LATEX, MATH_MAX_LATEX);
  const source = latex.trim();
  if (source === "") return { ok: false, problem: { code: "empty" } };
  if (source.length > max) return { ok: false, problem: { code: "too_long", max } };
  const expr = parsesInBoundedTime(source) ? parse(source) : null;
  if (expr === null || !expr.isValid) return { ok: false, problem: { code: "syntax" } };
  const declared = new Set(options.symbols);
  const unknown = expr.unknowns.filter((name) => !declared.has(name));
  if (unknown.length > 0) return { ok: false, problem: { code: "unknown_symbol", names: unknown } };
  const unsupported = [...unsupportedIn(expr.json, declared)];
  if (unsupported.length > 0) return { ok: false, problem: { code: "unsupported", names: unsupported } };
  const functions = [...functionsOf(expr.json)];
  const forbidden = (options.forbidden ?? []).filter((name) => functions.includes(name));
  if (forbidden.length > 0) return { ok: false, problem: { code: "forbidden_function", names: forbidden } };
  const { json } = expr;
  return {
    ok: true,
    reading: {
      latex: echoLatex(expr.latex),
      functions,
      evaluate: (env) => {
        const value = valueOf(json, env);
        return Number.isFinite(value) ? value : null;
      },
    },
  };
}

/**
 * The points two expressions are compared at: `count` draws, each symbol
 * uniform in its interval, from a seed made of `seedParts` — the question's
 * own key and symbols, so the points belong to the question version and to
 * nothing else.
 */
export function samplePoints(
  symbols: readonly MathSymbol[],
  count: number,
  seedParts: readonly (string | number)[],
): Record<string, number>[] {
  const next = rng(hashSeed("math", ...seedParts));
  const points: Record<string, number>[] = [];
  for (let i = 0; i < count; i++) {
    const point: Record<string, number> = {};
    for (const symbol of symbols) point[symbol.name] = symbol.min + (symbol.max - symbol.min) * next();
    points.push(point);
  }
  return points;
}

export interface MathComparison {
  /** Equal within the tolerance at every point where the key has a value. */
  equivalent: boolean;
  /** The points where the key has a value: 0 means the key is undefined on the domain. */
  compared: number;
}

/**
 * Compares a candidate to the key at the sample points. A point where the
 * key has no value (a pole, a root of a negative number) is skipped; where
 * the key has one and the candidate none, the candidate is wrong. Two
 * values agree when their distance is within `tolerance` times the larger
 * of their magnitudes and of the key's magnitude over the whole sample —
 * relative, with a floor that keeps a near-zero value of a large function
 * from failing on float noise.
 */
export function compareMath(
  key: MathReading,
  candidate: MathReading,
  points: readonly Readonly<Record<string, number>>[],
  tolerance: number,
): MathComparison {
  const pairs: [number, number | null][] = [];
  for (const point of points) {
    const expected = key.evaluate(point);
    if (expected === null) continue;
    pairs.push([expected, candidate.evaluate(point)]);
  }
  if (pairs.length === 0) return { equivalent: false, compared: 0 };
  const scale = Math.max(...pairs.map(([expected]) => Math.abs(expected)));
  const equivalent = pairs.every(([expected, actual]) => {
    if (actual === null) return false;
    const magnitude = Math.max(Math.abs(expected), Math.abs(actual), scale);
    return magnitude === 0 || Math.abs(expected - actual) / magnitude <= tolerance;
  });
  return { equivalent, compared: pairs.length };
}

/**
 * The expression sampled on an even grid of `n` points over `[from, to]` of
 * `symbol`: what the plot draws, `null` where there is no value. An even
 * grid is never the grading sample, which is random (`samplePoints`).
 */
export function curveOf(reading: MathReading, symbol: string, from: number, to: number, n: number): (number | null)[] {
  const steps = Math.max(1, n - 1);
  const y: (number | null)[] = [];
  for (let i = 0; i <= steps; i++) y.push(reading.evaluate({ [symbol]: from + ((to - from) * i) / steps }));
  return y;
}
