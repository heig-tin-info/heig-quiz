/**
 * Starting the job queue (ADR-004): which queue a process gets, and what
 * each one does with a job.
 *
 *   - `JOBS_DISABLED=1`: none at all, and `app.boss` stays unset — the same
 *     state as a queue that failed to start;
 *   - an embedded database: the in-process queue, not durable, said so in
 *     the log;
 *   - a real PostgreSQL: pg-boss, behind the same four methods. pg-boss is
 *     replaced here by a recording double: what is pinned is the adapter,
 *     not pg-boss.
 *
 * A web-only process (`runWorkers: false`) sends jobs but never works them.
 */
import type { FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boss = vi.hoisted(() => ({
  failNextStart: false,
  instances: [] as {
    options: unknown;
    handlers: Map<string, (err: Error) => void>;
    start: ReturnType<typeof vi.fn>;
    createQueue: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    work: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock("pg-boss", () => ({
  PgBoss: vi.fn().mockImplementation(function (this: unknown, options: unknown) {
    const instance = {
      options,
      handlers: new Map<string, (err: Error) => void>(),
      start: vi.fn(async () => {
        if (boss.failNextStart) {
          boss.failNextStart = false;
          throw new Error("unreachable");
        }
      }),
      createQueue: vi.fn(async () => {}),
      send: vi.fn(async () => "job-id"),
      work: vi.fn(async () => "worker-id"),
      stop: vi.fn(async () => {}),
      on(event: string, handler: (err: Error) => void) {
        instance.handlers.set(event, handler);
      },
    };
    boss.instances.push(instance);
    return instance;
  }),
}));

import { InProcessQueue, startJobs } from "./jobs.js";

/** An app double: what `startJobs` decorates, hooks and logs. */
function fakeApp() {
  const decorations = new Map<string, unknown>();
  const closeHooks: (() => Promise<void>)[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const app = {
    log,
    decorate: (name: string, value: unknown) => void decorations.set(name, value),
    addHook: (name: string, fn: () => Promise<void>) => {
      if (name === "onClose") closeHooks.push(fn);
    },
  } as unknown as FastifyInstance;
  return { app, log, decorations, close: () => Promise.all(closeHooks.map((fn) => fn())) };
}

beforeEach(() => {
  boss.instances.length = 0;
});

describe("startJobs", () => {
  it("starts no queue when disabled, and leaves app.boss unset", async () => {
    const { app, log, decorations } = fakeApp();
    const queue = await startJobs(app, {
      databaseUrl: "postgres://x",
      embedded: false,
      runWorkers: true,
      disabled: true,
    });
    expect(queue).toBeNull();
    expect(decorations.has("boss")).toBe(false);
    expect(boss.instances).toHaveLength(0);
    expect(log.info).toHaveBeenCalled();
  });

  it("runs jobs in-process on the embedded database, and warns that they do not survive", async () => {
    const { app, log, decorations, close } = fakeApp();
    const queue = await startJobs(app, { databaseUrl: "pglite://x", embedded: true, runWorkers: true });
    expect(queue).toBeInstanceOf(InProcessQueue);
    expect(decorations.get("boss")).toBe(queue);
    expect(boss.instances).toHaveLength(0);
    expect(log.warn).toHaveBeenCalled();

    const seen: number[] = [];
    await queue!.work<{ n: number }>("q", async ({ n }) => void seen.push(n));
    await queue!.send("q", { n: 1 });
    await vi.waitFor(() => expect(seen).toEqual([1]));

    // Closing the app stops the queue: a job sent afterwards never runs.
    await close();
    await queue!.send("q", { n: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual([1]);
  });

  it("starts pg-boss on a real database, in the same database, and logs its errors", async () => {
    const { app, log, decorations } = fakeApp();
    const queue = await startJobs(app, {
      databaseUrl: "postgres://quiz@db/quiz",
      embedded: false,
      runWorkers: true,
    });
    expect(boss.instances).toHaveLength(1);
    const instance = boss.instances[0]!;
    expect(instance.options).toEqual({ connectionString: "postgres://quiz@db/quiz" });
    expect(instance.start).toHaveBeenCalledTimes(1);
    expect(decorations.get("boss")).toBe(queue);

    const err = new Error("connection lost");
    instance.handlers.get("error")!(err);
    expect(log.error).toHaveBeenCalledWith({ err }, "pg-boss error");
  });

  it("propagates a pg-boss that cannot start, and decorates no queue", async () => {
    const { app, decorations } = fakeApp();
    boss.failNextStart = true;
    await expect(
      startJobs(app, { databaseUrl: "postgres://x", embedded: false, runWorkers: true }),
    ).rejects.toThrow("unreachable");
    expect(decorations.has("boss")).toBe(false);
  });
});

describe("the pg-boss adapter", () => {
  async function started(runWorkers: boolean) {
    const fake = fakeApp();
    const queue = (await startJobs(fake.app, {
      databaseUrl: "postgres://x",
      embedded: false,
      runWorkers,
    }))!;
    return { ...fake, queue, instance: boss.instances.at(-1)! };
  }

  it("passes queue creation and sends through, options included", async () => {
    const { queue, instance } = await started(true);
    await queue.createQueue("grading.runner", { retryLimit: 2 });
    expect(instance.createQueue).toHaveBeenCalledWith("grading.runner", { retryLimit: 2 });

    await queue.send("grading.runner", { answerId: "a" }, { priority: -1 });
    expect(instance.send).toHaveBeenCalledWith("grading.runner", { answerId: "a" }, { priority: -1 });

    // No options is an empty object, never `undefined` handed to pg-boss.
    await queue.send("system.task", { key: "sessions.purge" });
    expect(instance.send).toHaveBeenLastCalledWith("system.task", { key: "sessions.purge" }, {});
  });

  it("hands each job of a batch to the handler, in order", async () => {
    const { queue, instance } = await started(true);
    const seen: string[] = [];
    await queue.work<{ id: string }>("q", async ({ id }) => void seen.push(id));
    expect(instance.work).toHaveBeenCalledTimes(1);
    const [name, batchHandler] = instance.work.mock.calls[0] as [
      string,
      (jobs: { data: { id: string } }[]) => Promise<void>,
    ];
    expect(name).toBe("q");
    await batchHandler([{ data: { id: "a" } }, { data: { id: "b" } }]);
    expect(seen).toEqual(["a", "b"]);
  });

  it("never registers a worker in a process that does not run them", async () => {
    const { queue, instance } = await started(false);
    await queue.work("q", async () => {});
    expect(instance.work).not.toHaveBeenCalled();
    // …but it still sends.
    await queue.send("q", { x: 1 });
    expect(instance.send).toHaveBeenCalledTimes(1);
  });

  it("stops pg-boss, closing its pool, when the app closes", async () => {
    const { instance, close } = await started(true);
    await close();
    expect(instance.stop).toHaveBeenCalledWith(expect.objectContaining({ close: true }));
  });
});

describe("the in-process queue, beyond ordering", () => {
  const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });

  it("logs a failing job and goes on with the next one", async () => {
    const l = log();
    const queue = new InProcessQueue(true, l as never);
    const seen: string[] = [];
    await queue.work<{ id: string }>("q", async ({ id }) => {
      if (id === "bad") throw new Error("boom");
      seen.push(id);
    });
    await queue.send("q", { id: "bad" });
    await queue.send("q", { id: "good" });
    await vi.waitFor(() => expect(seen).toEqual(["good"]));
    expect(l.error).toHaveBeenCalledWith(expect.objectContaining({ queue: "q" }), "in-process job failed");
  });

  // Unlike pg-boss, which keeps it in its table: acceptable for development
  // only, where every worker is registered at boot before anything is sent.
  it("drops a job sent to a queue nobody works yet", async () => {
    const queue = new InProcessQueue(true, log() as never);
    const seen: number[] = [];
    await queue.send("late", { n: 1 });
    await queue.work<{ n: number }>("late", async ({ n }) => void seen.push(n));
    await queue.send("late", { n: 2 });
    await vi.waitFor(() => expect(seen).toEqual([2]));
  });

  it("never works a job in a process that does not run workers", async () => {
    const queue = new InProcessQueue(false, log() as never);
    const handler = vi.fn(async () => {});
    await queue.work("q", handler);
    await queue.send("q", { n: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});
