import { z } from "zod";

import { REVIEW_MAX_FINDINGS, REVIEW_SEVERITIES, REVIEW_STATES } from "@quiz/domain";

/**
 * The LLM review of the published questions (ADR-060): teacher-only data,
 * in its own table; nothing of it is ever in a config, so `toStudent` never
 * sees it (invariant 4).
 */

/** One remark of a review: the field it is about, what is wrong, and an optional exact fix. */
export const ReviewFinding = z.object({
  severity: z.enum(REVIEW_SEVERITIES),
  /** The field, as a dot path into the config (`choices.2.text`), or `explanation`. */
  path: z.string(),
  message: z.string(),
  fix: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** The fix is in the draft (Fix pressed, not undone). */
  applied: z.boolean().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFinding>;

/** The review of one published version. */
export const QuestionReview = z.object({
  versionNumber: z.number().int(),
  state: z.enum(REVIEW_STATES),
  findings: z.array(ReviewFinding),
  reviewedAt: z.iso.datetime(),
});
export type QuestionReview = z.infer<typeof QuestionReview>;

/** The list's pill: the latest version's review, without its findings. */
export const ReviewPill = z.object({
  state: z.enum(REVIEW_STATES),
  count: z.number().int(),
  worst: z.enum(REVIEW_SEVERITIES).nullable(),
});
export type ReviewPill = z.infer<typeof ReviewPill>;

/** `GET /app/api/pools/:id/reviews`: the pool's open findings, and how far the review has got. */
export const ReviewList = z.object({
  /** The pool's owner turned the night's review on. */
  enabled: z.boolean(),
  /** Latest versions reviewed (any state) and still waiting, among the reviewable ones. */
  reviewed: z.number().int(),
  pending: z.number().int(),
  items: z.array(
    z.object({
      questionId: z.uuid(),
      internalName: z.string(),
      type: z.string(),
      review: QuestionReview,
    }),
  ),
});
export type ReviewList = z.infer<typeof ReviewList>;

/** `PUT /app/api/pools/:id/review`: the owner turns the night's review on or off. */
export const ReviewToggle = z.object({ enabled: z.boolean() }).strict();
export type ReviewToggle = z.infer<typeof ReviewToggle>;

/** `POST /app/api/questions/:id/review/fix`: a finding of the latest review, applied to the draft, or undone. */
export const ReviewFixBody = z
  .object({ finding: z.number().int().min(0).max(REVIEW_MAX_FINDINGS - 1), undo: z.boolean().optional() })
  .strict();
export type ReviewFixBody = z.infer<typeof ReviewFixBody>;
