/**
 * Gradings (PLAN-MVP §3.5). Owned by the `grading` module; `results` reads
 * them by join and never writes them (CLAUDE.md, Conventions).
 *
 * Three properties live in the schema rather than in the service:
 *
 *   - `gradings_validated_uq` is PARTIAL on `state = 'validated'`: a concurrent
 *     double-write fails loudly instead of producing two grades for one
 *     answer. It is the index §3.5 names, on `answer_id`;
 *   - `gradings_pair_validated_uq` is the same rule for an answer that does
 *     not exist. F-GRADE-01 grades an absent answer (zero points, validated,
 *     `auto`), and there is no `answers` row to hang it on, so `answer_id` is
 *     nullable and `(attempt_id, item_id)` carries the uniqueness instead.
 *     `answers` itself is unique on `(attempt_id, item_id)`, so the two
 *     indexes never disagree;
 *   - `supersedes_id` is a self-reference, so the whole history of an answer
 *     is a chain and not a pile: `writeGrading` supersedes the previous
 *     grading and points at it in ONE transaction (§5.4).
 *
 * `attempts` has no grade column: a grade is recomputed from the validated
 * gradings and frozen into `evaluations.released_grades` at release.
 */
import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { evaluationItems } from "./evaluation.js";
import { answers, attempts } from "./live.js";

export const gradings = pgTable(
  "gradings",
  {
    id: uuid("id").primaryKey(),
    /** Null when the student never answered (F-GRADE-01). */
    answerId: uuid("answer_id").references(() => answers.id, { onDelete: "cascade" }),
    /** Denormalised: the panel queries by attempt and the stats by item. */
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => evaluationItems.id, { onDelete: "cascade" }),
    /** `numeric(6,2)`: two decimals survive a partial or penalised fraction (D13). */
    points: numeric("points", { precision: 6, scale: 2, mode: "number" }).notNull(),
    maxPoints: numeric("max_points", { precision: 6, scale: 2, mode: "number" }).notNull(),
    source: text("source", { enum: ["auto", "llm", "manual"] }).notNull(),
    state: text("state", { enum: ["proposed", "validated", "superseded"] }).notNull(),
    /** Exactly what `type.grade` returned; the panel and the feedback read it. */
    details: jsonb("details"),
    confidence: text("confidence", { enum: ["low", "medium", "high"] }),
    /** Mandatory on a manual override (F-GRADE-05); machine note otherwise. */
    comment: text("comment"),
    gradedBy: uuid("graded_by").references(() => users.id),
    gradedAt: timestamp("graded_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => gradings.id),
    /** "re-graded with version N" (F-GRADE-06). */
    regradeNote: text("regrade_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("gradings_validated_uq")
      .on(t.answerId)
      .where(sql`${t.state} = 'validated'`),
    uniqueIndex("gradings_pair_validated_uq")
      .on(t.attemptId, t.itemId)
      .where(sql`${t.state} = 'validated'`),
    index("gradings_answer_idx").on(t.answerId),
    index("gradings_attempt_idx").on(t.attemptId),
    index("gradings_item_validated_idx")
      .on(t.itemId)
      .where(sql`${t.state} = 'validated'`),
  ],
);
