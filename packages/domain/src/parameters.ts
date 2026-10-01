/**
 * Parameterized questions: variables drawn per attempt (ADR-056, docs/04 §4.3).
 *
 * A question version may declare an ordered table of variables,
 * `{ name, expr, format }`, and an optional `condition`:
 *
 *     h = randint(1, 100)                     int
 *     g = choice([3.71, 8.87, 9.81, 24.79])   .2
 *     t = sqrt(2*h/g)                         .2
 *     condition: t > 1
 *
 * This module holds the pure rules: the restricted evaluator
 * (`./parameters/evaluator.ts`), the formats (`./parameters/format.ts`), the
 * `[[expr]]` interpolation (`./parameters/text.ts`), and here the draw, the
 * validation that publication runs and the distinct-choices rule of `mcq`.
 *
 * NOT re-exported from the package's index: it pulls mathjs, which the web
 * bundle must never carry (the editor's preview is computed by the API, ADR-056
 * §8). The server imports `@quiz/domain/parameters`.
 */
import { hashSeed, rng } from "@quiz/core/rng";

import {
  checkNames,
  checkValue,
  compile,
  isVariableName,
  ParameterError,
  randomScope,
  run,
  type Compiled,
  type Issue,
} from "./parameters/evaluator.js";
import { isFormat, roundToFormat } from "./parameters/format.js";
import { checkReference, instantiate, mapStrings, references, type Values } from "./parameters/text.js";

export {
  isVariableName,
  MAX_EXPRESSION_LENGTH,
  MAX_EXPRESSION_NODES,
  ParameterError,
  type Issue,
  type IssueCode,
} from "./parameters/evaluator.js";
export { FORMAT_PATTERN, formatValue, isFormat, roundToFormat } from "./parameters/format.js";
export { instantiate, interpolate, references, type Reference, type Values } from "./parameters/text.js";

export interface VariableRow {
  name: string;
  expr: string;
  /** `""`, `int`, `.1`–`.6` or `1s`–`6s` (`./parameters/format.ts`). */
  format: string;
}

export interface Parameters {
  rows: VariableRow[];
  /** A boolean expression over every row; a draw where it is false is drawn again. */
  condition?: string;
}

/** The draw's retry cap (ADR-056 §7). */
export const MAX_RUNS = 100;

/** The formats by variable name, for `interpolate` and `instantiate`. */
export function formatsOf(params: Parameters): Record<string, string> {
  return Object.fromEntries(params.rows.map((r) => [r.name, r.format]));
}

interface Plan {
  rows: { row: VariableRow; compiled: Compiled }[];
  condition: Compiled | null;
}

/** Every static issue of the table: names, formats, expressions, scopes. */
function checkTable(params: Parameters): { plan: Plan; issues: Issue[] } {
  const issues: Issue[] = [];
  const plan: Plan = { rows: [], condition: null };
  const seen = new Set<string>();
  for (const row of params.rows) {
    if (!isVariableName(row.name)) {
      issues.push({ code: "bad_name", message: `"${row.name}" is not a free identifier`, row: row.name });
    } else if (seen.has(row.name)) {
      issues.push({ code: "duplicate_name", message: `${row.name} is declared twice`, row: row.name });
    }
    if (!isFormat(row.format)) {
      issues.push({ code: "bad_format", message: `unknown format "${row.format}"`, row: row.name });
    }
    try {
      const compiled = compile(row.expr);
      // A row reads only the rows above it.
      checkNames(compiled, seen, true);
      plan.rows.push({ row, compiled });
    } catch (e) {
      issues.push({ ...(e as ParameterError).issue, row: row.name });
    }
    seen.add(row.name);
  }
  if (params.condition !== undefined && params.condition.trim() !== "") {
    try {
      plan.condition = compile(params.condition);
      checkNames(plan.condition, seen, false);
    } catch (e) {
      issues.push({ ...(e as ParameterError).issue, row: "condition" });
    }
  }
  return { plan, issues };
}

function evaluateOnce(plan: Plan, next: () => number): { values: Values; holds: boolean } {
  const scope = new Map<string, unknown>(randomScope(next));
  const values: Values = {};
  for (const { row, compiled } of plan.rows) {
    let value: number | string;
    try {
      value = checkValue(run(compiled, scope));
      if (typeof value === "string" && row.format !== "") {
        throw new ParameterError({ code: "bad_format", message: "a text value takes no format" });
      }
    } catch (e) {
      throw new ParameterError({ ...(e as ParameterError).issue, row: row.name });
    }
    // A variable IS its formatted value (ADR-056 §6): later rows read it rounded.
    if (typeof value === "number") value = roundToFormat(value, row.format);
    scope.set(row.name, value);
    values[row.name] = value;
  }
  if (plan.condition === null) return { values, holds: true };
  let holds: unknown;
  try {
    holds = run(plan.condition, scope);
  } catch (e) {
    throw new ParameterError({ ...(e as ParameterError).issue, row: "condition" });
  }
  if (typeof holds !== "boolean") {
    throw new ParameterError({ code: "not_a_boolean", message: "the condition is not true or false", row: "condition" });
  }
  return { values, holds };
}

export interface DrawOptions {
  /** A further condition on the values (mcq's distinct choices, ADR-056 §7). */
  accept?: (values: Values) => boolean;
  maxRuns?: number;
}

export interface Draw {
  values: Values;
  /** How many runs it took (1 when the first draw held). */
  runs: number;
  /** True when no run satisfied the condition: `values` is the last run's. */
  exhausted: boolean;
}

/**
 * Draws the values of a table. Rows are evaluated in order, each rounded by
 * its format before the next reads it. Run `k` draws from
 * `rng(hashSeed(seed, "run", k))`; a run the condition or `accept` rejects is
 * drawn again, up to `maxRuns`. Exhaustion never throws (ADR-056 §7): the
 * last run comes back with `exhausted: true`, and the caller records a
 * warning. A static issue or an evaluation failure throws a `ParameterError`
 * — publication's 200 draws exist so that this does not happen when serving.
 *
 * The caller passes `streamSeed(attempt.seed, item.id, "vars")`.
 */
export function draw(params: Parameters, seed: number, opts: DrawOptions = {}): Draw {
  const { plan, issues } = checkTable(params);
  if (issues.length > 0) throw new ParameterError(issues[0]!);
  const maxRuns = Math.max(1, opts.maxRuns ?? MAX_RUNS);
  let last: Values = {};
  for (let k = 0; k < maxRuns; k++) {
    const { values, holds } = evaluateOnce(plan, rng(hashSeed(seed, "run", k)));
    if (holds && (opts.accept === undefined || opts.accept(values))) {
      return { values, runs: k + 1, exhausted: false };
    }
    last = values;
  }
  return { values: last, runs: maxRuns, exhausted: true };
}

export interface ValidateOptions extends DrawOptions {
  /** Seeds 0 … samples-1 are drawn (ADR-056 §7: 200). */
  samples?: number;
  /** Wall-clock budget of the whole sampling, in milliseconds. */
  budgetMs?: number;
  /** Injected for tests; defaults to `performance.now`. */
  clock?: () => number;
}

/** Sampling budget of a validation: 200 draws of one-line expressions are far below it. */
export const VALIDATION_BUDGET_MS = 2000;

/**
 * What publication runs (ADR-056 §7). Returns every static issue — of each
 * row, of the condition, and of each `[[…]]` found in any string of
 * `content` (the configuration and the explanation, or an array of texts).
 * When there is none, draws seeds 0 … samples-1, instantiating `content`
 * with each, and stops at the first failure: an evaluation error, an
 * exhausted condition, or the budget spent.
 */
export function validateParameters(params: Parameters, content: unknown, opts: ValidateOptions = {}): Issue[] {
  const { issues } = checkTable(params);
  const known = new Set(params.rows.map((r) => r.name));
  mapStrings(content, (text, path) => {
    for (const ref of references(text)) {
      try {
        checkReference(ref, known);
      } catch (e) {
        issues.push({ ...(e as ParameterError).issue, path });
      }
    }
    return text;
  });
  if (issues.length > 0) return issues;

  const samples = opts.samples ?? 200;
  const budget = opts.budgetMs ?? VALIDATION_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());
  const formats = formatsOf(params);
  const start = clock();
  for (let seed = 0; seed < samples; seed++) {
    try {
      const result = draw(params, seed, opts);
      if (result.exhausted) {
        return [{ code: "condition_exhausted", message: `seed ${seed}: no draw in ${result.runs} satisfies the condition`, row: "condition" }];
      }
      instantiate(content, result.values, formats);
    } catch (e) {
      const issue = (e as ParameterError).issue;
      return [{ ...issue, message: `seed ${seed}: ${issue.message}` }];
    }
    if (clock() - start > budget) {
      return [{ code: "too_slow", message: `${seed + 1} draws took more than ${budget} ms` }];
    }
  }
  return [];
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;

/**
 * mcq's distinct-choices rule (ADR-056 §7): false when two rendered texts are
 * equal (after trimming), or are both plain numbers within `relGap` of each
 * other, relative to the larger magnitude. Passed to `draw` as `accept`.
 */
export function distinctRendered(texts: string[], relGap = 0.01): boolean {
  const trimmed = texts.map((t) => t.trim());
  for (let i = 0; i < trimmed.length; i++) {
    for (let j = i + 1; j < trimmed.length; j++) {
      const a = trimmed[i]!;
      const b = trimmed[j]!;
      if (a === b) return false;
      if (NUMBER.test(a) && NUMBER.test(b)) {
        const x = Number(a);
        const y = Number(b);
        if (Math.abs(x - y) <= relGap * Math.max(Math.abs(x), Math.abs(y))) return false;
      }
    }
  }
  return true;
}
