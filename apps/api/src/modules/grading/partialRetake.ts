/**
 * The partial retake (ADR-091): what a retake reads of the attempt it
 * follows, and the copy of its validated gradings.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { itemStanding, type StoodItem } from "@quiz/domain";

import { gradings } from "../../db/schema.js";
import type { DbOrTx, JoinedItem } from "../evaluation/service.js";
import type { GradingRecord } from "./records.js";

/** The VALIDATED gradings of one attempt: what a partial retake reads, once. */
export async function validatedOfAttempt(db: DbOrTx, attemptId: string): Promise<GradingRecord[]> {
  return db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")));
}

/**
 * Each item's standing in one attempt (ADR-091 §2), in the order of
 * `items`, computed ONCE from that attempt's validated gradings
 * (`validatedOfAttempt`): the retake and the results page read it, and
 * `acquiredItems` / `partialRetakeRefusal` take it as it is.
 */
export function standingsOf(
  items: readonly JoinedItem[],
  validated: readonly Pick<GradingRecord, "itemId" | "points">[],
): StoodItem[] {
  const points = new Map(validated.map((g) => [g.itemId, g.points]));
  return items.map((item) => ({
    id: item.item.id,
    standing: itemStanding({ maxPoints: item.item.points, validatedPoints: points.get(item.item.id) ?? null }),
  }));
}

/**
 * Copies validated gradings of attempt n onto the partial retake n + 1
 * (ADR-091 §3) — exactly the `rows` the retake read, inside its
 * transaction, so no override can slip between the read and the copy. A
 * frozen snapshot: new ids, the copied answer (`answerIds`, item → the
 * copy's id, `null` for an item that had none), a chain of its own
 * (`supersedesId` null).
 *
 * The cell then holds a validated grading, so the hand-in pass skips it like
 * any settled cell; a regrade of the item (`regradeItem`) stands it down and
 * grades the copied answer again. The evaluation is running, so no released
 * grade can move and `flagReleasedEvaluationsOf` has nothing to do.
 */
export async function copyGradings(
  tx: DbOrTx,
  input: {
    rows: readonly GradingRecord[];
    toAttemptId: string;
    answerIds: ReadonlyMap<string, string | null>;
    now: Date;
  },
): Promise<void> {
  if (input.rows.length === 0) return;
  await tx.insert(gradings).values(
    input.rows.map((row) => ({
      ...row,
      id: randomUUID(),
      attemptId: input.toAttemptId,
      answerId: input.answerIds.get(row.itemId) ?? null,
      supersedesId: null,
      createdAt: input.now,
    })),
  );
}
