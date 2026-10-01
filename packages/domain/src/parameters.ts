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
 * This file is the module's ONLY entry point: the draw, the instantiation of
 * a version's texts, the validation publication runs and mcq's
 * distinct-choices rule. `./parameters/*` (the restricted evaluator, the
 * formats, the `[[expr]]` templates) is internal. The mathjs-free vocabulary
 * (names, formats, caps) lives in `./parameterNames.ts`.
 *
 * NOT re-exported from the package's index: it pulls mathjs, which the web
 * bundle must never carry (the editor's preview is computed by the API, ADR-056
 * §8). The server imports `@quiz/domain/parameters`.
 */
import { hashSeed, rng } from "@quiz/core/rng";

import { FORMAT_PATTERN, isVariableName } from "./parameterNames.js";
import {
  at,
  checkNames,
  checkValue,
  collect,
  compile,
  fail,
  ParameterError,
  randomScope,
  run,
  type Compiled,
  type Issue,
} from "./parameters/evaluator.js";
import { roundToFormat } from "./parameters/format.js";
import { compileTemplate, type Values } from "./parameters/text.js";

export { FORMAT_PATTERN, isVariableName, MAX_EXPRESSION_LENGTH } from "./parameterNames.js";
export { ParameterError, type Issue, type IssueCode } from "./parameters/evaluator.js";
export { formatValue } from "./parameters/format.js";
export type { Values } from "./parameters/text.js";

export interface VariableRow {
  name: string;
  expr: string;
  /** `""`, `int`, `.1`–`.6` or `1s`–`6s` (`FORMAT_PATTERN`). */
  format: string;
}

export interface Parameters {
  rows: VariableRow[];
  /** A boolean expression over every row; a draw where it is false is drawn again. */
  condition?: string;
}

/** The draw's retry cap (ADR-056 §7). */
const MAX_RUNS = 100;
/** Seeds drawn by a validation (ADR-056 §7). */
const SAMPLES = 200;
/** Wall-clock budget of a validation's sampling: 200 draws of one-liners are far below it. */
const BUDGET_MS = 2000;
/** mcq: two numeric choices closer than this, relatively, are not distinct (ADR-056 §7). */
const RELATIVE_GAP = 0.01;

interface Plan {
  rows: { row: VariableRow; compiled: Compiled }[];
  condition: Compiled | null;
}

const formatsOf = (params: Parameters) => Object.fromEntries(params.rows.map((r) => [r.name, r.format]));

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
    if (!FORMAT_PATTERN.test(row.format)) {
      issues.push({ code: "bad_format", message: `unknown format "${row.format}"`, row: row.name });
    }
    const compiled = collect(issues, { row: row.name }, () => {
      const c = compile(row.expr);
      checkNames(c, seen, true); // a row reads only the rows above it
      return c;
    });
    if (compiled) plan.rows.push({ row, compiled });
    seen.add(row.name);
  }
  if (params.condition !== undefined && params.condition.trim() !== "") {
    const condition = params.condition;
    plan.condition =
      collect(issues, { row: "condition" }, () => {
        const c = compile(condition);
        checkNames(c, seen, false);
        return c;
      }) ?? null;
  }
  return { plan, issues };
}

function checkedPlan(params: Parameters): Plan {
  const { plan, issues } = checkTable(params);
  if (issues.length > 0) throw new ParameterError(issues[0]!);
  return plan;
}

/** One run: the values, and whether the condition holds on them. */
function evaluateOnce(plan: Plan, next: () => number): { values: Values; holds: boolean } {
  const scope = new Map<string, unknown>(randomScope(next));
  for (const { row, compiled } of plan.rows) {
    const value = at({ row: row.name }, () => {
      const v = checkValue(run(compiled, scope));
      if (typeof v === "string" && row.format !== "") fail("bad_format", "a text value takes no format");
      // A variable IS its formatted value (ADR-056 §6): later rows read it rounded.
      return typeof v === "number" ? roundToFormat(v, row.format) : v;
    });
    scope.set(row.name, value);
  }
  // `fromEntries`, not assignment: no name can be lost to a prototype setter.
  const values: Values = Object.fromEntries(plan.rows.map(({ row }) => [row.name, scope.get(row.name) as number | string]));
  if (plan.condition === null) return { values, holds: true };
  const holds = at({ row: "condition" }, () => run(plan.condition!, scope));
  if (typeof holds !== "boolean") {
    fail("not_a_boolean", "the condition is not true or false", { row: "condition" });
  }
  return { values, holds };
}

interface PlanDraw extends Draw {
  /** When exhausted: whether some run met the condition, so `accept` was the obstacle. */
  conditionMet: boolean;
}

function drawPlan(plan: Plan, seed: number, accept?: (values: Values) => boolean): PlanDraw {
  let last: Values = {};
  let conditionMet = false;
  for (let k = 0; k < MAX_RUNS; k++) {
    const { values, holds } = evaluateOnce(plan, rng(hashSeed(seed, "run", k)));
    if (holds && (accept === undefined || accept(values))) {
      return { values, runs: k + 1, exhausted: false, conditionMet: true };
    }
    conditionMet ||= holds;
    last = values;
  }
  return { values: last, runs: MAX_RUNS, exhausted: true, conditionMet };
}

export interface DrawOptions {
  /** A further condition on the values (mcq's distinct choices, ADR-056 §7). */
  accept?: (values: Values) => boolean;
}

export interface Draw {
  values: Values;
  /** How many runs it took (1 when the first draw held). */
  runs: number;
  /** True when no run satisfied the condition and `accept`: `values` is the last run's. */
  exhausted: boolean;
}

/**
 * Draws the values of a table. Rows are evaluated in order, each rounded by
 * its format before the next reads it. Run `k` draws from
 * `rng(hashSeed(seed, "run", k))`; a run the condition or `accept` rejects is
 * drawn again, up to 100 runs. Exhaustion never throws (ADR-056 §7): the
 * last run comes back with `exhausted: true`, and the caller records a
 * warning. A static issue or an evaluation failure throws a `ParameterError`
 * — publication's 200 draws exist so that this does not happen when serving.
 *
 * The caller passes `streamSeed(attempt.seed, item.id, "vars")`.
 */
export function draw(params: Parameters, seed: number, opts: DrawOptions = {}): Draw {
  const { values, runs, exhausted } = drawPlan(checkedPlan(params), seed, opts.accept);
  return { values, runs, exhausted };
}

/**
 * Replaces every `[[expr]]` in every string of `json` (a configuration, an
 * explanation) with its value; a bare `[[g]]` is written with `g`'s format.
 * Returns a new value, the input untouched. Throws a `ParameterError` with
 * the path and the offset of the first bad `[[…]]`.
 */
export function instantiate<T>(json: T, params: Parameters, values: Values): T {
  const template = compileTemplate(json, formatsOf(params));
  if (template.issues.length > 0) throw new ParameterError(template.issues[0]!);
  return template.render(values);
}

export interface ValidateOptions extends DrawOptions {
  /** Injected for tests; defaults to `performance.now`. */
  clock?: () => number;
}

/**
 * What publication runs (ADR-056 §7). Returns every static issue — of each
 * row, of the condition, and of each `[[…]]` found in any string of
 * `content` (the configuration and the explanation, or an array of texts).
 * When there is none, draws seeds 0 … 199, rendering `content` with each,
 * and stops at the first failure: an evaluation error, an exhausted
 * condition, choices `accept` never found distinct, or 2 s spent.
 */
export function validateParameters(params: Parameters, content: unknown, opts: ValidateOptions = {}): Issue[] {
  const { plan, issues } = checkTable(params);
  const template = compileTemplate(content, formatsOf(params));
  issues.push(...template.issues);
  if (issues.length > 0) return issues;

  const clock = opts.clock ?? (() => performance.now());
  const start = clock();
  for (let seed = 0; seed < SAMPLES; seed++) {
    try {
      const result = drawPlan(plan, seed, opts.accept);
      if (result.exhausted && result.conditionMet) {
        return [{ code: "choices_not_distinct", message: `seed ${seed}: no draw in ${result.runs} gives distinct choices` }];
      }
      if (result.exhausted) {
        return [{ code: "condition_exhausted", message: `seed ${seed}: no draw in ${result.runs} satisfies the condition`, row: "condition" }];
      }
      template.render(result.values);
    } catch (e) {
      if (!(e instanceof ParameterError)) throw e;
      return [{ ...e.issue, message: `seed ${seed}: ${e.issue.message}` }];
    }
    if (clock() - start > BUDGET_MS) {
      return [{ code: "too_slow", message: `${seed + 1} draws took more than ${BUDGET_MS} ms` }];
    }
  }
  return [];
}

/** A plain decimal number, matched in linear time (no nested quantifiers over digits). */
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i;
/** Longer texts are compared as text only: a choice is never a 40-digit number. */
const MAX_NUMERIC_LENGTH = 40;

const asNumber = (text: string): number | null =>
  text.length <= MAX_NUMERIC_LENGTH && NUMBER.test(text) ? Number(text) : null;

/**
 * mcq's distinct-choices rule (ADR-056 §7): false when two rendered texts are
 * equal (after trimming), or are both plain numbers within 1 % of each other,
 * relative to the larger magnitude. Passed to `draw` as `accept`.
 */
export function distinctRendered(texts: string[]): boolean {
  const trimmed = texts.map((t) => t.trim());
  const numbers = trimmed.map(asNumber);
  for (let i = 0; i < trimmed.length; i++) {
    for (let j = i + 1; j < trimmed.length; j++) {
      if (trimmed[i] === trimmed[j]) return false;
      const x = numbers[i];
      const y = numbers[j];
      if (x != null && y != null && Math.abs(x - y) <= RELATIVE_GAP * Math.max(Math.abs(x), Math.abs(y))) return false;
    }
  }
  return true;
}
