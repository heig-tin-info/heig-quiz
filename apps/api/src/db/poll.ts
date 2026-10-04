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
import { check, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.evaluationId, t.ideaKey] }),
    check("poll_idea_marks_status_ck", sql`${t.status} IN ('approved', 'hidden')`),
  ],
);
