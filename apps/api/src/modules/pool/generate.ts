/**
 * "Generate answers" (ADR-059): the question editor's wand. The type's
 * generator (`QuestionTypeServer.generator`) says what the model may propose
 * and how it merges; this file builds the prompt, calls the gateway of
 * ADR-058 and hands the merged draft back. Nothing is stored here: the
 * editor sets the result, its autosave stores it, and Undo reverts it.
 *
 * What is sent: the draft's config and explanation, nothing else — no name,
 * no student, no answer (open question 43 accepts question content only).
 */
import { z } from "zod";

import type { GenerateResult } from "@quiz/contracts";
import { questionType } from "@quiz/registry/server";

import type { LlmGateway } from "../llm/service.js";

/** Why a wand cannot run, before any model is asked. */
export class GenerateRefusal extends Error {
  constructor(readonly code: "generate_unsupported" | "statement_empty" | "item_not_empty") {
    super(code);
    this.name = "GenerateRefusal";
  }
}

/** The output budgets: a whole proposal, and one element. */
const MAX_TOKENS = { whole: 6_000, item: 1_500 } as const;

const SYSTEM = [
  "You help a teacher of the HEIG-VD, a Swiss school of engineering, finish a quiz question they are writing.",
  "You receive the draft as JSON and propose what it lacks; the teacher reviews it before anything reaches a student.",
  "Be correct above all: a wrong answer key is worse than none. When the statement is ambiguous, propose what its",
  "most natural reading calls for.",
  "Write in the language of the statement (French when it is unclear). Never change the statement.",
  "Text is Markdown. Keep every `[[…]]` expression (a parameter of the question) and every `asset:` link exactly as",
  "written.",
].join(" ");

const EXPLANATION =
  "`explanation`: why the answer is right, in a few sentences, as a student reads it after the evaluation " +
  "(Markdown). Leave it empty when the draft already has one.";

/** The types that have a wand. */
export function generatorTypes(types: readonly string[]): string[] {
  return types.filter((type) => questionType(type).generator !== undefined);
}

export async function generateAnswers(
  gateway: LlmGateway,
  input: { type: string; config: unknown; explanation: string; item?: number | undefined; userId: string },
): Promise<GenerateResult> {
  const generator = questionType(input.type).generator;
  if (!generator) throw new GenerateRefusal("generate_unsupported");
  // A draft may be anything (D16); the generator reads it defensively.
  const config = (input.config ?? {}) as never;
  if (generator.statement(config).trim() === "") throw new GenerateRefusal("statement_empty");

  const draft = [
    `Question type: ${input.type}.`,
    `The draft's config, as JSON:\n${JSON.stringify(input.config)}`,
    `The draft's explanation: ${input.explanation.trim() === "" ? "(empty)" : `\n${input.explanation}`}`,
  ].join("\n\n");

  if (input.item !== undefined) {
    const item = generator.item;
    if (!item) throw new GenerateRefusal("generate_unsupported");
    if (!item.accepts(config, input.item)) throw new GenerateRefusal("item_not_empty");
    const { value } = await gateway.complete({
      purpose: "generate",
      userId: input.userId,
      system: `${SYSTEM}\n\n${generator.instructions}`,
      prompt: `${draft}\n\nThe empty element is number ${input.item + 1}. ${item.instructions}`,
      schema: item.schema as z.ZodType<unknown>,
      maxTokens: MAX_TOKENS.item,
      effort: "low",
    });
    return { config: item.place(config, input.item, value), explanation: input.explanation };
  }

  const { value } = await gateway.complete({
    purpose: "generate",
    userId: input.userId,
    system: `${SYSTEM}\n\n${generator.instructions}\n\n${EXPLANATION}`,
    prompt: `${draft}\n\nPropose what the draft lacks.`,
    schema: z.object({ proposal: generator.proposalSchema as z.ZodType<unknown>, explanation: z.string() }),
    maxTokens: MAX_TOKENS.whole,
    effort: "low",
  });
  const explanation = input.explanation.trim() === "" ? value.explanation.trim().slice(0, 20_000) : input.explanation;
  return { config: generator.merge(config, value.proposal), explanation };
}
