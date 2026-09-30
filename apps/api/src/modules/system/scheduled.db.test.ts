/**
 * The scheduled tasks (D10, merge task M2-05): the seeding, the claim on
 * the database clock, the instrumented run, and "Run now".
 *
 * The claim is the whole of the multi-process safety, so it is tested the
 * way two processes would meet it: two claims in a row, and two at once.
 * "Later" is a `last_run_at` moved back in the table, since the claim reads
 * the database's `now()`, not the injected clock.
 */
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { scheduledTasks } from "../../db/schema.js";
import { SYSTEM_TASK_QUEUE } from "../../jobs.js";
import { testApp } from "../../test/db.js";
import type { ScheduledTask } from "../../ticker.js";
import {
  claimDueTasks,
  claimTaskNow,
  configureScheduledTask,
  dispatchScheduledTask,
  listScheduledTasks,
  runScheduledTask,
  RUNNING_STALE_MINUTES,
  seedScheduledTasks,
} from "./service.js";

let app: FastifyInstance;
let db: Db;
const config = {} as AppConfig;

/** Runs counted per key, so a test sees how many times a task really ran. */
let runs: Record<string, number>;

const ok: ScheduledTask = {
  key: "sessions.purge",
  defaultIntervalMinutes: 10,
  run: async () => {
    runs["sessions.purge"] = (runs["sessions.purge"] ?? 0) + 1;
    return "3 expired sessions deleted";
  },
};
const failing: ScheduledTask = {
  key: "oauth.purge",
  defaultIntervalMinutes: 60,
  run: async () => {
    runs["oauth.purge"] = (runs["oauth.purge"] ?? 0) + 1;
    throw new Error("relation does not exist");
  },
};
const catalog = [ok, failing];
const keys = catalog.map((t) => t.key);

async function row(key: string) {
  const [r] = await db.select().from(scheduledTasks).where(eq(scheduledTasks.key, key));
  return r!;
}

/** Moves the last claim `minutes` into the past, as if that time had gone by. */
async function ago(key: string, minutes: number) {
  await db
    .update(scheduledTasks)
    .set({ lastRunAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(eq(scheduledTasks.key, key));
}

/** One pass of the ticker: the claim, then each claimed task run to its end. */
async function pass() {
  const claimed = await claimDueTasks(db, keys);
  for (const key of claimed) await runScheduledTask(app, config, catalog.find((t) => t.key === key)!);
  return claimed.sort();
}

beforeAll(async () => {
  app = await testApp();
  db = app.db;
});
beforeEach(async () => {
  runs = {};
  await db.delete(scheduledTasks);
  await seedScheduledTasks(db, catalog);
});

describe("seeding", () => {
  it("inserts every catalog task with its default period, enabled, never run", async () => {
    expect(await row("sessions.purge")).toMatchObject({
      enabled: true,
      intervalMinutes: 10,
      lastRunAt: null,
      lastStatus: null,
    });
    expect((await row("oauth.purge")).intervalMinutes).toBe(60);
  });

  it("never overwrites what an administrator changed", async () => {
    await configureScheduledTask(db, ok, { intervalMinutes: 42, enabled: false });
    await seedScheduledTasks(db, catalog);
    expect(await row("sessions.purge")).toMatchObject({ intervalMinutes: 42, enabled: false });
  });

  it("ignores a row whose key left the catalog: never claimed, never listed", async () => {
    await db.insert(scheduledTasks).values({ key: "reconcile.gone", intervalMinutes: 1 });
    expect(await claimDueTasks(db, keys)).not.toContain("reconcile.gone");
    expect((await row("reconcile.gone")).lastRunAt).toBeNull();
    expect((await listScheduledTasks(db, catalog)).map((t) => t.key)).toEqual(keys);
  });
});

describe("the claim", () => {
  it("takes a due task once: a second claim right after finds nothing", async () => {
    expect((await claimDueTasks(db, keys)).sort()).toEqual([...keys].sort());
    expect(await claimDueTasks(db, keys)).toEqual([]);
    expect((await row("sessions.purge")).lastStatus).toBe("running");
  });

  it("takes a due task once when two processes race for it", async () => {
    const [a, b] = await Promise.all([claimDueTasks(db, ["sessions.purge"]), claimDueTasks(db, ["sessions.purge"])]);
    expect([...a!, ...b!]).toEqual(["sessions.purge"]);
  });

  it("does not run a task again before its period, and does after", async () => {
    expect(await pass()).toEqual([...keys].sort());
    expect(runs).toEqual({ "sessions.purge": 1, "oauth.purge": 1 });

    await ago("sessions.purge", 9);
    expect(await pass()).toEqual([]);

    await ago("sessions.purge", 10);
    expect(await pass()).toEqual(["sessions.purge"]);
    expect(runs["sessions.purge"]).toBe(2);
    // The other one keeps its own period.
    expect(runs["oauth.purge"]).toBe(1);
  });

  it("follows a period an administrator changed, from the next claim on", async () => {
    await pass();
    await ago("oauth.purge", 5);
    expect(await pass()).toEqual([]);
    await configureScheduledTask(db, failing, { intervalMinutes: 5 });
    expect(await pass()).toEqual(["oauth.purge"]);
  });

  it("never claims a disabled task, however overdue", async () => {
    await configureScheduledTask(db, ok, { enabled: false });
    expect(await pass()).toEqual(["oauth.purge"]);
    await ago("sessions.purge", 10_000);
    expect(await claimDueTasks(db, keys)).not.toContain("sessions.purge");
    expect(runs["sessions.purge"]).toBeUndefined();
  });

  it("never doubles a run still going, until it is taken for dead", async () => {
    expect(await claimDueTasks(db, ["sessions.purge"])).toEqual(["sessions.purge"]);
    // The process died mid-run: the row stays `running`, past its period…
    await ago("sessions.purge", RUNNING_STALE_MINUTES - 1);
    expect(await claimDueTasks(db, ["sessions.purge"])).toEqual([]);
    // …until the run is stale: then the catch-up claims it again.
    await ago("sessions.purge", RUNNING_STALE_MINUTES);
    expect(await claimDueTasks(db, ["sessions.purge"])).toEqual(["sessions.purge"]);
  });
});

describe("the run", () => {
  it("records a success: status, summary, duration, last success", async () => {
    await pass();
    const r = await row("sessions.purge");
    expect(r).toMatchObject({ lastStatus: "ok", lastMessage: "3 expired sessions deleted" });
    expect(r.lastDurationMs).toBeGreaterThanOrEqual(0);
    expect(r.lastOkAt).not.toBeNull();
  });

  it("records a failure without throwing out of the pass, and keeps the last success", async () => {
    await pass();
    let r = await row("oauth.purge");
    expect(r).toMatchObject({ lastStatus: "error", lastMessage: "relation does not exist", lastOkAt: null });

    // A task that succeeded once and then fails keeps the date of its success.
    const flaky: ScheduledTask = { ...ok, run: async () => Promise.reject(new Error("x".repeat(2_000))) };
    await ago("sessions.purge", 10);
    expect(await claimDueTasks(db, [flaky.key])).toEqual([flaky.key]);
    await expect(runScheduledTask(app, config, flaky)).resolves.toBeUndefined();
    r = await row("sessions.purge");
    expect(r.lastStatus).toBe("error");
    expect(r.lastMessage).toHaveLength(500);
    expect(r.lastOkAt).not.toBeNull();
  });

  it("goes to the `system.task` queue when there is one, and does not run here", async () => {
    const sent: { name: string; data: object }[] = [];
    const queued = {
      ...app,
      boss: { send: async (name: string, data: object) => void sent.push({ name, data }) },
    } as unknown as FastifyInstance;
    expect((await claimDueTasks(db, keys)).sort()).toEqual([...keys].sort());
    for (const task of catalog) expect(await dispatchScheduledTask(queued, config, task)).toBe("queued");
    expect(sent).toEqual(
      expect.arrayContaining([
        { name: SYSTEM_TASK_QUEUE, data: { key: "sessions.purge" } },
        { name: SYSTEM_TASK_QUEUE, data: { key: "oauth.purge" } },
      ]),
    );
    expect(runs).toEqual({});
    expect((await row("sessions.purge")).lastStatus).toBe("running");
  });

  it("records a send that failed as the run's error", async () => {
    const broken = {
      ...app,
      boss: { send: async () => Promise.reject(new Error("pg-boss down")) },
    } as unknown as FastifyInstance;
    await claimDueTasks(db, keys);
    await dispatchScheduledTask(broken, config, ok);
    expect(await row("sessions.purge")).toMatchObject({
      lastStatus: "error",
      lastMessage: "not enqueued: pg-boss down",
    });
  });
});

describe("Run now", () => {
  it("claims a task whatever its period, even disabled, but never while it runs", async () => {
    await pass();
    await configureScheduledTask(db, ok, { enabled: false });
    expect(await claimTaskNow(db, ok)).toBe(true);
    expect((await row("sessions.purge")).lastStatus).toBe("running");
    expect(await claimTaskNow(db, ok)).toBe(false);
  });


  it("restarts the period: the next claim waits a whole period", async () => {
    await pass();
    await ago("sessions.purge", 9);
    expect(await claimTaskNow(db, ok)).toBe(true);
    await db.update(scheduledTasks).set({ lastStatus: "ok" }).where(eq(scheduledTasks.key, ok.key));
    expect(await claimDueTasks(db, [ok.key])).toEqual([]);
  });
});

describe("the list", () => {
  it("joins the catalog to the rows, with the next run on the database clock", async () => {
    await configureScheduledTask(db, failing, { enabled: false });
    const before = await listScheduledTasks(db, catalog);
    expect(before[0]).toMatchObject({
      key: "sessions.purge",
      enabled: true,
      intervalMinutes: 10,
      defaultIntervalMinutes: 10,
      lastRunAt: null,
      lastStatus: null,
    });
    // Never run: due now.
    expect(before[0]!.nextRunAt).not.toBeNull();
    // Disabled: no next run.
    expect(before[1]).toMatchObject({ key: "oauth.purge", enabled: false, nextRunAt: null });

    await pass();
    const [after] = await listScheduledTasks(db, catalog);
    expect(Date.parse(after!.nextRunAt!) - Date.parse(after!.lastRunAt!)).toBe(10 * 60_000);
    expect(after).toMatchObject({ lastStatus: "ok", lastMessage: "3 expired sessions deleted" });
  });

  it("lists only the catalog tasks that have a row", async () => {
    await db.delete(scheduledTasks).where(eq(scheduledTasks.key, "oauth.purge"));
    expect((await listScheduledTasks(db, catalog)).map((t) => t.key)).toEqual(["sessions.purge"]);
    expect(await configureScheduledTask(db, failing, { enabled: false })).toBe(false);
  });
});
