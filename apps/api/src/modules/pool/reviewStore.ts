/**
 * The LLM review's rows (ADR-060), read and written: `question_reviews` and
 * `review_pools`, both the `pool` module's. No prompt and no model here —
 * that is `./review.ts`; this file is what the question screens and the
 * pool's tab read.
 */
import { and, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import type { QuestionReview, ReviewFinding, ReviewList } from "@quiz/contracts";
import { UNREVIEWED_TYPES, type ReviewState } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { questionReviews, questionVersions, questions, reviewPools } from "../../db/schema.js";
import { startOfDay } from "../llm/service.js";

type ReviewRow = typeof questionReviews.$inferSelect;

export const reviewJson = (row: ReviewRow, versionNumber: number): QuestionReview => ({
  versionNumber,
  state: row.state,
  findings: row.findings,
  reviewedAt: row.reviewedAt.toISOString(),
});

/** The review of a version, or null when it was never reviewed. */
export async function reviewOf(db: Db, versionId: string): Promise<ReviewRow | null> {
  const [row] = await db.select().from(questionReviews).where(eq(questionReviews.versionId, versionId)).limit(1);
  return row ?? null;
}

/** The question's latest published version, or null while it is a draft only. */
export async function latestVersionOf(db: Db, questionId: string) {
  const [row] = await db
    .select()
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, questionId), sql`${questionVersions.number} IS NOT NULL`))
    .orderBy(desc(questionVersions.number))
    .limit(1);
  return row ?? null;
}

/** Writes a version's review, replacing the one before. */
export async function saveReview(
  db: Db,
  versionId: string,
  review: { state: ReviewState; findings: ReviewFinding[]; model: string | null; at: Date },
): Promise<ReviewRow> {
  const values = {
    state: review.state,
    findings: review.findings,
    model: review.model,
    reviewedAt: review.at,
    ignoredBy: null,
    ignoredAt: null,
  };
  const [row] = await db
    .insert(questionReviews)
    .values({ versionId, ...values })
    .onConflictDoUpdate({ target: questionReviews.versionId, set: values })
    .returning();
  return row!;
}

/** The findings of a review, as the fix leaves them; nothing else changes. */
export async function saveFindings(db: Db, versionId: string, findings: ReviewFinding[]): Promise<void> {
  await db.update(questionReviews).set({ findings }).where(eq(questionReviews.versionId, versionId));
}

/** Ignore (ADR-060 §3): the version is not reviewed again, and its findings leave the tab. */
export async function ignoreReview(db: Db, versionId: string, userId: string, at: Date): Promise<ReviewRow | null> {
  const [row] = await db
    .update(questionReviews)
    .set({ state: "ignored", ignoredBy: userId, ignoredAt: at })
    .where(eq(questionReviews.versionId, versionId))
    .returning();
  return row ?? null;
}

export async function isReviewEnabled(db: Db, poolId: string): Promise<boolean> {
  const [row] = await db.select({ poolId: reviewPools.poolId }).from(reviewPools).where(eq(reviewPools.poolId, poolId));
  return row !== undefined;
}

export async function setReviewEnabled(db: Db, poolId: string, enabled: boolean, userId: string): Promise<void> {
  if (enabled) {
    await db.insert(reviewPools).values({ poolId, enabledBy: userId }).onConflictDoNothing();
  } else {
    await db.delete(reviewPools).where(eq(reviewPools.poolId, poolId));
  }
}

/** The latest published version of every live, reviewable question matching `where`, with its review if any. */
function latestVersions(db: Db, where: SQL | undefined) {
  const latest = sql`${questionVersions.number} = (
    SELECT max(v2.number) FROM ${questionVersions} v2 WHERE v2.question_id = ${questionVersions.questionId}
  )`;
  return db
    .select({
      versionId: questionVersions.id,
      number: questionVersions.number,
      config: questionVersions.config,
      explanation: questionVersions.explanation,
      publishedAt: questionVersions.publishedAt,
      questionId: questions.id,
      poolId: questions.poolId,
      type: questions.type,
      internalName: questions.internalName,
      review: questionReviews,
    })
    .from(questionVersions)
    .innerJoin(questions, eq(questions.id, questionVersions.questionId))
    .leftJoin(questionReviews, eq(questionReviews.versionId, questionVersions.id))
    .where(and(isNull(questions.deletedAt), latest, notInArray(questions.type, [...UNREVIEWED_TYPES]), where));
}

/** The pool's tab (ADR-060 §6): the open findings of its latest versions, and how far the review has got. */
export async function poolReviews(db: Db, poolId: string): Promise<ReviewList> {
  const [enabled, rows] = await Promise.all([
    isReviewEnabled(db, poolId),
    latestVersions(db, eq(questions.poolId, poolId)),
  ]);
  const reviewed = rows.filter((r) => r.review !== null && r.review.state !== "failed");
  return {
    enabled,
    reviewed: reviewed.length,
    pending: rows.length - reviewed.length,
    items: reviewed
      .filter((r) => r.review!.state === "findings")
      .map((r) => ({
        questionId: r.questionId,
        internalName: r.internalName,
        type: r.type,
        review: reviewJson(r.review!, r.number!),
      })),
  };
}

/**
 * What the night reviews next (ADR-060 §5): the latest versions of the
 * pools that asked, never reviewed — or whose review failed before today —,
 * newest first.
 */
export async function nightCandidates(db: Db, now: Date, limit: number) {
  const asked = db.select({ poolId: reviewPools.poolId }).from(reviewPools);
  return latestVersions(
    db,
    and(
      inArray(questions.poolId, asked),
      sql`(${questionReviews.versionId} IS NULL OR (${questionReviews.state} = 'failed' AND ${questionReviews.reviewedAt} < ${startOfDay(now)}))`,
    ),
  )
    .orderBy(desc(questionVersions.publishedAt))
    .limit(limit);
}
