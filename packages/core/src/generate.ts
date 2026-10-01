/**
 * What a question type tells the LLM gateway to complete a draft
 * ("Generate answers", ADR-059). Optional: a type without a generator shows
 * no wand.
 *
 * The model never sees nor writes the whole config. It reads the draft and
 * returns a PROPOSAL in the type's own narrow schema (the choices, the
 * expected answers, the model answer…), and the type MERGES it: it fills
 * what is empty and completes what is listed, and never changes the
 * statement, the settings, nor anything the teacher wrote (ADR-059 §2). The
 * merge is pure, so it is tested without a model.
 *
 * The config handed to every hook is the editor's UNVALIDATED draft
 * (decision D16): typed `TConfig` for convenience, read defensively — a list
 * may be missing or not a list at all.
 */
import type { z } from "zod";

export interface AnswerGenerator<TConfig, TProposal = unknown, TItem = unknown> {
  /** The draft's statement: the wand is refused while it is empty. */
  statement(config: TConfig): string;
  /** What the model must know of this type, in English: what to propose and how. */
  instructions: string;
  /** The proposal's shape, handed to the model as a structured output. */
  proposalSchema: z.ZodType<TProposal>;
  /** The draft with the proposal merged in: the empty filled, the rest kept. */
  merge(config: TConfig, proposal: TProposal): TConfig;
  /**
   * One element of the type's list, at `index` (the wand of one MCQ choice):
   * the element must be empty there. Absent: no per-element wand.
   */
  item?: {
    instructions: string;
    schema: z.ZodType<TItem>;
    /** Whether the element at `index` exists and is empty. */
    accepts(config: TConfig, index: number): boolean;
    place(config: TConfig, index: number, item: TItem): TConfig;
  };
}
