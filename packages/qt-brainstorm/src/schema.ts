/**
 * The `brainstorm` schemas (issue #458, ADR-071): a question that has no
 * answer key at all. Participants type short ideas; a poll gathers them into
 * a bubble cloud. It is run by a poll only: `hasKey` is always false, so an
 * exam, an exercise or a template refuses it like any keyless question
 * (`422 question_keyless`).
 */
import { BRAINSTORM_IDEA_MAX, BRAINSTORM_MAX_IDEAS, ideasOf } from "@quiz/domain";
import { z } from "zod";

export const BRAINSTORM_CONFIG_VERSION = 1;

export const BrainstormConfigSchema = z.object({
  configVersion: z.literal(BRAINSTORM_CONFIG_VERSION),
  prompt: z.string().min(1).max(20_000),
  /** How many ideas one participant may hold at once. */
  maxIdeas: z.number().int().min(1).max(BRAINSTORM_MAX_IDEAS).default(5),
});
export type BrainstormConfig = z.infer<typeof BrainstormConfigSchema>;

/** Each idea a few words, never blank. Over `maxIdeas` is `answerMisfit`'s. */
export const BrainstormAnswerSchema = z.object({
  ideas: z.array(z.string().trim().min(1).max(BRAINSTORM_IDEA_MAX)).max(BRAINSTORM_MAX_IDEAS),
});
export type BrainstormAnswer = z.infer<typeof BrainstormAnswerSchema>;

export const BrainstormStudentSchema = z.object({
  prompt: z.string(),
  maxIdeas: z.number().int(),
});
export type BrainstormStudent = z.infer<typeof BrainstormStudentSchema>;

/** Nothing is right: there is no solution to show. */
export const BrainstormSolutionSchema = z.null();
export type BrainstormSolution = z.infer<typeof BrainstormSolutionSchema>;

export const BrainstormDetailsSchema = z.object({});
export type BrainstormDetails = z.infer<typeof BrainstormDetailsSchema>;

export function emptyBrainstormDraft(): BrainstormConfig {
  return { configVersion: BRAINSTORM_CONFIG_VERSION, prompt: "", maxIdeas: 5 };
}

export const isBrainstormAnswered = (answer: BrainstormAnswer): boolean => ideasOf(answer).length > 0;
