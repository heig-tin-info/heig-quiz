/**
 * The `codespace.sync` worker (ADR-047 §6, merge task M6-06; the queue's
 * policy is `jobs.ts`'s). A failure throws, so pg-boss retries with
 * backoff; the error of the last attempt is on the project's portal row.
 */
import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config.js";
import { CODESPACE_SYNC_QUEUE, type JobQueue } from "../../jobs.js";
import { runCodespaceSync } from "./service.js";

/** Registered only when the portal is configured (`app.ts`). */
export async function registerCodespaceJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(CODESPACE_SYNC_QUEUE, { retryLimit: 5, retryBackoff: true, retryDelay: 30 });
  await queue.work<{ projectId: string }>(CODESPACE_SYNC_QUEUE, async ({ projectId }) => {
    await runCodespaceSync(app, config, projectId, app.log);
  });
}
