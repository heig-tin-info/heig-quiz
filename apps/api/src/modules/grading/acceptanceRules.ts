/**
 * The answers accepted at grading time (ADR-128) as every grading reads
 * them: the rules in force on an item, and those one attempt is graded
 * with. The act that writes them is `acceptance.ts`.
 */
import { inArray } from "drizzle-orm";

import type { AcceptedAnswer } from "@quiz/core/server";
import { rulesForAttempt, type AcceptanceRule } from "@quiz/domain";

import { answerAcceptances } from "../../db/schema.js";
import type { DbOrTx } from "../evaluation/service.js";
import type { AttemptRecord } from "./records.js";

/** The acceptances in force, by item id. */
export type ItemRules = ReadonlyMap<string, readonly AcceptanceRule[]>;

/** The acceptances in force on these items, oldest first. */
export async function acceptancesOf(db: DbOrTx, itemIds: readonly string[]): Promise<ItemRules> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select({
      itemId: answerAcceptances.itemId,
      part: answerAcceptances.part,
      answer: answerAcceptances.answer,
      attemptId: answerAcceptances.attemptId,
    })
    .from(answerAcceptances)
    .where(inArray(answerAcceptances.itemId, [...itemIds]))
    .orderBy(answerAcceptances.createdAt);
  const byItem = new Map<string, AcceptanceRule[]>();
  for (const { itemId, ...rule } of rows) byItem.set(itemId, [...(byItem.get(itemId) ?? []), rule]);
  return byItem;
}

/**
 * The accepted answers one attempt is graded with (ADR-128 §2): the item's
 * rules for everyone and the attempt's own — none on a practice attempt
 * (ADR-122), graded against the pool's key like the drill.
 */
export function acceptedFor(
  rules: readonly AcceptanceRule[] | undefined,
  attempt: Pick<AttemptRecord, "id" | "afterDue">,
): AcceptedAnswer[] {
  return rulesForAttempt(rules ?? [], { id: attempt.id, practice: attempt.afterDue });
}
