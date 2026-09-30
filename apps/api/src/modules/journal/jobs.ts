/**
 * What sets the journal's copy moving, apart from a staff action (M4-03):
 *
 * - the `journal.ingest` worker (queue policy in `jobs.ts`: `standard`, the
 *   serialisation is the ingestion's lock, fix J2);
 * - the webhook handlers, registered on `github`'s registry (M2-04; `github`
 *   never imports this module): a `push` fans out to every classroom row
 *   holding the repository on the pushed branch, a `repository` event
 *   follows a rename and records a deletion;
 * - the J4 sweep, a clock-bound task of the ticker (spec 05 §5.11, D10): a
 *   page's visibility is a date, and must not wait on an admin setting.
 */
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import { classroomJournals } from "../../db/schema.js";
import { JOURNAL_INGEST_QUEUE, type JobQueue } from "../../jobs.js";
import type { TickTask } from "../../ticker.js";
import { onEvent, type WebhookHandler } from "../github/service.js";
import { ingestJournal, repositoryChanged, sweepVisibleFrom } from "./ingest.js";
import { requestIngest } from "./service.js";

// ---------------------------------------------------------------- the queue

/** Registered only with Quiz's App (`app.ts`): without it there is no journal to copy. */
export async function registerJournalJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(JOURNAL_INGEST_QUEUE, { retryLimit: 3, retryBackoff: true, retryDelay: 20 });
  await queue.work<{ classroomId: string }>(JOURNAL_INGEST_QUEUE, async ({ classroomId }) => {
    const outcome = await ingestJournal(app, config, classroomId);
    // Recorded on the row already; only GitHub's unavailability is worth a retry.
    if (outcome?.status === "error" && outcome.code === "github_unavailable") {
      throw new Error("journal ingestion: GitHub unavailable");
    }
  });
}

// ---------------------------------------------------------------- the webhooks

/** What the push handler reads: the branch, the new head, the repository's immutable id. */
const PushEvent = z.object({
  ref: z.string(),
  after: z.string(),
  repository: z.object({ id: z.number().int() }),
});

const RepositoryEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int(), full_name: z.string().min(1) }),
});

/**
 * A push: one ingestion per classroom row holding the repository on the
 * pushed branch whose copy is not already at `after` — a browser save
 * re-ingests at once and its webhook arrives after (skipped), and a replayed
 * delivery finds the copy moved on (skipped too). A deleted branch (`after`
 * all zeros) is ingested like any head: the copy then says `ref_not_found`.
 */
const push: WebhookHandler = async (app, config, delivery) => {
  const event = PushEvent.safeParse(delivery.payload);
  if (!event.success || !event.data.ref.startsWith("refs/heads/")) return;
  const branch = event.data.ref.slice("refs/heads/".length);
  const rows = await app.db
    .select({ classroomId: classroomJournals.classroomId, lastCommitSha: classroomJournals.lastCommitSha })
    .from(classroomJournals)
    .where(and(eq(classroomJournals.githubRepoId, event.data.repository.id), eq(classroomJournals.ref, branch)));
  for (const row of rows) {
    if (row.lastCommitSha !== event.data.after) await requestIngest(app, config, row.classroomId);
  }
};

/** `repository`: `renamed` followed, `deleted` an error with the pages kept (F-JRN-05). */
const repository: WebhookHandler = async (app, _config, delivery) => {
  const event = RepositoryEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { action, repository: repo } = event.data;
  if (action === "renamed") await repositoryChanged(app, repo.id, { action, fullName: repo.full_name });
  else if (action === "deleted") await repositoryChanged(app, repo.id, { action });
};

/** Called once per app by the module's plugin; registering twice changes nothing. */
export function registerJournalHandlers(): void {
  onEvent("push", push);
  onEvent("repository", repository);
}

// ---------------------------------------------------------------- the ticker

/** Fix J4: every minute, the journals where a page's `visible_from` just passed. */
export const JOURNAL_TASKS: readonly TickTask[] = [
  {
    name: "journal.visible_from",
    everyMs: 60_000,
    run: async (app) => {
      await sweepVisibleFrom(app);
    },
  },
];
