/**
 * Parameterized questions on the server (ADR-056): the ONE place a version's
 * variables are drawn, stored values are read back, and a template becomes
 * the static version every type hook expects.
 *
 * The choke point is made unavoidable in two layers. At compile time, the
 * student exits (`live/studentView.ts`) take a `StaticVersion`
 * (`variables: null`), which a stored row is not. At run time, `loadConfig`
 * and `tryLoadConfig` (`config.ts`) demand the `variables` column and THROW
 * on a template (`TemplateRead`). A reader asks {@link instanceOf} for an
 * instance, whose `version` is a `StaticVersion`, and passes that along. The
 * raw template is read on purpose only: here, through `templateOf`, and by
 * `tryLoadConfig(…, { template: true })` (the draft handed to the editor,
 * the distractor statistics). A static version goes through untouched and is
 * never scanned for `[[` (§3), so it pays nothing.
 *
 * Values are drawn ONCE per attempt and item, when the attempt is created,
 * and stored (`attempts.instances`, §5): the `stored` of an
 * {@link instanceOf} without stored values. Every later read passes the
 * stored values back. Only a reader with nothing stored — the stateless
 * preview (ADR-018), the pool's try — draws them again from the same seed,
 * which gives the same numbers.
 *
 * Readers of a question's STRUCTURE (its points, whether it holds a key, the
 * debrief's projected key) read {@link exampleInstance}: `draw(params, 0)`,
 * the very draw publication put through the type's gate. A raw template need
 * not satisfy the type's schema — a cloze `{{#[[t]]:1%}}` is not a number
 * blank until it is instantiated — so nothing parses one as a config.
 *
 * `@quiz/domain/parameters` pulls mathjs: this file is server-only, like the
 * whole API.
 */
import { createHash } from "node:crypto";

import { issuesOf, type ParametersDraft, type ZodIssueLite } from "@quiz/contracts";
import type { AnyQuestionTypeServer } from "@quiz/core/server";
import { streamSeed } from "@quiz/core/rng";
import { PARAMETERIZED_TYPES } from "@quiz/domain";
import {
  distinctRendered,
  draw,
  formattedValues,
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
import {
  declaredVersion,
  isParameterized,
  loadConfig,
  NotPublishable,
  publishConfig,
  raise,
  saveConfig,
  templateOf,
  tryLoadConfig,
  typeOf,
  type StaticVersion,
  type StoredVersion,
} from "./config.js";

/** The columns of a question version an instance is made of. */
export interface VersionContent extends StoredVersion {
  /** `question_versions.id`: which version stored values were drawn for. */
  id: string;
  explanation: string;
  variables: ParametersDraft | null;
}

export interface Instance {
  /** The static version: hand THIS to `studentView`, `loadConfig`, a grader. */
  version: StaticVersion;
  /** The explanation, instantiated like the config. */
  explanation: string;
  /** The values it was rendered with; null for a static question. */
  values: Values | null;
  /**
   * What to store of it: its values under THIS version (replayed ones under
   * the version they were replayed for), and the fallback of a draw that
   * did not go to plan (§7). Null for a static question.
   */
  stored: StoredInstance | null;
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
  if (table === null || !isParameterized(version)) return null;
  const rows = table.rows.map(({ name, expr, format }) => ({ name, expr, format }));
  return table.condition === undefined || table.condition.trim() === ""
    ? { rows }
    : { rows, condition: table.condition };
}

/** mcq's distinct choices (§7), when the type has such a rule. */
function acceptOf(t: AnyQuestionTypeServer, template: unknown, params: Parameters) {
  const texts = t.distinctTexts;
  if (texts === undefined) return {};
  return { accept: (values: Values) => distinctRendered(texts(instantiate(template, params, values))) };
}

/** The template rendered with `values`, stamped at the type's current shape. */
function render(type: string, version: VersionContent, params: Parameters, stored: StoredInstance, values: Values): Instance {
  return {
    version: {
      config: instantiate(templateOf(type, version), params, values),
      configVersion: typeOf(type).configVersion,
      variables: null,
    },
    explanation: instantiate(version.explanation, params, values),
    values,
    stored,
  };
}

/** Parses an instance with the type's schema: throws when it is unusable. */
function checked(type: string, instance: Instance): Instance {
  const t = typeOf(type);
  (t.keylessConfigSchema ?? t.configSchema).parse(instance.version.config);
  return instance;
}

const isZodError = (error: unknown): boolean => (error as { name?: unknown } | null)?.name === "ZodError";

/**
 * A fresh instance, from `streamSeed(seed, itemId, "vars")`, checked to
 * render a usable configuration. Exhausting the condition keeps the last run
 * (§7); a draw that fails falls back on `draw(params, 0)`, which publication
 * validated. Either is flagged in `stored.fallback`; the student never sees
 * an error.
 */
function drawn(type: string, version: VersionContent, params: Parameters, seed: number, itemId: string): Instance {
  const options = acceptOf(typeOf(type), templateOf(type, version), params);
  const from = (s: number, failed: boolean) => {
    const result = draw(params, s, options);
    const fallback = failed ? "failed" : result.exhausted ? "exhausted" : undefined;
    const stored: StoredInstance = { versionId: version.id, values: result.values, ...(fallback ? { fallback } : {}) };
    return checked(type, render(type, version, params, stored, result.values));
  };
  try {
    return from(streamSeed(seed, itemId, "vars"), false);
  } catch (error) {
    if (!(error instanceof ParameterError) && !isZodError(error)) throw error;
    return from(0, true);
  }
}

/** The values to render a version with, from values stored under it or under another one (§5). */
function storedFor(params: Parameters, versionId: string, stored: StoredInstance): StoredInstance {
  if (stored.versionId === versionId) return stored;
  if (!sameNames(params, stored.values)) throw new InstanceMismatch();
  return { ...stored, versionId, values: replay(params, stored.values) };
}

/**
 * THE instantiation: the version a reader of one attempt's item (or one
 * drill review) uses. Static → the version itself. Parameterized → the
 * template rendered with the `stored` values (replayed when they were drawn
 * for another version with the same names, §5: `InstanceMismatch` when the
 * names differ, a `ParameterError` when the replay fails), or with values
 * drawn from the seed when nothing is stored — then `stored` is what to
 * store.
 */
export function instanceOf(
  type: string,
  version: VersionContent,
  at: { seed: number; itemId: string; stored?: StoredInstance | null | undefined },
): Instance {
  const params = parametersOf(version);
  if (params === null) {
    return {
      version: { config: version.config, configVersion: version.configVersion, variables: null },
      explanation: version.explanation,
      values: null,
      stored: null,
    };
  }
  if (!at.stored) return drawn(type, version, params, at.seed, at.itemId);
  const stored = storedFor(params, version.id, at.stored);
  return render(type, version, params, stored, stored.values);
}

/**
 * The instance of `draw(params, 0)` — the very draw publication put through
 * the type's gate — for a reader with no attempt behind it that needs the
 * question's STRUCTURE (its points, its key, its kind of blanks) or one
 * stable rendering (the debrief). The version itself when static.
 */
export function exampleInstance(type: string, version: VersionContent): Instance {
  const params = parametersOf(version);
  if (params === null) return instanceOf(type, version, { seed: 0, itemId: "" });
  return gatedInstance(type, version, params, 0);
}

/** The instance of `draw(params, seed)`: what publication gates for `seed`. */
function gatedInstance(type: string, version: VersionContent, params: Parameters, seed: number): Instance {
  const { values } = draw(params, seed, acceptOf(typeOf(type), templateOf(type, version), params));
  return render(type, version, params, { versionId: version.id, values }, values);
}

/** The parsed config a reader of a question's STRUCTURE uses: its {@link exampleInstance}'s. */
export function exampleConfig(type: string, version: VersionContent): unknown {
  return loadConfig(type, exampleInstance(type, version).version);
}

/**
 * The question AS WRITTEN, for a teacher's eyes (the grading table's expected
 * row, ADR-056 §9): the template itself when the type's schema takes it — an
 * mcq's choices and a short's number matcher hold their `[[…]]` as text —
 * else the {@link exampleInstance}, `example: true` (a cloze number blank
 * `{{#[[t]]:1%}}` is no blank until it is instantiated). Never a student
 * payload: no student route reads a template (invariant 4).
 */
export function writtenConfig(type: string, version: VersionContent): { config: unknown; example: boolean } {
  const template = tryLoadConfig(type, version, { template: true });
  return template.ok ? { config: template.config, example: false } : { config: exampleConfig(type, version), example: true };
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
  const read = readingPerAttempt(entry);
  return (attempt) => read(attempt).config;
}

/** What a reader of one attempt's item holds: its parsed config, and the values it was drawn with. */
export interface Reading {
  config: unknown;
  /** Null for a static question. */
  values: Values | null;
  /** The explanation instantiated with `values`; the version's own for a static question. */
  explanation: string;
}

/** {@link configPerAttempt}, with the values beside the config: the grading panel shows both. */
export function readingPerAttempt(entry: InstanceItem): (attempt: InstanceAttempt) => Reading {
  if (!isParameterized(entry.version)) {
    const reading = {
      config: loadConfig(entry.question.type, entry.version),
      values: null,
      explanation: entry.version.explanation,
    };
    return () => reading;
  }
  return (attempt) => {
    const instance = itemInstance(entry, attempt);
    return {
      config: loadConfig(entry.question.type, instance.version),
      values: instance.values,
      explanation: instance.explanation,
    };
  };
}

/** An explanation as the payloads carry it: `null` when there is none. */
export const explanationOrNull = (explanation: string): string | null => (explanation === "" ? null : explanation);

/**
 * The identity of a parameterized TEMPLATE, for a key that must not move
 * with each instance (the drill's `keyHashOf`, ADR-056 §5): the migrated
 * config, the explanation-free table. A new draw never changes it; an edit of
 * a formula does.
 */
export function templateHash(type: string, version: VersionContent): string {
  const body = JSON.stringify({ config: templateOf(type, version), variables: parametersOf(version) });
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

/** What {@link parameterIssues} reads of a draft. */
interface DraftContent {
  config: unknown;
  /** The stored row's; a caller holding a bare config (MCP) leaves it out: the config's own is read. */
  configVersion?: number;
  explanation: string;
  variables: ParametersDraft | null;
}

/**
 * Publication's check of a parameterized draft, and the values of the
 * draws it gated (one per seed of `GATE_SEEDS`, in order) when it passes.
 * See {@link parameterIssues}.
 */
function gate(type: string, draft: DraftContent, params: Parameters): { issues: ZodIssueLite[]; draws: Values[] } {
  const refused = (issues: ZodIssueLite[]) => ({ issues, draws: [] });
  if (!PARAMETERIZED_TYPES.has(type)) return refused([parameterIssue(["variables"], "parameters.unsupported_type")]);
  const t = typeOf(type);
  const template = raise(t, draft.config, draft.configVersion ?? declaredVersion(draft.config) ?? t.configVersion);
  const own = (t.parameterIssues?.(template) ?? []).map((i) => parameterIssue(i.path.map(String), i.message));
  if (own.length > 0) return refused(own);
  const options = acceptOf(t, template, params);
  const issues = validateParameters(params, { config: template, explanation: draft.explanation }, options);
  if (issues.length > 0) return refused(issues.map(issueOf));
  const draws: Values[] = [];
  for (const seed of GATE_SEEDS) {
    try {
      const { values } = draw(params, seed, options);
      publishConfig(type, instantiate(template, params, values));
      draws.push(values);
    } catch (error) {
      if (error instanceof NotPublishable) return refused(error.issues);
      if (error instanceof ParameterError) return refused([issueOf(error.issue)]);
      return refused(issuesOf(error));
    }
  }
  // The rules that read the drawn values (§6: a tolerance against the key's format).
  const formats = Object.fromEntries(params.rows.map((row) => [row.name, row.format]));
  const sampled = (t.sampleIssues?.(template, { formats, values: draws }) ?? []).map((i) =>
    parameterIssue(i.path.map(String), i.message),
  );
  return sampled.length > 0 ? refused(sampled) : { issues: [], draws };
}

/**
 * Everything publication requires of a parameterized draft (ADR-056 §3, §6,
 * §7, §10), as the editor's issues; empty for a static one (its config goes
 * through `publishConfig` as before). In order, stopping at the first
 * family that fails: a type that takes variables; the type's own rule on
 * the template (`parameterIssues`); the table and every `[[…]]` of the
 * config and the explanation, over 200 draws (`validateParameters`); the
 * instances of a few seeds through the type's publication gate; then the
 * type's rules on those draws' values (`sampleIssues`).
 */
export function parameterIssues(type: string, draft: DraftContent): ZodIssueLite[] {
  const params = parametersOf(draft);
  return params === null ? [] : gate(type, draft, params).issues;
}

/** One instance of the editor's preview (ADR-056 §8): its seed, its values as shown, the instance. */
export interface PreviewInstance {
  seed: number;
  /** In the table's order, each written with its row's format. */
  values: { name: string; value: string }[];
  instance: Instance;
}

/**
 * The editor's preview of a parameterized draft (ADR-056 §8): the instances
 * of the seeds publication gates, drawn exactly as it draws them, so what
 * the teacher reads is what publication checked. Issues instead when the
 * draft would not publish — the instances of a draft that does not draw
 * cannot be shown. Empty for a static draft.
 */
export function previewInstances(
  type: string,
  version: VersionContent,
): { instances: PreviewInstance[]; issues: ZodIssueLite[] } {
  const params = parametersOf(version);
  if (params === null) return { instances: [], issues: [] };
  const { issues, draws } = gate(type, version, params);
  if (issues.length > 0) return { instances: [], issues };
  // The very draws publication gated, rendered: nothing is drawn twice.
  const instances = draws.map((drawn, i) => {
    const instance = render(type, version, params, { versionId: version.id, values: drawn }, drawn);
    return { seed: GATE_SEEDS[i]!, values: formattedValues(params, drawn), instance };
  });
  return { instances, issues: [] };
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
