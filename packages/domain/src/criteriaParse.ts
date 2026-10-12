/**
 * The parser of a project's `criteria.yml` (ADR-106 §2): a port of
 * `StudentScore/schema.py` 0.7.5 for schema v2 (`_validate_v2_section`,
 * `_validate_v2_item`, `_validate_pair`, `_validate_grading`,
 * `_validate_student`). Every refusal is a closed code with its path
 * (`CriteriaError`), worded by the web; StudentScore's English is no
 * contract.
 *
 * What 0.7.5 accepts on a v2 criterion: `description`, `max_points`,
 * `bonus_points`, `awarded_points` (required), `rationale`, `prompt`,
 * `milestone`. It knows neither `test` nor `desc` (v1 had `$test`, which
 * v2's `prompt` replaced, and `$desc`). The port's deliberate choices:
 *
 * - **`test`** (a string) is accepted: it marks a criterion automatic
 *   (`classifyCriterion`, ADR-106 §2); **`desc`** is accepted as
 *   `description`'s short form (never both). A file using them fails
 *   StudentScore's own `score check`.
 * - **Schema v1** (`$`-prefixed keys, or no `schema_version`) is refused
 *   (`schema_v1`): its support is deferred.
 * - **Maxima are strict integers**: `schema.py` reads `int(total)`, which
 *   truncates `2.5` and fails on `"50%"`; here `2.5` is `not_integer` and a
 *   percentage `percent_max` — a percentage only ever applies to
 *   `awarded_points`, against the criterion's own maximum.
 * - **Refused where 0.7.5 lets them through**: a section or criterion name
 *   holding a dot (`dotted_key`: two dotted ids would collide), a negative
 *   `bonus_points` (`negative_bonus`), and a file with no criterion at all
 *   (`no_criteria`).
 */
import { parseDocument } from "yaml";

import {
  MILESTONE_PATTERN,
  type CriteriaError,
  type CriteriaGrading,
  type CriteriaLeaf,
  type CriteriaParseErrorCode,
  type CriteriaStudent,
  type ParsedCriteria,
} from "./criteria.js";

export type CriteriaParse = { ok: true; criteria: ParsedCriteria } | { ok: false; errors: CriteriaError[] };
const PERCENT_PATTERN = /^(-?\d+(?:\.\d+)?)%$/;
const ITEM_KEYS = ["awarded_points", "max_points", "bonus_points"];
const ITEM_FIELDS = new Set([...ITEM_KEYS, "description", "desc", "rationale", "prompt", "test", "milestone"]);

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

/** A criterion's maximum (`int(total)` of `_validate_pair`): a non-zero integer. */
function total(c: Collector, value: unknown, path: string[]): number | null {
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
function checkAwarded(c: Collector, value: unknown, max: number, path: string[]): void {
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

/** `_validate_v2_item`. */
function item(c: Collector, node: Node, path: string[], sectionPath: string[]): CriteriaLeaf | null {
  const before = c.errors.length;
  for (const key of Object.keys(node)) if (!ITEM_FIELDS.has(key)) c.add([...path, key], "unknown_key");
  // `desc` is `description`'s short form (ADR-106 §2, v1's `$desc`): one of them, not both.
  const descKey = node.description === undefined ? "desc" : "description";
  if (node.description !== undefined && node.desc !== undefined) c.add(path, "both_descriptions");
  const description = node[descKey] === undefined ? null : c.text(node[descKey], [...path, descKey]);
  if (node[descKey] === undefined) c.add(path, "missing_description");
  if (node.rationale !== undefined && node.rationale !== null) c.text(node.rationale, [...path, "rationale"]);
  const prompt = node.prompt === undefined ? undefined : c.string(node.prompt, [...path, "prompt"]);
  const test = node.test === undefined ? undefined : c.string(node.test, [...path, "test"]);
  let milestone: string | undefined;
  if (node.milestone !== undefined) {
    if (typeof node.milestone === "string" && MILESTONE_PATTERN.test(node.milestone)) milestone = node.milestone;
    else c.add([...path, "milestone"], "bad_milestone");
  }
  if (!("awarded_points" in node)) c.add([...path, "awarded_points"], "missing_awarded");
  const hasMax = "max_points" in node;
  const hasBonus = "bonus_points" in node;
  if (hasMax && hasBonus) c.add(path, "both_points");
  if (!hasMax && !hasBonus) c.add(path, "missing_points");
  const key = hasMax ? "max_points" : "bonus_points";
  const points = hasMax || hasBonus ? total(c, node[key], [...path, key]) : null;
  if (points !== null && hasBonus && !hasMax && points < 0) c.add([...path, key], "negative_bonus");
  if (points !== null && "awarded_points" in node) checkAwarded(c, node.awarded_points, points, [...path, key]);
  if (c.errors.length > before) return null;
  return {
    id: [...sectionPath, path[path.length - 1]!].join("."),
    sectionPath,
    description: description!,
    maxPoints: hasMax ? points! : 0,
    ...(hasMax ? {} : { bonusPoints: points! }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(test === undefined ? {} : { test }),
    ...(milestone === undefined ? {} : { milestone }),
  };
}

/** `_validate_v2_section`: a mapping of sections and criteria, with an optional description. */
function section(c: Collector, node: Node, path: string[], sectionPath: string[], out: ParsedCriteria): void {
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
    if (key.includes(".")) c.add(at, "dotted_key");
    else if (!isMapping(value)) c.add(at, "not_mapping");
    else if (ITEM_KEYS.some((k) => k in value)) {
      const leaf = item(c, value, at, sectionPath);
      if (leaf) out.leaves.push(leaf);
    } else section(c, value, at, [...sectionPath, key], out);
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
function grading(c: Collector, value: unknown): CriteriaGrading {
  const out: CriteriaGrading = { context: null, sources: [] };
  if (value === undefined || value === null) return out;
  if (!isMapping(value)) {
    c.add(["grading"], "not_mapping");
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    const at = ["grading", key];
    if (key === "context") out.context = c.text(v, at);
    else if (key === "sources") {
      if (isTextList(v)) out.sources = v;
      else c.add(at, "not_text_list");
    } else if (key === "student") {
      const s = student(c, v, at);
      if (s) out.student = s;
    } else c.add(at, "unknown_key");
  }
  return out;
}

/**
 * Reads a `criteria.yml`: the criteria, or every refusal with its path.
 * `schema_version: 2` is required; `1` (or its absence, which StudentScore
 * reads as 1) is refused until its support lands.
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
  if (data.schema_version !== 2) {
    c.add(["schema_version"], data.schema_version === undefined || data.schema_version === 1 ? "schema_v1" : "schema_version");
    return { ok: false, errors: c.errors };
  }
  const out: ParsedCriteria = { schemaVersion: 2, grading: grading(c, data.grading), sections: [], leaves: [] };
  if (data.criteria === undefined || data.criteria === null) c.add(["criteria"], "missing_criteria");
  else if (!isMapping(data.criteria)) c.add(["criteria"], "not_mapping");
  else section(c, data.criteria, ["criteria"], [], out);
  if (c.errors.length === 0 && out.leaves.length === 0) c.add(["criteria"], "no_criteria");
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, criteria: out };
}

