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
 * grading of the other questions.
 */
export const GRADING_EVALUATION_QUEUE = "grading.evaluation";
export const GRADING_RUNNER_QUEUE = "grading.runner";

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
}

interface JobHandler<T> {
  (data: T): Promise<void>;
}

/** The slice of pg-boss the application actually uses. */
export interface JobQueue {
  createQueue(name: string, options?: SendOptions): Promise<void>;
  send<T extends object>(name: string, data: T, options?: SendOptions): Promise<void>;
  work<T extends object>(name: string, handler: JobHandler<T>): Promise<void>;
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
  async work<T extends object>(name: string, handler: JobHandler<T>) {
    if (!this.runWorkers) return;
    await this.boss.work<T>(name, async (jobs) => {
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

  async send<T extends object>(name: string, data: T) {
    if (this.stopped) return;
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
