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

import { CHECK_STATUSES, SCHEDULED_TASK_STATUSES, SYSTEM_CHECK_KEYS } from "@quiz/contracts";
import { CHECK_NOTIFIED } from "@quiz/domain";

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

/**
 * What the `health.checks` scheduled task keeps of each health check between
 * two runs (ADR-055 §5), so that a transition is seen across restarts and
 * processes: the status of the last run, since when it holds and for how
 * many runs, and the last notice the administrators were sent about it. The
 * rule that reads and writes it is `nextCheckState` of `@quiz/domain`. Owned
 * by the `system` module; one row per check key, inserted at the check's
 * first run. A row whose key left the registry stays, ignored.
 */
export const healthCheckStates = pgTable("health_check_states", {
  key: text("key", { enum: SYSTEM_CHECK_KEYS }).primaryKey(),
  status: text("status", { enum: CHECK_STATUSES }).notNull(),
  since: timestamp("since", { withTimezone: true }).notNull(),
  consecutive: integer("consecutive").notNull(),
  /** `fail`: an alert is outstanding; `ok`: its recovery was sent; null: nobody was told. */
  notifiedStatus: text("notified_status", { enum: CHECK_NOTIFIED }),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
});
