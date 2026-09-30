/**
 * The scheduled tasks (D10, merge task M2-05, ported from heig-classroom's
 * `tasks.ts`): the configuration and the last state of the minutes-scale
 * periodic work, in `scheduled_tasks`, which this module owns.
 *
 * The catalog is code (`catalog.ts`, `SCHEDULED_TASKS`), and this module is
 * its only reader: the rest of the application goes through the functions
 * here and the tick of `jobs.ts`. The functions that act on the catalog take
 * it as a parameter defaulting to `SCHEDULED_TASKS`, which is what lets the
 * tests pass a fake one; the claim and the run know a task by its key, its
 * default period and its `run`, nothing of any domain.
 *
 * Every row is inserted once, at boot (`seedScheduledTasks`, `app.ts`); a
 * task whose row is missing is neither claimed nor listed.
 *
 * Every time here is the DATABASE's clock (`now()`), like classroom's: the
 * claim must agree across processes, and a period of minutes has nothing to
 * do with the live clock of invariant 5, which never goes through this table.
 */
import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { AdminScheduledTask, ScheduledTaskPatch } from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { scheduledTasks } from "../../db/schema.js";
import { publish } from "../../events.js";
import { SYSTEM_TASK_QUEUE } from "../../jobs.js";
import type { ScheduledTask } from "../../ticker.js";
import { SCHEDULED_TASKS } from "./catalog.js";

// The health checks (N-OPS-03, ADR-055) live beside, in `health.ts`; this
// file stays the module's entry.
export { coarseHealth, runChecks, systemStatus, HEALTH_CHECKS } from "./health.js";

/**
 * A run still `running` this long after its claim is taken for dead (a
 * process that crashed mid-run, an in-process job lost with its process):
 * the task may be claimed again. Until then, a slow run is never doubled by
 * the next period nor by "Run now".
 */
export const RUNNING_STALE_MINUTES = 30;

/** The stored message is a line for the admin screen, not a stack trace. */
const MESSAGE_MAX = 500;

const t = scheduledTasks;

/** Not running, or running for so long that the run is dead. */
const idle = sql`(${t.lastStatus} IS DISTINCT FROM 'running'
  OR ${t.lastRunAt} + make_interval(mins => ${RUNNING_STALE_MINUTES}) <= now())`;

/** The catalog task of this key, if the catalog holds one. */
export function scheduledTask(
  key: string,
  catalog: readonly ScheduledTask[] = SCHEDULED_TASKS,
): ScheduledTask | undefined {
  return catalog.find((task) => task.key === key);
}

/** The row of every catalog task, inserted with its defaults if missing. Once, at boot. */
export async function seedScheduledTasks(
  db: Db,
  catalog: readonly ScheduledTask[] = SCHEDULED_TASKS,
): Promise<void> {
  if (catalog.length === 0) return;
  await db
    .insert(scheduledTasks)
    .values(catalog.map((task) => ({ key: task.key, intervalMinutes: task.defaultIntervalMinutes })))
    .onConflictDoNothing();
}

/**
 * THE claim of the ticker: ONE conditional UPDATE takes every enabled task
 * of the catalog whose period has run out (or that never ran), stamps it
 * `running` at `now()`, and returns its key. Two processes, or two ticks,
 * racing on the same row: the second finds the condition false. A row whose
 * key is not in `keys` (a task removed from the catalog) is never claimed.
 */
export async function claimDueTasks(db: Db, keys: readonly string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const claimed = await db
    .update(scheduledTasks)
    .set({ lastRunAt: sql`now()`, lastStatus: "running" })
    .where(
      and(
        eq(t.enabled, true),
        inArray(t.key, [...keys]),
        or(
          isNull(t.lastRunAt),
          and(sql`${t.lastRunAt} + make_interval(mins => ${t.intervalMinutes}) <= now()`, idle),
        ),
      ),
    )
    .returning({ key: t.key });
  return claimed.map((row) => row.key);
}

/**
 * "Run now": the same claim for one task, whatever its period and even
 * disabled — an administrator asked — but never while it runs. `false` when
 * it is running (or has no row).
 */
export async function claimTaskNow(db: Db, task: ScheduledTask): Promise<boolean> {
  const [claimed] = await db
    .update(scheduledTasks)
    .set({ lastRunAt: sql`now()`, lastStatus: "running" })
    .where(and(eq(t.key, task.key), idle))
    .returning({ key: t.key });
  return claimed !== undefined;
}

/** The end of a run, whatever it was: status, message, duration. */
export async function recordOutcome(
  db: Db,
  key: string,
  outcome: { ok: boolean; message: string | null; durationMs: number },
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({
      lastStatus: outcome.ok ? "ok" : "error",
      lastMessage: outcome.message ? outcome.message.slice(0, MESSAGE_MAX) : null,
      lastDurationMs: Math.round(outcome.durationMs),
      ...(outcome.ok ? { lastOkAt: sql`now()` } : {}),
    })
    .where(eq(t.key, key));
  // The administrators' screen refreshes on the hint (`admin` topic).
  publish("admin", ["admin"]);
}

/**
 * One instrumented run of a CLAIMED task. It never throws: a failure is
 * logged and recorded as the task's last status, and the next period is its
 * retry.
 */
export async function runScheduledTask(
  app: FastifyInstance,
  config: AppConfig,
  task: ScheduledTask,
): Promise<void> {
  const started = performance.now();
  let outcome: { ok: boolean; message: string | null };
  try {
    outcome = { ok: true, message: (await task.run(app, config)) || null };
  } catch (err) {
    app.log.error({ err, task: task.key }, "scheduled task failed");
    outcome = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  try {
    await recordOutcome(app.db, task.key, { ...outcome, durationMs: performance.now() - started });
  } catch (err) {
    // The database went away between the run and its record: the row stays
    // `running` until it is stale, and the task is claimed again then.
    app.log.error({ err, task: task.key }, "scheduled task outcome not recorded");
  }
}

/** The payload of a `system.task` job. */
export interface TaskJob {
  key: string;
}

/**
 * Runs a claimed task: on the queue when there is one (`jobs.ts` works it),
 * inline otherwise. Resolves once the job is sent (or, inline, once the run
 * is over) and says which; never rejects — a send that fails is recorded as
 * the run's error.
 */
export async function dispatchScheduledTask(
  app: FastifyInstance,
  config: AppConfig,
  task: ScheduledTask,
): Promise<"inline" | "queued"> {
  if (!app.boss) {
    await runScheduledTask(app, config, task);
    return "inline";
  }
  try {
    await app.boss.send<TaskJob>(SYSTEM_TASK_QUEUE, { key: task.key });
  } catch (err) {
    app.log.error({ err, task: task.key }, "scheduled task not enqueued");
    await recordOutcome(app.db, task.key, {
      ok: false,
      message: `not enqueued: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
    }).catch(() => {});
  }
  return "queued";
}

const columns = {
  key: t.key,
  enabled: t.enabled,
  intervalMinutes: t.intervalMinutes,
  lastRunAt: t.lastRunAt,
  lastStatus: t.lastStatus,
  lastMessage: t.lastMessage,
  lastDurationMs: t.lastDurationMs,
  lastOkAt: t.lastOkAt,
  nextRunAt: sql`CASE WHEN ${t.enabled}
    THEN coalesce(${t.lastRunAt} + make_interval(mins => ${t.intervalMinutes}), now()) END`.mapWith(
    (v: string | Date | null) => (v === null ? null : new Date(v)),
  ),
};

type Row = typeof scheduledTasks.$inferSelect & { nextRunAt: Date | null };

function toWire(task: ScheduledTask, row: Row): AdminScheduledTask {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  return {
    key: task.key,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    defaultIntervalMinutes: task.defaultIntervalMinutes,
    lastRunAt: iso(row.lastRunAt),
    lastStatus: row.lastStatus,
    lastMessage: row.lastMessage,
    lastDurationMs: row.lastDurationMs,
    lastOkAt: iso(row.lastOkAt),
    nextRunAt: iso(row.nextRunAt),
  };
}

/** The catalog joined to its rows, in the catalog's order. */
export async function listScheduledTasks(
  db: Db,
  catalog: readonly ScheduledTask[] = SCHEDULED_TASKS,
): Promise<AdminScheduledTask[]> {
  if (catalog.length === 0) return [];
  const rows = await db
    .select(columns)
    .from(scheduledTasks)
    .where(inArray(t.key, catalog.map((task) => task.key)));
  const byKey = new Map(rows.map((row) => [row.key, row]));
  return catalog.flatMap((task) => {
    const row = byKey.get(task.key);
    return row ? [toWire(task, row)] : [];
  });
}

/** One task joined to its row; `undefined` without a row. */
export async function scheduledTaskRow(
  db: Db,
  task: ScheduledTask,
): Promise<AdminScheduledTask | undefined> {
  const [row] = await db.select(columns).from(scheduledTasks).where(eq(t.key, task.key));
  return row ? toWire(task, row) : undefined;
}

/**
 * An administrator's change of activation or period (validated by the
 * contract). `false` when the task has no row.
 */
export async function configureScheduledTask(
  db: Db,
  task: ScheduledTask,
  patch: ScheduledTaskPatch,
): Promise<boolean> {
  const updated = await db
    .update(scheduledTasks)
    .set({
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.intervalMinutes === undefined ? {} : { intervalMinutes: patch.intervalMinutes }),
    })
    .where(eq(t.key, task.key))
    .returning({ key: t.key });
  return updated.length > 0;
}
