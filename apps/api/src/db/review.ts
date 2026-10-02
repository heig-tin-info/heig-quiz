/**
 * The LLM review of the published questions (ADR-060), owned by the `pool`
 * module (`modules/pool/review.ts`): no other module writes these tables.
 *
 * `review_pools` holds one row per pool whose owner turned the night's
 * review on (OFF by default, ADR-060 §1). `question_reviews` holds one row
 * per reviewed published version: its state and its findings, never a
 * prompt. Both go with what they belong to (cascade).
 */
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import type { ReviewFinding } from "@quiz/contracts";
import { REVIEW_STATES } from "@quiz/domain";

import { users } from "./auth.js";
import { pools, questionVersions } from "./pool.js";

export const reviewPools = pgTable("review_pools", {
  poolId: uuid("pool_id")
    .primaryKey()
    .references(() => pools.id, { onDelete: "cascade" }),
  enabledBy: uuid("enabled_by").references(() => users.id, { onDelete: "set null" }),
  enabledAt: timestamp("enabled_at", { withTimezone: true }).notNull().defaultNow(),
});

export const questionReviews = pgTable("question_reviews", {
  versionId: uuid("version_id")
    .primaryKey()
    .references(() => questionVersions.id, { onDelete: "cascade" }),
  state: text("state", { enum: REVIEW_STATES }).notNull(),
  findings: jsonb("findings").$type<ReviewFinding[]>().notNull().default([]),
  /** The model that answered; null for a failed call. */
  model: text("model"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
  ignoredBy: uuid("ignored_by").references(() => users.id, { onDelete: "set null" }),
  ignoredAt: timestamp("ignored_at", { withTimezone: true }),
});
