/**
 * The grading-time counting act (ADR-108): an item becomes `normal`,
 * `bonus` or `neutralized` after the evaluation.
 */
import { and, eq } from "drizzle-orm";

import type { ItemCounting } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { attempts, officialAttempt } from "../../db/schema.js";
import {
  setItemCounting,
  setModifiedAfterRelease,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { watchReleasedGrades } from "../results/service.js";
import { pointsByAttempt } from "./reads.js";

/**
 * The grading-time counting act (ADR-108): `itemId` of `evaluation` becomes
 * `normal`, `bonus` or `neutralized`. The write is the evaluation module's
 * (`setItemCounting`: the frozen-list gate, the total that must stay above
 * 0); this orchestrates around it what a grading write does after the
 * release (ADR-030 §h): the grades the students are shown are read before,
 * the evaluation is marked modified after publication in the same
 * transaction as the change (so the frozen snapshot stops being served), and
 * the students whose shown grade moved are told after the commit. Stored
 * gradings are never touched. Null for an item the evaluation does not hold.
 */
export async function changeItemCounting(
  db: Db,
  evaluation: EvaluationRecord,
  itemId: string,
  counting: ItemCounting,
  now: Date,
): Promise<CountingChange | null> {
  const watch = await watchCounting(db, evaluation, itemId);
  const outcome = await db.transaction(async (tx): Promise<CountingChange | null> => {
    const before = await setItemCounting(tx, evaluation, itemId, counting);
    if (before === null) return null;
    // Choosing the counting it already has changes nothing, and flags nothing.
    if (before === counting) return { changed: false, before, modifiedAfterRelease: false };
    return { changed: true, before, modifiedAfterRelease: await setModifiedAfterRelease(tx, evaluation.id, now) };
  });
  if (outcome?.changed) await watch.announce();
  return outcome;
}

/** What {@link changeItemCounting} did: whether anything moved, from what, and the release flag. */
export interface CountingChange {
  changed: boolean;
  before: ItemCounting;
  modifiedAfterRelease: boolean;
}

/** The grades shown before a counting change; nothing to read on an evaluation not released. */
async function watchCounting(db: Db, evaluation: EvaluationRecord, itemId: string) {
  if (evaluation.releasedAt === null) return { announce: async () => {} };
  const owners = await db
    .select({ attemptId: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluation.id), officialAttempt));
  return watchReleasedGrades(
    db,
    owners.map((o) => ({ attemptId: o.attemptId, itemId })),
    pointsByAttempt,
  );
}
