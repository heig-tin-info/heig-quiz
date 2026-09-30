/**
 * The scheduled tasks on the ticker and on the queue (D10, merge task M2-05).
 *
 * The ticker's part is one tick task, `system.scheduled_tasks`: it claims
 * the due tasks (`claimDueTasks`, one conditional UPDATE) and hands each to
 * the `system.task` queue. It never runs one inside the tick — a purge must
 * not hold up the live clock of the next second (invariant 5). Without a
 * queue (`JOBS_DISABLED=1`, or a queue that failed to start), a claimed task
 * runs inline instead, beside the tick and not awaited by it, like the
 * grading pass runs at its call site.
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { SYSTEM_TASK_QUEUE, type JobQueue } from "../../jobs.js";
import type { TickTask } from "../../ticker.js";
import { SCHEDULED_TASKS } from "./catalog.js";
import {
  claimDueTasks,
  dispatchScheduledTask,
  runScheduledTask,
  scheduledTask,
  type TaskJob,
} from "./service.js";

/**
 * How often the ticker looks for a due task. Periods are whole minutes; a
 * claim that comes up to fifteen seconds late costs nothing, and a pass of
 * the 1-s loop in fifteen is one cheap statement.
 */
export const SCHEDULED_CLAIM_EVERY_MS = 15_000;

/** The queue and its worker. Called once, from `buildApp`. */
export async function registerSystemJobs(
  app: FastifyInstance,
  queue: JobQueue,
  config: AppConfig,
): Promise<void> {
  await queue.createQueue(SYSTEM_TASK_QUEUE);
  await queue.work<TaskJob>(SYSTEM_TASK_QUEUE, async ({ key }) => {
    // A key that left the catalog between the claim and the run: nothing to do.
    const task = scheduledTask(key);
    if (task) await runScheduledTask(app, config, task);
  });
}

/** The tick task that drives the catalog: claim, then dispatch, never awaited. */
export function scheduledTasksTick(): TickTask {
  return {
    name: "system.scheduled_tasks",
    everyMs: SCHEDULED_CLAIM_EVERY_MS,
    run: async (app, config) => {
      const claimed = await claimDueTasks(
        app.db,
        SCHEDULED_TASKS.map((task) => task.key),
      );
      for (const key of claimed) {
        const task = scheduledTask(key);
        if (task) void dispatchScheduledTask(app, config, task);
      }
    },
  };
}
