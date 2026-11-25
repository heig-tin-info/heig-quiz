/**
 * The `codespace` workers (the queues' policies are `jobs.ts`'s):
 *
 *   - `codespace.sync` (ADR-047 §6, merge task M6-06): a failure throws, so
 *     pg-boss retries with backoff; the error of the last attempt is on the
 *     project's portal row;
 *   - `codespace.image` (ADR-146 §5): one tick of a course image's admission
 *     follow-up, which sends the next one while the admission is in flight.
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { CODESPACE_IMAGE_QUEUE, CODESPACE_SYNC_QUEUE, type JobQueue } from "../../jobs.js";
import { followAdmission, followLater } from "./images.js";
import { runCodespaceSync } from "./service.js";

/** Registered only when the portal is configured (`app.ts`). */
export async function registerCodespaceJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(CODESPACE_SYNC_QUEUE, { retryLimit: 5, retryBackoff: true, retryDelay: 30 });
  await queue.work<{ projectId: string }>(CODESPACE_SYNC_QUEUE, async ({ projectId }) => {
    await runCodespaceSync(app, config, projectId, app.log);
  });
  // A failed tick (the database) is retried; a portal that cannot be asked is a tick that changes nothing.
  await queue.createQueue(CODESPACE_IMAGE_QUEUE, { retryLimit: 3, retryBackoff: true, retryDelay: 5 });
  await queue.work<{ imageId: string }>(CODESPACE_IMAGE_QUEUE, async ({ imageId }) => {
    if ((await followAdmission(app, config, imageId)) === "pending") await followLater(app, config, imageId);
  });
}
