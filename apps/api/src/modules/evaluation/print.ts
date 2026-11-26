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
import { itemListLock } from "@quiz/domain";

/** A paper copy's refusal: its code, and the hand-out's refusal when it does not print (the 409's body). */
interface PaperEntryRefusal {
  code: (typeof PAPER_ENTRY_REFUSALS)[number];
  print: PrintRefusal | null;
}

import { evaluations, paperVariants } from "../../db/schema.js";
import { completeInstances, replays, sameVersion, typeOf, type InstanceAttempt } from "../pool/service.js";
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
 * parameterized item of `items`, completed and stored here by the draw rule
 * of an attempt's (`completeInstances`) — the one writer of
 * `paper_variants`.
 *
 *   - The row is created on the first call ({@link variantRow}).
 *   - The values an item lacks are drawn from the variant's seed. Before the
 *     opening (`itemListLock`), while the questions may still change, a
 *     stored entry is kept only when it was drawn for the item's current
 *     version: an edited or retargeted question is drawn again, the teacher
 *     printing again anyway, since old values may sit outside a corrected
 *     range or fail a corrected condition, which a replay does not check.
 *     After it, an entry is kept whenever it replays (ADR-056 §5); one that
 *     cannot — only a lost update leaves one, a print in flight writing
 *     values of the old names while the item was retargeted — is drawn
 *     again rather than refused for ever.
 *   - The row is written only when something was drawn; an entry of an item
 *     gone, or made static, drops at the next such write. Draws are a
 *     function of the seed, so two concurrent calls write the same values.
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
  const editable = itemListLock(evaluation.state, 0) === null;
  const { instances, drew } = completeInstances(items, row, editable ? sameVersion : replays);
  if (drew) {
    await db
      .update(paperVariants)
      .set({ instances, updatedAt: now })
      .where(and(eq(paperVariants.evaluationId, evaluation.id), eq(paperVariants.number, VARIANT)));
  }
  return { seed: row.seed, instances };
}

/**
 * The variant's row, created by the first caller in ONE statement: its seed
 * is the one an older server stored on the evaluation (`paper_seed`), else
 * one from the CSPRNG in the range of an attempt's (`drawSeed`); and that
 * seed is written back to `paper_seed` where it is null, so a rolled-back
 * image prints the same order. A concurrent first call keeps the row that
 * landed first. The contract migration removes the column, this write-back
 * and the `coalesce` read together (ADR-147 §2).
 */
async function variantRow(db: DbOrTx, evaluationId: string, now: Date) {
  const read = () =>
    db
      .select({ seed: paperVariants.seed, instances: paperVariants.instances })
      .from(paperVariants)
      .where(and(eq(paperVariants.evaluationId, evaluationId), eq(paperVariants.number, VARIANT)));
  const [found] = await read();
  if (found) return found;
  const at = now.toISOString();
  await db.execute(sql`
    with created as (
      insert into ${paperVariants} ("evaluation_id", "number", "seed", "created_at", "updated_at")
      select "id", ${VARIANT}, coalesce("paper_seed", ${randomInt(0, 0x7fffffff)}), ${at}::timestamptz, ${at}::timestamptz
      from ${evaluations} where "id" = ${evaluationId}
      on conflict do nothing
      returning "evaluation_id", "seed"
    )
    update ${evaluations} set "paper_seed" = coalesce(${evaluations}."paper_seed", created."seed")
    from created where ${evaluations}."id" = created."evaluation_id"`);
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
