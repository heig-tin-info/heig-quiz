/**
 * Whether an evaluation prints (ADR-125 §5): the one pure rule the detail's
 * `exports`, the document routes and the paper attempt all read. The paper's
 * variants are `variants.ts`'s.
 */
import type { EvaluationExports, PAPER_ENTRY_REFUSALS, PaperVariantsState, PrintRefusal } from "@quiz/contracts";

/** A paper copy's refusal: its code, and the hand-out's refusal when it does not print (the 409's body). */
interface PaperEntryRefusal {
  code: (typeof PAPER_ENTRY_REFUSALS)[number];
  print: PrintRefusal | null;
}

import { typeOf } from "../pool/service.js";

/** The fields of an item the rule reads. */
interface PrintedItem {
  question: { type: string };
}

/**
 * What each document needs of a type (ADR-125 §5): the hand-out a statement
 * and an answer zone, the staff "statement with key" a statement, a copy a
 * statement and the student's answer. A type declares each by implementing
 * the hook; no list of type names lives here.
 */
const HOOKS = {
  handout: ["statementDoc", "answerZone"],
  document: ["statementDoc"],
  copy: ["statementDoc", "studentAnswerDoc"],
} as const;

/** Whether `type` implements every hook `document` needs of it. */
export const declares = (type: string, document: keyof typeof HOOKS): boolean =>
  HOOKS[document].every((hook) => typeOf(type)[hook] !== undefined);

/**
 * Why `evaluation` does not make `document`, or `null` when it does: a poll
 * (run on a beamer, never printed), then every type missing a hook, each
 * named once in the items' order. A parameterized item prints: the paper is
 * a variant, which has its draw (ADR-148).
 */
export function printRefusal(
  evaluation: { mode: string },
  items: readonly PrintedItem[],
  document: Exclude<keyof typeof HOOKS, "copy">,
): PrintRefusal | null {
  if (evaluation.mode === "poll") return { reason: "poll", types: [] };
  const types = [...new Set(items.map((i) => i.question.type).filter((type) => !declares(type, document)))];
  return types.length === 0 ? null : { reason: "type", types };
}

/**
 * Why `evaluation` takes no paper copy (ADR-125 §11), or `null` when it does:
 * an exam, not released, that has run, and prints. The one rule of the
 * submission, of the entry page's read and of the screens' row action
 * (`EvaluationDetail.exports.paper`).
 */
export function paperRefusal(
  evaluation: { mode: string; state: string; startedAt: Date | null },
  items: readonly PrintedItem[],
): PaperEntryRefusal | null {
  if (evaluation.mode !== "exam") return { code: "paper_mode", print: null };
  if (evaluation.state === "released") return { code: "paper_released", print: null };
  if (evaluation.startedAt === null) return { code: "paper_not_started", print: null };
  const print = printRefusal(evaluation, items, "handout");
  return print && { code: "not_printable", print };
}

/**
 * The documents' refusals and the paper copy's, for the export sheet and the
 * rows (`EvaluationDetail.exports`), with the paper's `variants` read apart.
 */
export const exportsOf = (
  evaluation: Parameters<typeof paperRefusal>[0],
  items: readonly PrintedItem[],
  variants: PaperVariantsState,
): EvaluationExports => ({
  document: printRefusal(evaluation, items, "document"),
  handout: printRefusal(evaluation, items, "handout"),
  paper: paperRefusal(evaluation, items)?.code ?? null,
  variants,
});
