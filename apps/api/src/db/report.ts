/**
 * The reports on a question (issue #680, lot 3), owned by the `pool` module
 * (`modules/pool/reports.ts`): no other module writes this table.
 *
 * A reader of the pool tells its writers that a question is wrong, with a
 * message. It stays open until a writer resolves it, with an optional reply
 * the reporter is told of. Never read by an attempt or by `toStudent`
 * (invariant 4). The reports go with their question (cascade): a hard delete
 * removes them, a soft delete closes the open ones (`closeReportsOf`).
 * `resolved_by` is null on a report closed by the question's deletion.
 */
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { questions } from "./pool.js";

export const questionReports = pgTable(
  "question_reports",
  {
    id: uuid("id").primaryKey(),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id").references(() => users.id, { onDelete: "set null" }),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    /** The writer's reply to the reporter; empty when none was given. */
    resolution: text("resolution").notNull().default(""),
  },
  (t) => [index("question_reports_question_idx").on(t.questionId, t.resolvedAt)],
);
