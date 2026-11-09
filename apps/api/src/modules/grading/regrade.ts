/**
 * The regrade of one item (F-GRADE-06): readying it, the model's daily
 * budget (audit L2) and the points a student saw before it.
 */
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { ParametersDraft } from "@quiz/contracts";
import {
  attemptTotal,
  LLM_REGRADES_PER_ITEM_PER_DAY,
  SCHOOL_TIME_ZONE,
  type ItemCounting,
} from "@quiz/domain";
import { sameTable } from "@quiz/domain/parameters";

import type { Db } from "../../db/client.js";
import {
  attempts,
  auditLog,
  evaluationItems,
  gradings,
  officialAttempt,
  questionVersions,
} from "../../db/schema.js";
import { clearGradingReady, joinedItem, retargetItemVersion } from "../evaluation/service.js";
import { parametersOf } from "../pool/service.js";
import { dropVanishedAcceptances } from "./acceptance.js";
import { lockItems } from "./acceptanceRules.js";
import { GradingError, pairKey, type PairKey } from "./records.js";

/**
 * Readies ONE item for a regrade (F-GRADE-06): repoints it at version
 * `toVersionNumber` of its question when one is asked for, then stands down
 * every standing grading of it — the pass skips a cell that already holds a
 * validated grading, and nothing is deleted: the history of §4.5 is the whole
 * chain. Returns the note the pass writes on every new grading, or `null`
 * when the question has no such version (the route's 404).
 *
 * The answers accepted at grading time (ADR-128) are the item's and stay:
 * the pass applies them. Onto another version, those whose part — or
 * option — the new version no longer holds are dropped, and the note says
 * which.
 */
export async function regradeItem(
  db: Db,
  item: {
    evaluationId: string;
    itemId: string;
    questionId: string;
    /** The variables of the version the item holds now (ADR-056 §5). */
    variables: ParametersDraft | null;
  },
  input: { note: string; toVersionNumber?: number | undefined },
): Promise<string | null> {
  return db.transaction(async (tx) => {
    // ADR-128: the item's lock, which the acceptance act takes too — a
    // retarget never races a rule written for the old version.
    await lockItems(tx, [item.itemId]);
    let note = input.note.trim();
    if (input.toVersionNumber !== undefined) {
      const [version] = await tx
        .select()
        .from(questionVersions)
        .where(
          and(
            eq(questionVersions.questionId, item.questionId),
            eq(questionVersions.number, input.toVersionNumber),
          ),
        )
        .limit(1);
      if (!version) return null;
      // The values the students had are kept, and the new version's derived
      // rows replayed from them (ADR-056 §5): only under the same names.
      if (!sameTable(parametersOf(item), parametersOf(version))) throw new GradingError("variables_changed");
      const held = await joinedItem(tx, item.evaluationId, item.itemId);
      await retargetItemVersion(tx, item.itemId, version.id);
      note = `${note} (re-graded with version ${input.toVersionNumber})`;
      const dropped = held ? await dropVanishedAcceptances(tx, held, version) : [];
      if (dropped.length > 0) note = `${note} (accepted answers dropped: ${dropped.map((d) => `"${d}"`).join(", ")})`;
    }
    // A practice attempt's cells (ADR-122) keep their grading: the regrade's
    // pass covers the official attempts only.
    await tx
      .update(gradings)
      .set({ state: "superseded" })
      .where(
        and(
          eq(gradings.itemId, item.itemId),
          ne(gradings.state, "superseded"),
          inArray(
            gradings.attemptId,
            tx
              .select({ id: attempts.id })
              .from(attempts)
              .where(and(eq(attempts.evaluationId, item.evaluationId), officialAttempt)),
          ),
        ),
      );
    // The item's cells are empty again: the pass that refills them completes a
    // new grid, and the staff hear of it (`ready.ts`, #286).
    await clearGradingReady(tx, item.evaluationId);
    return note;
  });
}

/**
 * The payload of a `grading.regrade` audit entry: written by the regrade
 * route, and read back by {@link checkLlmRegradeBudget} — one shape, so a
 * renamed key cannot silently reset the budgets.
 */
export const RegradeAudit = z.object({
  itemId: z.string(),
  note: z.string(),
  toVersionNumber: z.number().nullable(),
  modifiedAfterRelease: z.boolean(),
  /** The re-grade asked the model again: what the budget counts. */
  llm: z.literal(true).optional(),
});
export type RegradeAudit = z.infer<typeof RegradeAudit>;
const REGRADE_KEY = RegradeAudit.keyof().enum;

/**
 * Whether a re-grade of this item asks the model again — it did grade one of
 * its answers — and, then, the item's daily budget (audit L2): past
 * {@link LLM_REGRADES_PER_ITEM_PER_DAY} such re-grades today (Europe/Zurich,
 * the server's clock), `429 llm_budget_exhausted`. The count is the audit
 * log's: the regrade route records each one with `llm: true`. Two re-grades
 * of one item pressed at the same instant may both pass the count; the
 * budget bounds a day, not a race (ADR-058, amendment of 2026-10-11).
 */
export async function checkLlmRegradeBudget(db: Db, evaluationId: string, itemId: string, now: Date): Promise<boolean> {
  const [graded] = await db
    .select({ id: gradings.id })
    .from(gradings)
    .where(and(eq(gradings.itemId, itemId), eq(gradings.source, "llm")))
    .limit(1);
  if (!graded) return false;
  const [today] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, "grading.regrade"),
        eq(auditLog.subjectId, evaluationId),
        sql`${auditLog.payload}->>${REGRADE_KEY.itemId} = ${itemId}`,
        sql`${auditLog.payload}->>${REGRADE_KEY.llm} = 'true'`,
        sql`${auditLog.createdAt} >= date_trunc('day', ${now.toISOString()}::timestamptz, ${SCHOOL_TIME_ZONE})`,
      ),
    );
  if ((today?.n ?? 0) >= LLM_REGRADES_PER_ITEM_PER_DAY) throw new GradingError("llm_budget_exhausted");
  return true;
}

/**
 * {@link pointsByAttempt} as the student saw it BEFORE a regrade touched
 * `cells`: on each of those cells that holds no validated grading, the
 * grading a regrade stood down counts instead — the newest `superseded` row
 * of the cell that nothing supersedes (`regradeItem` stands a cell down
 * without writing a successor; every other supersession links one). The
 * cells outside `cells` count as they stand. `results_updated` reads its
 * "before" through it, so a regrade that gives a student the same points
 * back tells nobody (ADR-030 §h, step 8).
 *
 * The state a stood-down row had is not kept: a PROPOSAL a regrade stood
 * down counts here as if it had been validated. It only matters for a cell
 * still a proposal when it was regraded, which the page did not count.
 */
export function pointsAcrossRegrade(
  cells: readonly { attemptId: string; itemId: string }[],
): (db: Db, attemptIds: readonly string[]) => Promise<Map<string, number>> {
  const touched = new Set(cells.map((c) => pairKey(c.attemptId, c.itemId)));
  return async (db, attemptIds) => {
    if (attemptIds.length === 0) return new Map();
    const rows = await db
      .select({
        attemptId: gradings.attemptId,
        itemId: gradings.itemId,
        points: gradings.points,
        state: gradings.state,
        counting: evaluationItems.counting,
      })
      .from(gradings)
      .innerJoin(evaluationItems, eq(evaluationItems.id, gradings.itemId))
      .where(
        and(
          inArray(gradings.attemptId, [...attemptIds]),
          or(
            eq(gradings.state, "validated"),
            and(
              eq(gradings.state, "superseded"),
              sql`not exists (select 1 from ${gradings} as successor where successor.attempt_id = ${gradings.attemptId} and successor.supersedes_id = ${gradings.id})`,
            ),
          ),
        ),
      )
      .orderBy(asc(gradings.gradedAt));
    // Per cell: a validated grading wins; otherwise, on a touched cell, the
    // newest stood-down one (ascending order: the last one read).
    const byCell = new Map<PairKey, { attemptId: string; points: number; counting: ItemCounting; validated: boolean }>();
    for (const row of rows) {
      const key = pairKey(row.attemptId, row.itemId);
      const validated = row.state === "validated";
      if (!validated && !touched.has(key)) continue;
      if (byCell.get(key)?.validated) continue;
      byCell.set(key, { attemptId: row.attemptId, points: row.points, counting: row.counting, validated });
    }
    const perAttempt = new Map<string, { points: number; counting: ItemCounting }[]>();
    for (const cell of byCell.values()) {
      const list = perAttempt.get(cell.attemptId);
      if (list) list.push(cell);
      else perAttempt.set(cell.attemptId, [cell]);
    }
    return new Map([...perAttempt].map(([id, points]) => [id, attemptTotal(points)]));
  };
}
