/**
 * Single ticker (ADR-006): no one-shot scheduled jobs. Every `TICK_MS` it
 * re-reads the database and does whatever is due. Rescheduling is free (the
 * condition is re-read), catch-up after an outage is free (the condition
 * stays true). Multi-process safety does not rest on the ticker: every
 * action performs an atomic claim (conditional UPDATE) or goes through a
 * queue singleton.
 *
 * The period is one second by default because that is what the live
 * evaluation clock needs (docs/spec/05-architecture.md, 5.4): a tentative
 * whose deadline has passed by more than three seconds must already be
 * closed by the server. A task that does not need that cadence carries its
 * own `everyMs`.
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { purgeExpiredSessions } from "./auth/session.js";

export interface TickTask {
  name: string;
  /** Minimum delay between two runs; omitted = every tick. */
  everyMs?: number;
  run: (app: FastifyInstance, config: AppConfig) => Promise<void>;
}

/** Tasks every deployment runs. Modules add theirs at registration time. */
export const CORE_TASKS: TickTask[] = [
  {
    name: "sessions.purge",
    everyMs: 10 * 60_000,
    run: async (app) => {
      await purgeExpiredSessions(app.db);
    },
  },
];

export function startTicker(
  app: FastifyInstance,
  config: AppConfig,
  tasks: readonly TickTask[] = CORE_TASKS,
) {
  let running = false;
  const lastRun = new Map<string, number>();

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
