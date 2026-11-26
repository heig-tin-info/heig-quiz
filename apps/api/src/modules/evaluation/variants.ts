/**
 * The paper variants of an evaluation (ADR-148), and the one writer of
 * `paper_variants`. A variant is one draw of the whole printed paper: its
 * item and choice order recomputed from a secret seed, the values of its
 * parameterized items stored. An evaluation has 1 to 26, numbered and
 * lettered A to Z; the hand-out, its key, a paper copy typed from it all
 * read the same variant.
 *
 *   - {@link paperVariant}: one variant's seed and values, completed and
 *     stored at each print and paper entry;
 *   - {@link setPaperVariantCount}, {@link redrawPaperVariants}: the export
 *     sheet's two writes, under the evaluation's row lock, refused by the
 *     pure rules of `@quiz/domain/paperVariants` once the evaluation opened,
 *     when a printed stack may be in a student's hands;
 *   - {@link paperVariantsState}: what the sheet reads, never a seed.
 *
 * The seeds never leave this module but to the `live` module's builders.
 */
import { randomInt } from "node:crypto";

import { and, count, eq, gt, sql } from "drizzle-orm";

import type { PaperVariantRef, PaperVariantsState } from "@quiz/contracts";
import { itemListLock, paperVariantsLocked, variantCountRefusal, variantLetter, variesOnPaper } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { evaluations, paperVariants } from "../../db/schema.js";
import { completeInstances, isParameterized, replays, sameVersion, type InstanceAttempt } from "../pool/service.js";
import { joinedItems, settingsOf, type JoinedItem } from "./reads.js";
import { EvaluationError, type DbOrTx, type EvaluationRecord } from "./shared.js";

/** A seed in the range of an attempt's (`drawSeed`), from the CSPRNG: a printed order must not be predictable. */
const drawPaperSeed = (): number => randomInt(0, 0x7fffffff);

const variantWhere = (evaluationId: string, number: number) =>
  and(eq(paperVariants.evaluationId, evaluationId), eq(paperVariants.number, number));

/** How many variants the paper has: 1 while none was printed (variant 1 is made by the first print). */
export async function paperVariantCount(db: DbOrTx, evaluationId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(paperVariants).where(eq(paperVariants.evaluationId, evaluationId));
  return Math.max(1, row?.n ?? 0);
}

/** Variant `number` of a paper of `of` variants, as the documents and a paper copy name it. */
export const variantRef = (number: number, of: number): PaperVariantRef => ({ number, letter: variantLetter(number), of });

const variesOf = (evaluation: EvaluationRecord, items: readonly Pick<JoinedItem, "version">[]): boolean =>
  variesOnPaper(settingsOf(evaluation), items.some((i) => isParameterized(i.version)));

/** The export sheet's view of the variants (`EvaluationDetail.exports.variants`): never a seed. */
export async function paperVariantsState(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  items: readonly Pick<JoinedItem, "version">[],
): Promise<PaperVariantsState> {
  return {
    count: await paperVariantCount(db, evaluation.id),
    varies: variesOf(evaluation, items),
    locked: paperVariantsLocked(evaluation.state),
  };
}

/**
 * Variant `number` of `evaluation`'s paper: its name (`ref`: number, letter,
 * count), and as `attempt` its seed and the values of every parameterized
 * item of `items`, completed and stored here by the draw rule of an
 * attempt's (`completeInstances`). The one check of a variant's number.
 *
 *   - Variant 1 is created on the first call ({@link firstVariant}); any
 *     other exists only once the count was raised to it, else `422
 *     variant_unknown`.
 *   - The values an item lacks are drawn from the variant's seed. Before the
 *     opening (`itemListLock`), while the questions may still change, a
 *     stored entry is kept only when it was drawn for the item's current
 *     version: an edited or retargeted question is drawn again, the teacher
 *     printing again anyway, since old values may sit outside a corrected
 *     range or fail a corrected condition, which a replay does not check.
 *     After it, an entry is kept whenever it replays (ADR-056 §5); one that
 *     cannot — values of other names, or a regrade's version whose derived
 *     rows fail on them — is drawn again rather than refused for ever.
 *   - The row is written only when something was drawn; an entry of an item
 *     gone, or made static, drops at the next such write. Draws are a
 *     function of the seed, so two concurrent calls draw the same values,
 *     and the write lands only over the values this call read.
 *
 * Never returned to a client nor logged: the callers hand it to the `live`
 * module's builders only.
 */
export async function paperVariant(
  db: DbOrTx,
  evaluation: EvaluationRecord,
  items: readonly JoinedItem[],
  now: Date,
  number = 1,
): Promise<{ ref: PaperVariantRef; attempt: InstanceAttempt }> {
  const row = number === 1 ? await firstVariant(db, evaluation.id, now) : await variantRow(db, evaluation.id, number);
  const of = await paperVariantCount(db, evaluation.id);
  if (!row || number > of) throw new EvaluationError("variant_unknown");
  const editable = itemListLock(evaluation.state, 0) === null;
  const { instances, drew } = completeInstances(items, row, editable ? sameVersion : replays);
  if (drew) {
    await db
      .update(paperVariants)
      .set({ instances, updatedAt: now })
      // Only over the values this call read: a print that started before a
      // retarget or a Redraw must not write its older draw over a newer one.
      .where(and(variantWhere(evaluation.id, number), eq(paperVariants.instances, row.instances)));
  }
  return { ref: variantRef(number, of), attempt: { seed: row.seed, instances } };
}

async function variantRow(db: DbOrTx, evaluationId: string, number: number) {
  const [row] = await db
    .select({ seed: paperVariants.seed, instances: paperVariants.instances })
    .from(paperVariants)
    .where(variantWhere(evaluationId, number));
  return row ?? null;
}

/**
 * Variant 1, created by the first caller in ONE statement: its seed is the
 * one an older server stored on the evaluation (`paper_seed`), else a new
 * one; and that seed is written back to `paper_seed` where it is null, so a
 * rolled-back image prints the same order. A concurrent first call keeps the
 * row that landed first. The contract migration removes the column, this
 * write-back, the `coalesce` read and Redraw's write-back together (ADR-148
 * §2).
 */
async function firstVariant(db: DbOrTx, evaluationId: string, now: Date) {
  const found = await variantRow(db, evaluationId, 1);
  if (found) return found;
  const at = now.toISOString();
  await db.execute(sql`
    with created as (
      insert into ${paperVariants} ("evaluation_id", "number", "seed", "created_at", "updated_at")
      select "id", 1, coalesce("paper_seed", ${drawPaperSeed()}), ${at}::timestamptz, ${at}::timestamptz
      from ${evaluations} where "id" = ${evaluationId}
      on conflict do nothing
      returning "evaluation_id", "seed"
    )
    update ${evaluations} set "paper_seed" = coalesce(${evaluations}."paper_seed", created."seed")
    from created where ${evaluations}."id" = created."evaluation_id"`);
  return variantRow(db, evaluationId, 1);
}

/** The evaluation's row, locked until the transaction ends: the two writes below serialize on it. */
async function lockedEvaluation(tx: DbOrTx, evaluationId: string): Promise<EvaluationRecord> {
  const [row] = await tx.select().from(evaluations).where(eq(evaluations.id, evaluationId)).for("update");
  if (!row) throw new EvaluationError("not_found");
  return row;
}

/**
 * Sets how many variants the paper has (ADR-148 §2): the missing ones made
 * with seeds of their own, the highest numbers removed. More than one is
 * refused where nothing varies (`422 variants_identical`), fewer once the
 * evaluation opened (`409 variants_locked`). Answers the counts before and
 * after, for the audit.
 */
export function setPaperVariantCount(
  db: Db,
  evaluation: EvaluationRecord,
  to: number,
  now: Date,
): Promise<{ from: number; to: number }> {
  return db.transaction(async (tx) => {
    const row = await lockedEvaluation(tx, evaluation.id);
    const from = await paperVariantCount(tx, row.id);
    const refusal = variantCountRefusal(from, to, {
      varies: variesOf(row, await joinedItems(tx, row.id)),
      locked: paperVariantsLocked(row.state),
    });
    if (refusal) throw new EvaluationError(refusal);
    if (to > 1) {
      await firstVariant(tx, row.id, now);
      const added = Array.from({ length: Math.max(0, to - from) }, (_, i) => ({
        evaluationId: row.id,
        number: from + 1 + i,
        seed: drawPaperSeed(),
        createdAt: now,
        updatedAt: now,
      }));
      if (added.length > 0) await tx.insert(paperVariants).values(added).onConflictDoNothing();
    }
    await tx.delete(paperVariants).where(and(eq(paperVariants.evaluationId, row.id), gt(paperVariants.number, to)));
    return { from, to };
  });
}

/**
 * Redraw (ADR-148 §2): every variant gets a new seed and loses its stored
 * values, so the next print draws them again; `paper_seed` follows variant
 * 1's (the rollback write-back). Refused like fewer variants (`409
 * variants_locked`): a paper already printed would no longer match. Answers
 * how many variants were drawn again, none before the first print.
 */
export function redrawPaperVariants(db: Db, evaluation: EvaluationRecord, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const row = await lockedEvaluation(tx, evaluation.id);
    if (paperVariantsLocked(row.state)) throw new EvaluationError("variants_locked");
    const variants = await tx
      .select({ number: paperVariants.number })
      .from(paperVariants)
      .where(eq(paperVariants.evaluationId, row.id));
    for (const { number } of variants) {
      const seed = drawPaperSeed();
      await tx.update(paperVariants).set({ seed, instances: {}, updatedAt: now }).where(variantWhere(row.id, number));
      if (number === 1) await tx.update(evaluations).set({ paperSeed: seed }).where(eq(evaluations.id, row.id));
    }
    return variants.length;
  });
}
