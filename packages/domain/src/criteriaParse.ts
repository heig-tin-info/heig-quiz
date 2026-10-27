/**
 * The parser of a project's `criteria.yml`, in its two schemas. Every
 * refusal is a closed code with its path (`CriteriaError`), worded by the
 * web; StudentScore's English is no contract. The version picks the
 * grading model (`ParsedCriteria.schemaVersion`); both stay until schema 2
 * is removed (L-06g).
 *
 * **Schema 2** (ADR-106 §2) is a port of `StudentScore/schema.py` 0.7.5
 * (`_validate_v2_section`, `_validate_v2_item`, `_validate_pair`,
 * `_validate_grading`, `_validate_student`). On a criterion:
 * `description`, `max_points`, `bonus_points`, `awarded_points`
 * (required), `rationale`, `prompt`, `milestone`, and the port's own `test`
 * (a string: the criterion is automatic on the runner's evidence) and
 * `desc` (`description`'s short form, never both). Maxima are strict
 * integers (`not_integer`; a percentage `percent_max`); `awarded_points`
 * lies in the criterion's range, a percentage of its own maximum. Refused
 * where 0.7.5 lets them through: a dotted name (`dotted_key`), a negative
 * bonus (`negative_bonus`), a file with no criterion (`no_criteria`).
 *
 * **Schema 3** (the criteria-3 contract, ADR-119; StudentScore 1.0's
 * `_validate_v3_*`): a leaf is a mapping carrying any leaf key but
 * `description`. It takes `description` or `desc` (required, never both),
 * `max_points` (a non-zero number, negative for a penalty) or
 * `bonus_points` (a positive number), `prompt` (LLM-proposed), `command`
 * (an argv of 1 to 20 strings, the first non-empty, none holding NUL; never
 * a shell string: automatic), `milestone`; `awarded_points` and `rationale`
 * (StudentScore's output) are accepted and ignored. Any other key is
 * refused — `test` included — at the top level too. A name holds neither a
 * dot nor a space; no percentage anywhere; `grading.sources` are plain
 * paths (a directory ends with `/`), never a wildcard.
 *
 * Schema 1 (`$`-prefixed keys, or no `schema_version`) is refused
 * (`schema_v1`).
 */
import { parseDocument } from "yaml";

import {
  COMMAND_MAX_ARGS,
  MILESTONE_PATTERN,
  type CriteriaError,
  type CriteriaGrading,
  type CriteriaLeaf,
  type CriteriaParseErrorCode,
  type CriteriaStudent,
  type ParsedCriteria,
} from "./criteria.js";

export type CriteriaParse = { ok: true; criteria: ParsedCriteria } | { ok: false; errors: CriteriaError[] };

type Node = Record<string, unknown>;

const isMapping = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

class Collector {
  readonly errors: CriteriaError[] = [];
  add(path: string[], code: CriteriaParseErrorCode, params?: Record<string, string | number>): void {
    this.errors.push({ path: path.length > 0 ? path.join("/") : "<root>", code, ...(params ? { params } : {}) });
  }
  /** A string, or a list of strings joined by lines (`_ensure_text_or_text_list`). */
  text(value: unknown, path: string[]): string | null {
    if (typeof value === "string") return value;
    if (isTextList(value)) return value.join("\n");
    this.add(path, "not_text");
    return null;
  }
  string(value: unknown, path: string[]): string | undefined {
    if (typeof value === "string") return value;
    this.add(path, "not_string");
    return undefined;
  }
}

/** How a schema reads its tree: which mapping is a leaf, which names it refuses, how it reads a leaf and the sources. */
interface Schema {
  version: 2 | 3;
  isLeaf(node: Node): boolean;
  badName(name: string): CriteriaParseErrorCode | null;
  item(c: Collector, node: Node, path: string[], sectionPath: string[]): CriteriaLeaf | null;
  sources(c: Collector, value: unknown, path: string[]): string[];
}

/** A leaf's unknown keys, then its description: `desc` is `description`'s short form (ADR-106 §2, v1's `$desc`), one of them, not both. */
function leafDescription(c: Collector, node: Node, path: string[], fields: ReadonlySet<string>): string | null {
  for (const key of Object.keys(node)) if (!fields.has(key)) c.add([...path, key], "unknown_key");
  const descKey = node.description === undefined ? "desc" : "description";
  if (node.description !== undefined && node.desc !== undefined) c.add(path, "both_descriptions");
  if (node[descKey] === undefined) {
    c.add(path, "missing_description");
    return null;
  }
  return c.text(node[descKey], [...path, descKey]);
}

/** A leaf's milestone tag (`_validate_milestone`). */
function leafMilestone(c: Collector, node: Node, path: string[]): string | undefined {
  if (node.milestone === undefined) return undefined;
  if (typeof node.milestone === "string" && MILESTONE_PATTERN.test(node.milestone)) return node.milestone;
  c.add([...path, "milestone"], "bad_milestone");
  return undefined;
}

/** Which points key a leaf carries: one of `max_points` and `bonus_points`, else null (refused). */
function leafPointsKey(c: Collector, node: Node, path: string[]): "max_points" | "bonus_points" | null {
  const hasMax = "max_points" in node;
  const hasBonus = "bonus_points" in node;
  if (hasMax && hasBonus) c.add(path, "both_points");
  if (!hasMax && !hasBonus) c.add(path, "missing_points");
  return hasMax === hasBonus ? null : hasMax ? "max_points" : "bonus_points";
}

/** The leaf as both schemas return it, once its checks passed. */
function leafOf(
  path: string[],
  sectionPath: string[],
  description: string,
  key: "max_points" | "bonus_points",
  points: number,
  extra: { [K in "prompt" | "test" | "command" | "milestone"]?: CriteriaLeaf[K] | undefined },
): CriteriaLeaf {
  return {
    id: [...sectionPath, path[path.length - 1]!].join("."),
    sectionPath,
    description,
    maxPoints: key === "max_points" ? points : 0,
    ...(key === "max_points" ? {} : { bonusPoints: points }),
    ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
  };
}

// ---------------------------------------------------------------- schema 2

const PERCENT_PATTERN = /^(-?\d+(?:\.\d+)?)%$/;
const V2_POINT_KEYS = ["awarded_points", "max_points", "bonus_points"];
const V2_FIELDS = new Set([...V2_POINT_KEYS, "description", "desc", "rationale", "prompt", "test", "milestone"]);

/** A criterion's maximum (`int(total)` of `_validate_pair`): a non-zero integer. */
function v2Total(c: Collector, value: unknown, path: string[]): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    c.add(path, typeof value === "string" && PERCENT_PATTERN.test(value.trim()) ? "percent_max" : "not_integer");
    return null;
  }
  if (value === 0) {
    c.add(path, "zero_points");
    return null;
  }
  return value;
}

/** `awarded_points` against its maximum (`_validate_pair`): a number or `"42%"`, inside the criterion's range. */
function v2Awarded(c: Collector, value: unknown, max: number, path: string[]): void {
  let awarded: number;
  if (typeof value === "string") {
    const match = PERCENT_PATTERN.exec(value.trim());
    if (!match) return c.add(path, "bad_percent");
    const percent = Number(match[1]);
    if (percent < -100 || percent > 100) return c.add(path, "percent_range");
    awarded = Math.abs(percent / 100) * max;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    awarded = value;
  } else {
    return c.add(path, "not_numeric");
  }
  // `_validate_pair`'s four refusals: inside [0, max], or [max, 0] for a penalty.
  const [low, high] = max > 0 ? [0, max] : [max, 0];
  if (awarded < low || awarded > high) c.add(path, "awarded_out_of_range", { awarded, max });
}

const SCHEMA_2: Schema = {
  version: 2,
  isLeaf: (node) => V2_POINT_KEYS.some((k) => k in node),
  badName: (name) => (name.includes(".") ? "dotted_key" : null),
  /** `_validate_v2_item`. */
  item(c, node, path, sectionPath) {
    const before = c.errors.length;
    const description = leafDescription(c, node, path, V2_FIELDS);
    if (node.rationale !== undefined && node.rationale !== null) c.text(node.rationale, [...path, "rationale"]);
    const prompt = node.prompt === undefined ? undefined : c.string(node.prompt, [...path, "prompt"]);
    const test = node.test === undefined ? undefined : c.string(node.test, [...path, "test"]);
    const milestone = leafMilestone(c, node, path);
    if (!("awarded_points" in node)) c.add([...path, "awarded_points"], "missing_awarded");
    leafPointsKey(c, node, path);
    const hasMax = "max_points" in node;
    const key = hasMax ? "max_points" : "bonus_points";
    // Beside a second points key, the maximum is still read: both refusals are named, as before.
    const points = key in node ? v2Total(c, node[key], [...path, key]) : null;
    if (points !== null && key === "bonus_points" && points < 0) c.add([...path, key], "negative_bonus");
    if (points !== null && "awarded_points" in node) v2Awarded(c, node.awarded_points, points, [...path, key]);
    if (c.errors.length > before) return null;
    return leafOf(path, sectionPath, description!, key, points!, { prompt, test, milestone });
  },
  sources(c, value, path) {
    if (isTextList(value)) return value;
    c.add(path, "not_text_list");
    return [];
  },
};

// ---------------------------------------------------------------- schema 3

const V3_FIELDS = new Set(["description", "desc", "max_points", "bonus_points", "awarded_points", "rationale", "prompt", "command", "milestone"]);
/** A mapping carrying one of these is a leaf, never a section (StudentScore's `_V3_LEAF_MARKERS`). */
const V3_LEAF_MARKERS = [...V3_FIELDS].filter((key) => key !== "description");
/** A wildcard in a source (StudentScore's `_WILDCARD_PATTERN`). */
const WILDCARD = /[*?[]/;

/** A maximum or a bonus (`_v3_amount`): a non-zero number, a bonus positive. */
function v3Amount(c: Collector, value: unknown, path: string[], bonus: boolean): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    c.add(path, "not_number");
    return null;
  }
  if (value === 0) {
    c.add(path, "zero_points");
    return null;
  }
  if (bonus && value < 0) {
    c.add(path, "negative_bonus");
    return null;
  }
  return value;
}

/** A check's argv (`_validate_v3_command`): 1 to 20 strings, the first non-empty, none holding NUL (no argv can carry one). */
function v3Command(c: Collector, value: unknown, path: string[]): string[] | undefined {
  const ok =
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= COMMAND_MAX_ARGS &&
    value.every((word) => typeof word === "string" && !word.includes("\0")) &&
    value[0] !== "";
  if (ok) return value as string[];
  c.add(path, "bad_command", { max: COMMAND_MAX_ARGS });
  return undefined;
}

const SCHEMA_3: Schema = {
  version: 3,
  isLeaf: (node) => V3_LEAF_MARKERS.some((k) => k in node),
  badName: (name) => (name.includes(".") ? "dotted_key" : /\s/.test(name) ? "spaced_key" : null),
  /** `_validate_v3_item`. */
  item(c, node, path, sectionPath) {
    const before = c.errors.length;
    const description = leafDescription(c, node, path, V3_FIELDS);
    const prompt = node.prompt === undefined ? undefined : c.string(node.prompt, [...path, "prompt"]);
    const command = node.command === undefined ? undefined : v3Command(c, node.command, [...path, "command"]);
    const milestone = leafMilestone(c, node, path);
    const key = leafPointsKey(c, node, path);
    const points = key === null ? null : v3Amount(c, node[key], [...path, key], key === "bonus_points");
    if (c.errors.length > before) return null;
    return leafOf(path, sectionPath, description!, key!, points!, { prompt, command, milestone });
  },
  /** A list of plain paths, each wildcard refused under its index. */
  sources(c, value, path) {
    const sources = SCHEMA_2.sources(c, value, path);
    sources.forEach((source, index) => {
      if (WILDCARD.test(source)) c.add([...path, String(index)], "wildcard_source", { source });
    });
    return sources;
  },
};

// ---------------------------------------------------------------- both

/** A section: a mapping of sections and criteria, with an optional description. */
function section(c: Collector, schema: Schema, node: Node, path: string[], sectionPath: string[], out: ParsedCriteria): void {
  if (sectionPath.length > 0) {
    let description: string | null = null;
    if (typeof node.description === "string") description = node.description;
    else if (node.description !== undefined && node.description !== null) c.add([...path, "description"], "not_string");
    out.sections.push({ id: sectionPath.join("."), path: sectionPath, description });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "description") continue;
    const at = [...path, key];
    // A dotted key would make two criteria share an id.
    const bad = schema.badName(key);
    if (bad) c.add(at, bad);
    else if (!isMapping(value)) c.add(at, "not_mapping");
    else if (schema.isLeaf(value)) {
      const leaf = schema.item(c, value, at, sectionPath);
      if (leaf) out.leaves.push(leaf);
    } else section(c, schema, value, at, [...sectionPath, key], out);
  }
}

/** `_validate_student`. */
function student(c: Collector, value: unknown, path: string[]): CriteriaStudent | undefined {
  if (!isMapping(value)) return void c.add(path, "not_mapping");
  const out: CriteriaStudent = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "level") {
      if (typeof v === "string") out.level = v;
      else c.add([...path, key], "not_string");
    } else if (key === "knows" || key === "learning") {
      if (isTextList(v)) out[key] = v;
      else c.add([...path, key], "not_text_list");
    } else c.add([...path, key], "unknown_key");
  }
  return out;
}

/** `_validate_grading`. */
function grading(c: Collector, schema: Schema, value: unknown): CriteriaGrading {
  const out: CriteriaGrading = { context: null, sources: [] };
  if (value === undefined || value === null) return out;
  if (!isMapping(value)) {
    c.add(["grading"], "not_mapping");
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    const at = ["grading", key];
    if (key === "context") out.context = c.text(v, at);
    else if (key === "sources") out.sources = schema.sources(c, v, at);
    else if (key === "student") {
      const s = student(c, v, at);
      if (s) out.student = s;
    } else c.add(at, "unknown_key");
  }
  return out;
}

/**
 * Reads a `criteria.yml`: the criteria, or every refusal with its path.
 * `schema_version` 2 or 3 picks the rules; `1` (or its absence, which
 * StudentScore reads as 1) is refused with `schema_v1`, anything else with
 * `schema_version`.
 */
export function parseCriteria(yamlText: string): CriteriaParse {
  const c = new Collector();
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    for (const e of doc.errors) c.add([], "yaml_syntax", e.linePos ? { line: e.linePos[0].line } : undefined);
    return { ok: false, errors: c.errors };
  }
  const data: unknown = doc.toJS();
  if (!isMapping(data)) {
    c.add([], "not_mapping");
    return { ok: false, errors: c.errors };
  }
  const schema = data.schema_version === 2 ? SCHEMA_2 : data.schema_version === 3 ? SCHEMA_3 : null;
  if (schema === null) {
    c.add(["schema_version"], data.schema_version === undefined || data.schema_version === 1 ? "schema_v1" : "schema_version");
    return { ok: false, errors: c.errors };
  }
  const out: ParsedCriteria = { schemaVersion: schema.version, grading: grading(c, schema, data.grading), sections: [], leaves: [] };
  if (schema.version === 3) {
    for (const key of Object.keys(data)) if (key !== "schema_version" && key !== "grading" && key !== "criteria") c.add([key], "unknown_key");
  }
  if (data.criteria === undefined || data.criteria === null) c.add(["criteria"], "missing_criteria");
  else if (!isMapping(data.criteria)) c.add(["criteria"], "not_mapping");
  else section(c, schema, data.criteria, ["criteria"], [], out);
  if (c.errors.length === 0 && out.leaves.length === 0) c.add(["criteria"], "no_criteria");
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, criteria: out };
}
