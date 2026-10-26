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

import type { RunnerService } from "./runner.js";

/**
 * What running could not settle after a merge: the platform has no runner
 * (or it is busy), the merged draft is not valid enough to run, the
 * reference did not compile, or some of what it should produce did not come
 * (a case that timed out, a picture with a missing pixel). The draft comes
 * back merged all the same; the editor says what is left to do.
 */
/**
 * Two items of a list are the same when this says so: trimmed, lower-cased,
 * spaces collapsed. The ONE rule of "never repeat a text the list holds",
 * for the wand's fill-and-append (ADR-059 §2) and the assistant's (ADR-080
 * P3, decision 1).
 */
export const sameItemText = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * How the editor names a free-text field in the assistant's diff, a closed
 * list the web translates (`assist.edit.<label>`); an item of a list is
 * numbered ("Choice 2"). A type whose field fits none adds one here, and
 * its English and French strings beside the others.
 */
export const ASSIST_TEXT_LABELS = ["statement", "choice", "column", "card", "case"] as const;
export type AssistTextLabel = (typeof ASSIST_TEXT_LABELS)[number];

export const GENERATE_INCOMPLETE = ["runner_unavailable", "draft_invalid", "compile_failed", "partial"] as const;
export type GenerateIncomplete = (typeof GENERATE_INCOMPLETE)[number];

/**
 * A part of the draft the wand writes on its own, beside the whole-question
 * proposal and the one-element `item`: the grading prompt of one essay
 * criterion, an essay's free rubric split into criteria (ADR-118). A closed
 * list, so the request schema (`@quiz/contracts`) and the editors name the
 * same targets; a type serves the ones it declares in `targets`.
 */
export type GenerateTarget = { kind: "criterionPrompt"; criterionId: string } | { kind: "criteriaFromRubric" };
export type GenerateTargetKind = GenerateTarget["kind"];

/**
 * How a type writes one target: whether the draft allows it, what to ask,
 * the reply's narrow schema, and where the reply goes. Like `merge`, `place`
 * is pure and tested without a model.
 */
export interface TargetGenerator<TConfig, TTarget extends GenerateTarget, TValue = unknown> {
  /** Whether the draft allows the target now (the criterion exists and has a title, the rubric is written…). */
  accepts(config: TConfig, target: TTarget): boolean;
  /** What the model must know, in English, for the system prompt. */
  instructions: string;
  /** The request's last line: what to write, named (a criterion's id). */
  ask(config: TConfig, target: TTarget): string;
  schema: z.ZodType<TValue>;
  place(config: TConfig, target: TTarget, value: TValue): TConfig;
}

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
   * What only RUNNING can produce, after the merge — the expected outputs of
   * a code question, the target of a picture — computed from the reference
   * on the runner, never taken from the model (ADR-059 §7). Unlike the other
   * hooks it receives a config the caller has VALIDATED with `configSchema`.
   * It throws the runner's own `RunnerUnavailable` / `RunnerBusy`; the
   * caller reports them.
   */
  settle?(config: TConfig, runner: RunnerService): Promise<{ config: TConfig; incomplete?: GenerateIncomplete }>;
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
  /** The targets this type writes on their own ({@link GenerateTarget}). Absent: none. */
  targets?: { [K in GenerateTargetKind]?: TargetGenerator<TConfig, Extract<GenerateTarget, { kind: K }>> };
}
