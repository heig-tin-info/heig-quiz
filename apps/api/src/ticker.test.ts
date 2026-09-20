/**
 * The ticker's live tasks (PLAN-MVP §5.3, ADR-006).
 *
 * The property every one of them must have is IDEMPOTENCE: a tick is a
 * conditional UPDATE, so running it twice changes nothing the second time,
 * and catching up after an outage is the same code path as the normal one.
 * The clock is injected, so "two minutes later" costs a microsecond.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";
import { GRACE_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { TestClock } from "./clock.js";
import type { Db } from "./db/client.js";
import { attempts, evaluations } from "./db/schema.js";
import { testDb } from "./test/db.js";
import { fakeShort } from "./test/fakeType.js";
import { reload, seedLive } from "./test/live.js";
import { applyState, settingsOf } from "./modules/evaluation/service.js";
import { LIVE_TASKS, PRESENCE_IDLE_MS } from "./modules/live/jobs.js";
import * as live from "./modules/live/service.js";
import { presence } from "./modules/realtime/presence.js";
import { CORE_TASKS, type TickTask } from "./ticker.js";

let db: Db;
let restore: () => void;
let clock: TestClock;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = (await testDb()) as unknown as Db;
});
afterAll(() => restore());
beforeEach(() => {
  clock = new TestClock("2026-09-20T08:00:00.000Z");
  presence.reset();
});

/** One pass of the live tasks, exactly as `startTicker` runs them. */
async function tick(tasks: readonly TickTask[] = LIVE_TASKS): Promise<void> {
  const app = { db, clock, log: { error: () => {} } } as never;
  for (const task of tasks) await task.run(app, {} as never);
}

describe("registration", () => {
  it("is part of CORE_TASKS, so a deployment runs it without extra wiring", () => {
    const names = CORE_TASKS.map((t) => t.name);
    expect(names).toContain("sessions.purge");
    for (const task of LIVE_TASKS) expect(names).toContain(task.name);
  });
});

describe("expiring attempts (§5.3 step 1)", () => {
  async function startedAttempt(durationS = 600) {
    const seed = await seedLive(db, { durationS });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await live.participantOf(db, row, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, row, participant, clock.now());
    return live.beginAttempt(db, row, created, participant, clock.now());
  }

  it("leaves an attempt alone until deadline + grace, then closes it", async () => {
    const attempt = await startedAttempt();
    const deadline = attempt.deadlineAt!;

    clock.set(new Date(deadline.getTime() + GRACE_MS - 1));
    await tick();
    expect((await live.attemptById(db, attempt.id))!.state).toBe("in_progress");

    clock.set(new Date(deadline.getTime() + GRACE_MS));
    await tick();
    const closed = (await live.attemptById(db, attempt.id))!;
    expect(closed.state).toBe("expired");
    expect(closed.closedBy).toBe("server");
    expect(closed.closedAt).not.toBeNull();
  });

  it("re-ticks for free: the second pass closes nothing and changes nothing", async () => {
    const attempt = await startedAttempt();
    clock.set(new Date(attempt.deadlineAt!.getTime() + GRACE_MS + 5_000));
    await tick();
    const first = (await live.attemptById(db, attempt.id))!;

    clock.advance(1_000);
    const closedAgain = await live.expireDueAttempts(db, clock.now());
    expect(closedAgain).toHaveLength(0);
    const second = (await live.attemptById(db, attempt.id))!;
    expect(second.closedAt!.toISOString()).toBe(first.closedAt!.toISOString());
  });

  it("never touches an attempt with no deadline (manual timing)", async () => {
    const seed = await seedLive(db, {
      durationS: null,
      settings: { timing: "manual" },
      mode: "exercise",
    });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await live.participantOf(db, row, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, row, participant, clock.now());
    const attempt = await live.beginAttempt(db, row, created, participant, clock.now());
    expect(attempt.deadlineAt).toBeNull();

    clock.advance(30 * 24 * 3_600_000); // a month later
    await tick();
    expect((await live.attemptById(db, attempt.id))!.state).toBe("in_progress");
  });
});

describe("opening and closing on time (§5.3 steps 2 and 4)", () => {
  it("moves a scheduled evaluation into the lobby at opens_at", async () => {
    const opensAt = new Date(clock.now().getTime() + 60_000);
    const seed = await seedLive(db, { opensAt });
    await applyState(db, await reload(db, seed.evaluationId), "scheduled", clock.now());

    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("scheduled");

    clock.set(opensAt);
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("lobby");

    // Idempotent: a second pass finds nothing in `scheduled` any more.
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("lobby");
  });

  it("goes straight to running when the lobby is skipped (F-EVAL-06)", async () => {
    const opensAt = new Date(clock.now().getTime() + 60_000);
    const seed = await seedLive(db, { opensAt, settings: { lobby: "skip" } });
    await applyState(db, await reload(db, seed.evaluationId), "scheduled", clock.now());
    clock.set(opensAt);
    await tick();
    const row = await reload(db, seed.evaluationId);
    expect(row.state).toBe("running");
    expect(row.startedAt).not.toBeNull();
  });

  it("starts a full `auto` lobby, and only when everybody enrolled is there", async () => {
    const seed = await seedLive(db, { students: 2, settings: { lobby: "auto" } });
    const row = await applyState(db, await reload(db, seed.evaluationId), "lobby", clock.now());

    presence.join(row.id, seed.studentIds[0]!, clock.now());
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("lobby");

    presence.join(row.id, seed.studentIds[1]!, clock.now());
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("running");
  });

  it("closes a running evaluation at closes_at and expires what is open", async () => {
    const closesAt = new Date(clock.now().getTime() + 3_600_000);
    const seed = await seedLive(db, {
      settings: { timing: "deadline" },
      durationS: null,
      opensAt: clock.now(),
      closesAt,
    });
    const row = await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    const participant = (await live.participantOf(db, row, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, row, participant, clock.now());
    const attempt = await live.beginAttempt(db, row, created, participant, clock.now());

    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("running");

    // The autosave gate accepts a write until `deadline + GRACE_MS`, so the
    // ticker waits for the same instant before closing (finding H4).
    clock.set(closesAt);
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("running");

    clock.set(new Date(closesAt.getTime() + GRACE_MS + 1));
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("closed");
    const closed = (await live.attemptById(db, attempt.id))!;
    expect(closed.state).toBe("expired");
    expect(closed.closedBy).toBe("server");

    // And again: nothing is in `running` any more, so nothing happens.
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("closed");
  });

  it("does not touch an evaluation whose closes_at is still ahead", async () => {
    const seed = await seedLive(db, { closesAt: new Date(clock.now().getTime() + 86_400_000) });
    await applyState(db, await reload(db, seed.evaluationId), "running", clock.now());
    await tick();
    expect((await reload(db, seed.evaluationId)).state).toBe("running");
  });
});

describe("presence sweep (§5.3 step 5)", () => {
  it("marks a silent connection offline without touching a table", async () => {
    const seed = await seedLive(db);
    presence.join(seed.evaluationId, seed.studentIds[0]!, clock.now());
    expect(presence.count(seed.evaluationId)).toBe(1);

    clock.advance(PRESENCE_IDLE_MS - 1);
    await tick();
    expect(presence.count(seed.evaluationId)).toBe(1);

    clock.advance(2);
    await tick();
    expect(presence.count(seed.evaluationId)).toBe(0);
    // Nothing in the database moved: presence is a property of the sockets.
    const rows = await db.select().from(attempts).where(eq(attempts.evaluationId, seed.evaluationId));
    expect(rows).toHaveLength(0);
  });
});

describe("the settings the tasks read", () => {
  it("reads `lobby` from the jsonb through the contract schema", async () => {
    const seed = await seedLive(db, { settings: { lobby: "skip" } });
    const row = await reload(db, seed.evaluationId);
    expect(settingsOf(row).lobby).toBe("skip");
    const [stored] = await db.select().from(evaluations).where(eq(evaluations.id, row.id));
    expect(stored!.state).toBe("draft");
  });
});
