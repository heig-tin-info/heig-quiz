/**
 * "Generate answers" for an essay (ADR-059): a model answer, grading
 * criteria (ADR-118) and the grader's global instructions, each written only
 * where the teacher left the field empty. All are the grader's (invariant
 * 4): `toStudent` never sends them.
 */
import { z } from "zod";

import type { AnswerGenerator } from "@quiz/core/server";
import { newId } from "@quiz/core/id";

import {
  RICH_MAX_CHARS,
  RICH_MAX_CRITERIA,
  RICH_MAX_CRITERION_PROMPT,
  RICH_MAX_CRITERION_TITLE,
  RICH_MAX_WEIGHT,
  type RichConfig,
  type RichCriterion,
} from "./schema.js";

const RichProposal = z.object({
  reference: z.string(),
  rubric: z.string(),
  criteria: z.array(z.object({ title: z.string(), weight: z.number(), prompt: z.string() })),
});
type RichProposal = z.infer<typeof RichProposal>;

const blank = (text: string | undefined) => (text ?? "").trim() === "";

/** The proposed criteria the schema holds, each with a fresh id: a blank title is dropped, a weight made a whole 1..100. */
function proposedCriteria(proposal: RichProposal["criteria"] | undefined): RichCriterion[] {
  return (proposal ?? [])
    .filter((c) => !blank(c.title))
    .slice(0, RICH_MAX_CRITERIA)
    .map((c) => ({
      id: newId(),
      title: c.title.trim().slice(0, RICH_MAX_CRITERION_TITLE),
      weight: Math.min(RICH_MAX_WEIGHT, Math.max(1, Math.round(Number.isFinite(c.weight) ? c.weight : 1))),
      prompt: c.prompt.trim().slice(0, RICH_MAX_CRITERION_PROMPT),
    }));
}

export function mergeRich(config: RichConfig, proposal: RichProposal): RichConfig {
  const reference = proposal.reference.trim().slice(0, RICH_MAX_CHARS);
  const rubric = proposal.rubric.trim().slice(0, 20_000);
  const criteria = (config.criteria ?? []).length === 0 ? proposedCriteria(proposal.criteria) : [];
  return {
    ...config,
    ...(blank(config.reference) && reference ? { reference } : {}),
    ...(blank(config.rubric) && rubric ? { rubric } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
  };
}

export const richGenerator: AnswerGenerator<RichConfig, RichProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is an essay. Propose:",
    "`reference`, a model answer in Markdown, of the length and level the statement asks for (respect `maxChars` when set);",
    "`criteria`, two to five grading criteria, each a short `title`, a whole `weight` (its points) and a plain-text `prompt`.",
    "The grader scores each criterion from 0 to its weight in quarter points, reading its prompt alone:",
    "the prompt says concretely what earns the weight and what loses part of it.",
    "`rubric` is the grader's global instructions in Markdown, for what applies to every criterion; leave it empty when nothing does.",
    "A field the draft already fills is kept as the teacher wrote it: you may leave its proposal empty.",
  ].join(" "),
  proposalSchema: RichProposal,
  merge: mergeRich,
};
