/**
 * The drill (ADR-041, docs/spec/05 §5.4): one card per student and question,
 * and the history of its reviews. Owned by the `drill` module
 * (`modules/drill/`); every other module reads them by join and never writes
 * them.
 *
 * The switches that gate the drill live on the rows they qualify and belong
 * to their own modules: `classrooms.drill_enabled_at` and
 * `enrollments.drill_opted_out_at` (`org`), `settings.allowDrill`
 * (`evaluation`).
 *
 * What the schema holds by itself:
 *   - `drill_cards_user_question_uq`: a card per (student, question), so the
 *     creation at a release or a hand-in is an `INSERT … ON CONFLICT DO
 *     NOTHING` and the FIRST classroom and evaluation win (06, question 28 (j));
 *   - the cascades of N-DATA-03: deleting a classroom, an evaluation or a
 *     question deletes the cards it gave rise to, and a card its reviews.
 *     The user is NO ACTION, like `attempts.user_id`: an account leaves by
 *     anonymisation, never by a DELETE;
 *   - `drill_cards_serve_ck`: no time on screen without a served question.
 */
import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { evaluations } from "./evaluation.js";
import { classrooms } from "./org.js";
import { questions } from "./pool.js";

export const drillCards = pgTable(
  "drill_cards",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    /** Where the card was met first: its teacher sees its reviews (06, question 28 (j)). */
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    /** Where the card was met first: its settings grade every review (06, question 28 (e)). */
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /** The FSRS state (`DrillCard` of `@quiz/domain/drillSchedule`); 0 on a new card. */
    stability: doublePrecision("stability").notNull().default(0),
    difficulty: doublePrecision("difficulty").notNull().default(0),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    /** Null on a card never reviewed: it is NEW. */
    lastReviewAt: timestamp("last_review_at", { withTimezone: true }),
    /** sha256 of the key (`toSolution` under a fixed view) the card was last scheduled on (ADR-041 §7). */
    keyHash: text("key_hash").notNull(),
    /**
     * The review in progress: the seed the question was served with (a new
     * one at each review, 06, question 28 (i)) — null when none is — the
     * open interval on screen (null while the tab is hidden) and the active
     * time already credited. Cleared by the answer.
     */
    serveSeed: integer("serve_seed"),
    shownSince: timestamp("shown_since", { withTimezone: true }),
    activeMs: integer("active_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("drill_cards_user_question_uq").on(t.userId, t.questionId),
    index("drill_cards_user_due_idx").on(t.userId, t.dueAt),
    index("drill_cards_question_idx").on(t.questionId),
    index("drill_cards_classroom_idx").on(t.classroomId),
    index("drill_cards_evaluation_idx").on(t.evaluationId),
    check(
      "drill_cards_serve_ck",
      sql`${t.serveSeed} is not null or (${t.shownSince} is null and ${t.activeMs} = 0)`,
    ),
  ],
);

/**
 * One review: what the reference times (same device class), the teacher's
 * view and a later re-optimisation of the weights read. Kept five years
 * (N-DATA-03), then purged by the `drill.purge` ticker task.
 */
export const drillReviews = pgTable(
  "drill_reviews",
  {
    id: uuid("id").primaryKey(),
    cardId: uuid("card_id")
      .notNull()
      .references(() => drillCards.id, { onDelete: "cascade" }),
    /** FSRS rating, 1 Again to 4 Easy (`drillRating`). */
    rating: smallint("rating").notNull(),
    /** What the grading said; `right` reviews make the reference times (`drillReferenceMs`). */
    correctness: text("correctness", { enum: ["right", "partial", "wrong"] }).notNull(),
    /** The ACTIVE time, summed by the server with the idle cap (ADR-039, ADR-041 §4). */
    elapsedMs: integer("elapsed_ms").notNull(),
    deviceClass: text("device_class", { enum: ["coarse", "fine"] }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    answerPayload: jsonb("answer_payload"),
  },
  (t) => [
    index("drill_reviews_card_idx").on(t.cardId, t.reviewedAt),
    index("drill_reviews_reviewed_idx").on(t.reviewedAt),
    check("drill_reviews_rating_ck", sql`${t.rating} between 1 and 4`),
  ],
);
