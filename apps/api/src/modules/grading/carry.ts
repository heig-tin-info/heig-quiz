/**
 * The partial retake of an exercise (ADR-090), on the grading side: which
 * questions of an attempt are acquired, and the copy of their validated
 * gradings onto the retake that carries them over.
 *
 * The rule is `@quiz/domain#itemStanding`; this file feeds it the validated
 * points of one attempt. The retake (`live/attempt.ts`), the results page
 * (`results/service.ts`) and the retake count it offers all read the same
 * answer from here.
 *
 * Imported through `./service.ts`. It reads and writes `gradings` (this
 * module's table) only; the answers it points at are copied by `live`.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { itemStanding, type ItemStanding, type StandingInput } from "@quiz/domain";

import { gradings } from "../../db/schema.js";
import type { DbOrTx, JoinedItem } from "../evaluation/service.js";

/** One item of an attempt, with what {@link itemStanding} read and what it said. */
export interface ItemStandingRow extends StandingInput {
  id: string;
  standing: ItemStanding;
}

/**
 * Each item's standing in one attempt (ADR-090 §2), in the order of
 * `items`: its points as the evaluation gives them, and its validated
 * points — a proposal counts as none.
 */
export async function standingsOf(
  db: DbOrTx,
  items: readonly JoinedItem[],
  attemptId: string,
): Promise<ItemStandingRow[]> {
  const rows = await db
    .select({ itemId: gradings.itemId, points: gradings.points })
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")));
  const points = new Map(rows.map((r) => [r.itemId, r.points]));
  return items.map((item) => {
    const input = { maxPoints: item.item.points, validatedPoints: points.get(item.item.id) ?? null };
    return { id: item.item.id, ...input, standing: itemStanding(input) };
  });
}

/**
 * Copies the VALIDATED grading of each carried item from attempt n onto the
 * partial retake n + 1 (ADR-090 §3): a frozen snapshot, new ids, pointing at
 * the copied answer (`answerIds`, item → the copy's id; `null` for an item
 * that had no answer). The copy starts a chain of its own (`supersedesId`
 * null): its history is attempt n's.
 *
 * Because the cell holds a validated grading, the hand-in pass skips it like
 * any settled cell; a regrade of the item (`regradeItem`) stands it down and
 * grades the copied answer again, like every other cell of the item. An
 * item carried with no validated grading (one worth nothing) has nothing to
 * copy and is graded at hand-in.
 *
 * Runs inside the retake's transaction, where the evaluation is running, so
 * no released grade can move (`flagReleasedEvaluationsOf` has nothing to do).
 */
export async function copyValidatedGradings(
  tx: DbOrTx,
  input: {
    fromAttemptId: string;
    toAttemptId: string;
    answerIds: ReadonlyMap<string, string | null>;
    now: Date;
  },
): Promise<void> {
  const itemIds = [...input.answerIds.keys()];
  if (itemIds.length === 0) return;
  const rows = await tx
    .select()
    .from(gradings)
    .where(
      and(
        eq(gradings.attemptId, input.fromAttemptId),
        eq(gradings.state, "validated"),
        inArray(gradings.itemId, itemIds),
      ),
    );
  if (rows.length === 0) return;
  await tx.insert(gradings).values(
    rows.map((row) => ({
      ...row,
      id: randomUUID(),
      attemptId: input.toAttemptId,
      answerId: input.answerIds.get(row.itemId) ?? null,
      supersedesId: null,
      createdAt: input.now,
    })),
  );
}
