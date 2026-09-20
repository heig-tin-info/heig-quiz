/**
 * pg-boss job queue (ADR-004): PostgreSQL is the only stateful component.
 * Handlers run with exponential-backoff retries then dead-letter (visible in
 * the database).
 */
import { PgBoss } from "pg-boss";

import type { FastifyInstance } from "fastify";

/** Purge of expired sessions, wired into the ticker. */
export const HOUSEKEEPING_QUEUE = "housekeeping.purge";

export interface SendOptions {
  /** At most one pending job per key. */
  singletonKey?: string;
  retryLimit?: number;
  retryBackoff?: boolean;
  retryDelay?: number;
}

export interface JobHandler<T> {
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

export async function startJobs(
  app: FastifyInstance,
  opts: { databaseUrl: string; runWorkers: boolean },
): Promise<JobQueue> {
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    // The pgboss.* schema lives in the same database (a single backup).
  });
  boss.on("error", (err: Error) => app.log.error({ err }, "pg-boss error"));
  await boss.start();
  const queue: JobQueue = new PgBossQueue(boss, opts.runWorkers);

  await queue.createQueue(HOUSEKEEPING_QUEUE, { retryLimit: 0 });

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
