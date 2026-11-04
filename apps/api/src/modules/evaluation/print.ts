/**
 * Whether an evaluation prints (ADR-125 §5): the one pure rule the detail's
 * `exports`, the document routes and the paper attempt to come all read.
 */
import type { EvaluationExports, PrintRefusal } from "@quiz/contracts";

import { isParameterized, typeOf } from "../pool/config.js";

/** The fields of an item the rule reads. */
interface PrintedItem {
  question: { type: string };
  version: { variables: { rows: readonly unknown[] } | null };
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
 * (run on a beamer, never printed), a parameterized item (ADR-056: a copy
 * has no draw), then every type missing a hook, each named once in the
 * items' order.
 */
export function printRefusal(
  evaluation: { mode: string },
  items: readonly PrintedItem[],
  document: Exclude<keyof typeof HOOKS, "copy">,
): PrintRefusal | null {
  if (evaluation.mode === "poll") return { reason: "poll", types: [] };
  if (items.some((i) => isParameterized(i.version))) return { reason: "parameterized", types: [] };
  const types = [...new Set(items.map((i) => i.question.type).filter((type) => !declares(type, document)))];
  return types.length === 0 ? null : { reason: "type", types };
}

/** Both documents' refusals, for the export sheet (`EvaluationDetail.exports`). */
export const exportsOf = (evaluation: { mode: string }, items: readonly PrintedItem[]): EvaluationExports => ({
  document: printRefusal(evaluation, items, "document"),
  handout: printRefusal(evaluation, items, "handout"),
});
