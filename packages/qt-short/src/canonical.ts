/**
 * The canonical YAML mapping of a `short` config (docs/04 §4.2, PLAN-MVP §2.2).
 *
 * Plain objects: the YAML codec is `packages/canonical`, a later work package.
 * A field left at its schema default is omitted, so a matcher reads as
 * `{ kind: exact, value: "#include <stdio.h>" }` and not as a wall of defaults.
 */
import {
  SHORT_CONFIG_VERSION,
  ShortConfigSchema,
  type ShortConfig,
  type ShortMatcher,
} from "./schema.js";

export type ShortCanonicalMatcher = Record<string, unknown> & { kind: ShortMatcher["kind"] };

export interface ShortCanonical {
  configVersion: number;
  prompt: string;
  kind?: ShortConfig["kind"];
  placeholder?: string;
  matchers: ShortCanonicalMatcher[];
}

function canonicalMatcher(matcher: ShortMatcher): ShortCanonicalMatcher {
  const out: ShortCanonicalMatcher = { kind: matcher.kind };
  switch (matcher.kind) {
    case "exact":
      out.value = matcher.value;
      if (matcher.caseSensitive) out.caseSensitive = true;
      if (!matcher.trim) out.trim = false;
      if (!matcher.collapseSpaces) out.collapseSpaces = false;
      break;
    case "regex":
      out.pattern = matcher.pattern;
      if (matcher.flags !== "i") out.flags = matcher.flags;
      break;
    case "number":
      out.value = matcher.value;
      if (matcher.tolerance !== 0) out.tolerance = matcher.tolerance;
      if (matcher.toleranceMode !== "abs") out.toleranceMode = matcher.toleranceMode;
      if (matcher.unit !== undefined) out.unit = matcher.unit;
      if (matcher.unitRequired) out.unitRequired = true;
      break;
    case "date":
      out.value = matcher.value;
      if (matcher.toleranceDays !== 0) out.toleranceDays = matcher.toleranceDays;
      break;
    case "time":
      out.value = matcher.value;
      if (matcher.toleranceMinutes !== 0) out.toleranceMinutes = matcher.toleranceMinutes;
      break;
    case "llm":
      out.rubric = matcher.rubric;
      if (matcher.reference !== undefined) out.reference = matcher.reference;
      break;
  }
  if (matcher.points !== 1) out.points = matcher.points;
  return out;
}

export function toCanonical(config: ShortConfig): ShortCanonical {
  const out: ShortCanonical = {
    configVersion: SHORT_CONFIG_VERSION,
    prompt: config.prompt,
    matchers: config.matchers.map(canonicalMatcher),
  };
  if (config.kind !== "text") out.kind = config.kind;
  if (config.placeholder !== undefined) out.placeholder = config.placeholder;
  return out;
}

export function fromCanonical(raw: unknown): ShortConfig {
  return ShortConfigSchema.parse(raw);
}
