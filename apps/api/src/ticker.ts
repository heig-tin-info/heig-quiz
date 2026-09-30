/**
 * Single ticker (ADR-006): no one-shot scheduled jobs. Every `TICK_MS` it
 * re-reads the database and does whatever is due. Rescheduling is free (the
 * condition is re-read), catch-up after an outage is free (the condition
 * stays true). Multi-process safety does not rest on the ticker: every
 * action performs an atomic claim (conditional UPDATE or insert on a unique
 * key), and what it enqueues is idempotent (no queue dedupes, #273).
 *
 * The period is one second by default because that is what the live
 * evaluation clock needs (docs/spec/05-architecture.md, 5.4): a tentative
 * whose deadline has passed by more than three seconds must already be
 * closed by the server.
 *
 * Two kinds of periodic work, kept apart on purpose (D10, merge task M2-05):
 *
 *   - the CLOCK-BOUND tasks (`TickTask`, `TICK_TASKS`): the live half, run
 *     by the loop itself, every tick or every `everyMs`. They are neither
 *     configurable nor disableable — invariant 5 (the server owns the clock)
 *     must never depend on an admin setting;
 *   - the SCHEDULED tasks (`ScheduledTask`, catalog `SCHEDULED_TASKS` in
 *     `modules/system/catalog.ts`): the minutes-scale housekeeping, whose
 *     period, activation and last outcome live in the `scheduled_tasks`
 *     table, where an administrator sees and changes them. One tick task of
 *     the loop claims the due ones and enqueues them
 *     (`modules/system/jobs.ts`); it never runs one inside the tick.
 */
import type { FastifyInstance } from "fastify";

import type { ScheduledTaskKey } from "@quiz/contracts";

import type { AppConfig } from "./config.js";
import { expireSuperPowers } from "./auth/session.js";
import { KIOSK_TASKS } from "./modules/kiosk/jobs.js";
import { perApp } from "./perApp.js";
import { LIVE_TASKS } from "./modules/live/jobs.js";
import { scheduledTasksTick } from "./modules/system/jobs.js";

export interface TickTask {
  name: string;
  /** Minimum delay between two runs; omitted = every tick. */
  everyMs?: number;
  run: (app: FastifyInstance, config: AppConfig) => Promise<void>;
}

/**
 * A task of the scheduled catalog. `key` is one of the closed list of
 * `@quiz/contracts` (the admin screen names each one, in both languages);
 * `run` may return a short English summary of what it did ("3 sessions
 * deleted"), stored as the task's last message for the administrator —
 * operator data, like a log line, never translated.
 */
export interface ScheduledTask {
  key: ScheduledTaskKey;
  defaultIntervalMinutes: number;
  run: (app: FastifyInstance, config: AppConfig) => Promise<string | void>;
}

/**
 * Tasks every deployment runs on the loop. The live half (`LIVE_TASKS`) is
 * what makes the one-second period worthwhile: expiring attempts past
 * `deadline + GRACE_MS`, opening the evaluations whose `opens_at` has come
 * and closing those past `closes_at`. Then the expiry of Super Powers
 * (ADR-054) and the suspension of the silent kiosk stations (ADR-051 §6).
 * The last one claims and enqueues the due scheduled tasks.
 */
export const TICK_TASKS: TickTask[] = [
  ...LIVE_TASKS,
  {
    // ADR-054: Super Powers past their hour end here when no request of the
    // session comes — audited `expired`, the admin's streams closed — so an
    // open stream outlives them by one period at most. A clock-bound task,
    // not a scheduled one: an admin must not be able to pause the expiry of
    // their own Super Powers (06 no. 37).
    name: "superpowers.expire",
    everyMs: 60_000,
    run: async (app) => {
      await expireSuperPowers(app.db, app.clock.now());
    },
  },
  // ADR-051 §6: the silent kiosk stations suspended, clock-bound like the
  // expiry above, so a bare tick task too.
  ...KIOSK_TASKS,
  scheduledTasksTick(),
];

/**
 * When each application's ticker last COMPLETED a pass (wall clock, ms), for
 * the system status (N-OPS-03): a pass that hangs, or a loop that stopped,
 * shows as a growing lag. No entry: this process runs no ticker
 * (`WORKER_MODE=web`).
 */
const lastPass = perApp<number>();

/** The end of the last completed pass of this app's ticker; `undefined` without one. */
export function lastTickOf(app: FastifyInstance): number | undefined {
  return lastPass.get(app);
}

export function startTicker(
  app: FastifyInstance,
  config: AppConfig,
  tasks: readonly TickTask[] = TICK_TASKS,
) {
  let running = false;
  const lastRun = new Map<string, number>();
  lastPass.set(app, Date.now());

  const tick = async () => {
    if (running) return; // no overlap
    running = true;
    try {
      const now = Date.now();
      for (const task of tasks) {
        if (task.everyMs && now - (lastRun.get(task.name) ?? 0) < task.everyMs) continue;
        lastRun.set(task.name, now);
        try {
          await task.run(app, config);
        } catch (err) {
          app.log.error({ err, task: task.name }, "ticker task failed");
        }
      }
      lastPass.set(app, Date.now());
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), config.TICK_MS);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
  void tick(); // immediate first pass (catch-up after a restart)
  return () => clearInterval(timer);
}
