/**
 * Background job queue (ADR-004). On a real PostgreSQL the queue IS pg-boss:
 * durable, retried, dead-lettered, visible in the database.
 *
 * On the embedded development database (`pglite://…`) pg-boss cannot run —
 * it needs its own `pgboss` schema, advisory locks and several connections.
 * Rather than making `pnpm dev` depend on a container engine, this module
 * swaps in a minimal in-process runner behind the SAME `send`/`work`
 * surface. It is deliberately not durable: a job not yet run dies with the
 * process. That is acceptable for development and nowhere else, which is why
 * `config.ts` refuses a pglite URL under NODE_ENV=production.
 */
import { PgBoss } from "pg-boss";

import type { FastifyInstance } from "fastify";

/**
 * The grading queues (PLAN-MVP §5.4). Their names live here, next to the
 * queue itself, so that `grep QUEUE jobs.ts` lists everything this process
 * can be asked to do in the background.
 *
 * `grading.evaluation` is one job per REQUEST, never deduplicated (#273):
 * a pass is idempotent, and every pass sent runs in full, so the close's
 * whole-evaluation pass can never be swallowed by a narrower one already
 * waiting. The reasoning is in `modules/grading/jobs.ts`.
 * `grading.runner` is one job per answer, at low priority, because a
 * container run is the slow half and must never hold up the deterministic
 * grading of the other questions. `grading.llm` is one job per answer too,
 * a call to the model (ADR-063).
 */
export const GRADING_EVALUATION_QUEUE = "grading.evaluation";
export const GRADING_RUNNER_QUEUE = "grading.runner";
export const GRADING_LLM_QUEUE = "grading.llm";

/**
 * One run of a scheduled task (D10, `modules/system/jobs.ts`): `{ key }`,
 * sent by the ticker after it claimed the task, or by an admin's "Run now".
 * The claim, not the queue, is what keeps a task from running twice at once;
 * no retry either: a failed run is recorded, and the next period is the retry.
 */
export const SYSTEM_TASK_QUEUE = "system.task";

/**
 * One GitHub webhook delivery to handle (spec 05 §5.11, merge task M2-04):
 * `{ deliveryId }`, sent by `/webhooks/github` once the delivery is stored,
 * and by `reconcile.deliveries` for one left unprocessed. The job carries
 * the id only; the worker reads the stored payload. A `standard` queue, no
 * dedupe: the stored `processed_at` is what makes a second job a no-op, and
 * the handlers are idempotent (ADR-011). Retried five times with backoff,
 * the error kept on the delivery.
 */
export const GITHUB_WEBHOOK_QUEUE = "github.webhook";

/**
 * One rebuild of a classroom's journal copy (spec 05 §5.11, merge task
 * M4-02): `{ classroomId }`, sent by the push handler (and by M4-03's
 * Refresh and saves). A `standard` queue, no dedupe: two jobs of one
 * classroom never commit over each other: each writes only if the row's
 * `version` is still the one it read before calling GitHub (fix J2,
 * `modules/journal/ingest.ts`), in pg-boss and in the in-process queue
 * alike. Retried three times with backoff when GitHub was unavailable.
 */
export const JOURNAL_INGEST_QUEUE = "journal.ingest";

/**
 * The deadline work of one project (spec 05 §5.11, merge task M3-05a,
 * ADR-064): `{ projectId, lease }`, sent by the ticker or a staff action
 * once it holds the project's lease (`projects.deadline_job_at`). A
 * `standard` queue, no dedupe: the lease, not the queue, is what keeps two
 * jobs of one project apart — a job whose lease is no longer the row's does
 * nothing —, and every repository's step re-reads its row and is idempotent.
 * No retry by the queue: the job renews its lease as it goes, so a retry
 * would carry a stale one; a failed job backdates its lease so that the
 * ticker claims the work again some 30 s on, a crashed one leaves it to
 * expire, ten minutes after its last renewal.
 */
export const PROJECT_DEADLINE_QUEUE = "project.deadline";

/**
 * The review dispatches of one project (merge task M3-05b, ADR-064
 * addendum): `{ projectId, lease }`, sent by the ticker only once it holds
 * the project's OTHER lease (`projects.dispatch_job_at`) — the final review
 * of each repository frozen, the checkpoints due. As
 * {@link PROJECT_DEADLINE_QUEUE}: `standard`, no dedupe, no retry by the
 * queue (a failure backdates the lease); and each repository's dispatch is
 * claimed in the `grade_dispatches` ledger before GitHub is called, at most
 * once.
 */
export const PROJECT_DISPATCH_QUEUE = "project.dispatch";

/**
 * The moves of a group set that wait for GitHub, for one project's copy
 * (ADR-070 §4, merge task M3-15b-2): `{ projectId, lease }`, sent right
 * after a set's write leaves some (`projects.group_sync_due_at`), or by the
 * ticker once it holds the project's lease (`projects.group_sync_job_at`).
 * As {@link PROJECT_DEADLINE_QUEUE}: `standard`, no dedupe, no retry by
 * the queue; a failed pass moves the due mark later (a backoff capped at an
 * hour), a crashed one leaves its lease to expire. Without a queue nothing
 * sends it: the moves wait (documented, M3-15b-2).
 */
export const PROJECT_GROUP_SYNC_QUEUE = "group.sync";

/**
 * One AI pass over a brainstorm (ADR-072): `{ evaluationId, lease }`, sent a
 * few seconds after the answer that claimed the poll's lease
 * (`poll_ai_runs.lease_at`). A `standard` queue, no dedupe, no retry: the
 * lease keeps two passes of one poll apart, and a failure is recorded and
 * left for the next answer to try again (`modules/poll/ai.ts`).
 */
export const POLL_AI_QUEUE = "poll.ai";

/**
 * No `singletonKey`, on purpose (#273). Our queues are pg-boss `standard`
 * queues (`createQueue` passes no policy, and pg-boss 12 refuses to change a
 * policy after creation), on which a key without `singletonSeconds` dedupes
 * nothing — while the in-process queue below used to drop the later job. A
 * dedupe that exists in only one of the two is worse than none.
 */
interface SendOptions {
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
  /** Higher runs first; the in-process development runner ignores it. */
  priority?: number;
  /**
   * Not before this instant: a job sent again past a GitHub rate limit's
   * reset (N-PERF-07). The in-process runner holds it in a timer.
   */
  startAfter?: Date;
}

interface WorkOptions {
  /** Jobs of this queue run at once in this process; the in-process runner runs one. */
  localConcurrency?: number;
}

interface JobHandler<T> {
  (data: T): Promise<void>;
}

/** The slice of pg-boss the application actually uses. */
export interface JobQueue {
  createQueue(name: string, options?: SendOptions): Promise<void>;
  send<T extends object>(name: string, data: T, options?: SendOptions): Promise<void>;
  work<T extends object>(name: string, handler: JobHandler<T>, options?: WorkOptions): Promise<void>;
  stop(): Promise<void>;
}

class PgBossQueue implements JobQueue {
  constructor(
    private readonly boss: PgBoss,
    private readonly runWorkers: boolean,
  ) {}
  async createQueue(name: string, options?: SendOptions) {
    await this.boss.createQueue(name, options as never);
  }
  async send<T extends object>(name: string, data: T, options?: SendOptions) {
    await this.boss.send(name, data, (options ?? {}) as never);
  }
  async work<T extends object>(name: string, handler: JobHandler<T>, options?: WorkOptions) {
    if (!this.runWorkers) return;
    await this.boss.work<T>(name, { ...options }, async (jobs) => {
      for (const job of jobs) await handler(job.data);
    });
  }
  async stop() {
    await this.boss.stop({ close: true, timeout: 5000 });
  }
}

/**
 * In-process replacement: jobs run on the next tick of the event loop, in
 * order, one at a time, and every job sent runs — none is collapsed, exactly
 * as on a pg-boss `standard` queue worked by one worker (`localConcurrency`
 * 1, the default). Exported for its tests.
 */
export class InProcessQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly pending: { name: string; data: object }[] = [];
  private draining = false;
  private stopped = false;

  constructor(
    private readonly runWorkers: boolean,
    private readonly log: FastifyInstance["log"],
  ) {}

  async createQueue() {
    /* nothing to create: the queue is an array */
  }

  async send<T extends object>(name: string, data: T, options?: SendOptions) {
    if (this.stopped) return;
    const delay = options?.startAfter ? options.startAfter.getTime() - Date.now() : 0;
    if (delay > 0) {
      setTimeout(() => void this.send(name, data), delay).unref();
      return;
    }
    this.pending.push({ name, data });
    void this.drain();
  }

  async work<T extends object>(name: string, handler: JobHandler<T>) {
    if (!this.runWorkers) return;
    this.handlers.set(name, handler as JobHandler<never>);
    void this.drain();
  }

  private async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      let job = this.pending.shift();
      while (job) {
        const handler = this.handlers.get(job.name);
        if (handler) {
          try {
            await (handler as JobHandler<object>)(job.data);
          } catch (err) {
            // No retry, no dead letter: the durable queue is the one that
            // owes those guarantees, and it is not this one.
            this.log.error({ err, queue: job.name }, "in-process job failed");
          }
        }
        job = this.pending.shift();
      }
    } finally {
      this.draining = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.pending.length = 0;
  }
}

export async function startJobs(
  app: FastifyInstance,
  opts: { databaseUrl: string; embedded: boolean; runWorkers: boolean; disabled?: boolean },
): Promise<JobQueue | null> {
  // `JOBS_DISABLED=1`: no queue at all, and `app.boss` stays undefined —
  // exactly the state a failed start leaves behind, so nothing downstream
  // learns a new case. /healthz reports `jobs: "down"`, which is true.
  if (opts.disabled) {
    app.log.info("JOBS_DISABLED=1: job queue not started");
    return null;
  }
  let queue: JobQueue;
  if (opts.embedded) {
    app.log.warn(
      "embedded database (pglite): pg-boss disabled, jobs run in-process and do not survive a restart",
    );
    queue = new InProcessQueue(opts.runWorkers, app.log);
  } else {
    const boss = new PgBoss({
      connectionString: opts.databaseUrl,
      // The pgboss.* schema lives in the same database (a single backup).
    });
    boss.on("error", (err: Error) => app.log.error({ err }, "pg-boss error"));
    await boss.start();
    queue = new PgBossQueue(boss, opts.runWorkers);
  }

  app.decorate("boss", queue);
  app.addHook("onClose", async () => {
    await queue.stop();
  });
  return queue;
}

declare module "fastify" {
  interface FastifyInstance {
    /** Absent if the queue failed to start (database unreachable at boot). */
    boss?: JobQueue;
  }
}
