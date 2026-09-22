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
 * `grading.evaluation` is a SINGLETON per evaluation: closing an evaluation
 * twice, or pressing "re-grade" while a pass is already pending, enqueues one
 * job. `grading.runner` is one job per answer, at low priority, because a
 * container run is the slow half and must never hold up the deterministic
 * grading of the other questions.
 */
export const GRADING_EVALUATION_QUEUE = "grading.evaluation";
export const GRADING_RUNNER_QUEUE = "grading.runner";

interface SendOptions {
  /** At most one pending job per key, as pg-boss defines it. */
  singletonKey?: string;
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
 * order, one at a time. `singletonKey` collapses duplicates that have not
 * started yet, which is the property the callers rely on.
 */
class InProcessQueue implements JobQueue {
  private readonly handlers = new Map<string, JobHandler<never>>();
  private readonly pending: { name: string; data: object; key?: string | undefined }[] = [];
  private readonly keys = new Set<string>();
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
    const key = options?.singletonKey ? `${name}:${options.singletonKey}` : undefined;
    if (key) {
      if (this.keys.has(key)) return;
      this.keys.add(key);
    }
    this.pending.push({ name, data, key });
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
        if (job.key) this.keys.delete(job.key);
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
    this.keys.clear();
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
