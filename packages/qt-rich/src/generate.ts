/**
 * "Generate answers" for an essay (ADR-059): a model answer, grading
 * criteria (ADR-118) and the grader's global instructions, each written only
 * where the teacher left the field empty; and two targets of their own, one
 * criterion's grading prompt and a legacy rubric split into criteria. All
 * are the grader's (invariant 4): `toStudent` never sends them.
 */
import { z } from "zod";

import type { AnswerGenerator, TargetGenerator } from "@quiz/core/server";
import { newId } from "@quiz/core/id";

import {
  RICH_MAX_CHARS,
  RICH_MAX_CRITERIA,
  RICH_MAX_CRITERION_PROMPT,
  RICH_MAX_CRITERION_TITLE,
  RICH_MAX_RUBRIC,
  RICH_MAX_WEIGHT,
  RICH_TARGETS,
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

/** A draft's criteria, read defensively (D16): a missing or non-list field is none. */
const criteriaOf = (config: RichConfig): RichCriterion[] => (Array.isArray(config.criteria) ? config.criteria : []);

/** The grader's contract, stated in the same words by every prompt about criteria (ADR-118 §3). */
const GRADER_CONTRACT =
  "The grader later reads the student's answer with each criterion's prompt alone and scores that criterion " +
  "from 0 to its weight in quarter points. So a prompt says concretely what earns the whole weight and what earns part of it.";

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
  const rubric = proposal.rubric.trim().slice(0, RICH_MAX_RUBRIC);
  const criteria = criteriaOf(config).length === 0 ? proposedCriteria(proposal.criteria) : [];
  return {
    ...config,
    ...(blank(config.reference) && reference ? { reference } : {}),
    ...(blank(config.rubric) && rubric ? { rubric } : {}),
    ...(criteria.length > 0 ? { criteria } : {}),
  };
}

const CriterionPromptReply = z.object({ prompt: z.string() });

/**
 * "Generate the prompt" of one criterion (ADR-118), the target's `id` being
 * the criterion's: from its title and weight, the statement, the model
 * answer and the other criteria's titles, so the prompts do not overlap. It
 * replaces the prompt there: the field is the teacher's draft, which they
 * edit after.
 */
export const criterionPromptTarget: TargetGenerator<RichConfig, z.infer<typeof CriterionPromptReply>> = {
  accepts: (config, target) => !blank(criteriaOf(config).find((c) => c.id === target.id)?.title),
  instructions: [
    "The question is an essay graded by criteria. You write the grading prompt of ONE criterion, `prompt`, in plain text:",
    "a few sentences for the grader only, saying what the answer must state or explain to earn the criterion's weight,",
    "and what earns part of it (a fact stated without its explanation, for instance).",
    GRADER_CONTRACT,
    "Build it from the statement, the model answer (`reference`) when there is one, and the criterion's title and weight.",
    "Cover this criterion alone: the other criteria score what their titles name, so never repeat it.",
    "`rubric`, when written, is the teacher's global instructions: follow it, never copy it.",
  ].join(" "),
  ask(config, target) {
    const criteria = criteriaOf(config);
    const criterion = criteria.find((c) => c.id === target.id)!;
    const others = criteria.filter((c) => c !== criterion && !blank(c.title)).map((c) => `"${c.title.trim()}"`);
    return [
      `Write the prompt of the criterion "${criterion.title.trim()}" (id ${criterion.id}), worth ${criterion.weight}.`,
      others.length > 0 ? `The other criteria: ${others.join(", ")}.` : "It is the only criterion.",
    ].join(" ");
  },
  schema: CriterionPromptReply,
  place(config, target, value) {
    const prompt = value.prompt.trim().slice(0, RICH_MAX_CRITERION_PROMPT);
    if (prompt === "") return config;
    return { ...config, criteria: criteriaOf(config).map((c) => (c.id === target.id ? { ...c, prompt } : c)) };
  },
};

const CriteriaFromRubricReply = z.object({ criteria: RichProposal.shape.criteria, rubric: z.string() });

/**
 * "Convert to criteria" (ADR-118, amendment of 2026-10-27): an essay written
 * before criteria existed has its whole grading scheme in the free rubric;
 * the model splits it into criteria, and what applies to every criterion
 * stays the rubric. Only on a draft with a rubric and no criteria; a reply
 * with no criterion changes nothing, so the rubric is never emptied for
 * nothing.
 */
export const criteriaFromRubricTarget: TargetGenerator<RichConfig, z.infer<typeof CriteriaFromRubricReply>> = {
  accepts: (config) => criteriaOf(config).length === 0 && !blank(config.rubric),
  instructions: [
    "The question is an essay whose grading scheme is a free text, `rubric`. Split it into grading criteria:",
    "`criteria`, at most twelve, in the rubric's order, each a `title`, a `weight` and a `prompt`.",
    GRADER_CONTRACT,
    "`weight` is a whole number: the rubric's own points when it states them (double every weight when it uses half points),",
    "else 1 to 5 by importance.",
    "`title` is short and neutral, a few words naming what is judged, never the expected answer: a student may read it after grading.",
    "`prompt` is plain text for the grader: what earns the weight, what earns part of it. A common mistake the rubric lists",
    "goes into the prompt of the criterion it concerns.",
    "`rubric` keeps what applies to every criterion (spelling, language, length), else it is empty: nothing of the rubric is lost.",
  ].join(" "),
  ask: () => "Split the draft's `rubric` into criteria.",
  schema: CriteriaFromRubricReply,
  place(config, _target, value) {
    const criteria = proposedCriteria(value.criteria);
    if (criteria.length === 0) return config;
    return { ...config, criteria, rubric: value.rubric.trim().slice(0, RICH_MAX_RUBRIC) };
  },
};

export const richGenerator: AnswerGenerator<RichConfig, RichProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is an essay. Propose:",
    "`reference`, a model answer in Markdown, of the length and level the statement asks for (respect `maxChars` when set);",
    "`criteria`, two to five grading criteria, each a short `title`, a whole `weight` (its points) and a plain-text `prompt`.",
    GRADER_CONTRACT,
    "`rubric` is the grader's global instructions in Markdown, for what applies to every criterion; leave it empty when nothing does.",
    "A field the draft already fills is kept as the teacher wrote it: you may leave its proposal empty.",
  ].join(" "),
  proposalSchema: RichProposal,
  merge: mergeRich,
  targets: { [RICH_TARGETS.criterionPrompt]: criterionPromptTarget, [RICH_TARGETS.criteriaFromRubric]: criteriaFromRubricTarget },
};
