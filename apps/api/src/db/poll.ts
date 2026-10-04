/**
 * The teacher's word on a brainstorm's ideas (issue #458, ADR-071). Owned by
 * the `poll` module.
 *
 * A mark is keyed by the IDEA (`ideaKey` of `@quiz/domain`), never by an
 * attempt or an answer: a participant who edits their answer keeps the
 * teacher's decision on the text they kept, and two participants who wrote
 * the same idea share it. A poll run "again" is a new evaluation and starts
 * with no mark.
 */
import { check, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { PollAiError } from "@quiz/contracts";

import { evaluations } from "./evaluation.js";

export const pollIdeaMarks = pgTable(
  "poll_idea_marks",
  {
    evaluationId: uuid("evaluation_id")
      .notNull()
      .references(() => evaluations.id, { onDelete: "cascade" }),
    ideaKey: text("idea_key").notNull(),
    /** `approved`, `hidden`, or null: not moderated yet. */
    status: text("status").$type<"approved" | "hidden">(),
    /** The idea key this idea was merged into; null when it stands alone. */
    mergedInto: text("merged_into"),
    /** The teacher's name for the cluster this idea heads. */
    label: text("label"),
    /** The model's corrected form of this idea (ADR-072); the stored answer is never changed. */
    correction: text("correction"),
    /** Who wrote the decision: a model writes only where nobody has (ADR-072). */
    source: text("source").$type<"teacher" | "ai">().notNull().default("teacher"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.evaluationId, t.ideaKey] }),
    check("poll_idea_marks_status_ck", sql`${t.status} IN ('approved', 'hidden')`),
    check("poll_idea_marks_source_ck", sql`${t.source} IN ('teacher', 'ai')`),
  ],
);

/**
 * The model's passes over one brainstorm (ADR-072). `lease_at` is held by the
 * one pass that may run: an answer that finds it free claims it and sends a
 * `poll.ai` job, and the job releases it when nothing is left to judge — so
 * two processes never judge the same ideas twice. `calls` counts this poll's
 * calls against the per-run limit; `error` is the last failure's code, shown
 * on the teacher's board and cleared by the next call that succeeds.
 */
export const pollAiRuns = pgTable("poll_ai_runs", {
  evaluationId: uuid("evaluation_id")
    .primaryKey()
    .references(() => evaluations.id, { onDelete: "cascade" }),
  leaseAt: timestamp("lease_at", { withTimezone: true }),
  calls: integer("calls").notNull().default(0),
  error: text("error").$type<PollAiError>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
