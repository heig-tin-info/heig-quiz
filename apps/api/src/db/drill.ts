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
 *
 * Targeted revision (ADR-115) keeps its own two tables below: a round and
 * its answers, never a `drill_reviews` row nor a write to a card.
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

import { DRILL_CORRECTNESSES, DRILL_DEVICE_CLASSES, DRILL_REVISION_ROUND_SIZE, DWELL_IDLE_CAP_MS } from "@quiz/domain";

import { users } from "./auth.js";
import type { StoredInstance } from "./columns.js";
import { concepts } from "./concept.js";
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
    /**
     * The values a parameterized question was served with (ADR-056 §5),
     * beside `serve_seed` and cleared with it; null for a static question.
     */
    serveValues: jsonb("serve_values").$type<StoredInstance>(),
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
    check("drill_cards_serve_values_ck", sql`${t.serveSeed} is not null or ${t.serveValues} is null`),
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
    correctness: text("correctness", { enum: DRILL_CORRECTNESSES }).notNull(),
    /** The ACTIVE time, summed by the server with the idle cap (ADR-039, ADR-041 §4). */
    elapsedMs: integer("elapsed_ms").notNull(),
    deviceClass: text("device_class", { enum: DRILL_DEVICE_CLASSES }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    answerPayload: jsonb("answer_payload"),
    /** The values of a parameterized question the answer was given to (ADR-056 §5); null when static. */
    values: jsonb("values").$type<StoredInstance>(),
    /**
     * How sure the student said they were before the correction, 0 No idea to
     * 4 Certain (ADR-085); null when they skipped it. Never read by the
     * rating, the schedule or any score.
     */
    confidence: smallint("confidence"),
  },
  (t) => [
    index("drill_reviews_card_idx").on(t.cardId, t.reviewedAt),
    index("drill_reviews_reviewed_idx").on(t.reviewedAt),
    check("drill_reviews_rating_ck", sql`${t.rating} between 1 and 4`),
    check("drill_reviews_confidence_ck", sql`${t.confidence} between 0 and 4`),
  ],
);

/**
 * A round of targeted revision (ADR-115): one student revising one concept
 * of a classroom's course, on at most ten of their own cards, outside FSRS
 * and the level. What the teacher sees of it (`classroomRevision`) is the
 * round itself: who, which concept, when, and per student the totals of the
 * two counters, which the answers keep up to date. The user is NO ACTION like the cards'; the
 * classroom cascades (N-DATA-03); a concept deleted later leaves the round
 * unnamed. Purged five years after its start by `drill.purge`.
 */
export const drillRevisionRounds = pgTable(
  "drill_revision_rounds",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    conceptId: uuid("concept_id").references(() => concepts.id, { onDelete: "set null" }),
    /** The round's cards in their order (`composeRevisionRound`), fixed at the start. */
    cardIds: uuid("card_ids").array().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Distinct cards answered at their first pass: one more at each first-pass answer. */
    cardsServed: integer("cards_served").notNull().default(0),
    /** Of them, those answered right at their first pass. */
    cardsCorrect: integer("cards_correct").notNull().default(0),
  },
  (t) => [
    index("drill_revision_rounds_classroom_idx").on(t.classroomId, t.startedAt),
    index("drill_revision_rounds_user_idx").on(t.userId, t.startedAt),
    index("drill_revision_rounds_concept_idx").on(t.conceptId),
    check("drill_revision_rounds_cards_ck", sql`cardinality(${t.cardIds}) between 1 and ${sql.raw(String(DRILL_REVISION_ROUND_SIZE))}`),
    check(
      "drill_revision_rounds_counts_ck",
      sql`${t.cardsCorrect} >= 0 and ${t.cardsCorrect} <= ${t.cardsServed} and ${t.cardsServed} <= cardinality(${t.cardIds})`,
    ),
    check("drill_revision_rounds_ended_ck", sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`),
  ],
);

/**
 * One pass of one card in a round: served (a seed and its values, kept on a
 * reload), then answered (the correctness and the time it took, on the
 * server's instants, capped at the idle cap). A card has a second pass only
 * after a wrong first one. Neither the answer given nor a confidence is
 * stored. A card removed by the teacher takes its passes with it; the
 * round keeps its counters.
 */
export const drillRevisionAnswers = pgTable(
  "drill_revision_answers",
  {
    id: uuid("id").primaryKey(),
    roundId: uuid("round_id")
      .notNull()
      .references(() => drillRevisionRounds.id, { onDelete: "cascade" }),
    cardId: uuid("card_id")
      .notNull()
      .references(() => drillCards.id, { onDelete: "cascade" }),
    pass: smallint("pass").notNull(),
    servedAt: timestamp("served_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    correctness: text("correctness", { enum: DRILL_CORRECTNESSES }),
    timeMs: integer("time_ms"),
    serveSeed: integer("serve_seed").notNull(),
    /** The values of a parameterized question it was served with (ADR-056 §5); null when static. */
    serveValues: jsonb("serve_values").$type<StoredInstance>(),
  },
  (t) => [
    uniqueIndex("drill_revision_answers_pass_uq").on(t.roundId, t.cardId, t.pass),
    index("drill_revision_answers_card_idx").on(t.cardId),
    check("drill_revision_answers_pass_ck", sql`${t.pass} in (1, 2)`),
    check("drill_revision_answers_time_ck", sql`${t.timeMs} between 0 and ${sql.raw(String(DWELL_IDLE_CAP_MS))}`),
    check(
      "drill_revision_answers_answered_ck",
      sql`(${t.answeredAt} is null) = (${t.correctness} is null) and (${t.answeredAt} is null) = (${t.timeMs} is null)`,
    ),
  ],
);
