/**
 * `short` grading (docs/04 §4.5, PLAN-MVP §2.2).
 *
 * The normalisation pipeline and the six matcher kinds live in
 * `@quiz/domain/short`; the cloze type reuses the same functions, so the two
 * can never drift. This module maps an answer onto them and onto the item
 * scale, nothing more.
 *
 * What v2 added here is the PREFILTERS: `trim` and `lowercase` are applied
 * once, to the student's answer and to every `exact` value, so that the whole
 * question answers the same question ("does case count?") instead of each row
 * of the key answering it again. A regex sees the prefiltered input too — its
 * own `i` flag is untouched.
 */
import type { GradedResult } from "@quiz/core/server";
import {
  foldCase,
  matchShortAnswer,
  normalizeInput,
  parseNumericInput,
  round2,
  type ShortMatcher as DomainMatcher,
} from "@quiz/domain";
import type { ShortAnswer, ShortConfig, ShortDetails, ShortPrefilters } from "./schema.js";

/**
 * The question-level normalisation, applied to BOTH sides of a comparison.
 * `normalizeInput` (NFC, CRLF, exotic spaces) is not optional: it is what makes
 * two identical-looking strings comparable at all.
 */
export function applyShortPrefilters(raw: string, prefilters: ShortPrefilters): string {
  let out = normalizeInput(raw);
  if (prefilters.trim) out = out.trim();
  if (prefilters.lowercase) out = foldCase(out);
  return out;
}

/**
 * The matchers as `@quiz/domain` must see them once the prefilters have run:
 * an `exact` value is prefiltered like the answer, and the comparison is then
 * literal (`caseSensitive: true`) because the folding, if any, already
 * happened. Runs of whitespace INSIDE the answer are always collapsed — that
 * was the v1 default and no teacher ever turned it off.
 */
function effectiveMatchers(config: ShortConfig): DomainMatcher[] {
  return config.matchers.map((matcher): DomainMatcher => {
    if (matcher.kind !== "exact") return matcher;
    return {
      kind: "exact",
      value: applyShortPrefilters(matcher.value, config.prefilters),
      caseSensitive: true,
      trim: config.prefilters.trim,
      collapseSpaces: true,
      points: matcher.points,
    };
  });
}

/**
 * The one constraint that decides a verdict: a question whose field only takes
 * whole numbers marks 3.5 wrong, whatever the matchers say. Every other
 * constraint is a property of the FIELD (the player enforces it) and never of
 * the grade — a stored answer that predates a tightened constraint still
 * grades on its merits.
 */
function refusedByIntegerRule(input: string, config: ShortConfig): boolean {
  if (config.kind !== "number" || !config.constraints.integer) return false;
  const unit = config.matchers.find((m) => m.kind === "number")?.unit;
  const parsed = parseNumericInput(input, unit === undefined ? {} : { unit });
  return parsed !== null && !Number.isInteger(parsed);
}

export function gradeShort(
  config: ShortConfig,
  answer: ShortAnswer | null,
  itemPoints: number,
): GradedResult<ShortDetails> {
  // An absent answer and an empty one are the same thing: 0 without running a
  // single matcher (F-GRADE-01).
  const raw = answer?.text ?? null;
  const input = raw === null ? null : applyShortPrefilters(raw, config.prefilters);
  const match =
    input !== null && refusedByIntegerRule(input, config)
      ? matchShortAnswer(input, [])
      : matchShortAnswer(input, effectiveMatchers(config));
  return {
    kind: "graded",
    points: round2(match.fraction * itemPoints),
    maxPoints: itemPoints,
    state: "validated",
    details: {
      matchedIndex: match.matchedIndex,
      matchedKind: match.matchedKind,
      normalized: match.normalized,
      fraction: match.fraction,
    },
  };
}
