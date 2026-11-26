/**
 * Whether an evaluation prints (ADR-125 §5): the one pure rule the detail's
 * `exports`, the document routes and the paper attempt all read — and the
 * paper's variant (ADR-147): its secret seed and its stored values, which
 * the hand-out, the statement with key, the blank print and the paper
 * attempt share.
 */
import { randomInt } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { EvaluationExports, PAPER_ENTRY_REFUSALS, PrintRefusal } from "@quiz/contracts";
import { ITEM_LIST_EDITABLE_STATES, type EvaluationStateName } from "@quiz/domain";
import { ParameterError } from "@quiz/domain/parameters";

/** A paper copy's refusal: its code, and the hand-out's refusal when it does not print (the 409's body). */
interface PaperEntryRefusal {
  code: (typeof PAPER_ENTRY_REFUSALS)[number];
  print: PrintRefusal | null;
}

import type { StoredInstance } from "../../db/columns.js";
import { evaluations, paperVariants } from "../../db/schema.js";
import { instanceOf, InstanceMismatch, typeOf, type InstanceAttempt } from "../pool/service.js";
import type { JoinedItem } from "./reads.js";
import type { DbOrTx, EvaluationRecord } from "./shared.js";

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
 * a variant, which has its draw (ADR-147).
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

/** The one variant this step prints (ADR-147); the number a later label derives from. */
const VARIANT = 1;

/**
 * `evaluation`'s paper variant (ADR-147): its seed, and the values of every
 * parameterized item of `items`, each drawn from that seed by the stream of
 * an attempt's (`instanceOf`), completed and stored here — the one writer of
 * `paper_variants`.
 *
 *   - The row is created on the first call, from the CSPRNG in the range of
 *     an attempt's seed (`drawSeed`), or from a seed an older server stored
 *     on the evaluation (`paper_seed`, read in the same statement); a
 *     concurrent first call keeps the row that landed first.
 *   - Stored values that still fit their item are kept, never redrawn; the
 *     values an item lacks are drawn now. Before the opening, while the
 *     items may still change, values that no longer fit their version (its
 *     variable names changed, or a replay fails) are dropped and drawn again;
 *     after it, nothing is redrawn and a read replays them as an attempt's
 *     are (ADR-056 §5). An item no longer in `items` keeps nothing.
 *   - Draws are a function of the seed alone, so two concurrent calls write
 *     the same values.
 *
 * Never returned to a client nor logged: the callers hand it to the `live`
 * module's builders only.
 */
export async function paperVariant(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  items: readonly JoinedItem[],
  now: Date,
): Promise<InstanceAttempt> {
  const row = await variantRow(db, evaluation.id, now);
  const redraw = ITEM_LIST_EDITABLE_STATES.includes(evaluation.state as EvaluationStateName);
  const instances: Record<string, StoredInstance> = {};
  let changed = Object.keys(row.instances).some((id) => !items.some((entry) => entry.item.id === id));
  for (const entry of items) {
    const at = { seed: row.seed, itemId: entry.item.id };
    const kept = row.instances[entry.item.id];
    const stored = kept && (!redraw || fits(entry, { ...at, stored: kept })) ? kept : instanceOf(entry.question.type, entry.version, at).stored;
    if (stored) instances[entry.item.id] = stored;
    if ((stored ?? undefined) !== kept) changed = true;
  }
  if (changed) {
    await db
      .update(paperVariants)
      .set({ instances, updatedAt: now })
      .where(and(eq(paperVariants.evaluationId, evaluation.id), eq(paperVariants.number, VARIANT)));
  }
  return { seed: row.seed, instances };
}

/** Whether `stored` still renders `entry`'s version: the same version, or a replay under the same names. */
function fits(entry: JoinedItem, at: { seed: number; itemId: string; stored: StoredInstance }): boolean {
  try {
    instanceOf(entry.question.type, entry.version, at);
    return true;
  } catch (error) {
    if (error instanceof InstanceMismatch || error instanceof ParameterError) return false;
    throw error;
  }
}

/** The variant's row, created by the first caller. */
async function variantRow(db: DbOrTx, evaluationId: string, now: Date) {
  const read = () =>
    db
      .select({ seed: paperVariants.seed, instances: paperVariants.instances })
      .from(paperVariants)
      .where(and(eq(paperVariants.evaluationId, evaluationId), eq(paperVariants.number, VARIANT)));
  const [found] = await read();
  if (found) return found;
  await db
    .insert(paperVariants)
    .values({
      evaluationId,
      number: VARIANT,
      seed: sql`coalesce((select ${evaluations.paperSeed} from ${evaluations} where ${evaluations.id} = ${evaluationId}), ${randomInt(0, 0x7fffffff)})`,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [created] = await read();
  if (!created) throw new Error(`evaluation ${evaluationId} has no paper variant`);
  return created;
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
