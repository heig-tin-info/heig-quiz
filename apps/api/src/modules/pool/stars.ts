/**
 * Favourite stars on questions (F-POOL-10, ADR-039): one teacher's bookmarks.
 * Every function takes the caller's id and touches that caller's rows only;
 * which questions the caller may star is the route's business (it loads them
 * under `poolAccess` first).
 */
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "../../db/client.js";
import { questionStars, questions } from "../../db/schema.js";
import { qualified } from "./shared.js";

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
 * Removes the caller's stars on the live questions of one pool and says how
 * many went. A star on a soft-deleted question is hidden everywhere, so it
 * is not counted and not cleared: it comes back with its question.
 */
export async function clearPoolStars(db: Db, userId: string, poolId: string): Promise<number> {
  const gone = await db
    .delete(questionStars)
    .where(
      and(
        eq(questionStars.userId, userId),
        sql`EXISTS (SELECT 1 FROM ${questions} WHERE ${qualified(questions.id)} = ${qualified(questionStars.questionId)} AND ${qualified(questions.poolId)} = ${poolId} AND ${qualified(questions.deletedAt)} IS NULL)`,
      ),
    )
    .returning({ questionId: questionStars.questionId });
  return gone.length;
}
