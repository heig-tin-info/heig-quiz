/**
 * The restricted expression evaluator of parameterized questions (ADR-056 §2).
 * Internal: `../parameters.ts` is the entry point; nothing else imports this.
 *
 * An expression is written by a teacher and evaluated on the server, so it is
 * untrusted input. Two layers stand between it and mathjs:
 *
 *  1. Static: a length cap, then mathjs's parser, then a walk of the WHOLE
 *     syntax tree against an allowlist — node types, operators, function
 *     names, constants — and a cap on the number of nodes. Anything not on a
 *     list is refused: assignments, function definitions, property and index
 *     access, objects, blocks, ranges (refused outright in v1 rather than
 *     capped by size), nested arrays, implicit multiplication (`2pi` reads as
 *     a typo as easily as a product), `true`/`null` and every function that is
 *     not named below. This walk is the guarantee.
 *  2. The instance: built with `create()` from the factories of the allowed
 *     functions only (plus `format`, which `./format.ts` uses), not from `all`. `import` and `parse` remain on it (every
 *     instance has them), but no node that survives the walk can reach them:
 *     a call's callee must be a plain name on the allowlist, and a bare name
 *     must be a constant or a variable in scope. The smaller instance is
 *     defence in depth, not the guarantee.
 *
 * Randomness is the platform's own (`@quiz/core/rng`, decision D19):
 * `randint`, `uniform` and `choice` are not mathjs functions, they are put in
 * the scope of each evaluation, bound to the generator of the current draw.
 * mathjs's `random*` are not on the instance, and `Math.random` is never read.
 *
 * Errors are `ParameterError`s carrying a stable `Issue` (code, English
 * message for logs, and the row, path and offset when the caller knows them).
 */
import {
  absDependencies,
  acosDependencies,
  addDependencies,
  andDependencies,
  asinDependencies,
  atan2Dependencies,
  atanDependencies,
  cbrtDependencies,
  ceilDependencies,
  cosDependencies,
  coshDependencies,
  create,
  divideDependencies,
  eDependencies,
  equalDependencies,
  expDependencies,
  fixDependencies,
  floorDependencies,
  formatDependencies,
  hypotDependencies,
  largerDependencies,
  largerEqDependencies,
  log10Dependencies,
  log2Dependencies,
  logDependencies,
  maxDependencies,
  minDependencies,
  modDependencies,
  multiplyDependencies,
  notDependencies,
  orDependencies,
  parseDependencies,
  piDependencies,
  powDependencies,
  roundDependencies,
  signDependencies,
  sinDependencies,
  sinhDependencies,
  smallerDependencies,
  smallerEqDependencies,
  sqrtDependencies,
  subtractDependencies,
  tanDependencies,
  tanhDependencies,
  unaryMinusDependencies,
  unaryPlusDependencies,
  unequalDependencies,
  xorDependencies,
  type FactoryFunctionMap,
} from "mathjs";

import { CONSTANTS, FUNCTIONS, MAX_EXPRESSION_LENGTH, RANDOM_FUNCTIONS } from "../parameterNames.js";

/** The stable codes of a parameter issue. A UI translates them; never the message. */
export type IssueCode =
  | "bad_name"
  | "duplicate_name"
  | "bad_format"
  | "too_long"
  | "too_complex"
  /** A variable row with nothing written yet (an auto-created row starts so). */
  | "empty_expression"
  | "parse_error"
  | "forbidden_node"
  | "unknown_function"
  | "unknown_name"
  | "unterminated"
  | "not_a_number"
  | "not_a_boolean"
  | "eval_error"
  | "condition_exhausted"
  | "choices_not_distinct"
  | "too_slow";

export interface Issue {
  code: IssueCode;
  /** English, for logs and tests; the UI shows a translation of `code`. */
  message: string;
  /** The variable row involved, by name (or `"condition"`). */
  row?: string;
  /** Where in the validated JSON the text lives (`/choices/2/text`). */
  path?: string;
  /** Character offset in that text (the `[[` of an interpolation). */
  offset?: number;
}

export class ParameterError extends Error {
  constructor(readonly issue: Issue) {
    super(issue.message);
    this.name = "ParameterError";
  }
}

/**
 * Runs `f`; a `ParameterError` it throws is rethrown with `extra` laid over
 * its issue (the row, the path, the offset of the `[[`). Anything else is a
 * bug and goes up unchanged.
 */
export function at<T>(extra: Omit<Issue, "code" | "message">, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ParameterError) throw new ParameterError({ ...e.issue, ...extra });
    throw e;
  }
}

/** Like `at`, but records the issue in `issues` and returns undefined. */
export function collect<T>(issues: Issue[], extra: Omit<Issue, "code" | "message">, f: () => T): T | undefined {
  try {
    return at(extra, f);
  } catch (e) {
    if (!(e instanceof ParameterError)) throw e;
    issues.push(e.issue);
    return undefined;
  }
}

export function fail(code: IssueCode, message: string, extra: Omit<Issue, "code" | "message"> = {}): never {
  throw new ParameterError({ code, message, ...extra });
}

/** Largest syntax tree accepted, in nodes. */
const MAX_EXPRESSION_NODES = 100;

/** Operators by their mathjs function name: arithmetic, comparison, logic. */
const OPERATORS = new Set([
  "add", "subtract", "multiply", "divide", "pow", "mod", "unaryMinus", "unaryPlus",
  "equal", "unequal", "smaller", "larger", "smallerEq", "largerEq",
  "and", "or", "not", "xor",
]);
export const math = create(
  {
    parseDependencies,
    addDependencies, subtractDependencies, multiplyDependencies, divideDependencies,
    powDependencies, modDependencies, unaryMinusDependencies, unaryPlusDependencies,
    equalDependencies, unequalDependencies, smallerDependencies, largerDependencies,
    smallerEqDependencies, largerEqDependencies,
    andDependencies, orDependencies, notDependencies, xorDependencies,
    sqrtDependencies, cbrtDependencies, absDependencies, expDependencies,
    logDependencies, log10Dependencies, log2Dependencies,
    sinDependencies, cosDependencies, tanDependencies, asinDependencies,
    acosDependencies, atanDependencies, atan2Dependencies,
    sinhDependencies, coshDependencies, tanhDependencies,
    roundDependencies, floorDependencies, ceilDependencies, fixDependencies,
    signDependencies, minDependencies, maxDependencies, hypotDependencies,
    piDependencies, eDependencies,
    formatDependencies,
    // mathjs types each `*Dependencies` as possibly undefined; they are not.
  } as FactoryFunctionMap,
  // `predictable`: sqrt(-1) is NaN (refused), never a Complex. `Array`: a
  // `[...]` literal is a plain array that `choice` can read.
  { matrix: "Array", predictable: true },
);

/** What the walk reads of a node; mathjs's own types are generic-heavy. */
interface Node {
  type: string;
  value?: unknown;
  name?: string;
  fn?: unknown;
  op?: string;
  implicit?: boolean;
  args?: Node[];
  items?: Node[];
  content?: Node;
  condition?: Node;
  trueExpr?: Node;
  falseExpr?: Node;
}

export interface Compiled {
  /** The bare names read as values (variables), constants excluded. */
  names: ReadonlySet<string>;
  /** Whether it calls `randint`, `uniform` or `choice`. */
  random: boolean;
  evaluate(scope: Map<string, unknown>): unknown;
}

/**
 * Parses and validates an expression, without looking at the names in scope
 * (`checkNames` does). Throws a `ParameterError` when the expression is
 * refused; whatever else mathjs might throw becomes a `parse_error`.
 */
export function compile(expr: string): Compiled {
  if (expr.length > MAX_EXPRESSION_LENGTH) {
    fail("too_long", `expression longer than ${MAX_EXPRESSION_LENGTH} characters`);
  }
  if (expr.trim() === "") fail("parse_error", "empty expression");
  try {
    const root = math.parse(expr);
    const names = new Set<string>();
    const state = { nodes: 0, random: false };
    walk(root as unknown as Node, names, state);
    const code = root.compile();
    return { names, random: state.random, evaluate: (scope) => code.evaluate(scope) as unknown };
  } catch (e) {
    if (e instanceof ParameterError) throw e;
    // mathjs's SyntaxError carries `char`, 1-based.
    const char = (e as { char?: number }).char ?? 1;
    return fail("parse_error", (e as Error).message, { offset: char - 1 });
  }
}

function walk(node: Node, names: Set<string>, state: { nodes: number; random: boolean }): void {
  state.nodes += 1;
  if (state.nodes > MAX_EXPRESSION_NODES) {
    fail("too_complex", `expression larger than ${MAX_EXPRESSION_NODES} nodes`);
  }
  const children: Node[] = [];
  switch (node.type) {
    case "ConstantNode":
      if (typeof node.value === "string") break;
      if (typeof node.value !== "number") fail("forbidden_node", `constant ${String(node.value)} is not allowed`);
      if (!Number.isFinite(node.value)) fail("not_a_number", "constant is not a finite number");
      break;
    case "SymbolNode": {
      const name = node.name!;
      if (CONSTANTS.has(name)) break;
      if (FUNCTIONS.has(name) || RANDOM_FUNCTIONS.has(name)) {
        fail("forbidden_node", `function ${name} used as a value`);
      }
      names.add(name);
      break;
    }
    case "ParenthesisNode":
      children.push(node.content!);
      break;
    case "ConditionalNode":
      children.push(node.condition!, node.trueExpr!, node.falseExpr!);
      break;
    case "OperatorNode":
      if (node.implicit) fail("forbidden_node", "implicit multiplication: write the * (2*pi)");
      if (!OPERATORS.has(node.fn as string)) fail("forbidden_node", `operator ${node.op} is not allowed`);
      children.push(...node.args!);
      break;
    case "ArrayNode":
      for (const item of node.items!) {
        if (item.type === "ArrayNode") fail("forbidden_node", "nested arrays are not allowed");
      }
      children.push(...node.items!);
      break;
    case "FunctionNode": {
      const callee = node.fn as Node;
      if (callee.type !== "SymbolNode") fail("forbidden_node", "only a named function may be called");
      const name = callee.name!;
      if (RANDOM_FUNCTIONS.has(name)) state.random = true;
      else if (!FUNCTIONS.has(name)) fail("unknown_function", `unknown function ${name}`);
      state.nodes += 1;
      children.push(...node.args!);
      break;
    }
    default:
      fail("forbidden_node", `${node.type} is not allowed`);
  }
  for (const child of children) walk(child, names, state);
}

/**
 * Refuses a name the expression reads that is not in `known`, and a random
 * function where none is allowed (the condition and the texts).
 */
export function checkNames(compiled: Compiled, known: ReadonlySet<string>, allowRandom: boolean): void {
  if (compiled.random && !allowRandom) {
    fail("unknown_function", "randint, uniform and choice are allowed in a variable row only");
  }
  for (const name of compiled.names) {
    if (!known.has(name)) fail("unknown_name", `unknown name ${name}`);
  }
}

/** Evaluates a compiled expression; any throw becomes an `eval_error`. */
export function run(compiled: Compiled, scope: Map<string, unknown>): unknown {
  try {
    return compiled.evaluate(scope);
  } catch (e) {
    return fail("eval_error", (e as Error).message);
  }
}

/** A value a variable may hold: a finite number or a string. */
export function checkValue(value: unknown): number | string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail("not_a_number", `result is ${describe(value)}, not a finite number`);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return String(value);
  return `a ${typeof value}`;
}

/** `randint`, `uniform` and `choice`, bound to one generator. */
export function randomScope(next: () => number): [string, unknown][] {
  const finite = (name: string, ...xs: unknown[]): number[] =>
    xs.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : fail("eval_error", `${name}: arguments must be numbers`)));
  return [
    [
      "randint",
      (a: unknown, b: unknown): number => {
        const [x, y] = finite("randint", a, b) as [number, number];
        const lo = Math.ceil(x);
        const hi = Math.floor(y);
        if (lo > hi) fail("eval_error", "randint: empty range");
        return lo + Math.floor(next() * (hi - lo + 1));
      },
    ],
    [
      "uniform",
      (a: unknown, b: unknown): number => {
        const [x, y] = finite("uniform", a, b) as [number, number];
        return x + next() * (y - x);
      },
    ],
    [
      "choice",
      (list: unknown): unknown => {
        if (!Array.isArray(list) || list.length === 0) fail("eval_error", "choice: expects a non-empty list [...]");
        return list[Math.floor(next() * list.length)];
      },
    ],
  ];
}
