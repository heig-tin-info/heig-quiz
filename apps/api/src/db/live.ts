/**
 * Attempts, answers and the attempt journal (PLAN-MVP §3.4). Owned by the
 * `live` module.
 *
 * The three properties that matter under concurrency are in the schema:
 *   - `attempts_evaluation_user_uq` makes `POST /evaluations/:id/attempt`
 *     idempotent through `INSERT … ON CONFLICT DO NOTHING`: two tabs opened
 *     at the same second share one attempt, one seed and one deadline;
 *   - `attempts_deadline_idx` is PARTIAL on `state = 'in_progress'`, which is
 *     what makes the one-second ticker sweep free;
 *   - `answers_attempt_item_uq` is the target of the autosave upsert, whose
 *     `WHERE answers.revision < excluded.revision` settles the revision race
 *     in one statement, with no read-modify-write (§4.7).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { evaluationItems, evaluations } from "./evaluation.js";

/**
 * Participants without an account: a browser that scanned the QR of an
 * ANONYMOUS poll (F-AUTH-05, ADR-014).
 *
 * `token_hash` is `sha256(token)`; the token itself only ever exists in the
 * `quiz_guest` cookie of that browser, scoped to `/app/api/p`. A guest is a
 * row of THIS table and never an `enrollments` seat: a poll has no roster,
 * and nothing about a guest reaches the grade table.
 */
export const guestParticipants = pgTable(
  "guest_participants",
  {
    id: uuid("id").primaryKey(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /** Reserved for a named guest (F-AUTH-05); no route sets it yet. */
    pseudonym: text("pseudonym"),
    /** sha256 of the cookie value — the clear token is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("guest_participants_evaluation_idx").on(t.evaluationId)],
);

export const attempts = pgTable(
  "attempts",
  {
    id: uuid("id").primaryKey(),
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    /**
     * The account that holds this attempt — NULL for a guest of a poll, and
     * only then: the check constraint below is what makes "exactly one owner"
     * a property of the schema rather than of a service.
     *
     * NO ACTION, like `enrollments.user_id`: deleting an account must never
     * erase its answers, gradings and journal in passing. An account leaves
     * by `users.anonymized_at` (ADR-003 §5), not by a DELETE.
     */
    userId: uuid("user_id").references(() => users.id),
    guestId: uuid("guest_id").references(() => guestParticipants.id, { onDelete: "cascade" }),
    state: text("state", { enum: ["not_started", "in_progress", "submitted", "expired"] })
      .notNull()
      .default("not_started"),
    /** Drawn once; every permutation is derived from it and never stored (D19). */
    seed: integer("seed").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    /** Null in `manual` timing: only the teacher closes (F-EVAL-04). */
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    /** The accommodation actually granted, in seconds (F-ORG-07, decision D8). */
    bonusS: integer("bonus_s").notNull().default(0),
    /** Accumulated teacher extensions, in seconds (F-LIVE-11). */
    extraS: integer("extra_s").notNull().default(0),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by", { enum: ["server", "student", "teacher"] }),
    /** Where the student was, restored on reload (F-LIVE-06). */
    lastItemId: uuid("last_item_id"),
    /** Last sign of life; the presence map is in memory, this survives a restart. */
    presentAt: timestamp("present_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("attempts_evaluation_user_uq").on(t.evaluationId, t.userId),
    // The same idempotency, for the guest half: one attempt per (poll,
    // browser), so a reload of `/p/<code>` never opens a second one.
    uniqueIndex("attempts_evaluation_guest_uq").on(t.evaluationId, t.guestId),
    check(
      "attempts_owner_ck",
      sql`(${t.userId} is null) <> (${t.guestId} is null)`,
    ),
    index("attempts_deadline_idx")
      .on(t.deadlineAt)
      .where(sql`${t.state} = 'in_progress'`),
  ],
);

export const answers = pgTable(
  "answers",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => evaluationItems.id, { onDelete: "cascade" }),
    /** Validated by `type.answerSchema` before it gets here; never garbage. */
    payload: jsonb("payload").notNull(),
    /** Client-local monotonic counter; the upsert keeps the highest one. */
    revision: integer("revision").notNull().default(0),
    markedDone: boolean("marked_done").notNull().default(false),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("answers_attempt_item_uq").on(t.attemptId, t.itemId),
    index("answers_item_idx").on(t.itemId),
  ],
);

/**
 * The attempt journal (F-EVAL-13): tab visibility, focus, reconnections,
 * teacher extensions and Run requests. Nothing here blocks a student; it is
 * what the teacher sees next to a row. `run` rows also carry the per-minute
 * rate limit of `POST /attempts/:id/run`.
 */
export const attemptEvents = pgTable(
  "attempt_events",
  {
    id: uuid("id").primaryKey(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: [
        "visibility",
        "focus",
        "ip_change",
        "reconnect",
        "time_added",
        "paused",
        "resumed",
        "run",
      ],
    }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    details: jsonb("details"),
  },
  (t) => [index("attempt_events_attempt_idx").on(t.attemptId, t.at)],
);

