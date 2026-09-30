/**
 * The ticker's LOOP (`startTicker`) and the clock-bound tasks that are not
 * the live ones (ADR-006, ADR-054, ADR-051 §6).
 *
 * `ticker.test.ts` drives the live tasks by hand; here the loop itself runs,
 * on fake timers: the immediate first pass, the period, the `everyMs` gate,
 * a failing task that must not stop the others, and the absence of overlap
 * when a pass outlasts the period. Then the expiry of Super Powers on the
 * server's clock (invariant 5) and the kiosk sweep, inert while the kiosk
 * path is off.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { createSession } from "./auth/session.js";
import { TestClock } from "./clock.js";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { auditLog, sessions, users } from "./db/schema.js";
import { testApp, testDb } from "./test/db.js";
import { lastTickOf, startTicker, TICK_TASKS, type TickTask } from "./ticker.js";

const TICK_MS = 1_000;
const config = { TICK_MS, KIOSK_ATTESTATION: "off" } as unknown as AppConfig;

/** The smallest app the loop needs: an `onClose` hook list and a logger. */
function loopApp() {
  const closeHooks: (() => Promise<void>)[] = [];
  const error = vi.fn();
  const app = {
    addHook: (name: string, fn: () => Promise<void>) => {
      if (name === "onClose") closeHooks.push(fn);
    },
    log: { error },
  } as unknown as FastifyInstance;
  return { app, error, close: () => Promise.all(closeHooks.map((fn) => fn())) };
}

/** A task that counts its runs. */
function counting(name: string, everyMs?: number): TickTask & { runs: number } {
  const task = {
    name,
    runs: 0,
    run: async () => {
      task.runs += 1;
    },
    ...(everyMs === undefined ? {} : { everyMs }),
  };
  return task;
}

describe("startTicker (the loop)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-09-20T08:00:00.000Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs a first pass at once, then one per period", async () => {
    const { app, close } = loopApp();
    const task = counting("every-tick");
    startTicker(app, config, [task]);

    // The catch-up pass after a restart does not wait for the first period.
    await vi.advanceTimersByTimeAsync(0);
    expect(task.runs).toBe(1);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(task.runs).toBe(2);
    await vi.advanceTimersByTimeAsync(3 * TICK_MS);
    expect(task.runs).toBe(5);
    await close();
  });

  it("runs an `everyMs` task at most once per its own period", async () => {
    const { app, close } = loopApp();
    const fast = counting("fast");
    const slow = counting("slow", 5 * TICK_MS);
    startTicker(app, config, [fast, slow]);

    await vi.advanceTimersByTimeAsync(0);
    expect([fast.runs, slow.runs]).toEqual([1, 1]);

    await vi.advanceTimersByTimeAsync(4 * TICK_MS);
    expect([fast.runs, slow.runs]).toEqual([5, 1]);

    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect([fast.runs, slow.runs]).toEqual([6, 2]);
    await close();
  });

  it("logs a failing task and still runs the ones after it", async () => {
    const { app, error, close } = loopApp();
    const failing: TickTask = {
      name: "broken",
      run: async () => {
        throw new Error("boom");
      },
    };
    const after = counting("after");
    startTicker(app, config, [failing, after]);

    await vi.advanceTimersByTimeAsync(0);
    expect(after.runs).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toMatchObject({ task: "broken" });

    // The failure is not sticky: the next pass tries it again.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(error).toHaveBeenCalledTimes(2);
    expect(after.runs).toBe(2);
    await close();
  });

  it("never overlaps two passes: a pass that outlasts the period skips the ticks meanwhile", async () => {
    const { app, close } = loopApp();
    let release!: () => void;
    let started = 0;
    const hanging: TickTask = {
      name: "hanging",
      run: () => {
        started += 1;
        return started === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
      },
    };
    startTicker(app, config, [hanging]);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5 * TICK_MS);
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(started).toBe(2);
    await close();
  });

  it("records the end of each completed pass, for the system status (N-OPS-03)", async () => {
    const { app, close } = loopApp();
    expect(lastTickOf(app)).toBeUndefined();

    startTicker(app, config, [counting("any")]);
    const start = Date.now();
    expect(lastTickOf(app)).toBe(start);

    await vi.advanceTimersByTimeAsync(3 * TICK_MS);
    expect(lastTickOf(app)).toBe(start + 3 * TICK_MS);

    // A child plugin context reads its root's value.
    const child = Object.create(app) as FastifyInstance;
    expect(lastTickOf(child)).toBe(start + 3 * TICK_MS);
    await close();
  });

  it("does not record a pass that hangs: the lag grows", async () => {
    const { app, close } = loopApp();
    const hanging: TickTask = { name: "stuck", run: () => new Promise<void>(() => {}) };
    startTicker(app, config, [hanging]);
    const start = Date.now();

    await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    expect(lastTickOf(app)).toBe(start);
    await close();
  });

  it("stops on the app's close, and through the function it returns", async () => {
    const first = loopApp();
    const a = counting("a");
    startTicker(first.app, config, [a]);
    await vi.advanceTimersByTimeAsync(0);
    await first.close();
    await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    expect(a.runs).toBe(1);

    const second = loopApp();
    const b = counting("b");
    const stop = startTicker(second.app, config, [b]);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    expect(b.runs).toBe(1);
  });
});

describe("clock-bound tasks beside the live ones", () => {
  let db: Db;
  let clock: TestClock;
  let app: FastifyInstance & { clock: TestClock };

  beforeAll(async () => {
    db = await testDb();
  });
  beforeEach(async () => {
    app = await testApp(db);
    clock = app.clock;
    clock.set("2026-09-20T08:00:00.000Z");
  });

  const task = (name: string): TickTask => {
    const found = TICK_TASKS.find((t) => t.name === name);
    if (!found) throw new Error(`no tick task ${name}`);
    return found;
  };

  async function adminWithSuperPowers(until: Date): Promise<{ userId: string; sidHash: string }> {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      oidcSub: `test-${userId}`,
      email: `${userId.slice(0, 8)}@heig.test`,
      role: "admin",
    });
    await createSession(db, userId, 12);
    const [row] = await db
      .update(sessions)
      .set({ superPowersUntil: until })
      .where(eq(sessions.userId, userId))
      .returning({ sidHash: sessions.sidHash });
    return { userId, sidHash: row!.sidHash };
  }

  const disabledAudits = (userId: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, userId), eq(auditLog.action, "superpowers.disabled")));

  it("superpowers.expire ends Super Powers at their hour by the server's clock, once", async () => {
    const until = new Date(clock.now().getTime() + 3_600_000);
    const { userId, sidHash } = await adminWithSuperPowers(until);
    const expire = task("superpowers.expire");
    const superPowersOf = async () =>
      (await db.select().from(sessions).where(eq(sessions.sidHash, sidHash)))[0]!.superPowersUntil;

    // One millisecond before the hour: untouched.
    clock.set(new Date(until.getTime() - 1));
    await expire.run(app, config);
    expect(await superPowersOf()).not.toBeNull();
    expect(await disabledAudits(userId)).toHaveLength(0);

    // At the hour: cleared, and audited as the system's doing.
    clock.set(until);
    await expire.run(app, config);
    expect(await superPowersOf()).toBeNull();
    const audits = await disabledAudits(userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorType).toBe("system");
    expect(audits[0]!.actorUserId).toBeNull();
    expect(audits[0]!.payload).toEqual({ reason: "expired" });

    // Idempotent: the next pass records nothing more.
    clock.advance(60_000);
    await expire.run(app, config);
    expect(await disabledAudits(userId)).toHaveLength(1);
  });

  it("superpowers.expire runs once a minute, not every second", () => {
    expect(task("superpowers.expire").everyMs).toBe(60_000);
  });

  it("kiosk.silent is inert while the kiosk path is off: it reads nothing", async () => {
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error("the database was read");
        },
      },
    );
    const offApp = { ...app, db: untouchable } as unknown as FastifyInstance;
    await expect(task("kiosk.silent").run(offApp, config)).resolves.toBeUndefined();
  });

  it("kiosk.silent sweeps when the kiosk path is on, on an empty world without error", async () => {
    const on = { ...config, KIOSK_ATTESTATION: "mock" } as AppConfig;
    await expect(task("kiosk.silent").run(app, on)).resolves.toBeUndefined();
  });
});
