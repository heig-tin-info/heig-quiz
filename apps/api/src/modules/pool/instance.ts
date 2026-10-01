/**
 * Parameterized questions on the server (ADR-056): the ONE place a version's
 * variables are drawn, stored values are read back, and a template becomes
 * the static version every type hook expects.
 *
 * The choke point is made unavoidable by `loadConfig` (`config.ts`): it
 * demands the `variables` column with the config and THROWS on a template
 * (`TemplateRead`). A reader therefore cannot hand a parameterized version
 * to `studentView`, a grader or a solution view by mistake: it asks
 * {@link instanceOf} for an instance, whose `version` is an ordinary static
 * row (`variables: null`), and passes that along. A static version goes
 * through untouched and is never scanned for `[[` (§3), so it pays nothing.
 *
 * Values are drawn ONCE per attempt and item, when the attempt is created,
 * and stored (`attempts.instances`, §5): {@link drawInstance}. Every later
 * read passes the stored values to {@link instanceOf}. Only a reader with
 * nothing stored — the stateless preview (ADR-018), the pool's try — draws
 * them again from the same seed, which gives the same numbers.
 *
 * Template-level readers (a question's points, whether it holds a key, the
 * debrief's projected key) read {@link exampleInstance}: the instance of seed
 * 0, which publication checked against the type's gate. A raw template need
 * not satisfy the type's schema — a cloze `{{#[[t]]:1%}}` is not a number
 * blank until it is instantiated — so nothing parses one.
 *
 * `@quiz/domain/parameters` pulls mathjs: this file is server-only, like the
 * whole API.
 */
import { createHash } from "node:crypto";

import { issuesOf, type ParametersDraft, type ZodIssueLite } from "@quiz/contracts";
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { streamSeed } from "@quiz/core/rng";
import {
  distinctRendered,
  draw,
  instantiate,
  ParameterError,
  replay,
  sameNames,
  validateParameters,
  type Issue,
  type Parameters,
  type Values,
} from "@quiz/domain/parameters";

import type { StoredInstance } from "../../db/columns.js";
import { loadConfig, migrated, NotPublishable, publishConfig, raise, saveConfig, typeOf, type VersionRow } from "./config.js";

/** The types whose texts may interpolate variables in v1 (ADR-056 §10). */
export const PARAMETERIZED_TYPES: ReadonlySet<string> = new Set(["mcq", "short", "cloze"]);

/** The columns of a question version an instance is made of. */
export interface VersionContent {
  /** `question_versions.id`: which version stored values were drawn for. */
  id: string;
  config: unknown;
  configVersion: number;
  explanation: string;
  variables: ParametersDraft | null;
}

/** A version every reader may use as it is: `variables` is null. */
export interface StaticVersion extends VersionRow {
  variables: null;
}

export interface Instance {
  /** The static version: hand THIS to `studentView`, `loadConfig`, a grader. */
  version: StaticVersion;
  /** The explanation, instantiated like the config. */
  explanation: string;
  /** The values it was rendered with; null for a static question. */
  values: Values | null;
  /** Set when the draw that served it did not go to plan (§7), for the grading details. */
  fallback?: StoredInstance["fallback"];
}

/** Thrown when stored values cannot be read under a version that declares other names (§5). */
export class InstanceMismatch extends Error {
  constructor() {
    super("the stored values do not fit this version's variables");
    this.name = "InstanceMismatch";
  }
}

/** The table, in the domain's shape; null for a static version (no row). */
export function parametersOf(version: { variables: ParametersDraft | null }): Parameters | null {
  const table = version.variables;
  if (table === null || table.rows.length === 0) return null;
  const rows = table.rows.map(({ name, expr, format }) => ({ name, expr, format }));
  return table.condition === undefined || table.condition.trim() === ""
    ? { rows }
    : { rows, condition: table.condition };
}

/** Whether a version declares variables: the meaning of `questions.randomizable` (§1). */
export const isParameterized = (version: { variables: ParametersDraft | null }): boolean =>
  parametersOf(version) !== null;

/** The variable names two versions declare are the same (a regrade's condition, §5). */
export function sameVariables(a: { variables: ParametersDraft | null }, b: { variables: ParametersDraft | null }): boolean {
  const names = (v: { variables: ParametersDraft | null }) => (parametersOf(v)?.rows ?? []).map((r) => r.name).sort();
  return JSON.stringify(names(a)) === JSON.stringify(names(b));
}

const staticOf = (version: VersionRow): StaticVersion => ({
  config: version.config,
  configVersion: version.configVersion,
  variables: null,
});

/** mcq's distinct choices (§7), when the type has such a rule. */
function acceptOf(t: AnyQuestionTypeServer, template: unknown, params: Parameters) {
  const texts = t.distinctTexts;
  if (texts === undefined) return {};
  return { accept: (values: Values) => distinctRendered(texts(instantiate(template, params, values))) };
}

/** The template rendered with `values`, stamped at the type's current shape. */
function render(type: string, version: VersionContent, params: Parameters, values: Values, extra: Partial<Instance> = {}): Instance {
  const t = typeOf(type);
  return {
    version: {
      config: instantiate(migrated(t, version), params, values),
      configVersion: t.configVersion,
      variables: null,
    },
    explanation: instantiate(version.explanation, params, values),
    values,
    ...extra,
  };
}

/** Parses an instance with the type's schema: throws when it is unusable. */
function checked(type: string, instance: Instance): Instance {
  const t = typeOf(type);
  (t.keylessConfigSchema ?? t.configSchema).parse(instance.version.config);
  return instance;
}

/**
 * Draws the values of one item of one attempt (or of one drill review), from
 * `streamSeed(seed, itemId, "vars")`, and checks that they render to a usable
 * configuration. Exhausting the condition keeps the last run (§7); a draw
 * that fails falls back on seed 0's, which publication validated. Either is
 * flagged for the grading details; the student never sees an error.
 * Null for a static version: nothing to store.
 */
export function drawInstance(type: string, version: VersionContent, seed: number, itemId: string): StoredInstance | null {
  return drawn(type, version, seed, itemId)?.stored ?? null;
}

function drawn(
  type: string,
  version: VersionContent,
  seed: number,
  itemId: string,
): { stored: StoredInstance; instance: Instance } | null {
  const params = parametersOf(version);
  if (params === null) return null;
  const t = typeOf(type);
  const options = acceptOf(t, migrated(t, version), params);
  const attempt = (s: number, failed: boolean) => {
    const result = draw(params, s, options);
    const fallback = failed ? "failed" : result.exhausted ? "exhausted" : undefined;
    const stored: StoredInstance = { versionId: version.id, values: result.values, ...(fallback ? { fallback } : {}) };
    return { stored, instance: checked(type, render(type, version, params, result.values, fallback ? { fallback } : {})) };
  };
  try {
    return attempt(streamSeed(seed, itemId, "vars"), false);
  } catch (error) {
    if (!(error instanceof ParameterError) && !isZodError(error)) throw error;
    return attempt(0, true);
  }
}

const isZodError = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "ZodError";

/** The values to render a version with, from values stored under it or under another one (§5). */
function valuesFor(params: Parameters, versionId: string, stored: StoredInstance): Values {
  if (stored.versionId === versionId) return stored.values;
  if (!sameNames(params, stored.values)) throw new InstanceMismatch();
  return replay(params, stored.values);
}

/**
 * THE instantiation: the version a reader of one attempt's item (or one
 * drill review) uses. Static → the version itself. Parameterized → the
 * template rendered with the `stored` values (replayed when they were drawn
 * for another version with the same names, §5), or with values drawn from
 * the seed when nothing is stored.
 */
export function instanceOf(
  type: string,
  version: VersionContent,
  at: { seed: number; itemId: string; stored?: StoredInstance | null | undefined },
): Instance {
  const params = parametersOf(version);
  if (params === null) return { version: staticOf(version), explanation: version.explanation, values: null };
  if (!at.stored) return drawn(type, version, at.seed, at.itemId)!.instance;
  const fallback = at.stored.fallback;
  return render(type, version, params, valuesFor(params, version.id, at.stored), fallback ? { fallback } : {});
}

/** The item id of {@link exampleInstance}: the stream of a version, not of any attempt. */
const EXAMPLE_ITEM = "example";

/**
 * The instance of seed 0, for a reader with no attempt behind it that needs
 * the question's STRUCTURE (its points, its key, its kind of blanks) or a
 * stable rendering (the debrief, a poll). Publication checked it.
 */
export function exampleInstance(type: string, version: VersionContent): Instance {
  return instanceOf(type, version, { seed: 0, itemId: EXAMPLE_ITEM });
}

/**
 * The parsed config a reader of a question's STRUCTURE uses — its points, its
 * key, whether it can be drilled: the version itself when static, its
 * {@link exampleInstance} when parameterized. Throws like `loadConfig`.
 */
export function exampleConfig(type: string, version: VersionContent): unknown {
  return loadConfig(type, isParameterized(version) ? exampleInstance(type, version).version : version);
}

/** What {@link itemInstance} reads of an evaluation item. */
export interface InstanceItem {
  item: { id: string };
  question: { type: string };
  version: VersionContent;
}

/** What {@link itemInstance} reads of an attempt: its seed and its stored values. */
export interface InstanceAttempt {
  seed: number;
  instances: Readonly<Record<string, StoredInstance>>;
}

/** {@link instanceOf} for one item of one attempt, with the values the attempt stored. */
export function itemInstance(entry: InstanceItem, attempt: InstanceAttempt): Instance {
  return instanceOf(entry.question.type, entry.version, {
    seed: attempt.seed,
    itemId: entry.item.id,
    stored: attempt.instances[entry.item.id],
  });
}

/**
 * The parsed config of one item, per attempt: parsed ONCE for a static
 * question — the readers that walk a whole column (the live grid, the
 * grading pass) keep that cost — and per attempt for a parameterized one,
 * whose every attempt has its own key. Throws like `loadConfig`.
 */
export function configPerAttempt(entry: InstanceItem): (attempt: InstanceAttempt) => unknown {
  if (!isParameterized(entry.version)) {
    const config = loadConfig(entry.question.type, entry.version);
    return () => config;
  }
  return (attempt) => loadConfig(entry.question.type, itemInstance(entry, attempt).version);
}

/**
 * The identity of a parameterized TEMPLATE, for a key that must not move
 * with each instance (the drill's `keyHashOf`, ADR-056 §5): the migrated
 * config, the explanation-free table. A new draw never changes it; an edit of
 * a formula does.
 */
export function templateHash(type: string, version: VersionContent): string {
  const t = typeOf(type);
  const body = JSON.stringify({ config: migrated(t, version), variables: parametersOf(version) });
  return createHash("sha256").update(body).digest("hex");
}

// --- Publication -----------------------------------------------------------

/** Seeds whose instances publication puts through the type's own gate. */
const GATE_SEEDS = [0, 1, 2, 3, 4];

/** A domain issue in the editor's shape: a translatable key, a path into the draft. */
function issueOf(issue: Issue): ZodIssueLite {
  const path =
    issue.row !== undefined
      ? ["variables", issue.row]
      : (issue.path ?? "").split("/").filter(Boolean).filter((part, i) => !(i === 0 && part === "config"));
  return { path, code: "custom", message: `parameters.${issue.code}` };
}

const parameterIssue = (path: string[], message: string): ZodIssueLite => ({ path, code: "custom", message });

/**
 * Everything publication requires of a parameterized draft (ADR-056 §3, §7,
 * §10), as the editor's issues; empty for a static one (its config goes
 * through `publishConfig` as before). In order, stopping at the first
 * family that fails: a type that takes variables; the type's own rule on
 * the template (`parameterIssues`); the table and every `[[…]]` of the
 * config and the explanation, over 200 draws (`validateParameters`); then
 * the instances of a few seeds through the type's publication gate.
 */
export function parameterIssues(
  type: string,
  draft: { config: unknown; configVersion: number; explanation: string; variables: ParametersDraft | null },
): ZodIssueLite[] {
  const params = parametersOf(draft);
  if (params === null) return [];
  if (!PARAMETERIZED_TYPES.has(type)) return [parameterIssue(["variables"], "parameters.unsupported_type")];
  const t = typeOf(type);
  const template = raise(t, draft.config, draft.configVersion);
  const own = (t.parameterIssues?.(template) ?? []).map((i) => parameterIssue(i.path.map(String), i.message));
  if (own.length > 0) return own;
  const options = acceptOf(t, template, params);
  const issues = validateParameters(params, { config: template, explanation: draft.explanation }, options);
  if (issues.length > 0) return issues.map(issueOf);
  for (const seed of GATE_SEEDS) {
    try {
      publishConfig(type, instantiate(template, params, draw(params, seed, options).values));
    } catch (error) {
      if (error instanceof NotPublishable) return error.issues;
      if (error instanceof ParameterError) return [issueOf(error.issue)];
      return issuesOf(error);
    }
  }
  return [];
}

/**
 * The configuration a parameterized version is STORED with: the template,
 * normalized by the type's schema when it parses (an mcq, a short), as
 * raised to the current shape otherwise (a cloze whose number blank holds a
 * `[[…]]`). Its instances are what the gates check, never this.
 */
export function storedTemplate(type: string, draft: { config: unknown; configVersion: number }): {
  config: unknown;
  configVersion: number;
} {
  const t = typeOf(type);
  try {
    return saveConfig(type, raise(t, draft.config, draft.configVersion));
  } catch {
    return { config: raise(t, draft.config, draft.configVersion), configVersion: t.configVersion };
  }
}
