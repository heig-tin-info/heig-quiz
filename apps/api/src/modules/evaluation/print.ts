/**
 * Whether an evaluation prints (ADR-125 §5): the one pure rule the detail's
 * `exports`, the document routes and the paper attempt all read — and the
 * paper's secret order (ADR-125 §8), which the hand-out, the blank print and
 * the paper attempt share.
 */
import { randomInt } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { EvaluationExports, PAPER_ENTRY_REFUSALS, PrintRefusal } from "@quiz/contracts";

/** A paper copy's refusal: its code, and the hand-out's refusal when it does not print (the 409's body). */
interface PaperEntryRefusal {
  code: (typeof PAPER_ENTRY_REFUSALS)[number];
  print: PrintRefusal | null;
}

import { evaluations } from "../../db/schema.js";
import { isParameterized, typeOf } from "../pool/config.js";
import type { DbOrTx, EvaluationRecord } from "./shared.js";

/** The fields of an item the rule reads. */
interface PrintedItem {
  question: { type: string };
  version: { variables: { rows: readonly unknown[] } | null };
}

/**
 * What each document needs of a type (ADR-125 §5): the hand-out a statement
 * and an answer zone, the staff "statement with key" a statement. A type
 * declares each by implementing the hook; no list of type names lives here.
 */
const HOOKS = {
  handout: ["statementDoc", "answerZone"],
  document: ["statementDoc"],
} as const;

/**
 * Why `evaluation` does not make `document`, or `null` when it does: a poll
 * (run on a beamer, never printed), a parameterized item (ADR-056: a copy
 * has no draw), then every type missing a hook, each named once in the
 * items' order.
 */
export function printRefusal(
  evaluation: { mode: string },
  items: readonly PrintedItem[],
  document: keyof typeof HOOKS,
): PrintRefusal | null {
  if (evaluation.mode === "poll") return { reason: "poll", types: [] };
  if (items.some((i) => isParameterized(i.version))) return { reason: "parameterized", types: [] };
  const lacks = (type: string) => HOOKS[document].some((hook) => typeOf(type)[hook] === undefined);
  const types = [...new Set(items.map((i) => i.question.type).filter(lacks))];
  return types.length === 0 ? null : { reason: "type", types };
}

/**
 * The seed of `evaluation`'s paper (ADR-125 §8): the stored one, or one drawn
 * now and stored by a single statement, so two first prints at the same
 * second keep the one that landed first. In the range of an attempt's seed
 * (`drawSeed`), from the CSPRNG: a printed order must not be predictable.
 * Never returned to a client nor logged. Read by the hand-out and by the
 * paper attempt (through the service), so a typed copy follows the paper.
 */
export async function paperSeedOf(db: DbOrTx, evaluation: EvaluationRecord): Promise<number> {
  if (evaluation.paperSeed !== null) return evaluation.paperSeed;
  const [row] = await db
    .update(evaluations)
    .set({ paperSeed: sql`coalesce(${evaluations.paperSeed}, ${randomInt(0, 0x7fffffff)})` })
    .where(eq(evaluations.id, evaluation.id))
    .returning({ seed: evaluations.paperSeed });
  if (row?.seed == null) throw new Error(`evaluation ${evaluation.id} has no paper seed`);
  return row.seed;
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

/** The documents' refusals and the paper copy's, for the export sheet and the rows (`EvaluationDetail.exports`). */
export const exportsOf = (
  evaluation: Parameters<typeof paperRefusal>[0],
  items: readonly PrintedItem[],
): EvaluationExports => ({
  document: printRefusal(evaluation, items, "document"),
  handout: printRefusal(evaluation, items, "handout"),
  paper: paperRefusal(evaluation, items)?.code ?? null,
});
