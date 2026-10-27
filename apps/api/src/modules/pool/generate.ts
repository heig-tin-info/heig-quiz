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
import {
  RunnerBusy,
  RunnerUnavailable,
  type GenerateTarget,
  type RunnerService,
  type TargetGenerator,
} from "@quiz/core/server";
import { questionType } from "@quiz/registry/server";

import type { LlmGateway } from "../llm/service.js";

/** A registered type's generator, and how it writes one part of the draft. */
type Generator = NonNullable<ReturnType<typeof questionType>["generator"]>;
type Writer = TargetGenerator<Parameters<Generator["merge"]>[0]>;

/** Why a wand cannot run, before any model is asked: `400 { error: code }`. */
export class GenerateRefusal extends Error {
  readonly status = 400;
  constructor(readonly code: "generate_unsupported" | "statement_empty" | "item_not_empty" | "target_unavailable") {
    super(code);
    this.name = "GenerateRefusal";
  }
}

/**
 * The output budgets: a whole proposal (a program and its cases, at worst),
 * one element, and one target (a rubric split into a dozen criteria, at worst).
 */
const MAX_TOKENS = { whole: 12_000, item: 1_500, target: 6_000 } as const;

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

/**
 * The part of the draft a request asks for, as ONE shape: a target the type
 * declares (ADR-118; its own instructions, not the whole question's, which
 * ask for more), or the element of `item` (an MCQ choice, ADR-059) adapted
 * to it. `null`: the whole question. A kind the type does not declare, or
 * an element of a type without one, is `generate_unsupported`.
 */
function partOf(
  generator: Generator,
  input: { item?: number | undefined; target?: GenerateTarget | undefined },
): { writer: Writer; target: GenerateTarget; refusal: "item_not_empty" | "target_unavailable"; maxTokens: number } | null {
  if (input.target !== undefined) {
    const targets = generator.targets ?? {};
    // Own keys only: a kind is a request's word, and `constructor` is not a target.
    const writer = Object.hasOwn(targets, input.target.kind) ? targets[input.target.kind] : undefined;
    if (!writer) throw new GenerateRefusal("generate_unsupported");
    return { writer, target: input.target, refusal: "target_unavailable", maxTokens: MAX_TOKENS.target };
  }
  if (input.item === undefined) return null;
  const item = generator.item;
  if (!item) throw new GenerateRefusal("generate_unsupported");
  const index = input.item;
  const writer: Writer = {
    accepts: (config) => item.accepts(config, index),
    instructions: generator.instructions,
    ask: () => `The empty element is number ${index + 1}. ${item.instructions}`,
    schema: item.schema,
    place: (config, _target, value) => item.place(config, index, value),
  };
  return { writer, target: { kind: "item" }, refusal: "item_not_empty", maxTokens: MAX_TOKENS.item };
}

export async function generateAnswers(
  gateway: LlmGateway,
  runner: RunnerService,
  input: {
    type: string;
    config: unknown;
    explanation: string;
    item?: number | undefined;
    target?: GenerateTarget | undefined;
    userId: string;
  },
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

  const part = partOf(generator, input);
  if (part) {
    // One part of the draft: the explanation is left as it is.
    if (!part.writer.accepts(config, part.target)) throw new GenerateRefusal(part.refusal);
    const { value } = await gateway.complete({
      purpose: "generate",
      userId: input.userId,
      system: `${SYSTEM}\n\n${part.writer.instructions}`,
      prompt: `${draft}\n\n${part.writer.ask(config, part.target)}`,
      schema: part.writer.schema,
      maxTokens: part.maxTokens,
      effort: "low",
    });
    return { config: part.writer.place(config, part.target, value), explanation: input.explanation };
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
  const merged = generator.merge(config, value.proposal);
  if (!generator.settle) return { config: merged, explanation };
  // What only running produces (expected outputs, a target), on the runner,
  // and only from a config that validates — as Try runs only a valid one.
  // Otherwise, or without a runner, the merge comes back as it is and the
  // editor says what is left to do.
  const valid = questionType(input.type).configSchema.safeParse(merged);
  if (!valid.success) return { config: merged, explanation, incomplete: "draft_invalid" };
  try {
    const settled = await generator.settle(valid.data, runner);
    // Nothing run or written: the draft as merged, not as the schema parsed
    // it (no default filled in, no key dropped behind the teacher's back).
    const out = settled.config === valid.data ? merged : settled.config;
    return { config: out, explanation, ...(settled.incomplete ? { incomplete: settled.incomplete } : {}) };
  } catch (error) {
    if (error instanceof RunnerUnavailable || error instanceof RunnerBusy) {
      return { config: merged, explanation, incomplete: "runner_unavailable" };
    }
    throw error;
  }
}
