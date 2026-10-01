/**
 * "Generate answers" for an essay (ADR-059): a model answer and a grading
 * rubric, each written only where the teacher left the field empty. Both
 * are the grader's (invariant 4): `toStudent` never sends them.
 */
import { z } from "zod";

import type { AnswerGenerator } from "@quiz/core/server";

import { RICH_MAX_CHARS, type RichConfig } from "./schema.js";

const RichProposal = z.object({ reference: z.string(), rubric: z.string() });
type RichProposal = z.infer<typeof RichProposal>;

const blank = (text: string | undefined) => (text ?? "").trim() === "";

export function mergeRich(config: RichConfig, proposal: RichProposal): RichConfig {
  const reference = proposal.reference.trim().slice(0, RICH_MAX_CHARS);
  const rubric = proposal.rubric.trim().slice(0, 20_000);
  return {
    ...config,
    ...(blank(config.reference) && reference ? { reference } : {}),
    ...(blank(config.rubric) && rubric ? { rubric } : {}),
  };
}

export const richGenerator: AnswerGenerator<RichConfig, RichProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is an essay, graded by hand. Propose, in Markdown:",
    "`reference`, a model answer of the length and level the statement asks for (respect `maxChars` when set);",
    "and `rubric`, the grading criteria a grader reads beside each answer: a short list of the points that earn",
    "marks, each with its share of the marks, and the common mistakes that lose them.",
    "A field the draft already fills is kept as the teacher wrote it: you may leave its proposal empty.",
  ].join(" "),
  proposalSchema: RichProposal,
  merge: mergeRich,
};
