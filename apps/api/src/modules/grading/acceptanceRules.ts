/**
 * The answers accepted at grading time (ADR-128) as every grading reads
 * them: the type's hook, the rules in force on an item, the one per-item
 * lock, and the write guard that keeps a grading from being written with
 * rules that moved since it was computed. The act that writes the rules is
 * `acceptance.ts`.
 */
import { and, inArray, ne, sql } from "drizzle-orm";

import type { AcceptanceRule } from "@quiz/domain";

import { answerAcceptances, evaluationItems, gradings } from "../../db/schema.js";
import type { DbOrTx, EvaluationRecord } from "../evaluation/service.js";
import { typeOf } from "../pool/config.js";
import { pairKey, type PairKey } from "./records.js";
import type { WriteGradingInput, WriteGuard } from "./writer.js";

export type AcceptanceHook = NonNullable<ReturnType<typeof typeOf>["acceptance"]>;

/**
 * THE way to the type's acceptance hook (ADR-128): none on a poll (no grade
 * to correct, ADR-014), none for a type without one or that this build does
 * not carry. `mode` absent: whatever the evaluation (a regrade's check).
 */
export function acceptanceHook(type: string, mode?: EvaluationRecord["mode"]): AcceptanceHook | undefined {
  if (mode === "poll") return undefined;
  try {
    return typeOf(type).acceptance;
  } catch {
    return undefined;
  }
}

/**
 * THE guarded reading of an answer's label (ADR-128): `config` is read
 * lazily, and a config or a hook that throws reads as "no such answer",
 * never a 500.
 */
export function ruleLabel(hook: AcceptanceHook, config: () => unknown, rule: { part: string; answer: string }): string | null {
  try {
    return hook.label(config(), rule.part, rule.answer);
  } catch {
    return null;
  }
}

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
 * THE per-item lock of the acceptances (ADR-128): the items' own
 * `evaluation_items` rows, `FOR UPDATE`, in id order. Taken by the rule's
 * write, by a regrade (which may retarget the item and drop rules), and by
 * the write guard below before it reads the rules a grading must carry —
 * so a grading is never written with rules that changed under it.
 */
export async function lockItems(tx: DbOrTx, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  await tx
    .select({ id: evaluationItems.id })
    .from(evaluationItems)
    .where(inArray(evaluationItems.id, ids))
    .orderBy(evaluationItems.id)
    .for("update");
}

/** One cell graded with the rules read when it was computed, and how to grade it again. */
export interface RuleBound {
  rules: readonly AcceptanceRule[];
  regrade(rules: readonly AcceptanceRule[]): Promise<WriteGradingInput | null>;
}

const ruleKey = (r: AcceptanceRule) => `${r.part}\u0000${r.answer}\u0000${r.attemptId ?? ""}`;
const sameRules = (a: readonly AcceptanceRule[], b: readonly AcceptanceRule[]) =>
  a.length === b.length && a.map(ruleKey).sort().join("\u0001") === b.map(ruleKey).sort().join("\u0001");

/**
 * The write guard of a grading that depends on acceptances (ADR-128): after
 * `inner` (the attempts' lock, `passGuard`), it takes the items' lock,
 * reads their rules again and re-grades every `bound` cell whose rules
 * moved since it was computed — a pass that loaded them before an act, two
 * acts on one item. With `leaveManual`, the cells' standing gradings are
 * locked and a cell whose grading in force is now a manual override is
 * dropped: the act never unseats a teacher's word (ADR-128 §6).
 */
export function acceptanceGuard(
  inner: WriteGuard,
  bound: ReadonlyMap<PairKey, RuleBound>,
  options: { leaveManual?: boolean } = {},
): WriteGuard {
  return async (tx, inputs) => {
    const kept = await inner(tx, inputs);
    const tied = kept.filter((i) => bound.has(pairKey(i.attemptId, i.itemId)));
    if (tied.length === 0) return kept;
    await lockItems(
      tx,
      tied.map((i) => i.itemId),
    );
    const rules = await acceptancesOf(
      tx,
      tied.map((i) => i.itemId),
    );
    const manual = options.leaveManual ? await manualCells(tx, tied) : new Set<PairKey>();
    const out: WriteGradingInput[] = [];
    for (const input of kept) {
      const key = pairKey(input.attemptId, input.itemId);
      if (manual.has(key)) continue;
      const cell = bound.get(key);
      const now = rules.get(input.itemId) ?? [];
      if (!cell || sameRules(cell.rules, now)) {
        out.push(input);
        continue;
      }
      const again = await cell.regrade(now);
      if (again) out.push(again);
    }
    return out;
  };
}

/** The cells whose standing grading is a manual override, those rows locked. */
async function manualCells(tx: DbOrTx, inputs: readonly WriteGradingInput[]): Promise<Set<PairKey>> {
  const pairs = inputs.map((i) => sql`(${i.attemptId}::uuid, ${i.itemId}::uuid)`);
  const rows = await tx
    .select({ attemptId: gradings.attemptId, itemId: gradings.itemId, source: gradings.source })
    .from(gradings)
    .where(and(ne(gradings.state, "superseded"), sql`(${gradings.attemptId}, ${gradings.itemId}) in (${sql.join(pairs, sql`, `)})`))
    .for("update");
  return new Set(rows.filter((r) => r.source === "manual").map((r) => pairKey(r.attemptId, r.itemId)));
}
