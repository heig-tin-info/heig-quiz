/**
 * Favourite stars on questions (F-POOL-10, ADR-040): one teacher's bookmarks.
 * Every function takes the caller's id and touches that caller's rows only;
 * which questions the caller may star is the route's business (it loads them
 * under `poolAccess` first).
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { questionStars, questions } from "../../db/schema.js";
import { qualified } from "./shared.js";

/**
 * THE definition of "starred by the caller", as a predicate on `questions`:
 * a star of theirs on a LIVE question. A soft-deleted question's star stays
 * in the table and is hidden by this clause everywhere — the row's flag, the
 * `starred=1` filter, the clear and its count — until the question is back.
 */
export function starredBy(userId: string): SQL {
  return sql`(${qualified(questions.deletedAt)} IS NULL AND EXISTS (SELECT 1 FROM ${questionStars} WHERE ${qualified(questionStars.questionId)} = ${qualified(questions.id)} AND ${qualified(questionStars.userId)} = ${userId}))`;
}

/** Stars the questions; one already starred keeps its first `starred_at`. */
export async function starQuestions(db: Db, userId: string, questionIds: readonly string[]) {
  if (questionIds.length === 0) return;
  await db
    .insert(questionStars)
    .values(questionIds.map((questionId) => ({ userId, questionId })))
    .onConflictDoNothing();
}

/** Unstars the questions; one that was not starred is not an error. */
export async function unstarQuestions(db: Db, userId: string, questionIds: readonly string[]) {
  if (questionIds.length === 0) return;
  await db
    .delete(questionStars)
    .where(and(eq(questionStars.userId, userId), inArray(questionStars.questionId, questionIds)));
}

/**
 * Removes the caller's stars on the questions of one pool that
 * {@link starredBy} shows, and says how many went: a hidden star (a
 * soft-deleted question) is neither counted nor cleared.
 */
export async function clearPoolStars(db: Db, userId: string, poolId: string): Promise<number> {
  const shown = db
    .select({ id: questions.id })
    .from(questions)
    .where(and(eq(questions.poolId, poolId), starredBy(userId)));
  const gone = await db
    .delete(questionStars)
    .where(and(eq(questionStars.userId, userId), inArray(questionStars.questionId, shown)))
    .returning({ questionId: questionStars.questionId });
  return gone.length;
}
