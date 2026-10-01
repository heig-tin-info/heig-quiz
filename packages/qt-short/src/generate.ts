/**
 * "Generate answers" for a short-answer question (ADR-059): the model
 * proposes accepted answers as plain values, the merge turns each into a
 * matcher of the question's `kind` — which the teacher chose and the model
 * never changes — keeps every matcher the teacher wrote, and drops the empty
 * placeholder of a fresh draft.
 */
import { z } from "zod";

import type { AnswerGenerator } from "@quiz/core/server";

import { SHORT_MAX_MATCHERS, type ShortConfig, type ShortMatcher } from "./schema.js";

const ShortProposal = z.object({
  answers: z.array(z.object({ value: z.string(), tolerance: z.number().optional() })),
});
type ShortProposal = z.infer<typeof ShortProposal>;

/** One proposed value as a matcher of `kind`, or null when it does not read as one. */
function matcherOf(kind: ShortConfig["kind"], value: string, tolerance: number | undefined): ShortMatcher | null {
  const v = value.trim();
  if (v === "") return null;
  switch (kind) {
    case "number": {
      const n = Number(v.replace(",", "."));
      if (!Number.isFinite(n)) return null;
      const t = tolerance !== undefined && Number.isFinite(tolerance) ? Math.abs(tolerance) : 0;
      return { kind: "number", value: n, tolerance: t, toleranceMode: "abs", unitRequired: false, points: 1 };
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { kind: "date", value: v, toleranceDays: 0, points: 1 } : null;
    case "time":
      return /^\d{2}:\d{2}$/.test(v) ? { kind: "time", value: v, toleranceMinutes: 0, points: 1 } : null;
    default:
      return v.length <= 500 ? { kind: "exact", value: v, points: 1 } : null;
  }
}

/** The empty placeholder of a fresh draft, or of a row the teacher cleared. */
const isEmpty = (m: ShortMatcher) =>
  (m.kind === "exact" || m.kind === "date" || m.kind === "time") && String(m.value ?? "").trim() === "";

const key = (m: ShortMatcher) =>
  m.kind === "exact" ? `exact:${m.value.trim().toLowerCase()}` : "value" in m ? `${m.kind}:${String(m.value)}` : null;

export function mergeShort(config: ShortConfig, proposal: ShortProposal): ShortConfig {
  const kept = (Array.isArray(config.matchers) ? config.matchers : []).filter((m) => !isEmpty(m));
  const seen = new Set(kept.map(key).filter((k) => k !== null));
  const added: ShortMatcher[] = [];
  for (const answer of proposal.answers) {
    if (kept.length + added.length >= SHORT_MAX_MATCHERS) break;
    const matcher = matcherOf(config.kind ?? "text", answer.value, answer.tolerance);
    const k = matcher && key(matcher);
    if (!matcher || !k || seen.has(k)) continue;
    seen.add(k);
    added.push(matcher);
  }
  // Nothing usable: the draft stays as it was, placeholder included.
  if (added.length === 0) return config;
  return { ...config, matchers: [...kept, ...added] };
}

export const shortGenerator: AnswerGenerator<ShortConfig, ShortProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is a short-answer question, graded by comparing the student's answer with accepted values.",
    "The draft's `kind` is the answer's kind and is not yours to change: `text`, `number`, `date` (YYYY-MM-DD)",
    "or `time` (HH:MM). Propose the accepted answers in `answers`, each a `value` exactly as a student would",
    "type it. For `text`: the expected answer and its common acceptable variants (spellings, synonyms,",
    "with or without an article); case and surrounding spaces are already ignored. For `number`: the value,",
    "with an absolute `tolerance` when rounding is to be accepted. Never repeat an answer the draft holds.",
  ].join(" "),
  proposalSchema: ShortProposal,
  merge: mergeShort,
};
