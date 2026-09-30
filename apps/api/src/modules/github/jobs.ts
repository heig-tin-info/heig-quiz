/**
 * The `github` module's background work (M2-04): the `github.webhook`
 * worker, and its scheduled tasks (D10, joined to the catalog in
 * `modules/system/catalog.ts`). None runs inside a tick: the ticker claims a
 * due task and the `system.task` queue runs it (invariant 5).
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { GITHUB_WEBHOOK_QUEUE, type JobQueue } from "../../jobs.js";
import type { ScheduledTask } from "../../ticker.js";
import { processDelivery, purgeDeliveryPayloads, reconcileDeliveries } from "./deliveries.js";

/**
 * The worker, registered only when Quiz's App is configured (`app.ts`):
 * without it there is no intake, so nothing to work. Retried five times
 * with backoff (classroom's policy); a delivery that exhausts them stays
 * unprocessed, its error kept, for `reconcile.deliveries`.
 */
export async function registerGithubJobs(
  app: FastifyInstance,
  queue: JobQueue,
  config: AppConfig,
): Promise<void> {
  await queue.createQueue(GITHUB_WEBHOOK_QUEUE, {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 30,
  });
  await queue.work<{ deliveryId: string }>(GITHUB_WEBHOOK_QUEUE, ({ deliveryId }) =>
    processDelivery(app, config, deliveryId),
  );
}

/**
 * Daily, both, like classroom's, and in the catalog whether or not the App
 * is configured (the catalog is static). Without it the reconciliation
 * returns at once, and the purge clears what an earlier configuration left.
 */
export const GITHUB_TASKS: readonly ScheduledTask[] = [
  {
    key: "reconcile.deliveries",
    defaultIntervalMinutes: 24 * 60,
    run: reconcileDeliveries,
  },
  {
    key: "deliveries.purge",
    defaultIntervalMinutes: 24 * 60,
    run: async (app) =>
      `${await purgeDeliveryPayloads(app.db, app.clock.now())} delivery payloads cleared`,
  },
];
