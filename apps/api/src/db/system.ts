/**
 * The scheduled tasks (D10, merge task M2-05; ported from heig-classroom's
 * table of the same name). Owned by the `system` module
 * (`modules/system/`): the ticker's claim, the worker's outcome and the
 * admin routes all write through its service, and no other module touches
 * the table.
 *
 * A row is the CONFIGURATION and the LAST STATE of one task of the catalog
 * (`SCHEDULED_TASKS`, `modules/system/catalog.ts`); the catalog itself —
 * what a task does, its default period — is code. A row is inserted with the
 * defaults at the first boot that knows its key, and a row whose key left
 * the catalog stays, ignored: never claimed, never listed.
 *
 * `last_run_at` is the claim: the ticker sets it, with `last_status =
 * 'running'`, in ONE conditional UPDATE on the database clock, so two
 * processes never claim the same run, and a restart, however long, finds the
 * condition still true and catches up.
 */
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { SCHEDULED_TASK_STATUSES } from "@quiz/contracts";

export const scheduledTasks = pgTable("scheduled_tasks", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  intervalMinutes: integer("interval_minutes").notNull(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status", { enum: SCHEDULED_TASK_STATUSES }),
  /** The run's English summary, or its error; truncated. */
  lastMessage: text("last_message"),
  lastDurationMs: integer("last_duration_ms"),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
});
