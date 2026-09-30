/**
 * `deadline_approaching` (ADR-030, addendum §d; #198 step 7): the ticker's
 * scan reminds each student who has not submitted, once, 24 hours before
 * the common `closes_at` — never for a window shorter than a day, never
 * twice, caught up after a restart, and only for a running evaluation that
 * is not a poll.
 *
 * The scan reads the whole database, and the tests share one: each asserts
 * on its own evaluation only.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { attempts, deadlineReminders, enrollments, evaluations, notifications } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { fakeShort } from "../../test/fakeType.js";
import { testDb } from "../../test/db.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { SCHEDULED_TASKS } from "../system/catalog.js";
import { sendDeadlineReminders } from "./deadline.js";
import { closeOutbox, openOutbox, type DeliveryJob } from "./outbox.js";

let db: Db;
let restore: () => void;
const HOUR = 3_600_000;
const MINUTE = 60_000;
/** The common end of every evaluation below. */
const closesAt = new Date("2026-10-10T16:00:00.000Z");
const boundary = new Date(closesAt.getTime() - 24 * HOUR);

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());
afterEach(() => closeOutbox());

/** The e-mail and Teams jobs `notifyMany` enqueues, recorded. */
function recordOutbox() {
  const sent: DeliveryJob[] = [];
  const queue: JobQueue = {
    async createQueue() {},
    async send(_name, data) {
      sent.push(data as unknown as DeliveryJob);
    },
    async work() {},
    async stop() {},
  };
  openOutbox({ queue, teams: true, log: { error: () => {} } });
  return sent;
}

/** The reminders of ONE evaluation a user holds. */
async function remindersOf(userId: string, evaluationId: string) {
  return db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.evaluationId, evaluationId),
        sql`${notifications.payload}->>'kind' = 'deadline_approaching'`,
      ),
    );
}

async function countsOf(seed: Seeded): Promise<number[]> {
  return Promise.all(seed.studentIds.map(async (id) => (await remindersOf(id, seed.evaluationId)).length));
}

/**
 * An evaluation of two claimed students, an unclaimed roster line and a
 * staff seat, running since `startedAt` and closing at {@link closesAt}.
 */
async function running(
  opts: { mode?: "exam" | "exercise"; startedAt?: Date } = {},
): Promise<Seeded> {
  const seed = await seedLive(db, { mode: opts.mode ?? "exercise", closesAt });
  await db
    .update(evaluations)
    .set({ state: "running", startedAt: opts.startedAt ?? new Date(closesAt.getTime() - 7 * 24 * HOUR) })
    .where(eq(evaluations.id, seed.evaluationId));
  await db.insert(enrollments).values([
    {
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Pas",
      prenom: "Encore",
      email: `unclaimed-${seed.classroomId.slice(0, 8)}@heig.test`,
    },
    {
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Prof",
      prenom: "Démo",
      email: `staff-${seed.classroomId.slice(0, 8)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    },
  ]);
  return seed;
}

async function attempt(
  seed: Seeded,
  userId: string,
  state: "not_started" | "in_progress" | "submitted" | "expired",
  attemptNumber = 1,
) {
  await db.insert(attempts).values({
    id: randomUUID(),
    evaluationId: seed.evaluationId,
    userId,
    state,
    attemptNumber,
    seed: 1,
  });
}

describe("deadline_approaching", () => {
  it("is sent once, at closesAt - 24 h and not a minute before, to the claimed students only", async () => {
    const seed = await running();
    const sent = recordOutbox();

    await sendDeadlineReminders(db, new Date(boundary.getTime() - MINUTE));
    expect(await countsOf(seed)).toEqual([0, 0]);

    await sendDeadlineReminders(db, boundary);
    const payload = {
      kind: "deadline_approaching",
      evaluationId: seed.evaluationId,
      evaluationTitle: "Test évaluation",
    };
    for (const student of seed.studentIds) {
      expect((await remindersOf(student, seed.evaluationId)).map((r) => r.payload)).toEqual([payload]);
    }
    expect(await remindersOf(seed.teacherId, seed.evaluationId)).toEqual([]);
    // E-mail on by default (§c): one job per student.
    const mine = sent.filter(
      (j) => j.payload.kind === "deadline_approaching" && j.payload.evaluationId === seed.evaluationId,
    );
    expect(mine.map((j) => [j.userId, j.channel])).toEqual(seed.studentIds.map((id) => [id, "email"]));

    // Every later pass finds the markers.
    await sendDeadlineReminders(db, new Date(boundary.getTime() + MINUTE));
    await sendDeadlineReminders(db, new Date(closesAt.getTime() - HOUR));
    expect(await countsOf(seed)).toEqual([1, 1]);
    const markers = await db
      .select()
      .from(deadlineReminders)
      .where(eq(deadlineReminders.evaluationId, seed.evaluationId));
    expect(markers.map((m) => m.sentAt)).toEqual([boundary, boundary]);
  });

  it("applies to an exam as to an exercise", async () => {
    const seed = await running({ mode: "exam" });
    await sendDeadlineReminders(db, boundary);
    expect(await countsOf(seed)).toEqual([1, 1]);
  });

  it("catches up after a restart that missed the boundary", async () => {
    const seed = await running();
    await sendDeadlineReminders(db, new Date(closesAt.getTime() - 3 * HOUR));
    expect(await countsOf(seed)).toEqual([1, 1]);
  });

  it("is never sent for an end already past (an evaluation left running by an extension)", async () => {
    const seed = await running();
    await sendDeadlineReminders(db, new Date(closesAt.getTime() + MINUTE));
    expect(await countsOf(seed)).toEqual([0, 0]);
  });

  it("is not sent again when closesAt moves after it was sent", async () => {
    const seed = await running();
    await sendDeadlineReminders(db, boundary);
    const later = new Date(closesAt.getTime() + 48 * HOUR);
    await db.update(evaluations).set({ closesAt: later }).where(eq(evaluations.id, seed.evaluationId));
    await sendDeadlineReminders(db, new Date(later.getTime() - 2 * HOUR));
    expect(await countsOf(seed)).toEqual([1, 1]);
  });

  it("tells a student once when two scans race", async () => {
    const seed = await running();
    const claimed = await Promise.all([sendDeadlineReminders(db, boundary), sendDeadlineReminders(db, boundary)]);
    const mine = claimed.flat().filter((c) => c.evaluationId === seed.evaluationId);
    expect(mine).toHaveLength(2);
    expect(await countsOf(seed)).toEqual([1, 1]);
  });

  it("says nothing when the evaluation started less than 24 h before it closes", async () => {
    const seed = await running({ startedAt: new Date(boundary.getTime() + MINUTE) });
    await sendDeadlineReminders(db, new Date(closesAt.getTime() - HOUR));
    expect(await countsOf(seed)).toEqual([0, 0]);
  });

  it("reminds an evaluation started exactly at closesAt - 24 h", async () => {
    const seed = await running({ startedAt: boundary });
    await sendDeadlineReminders(db, boundary);
    expect(await countsOf(seed)).toEqual([1, 1]);
  });

  it("skips a student with a finished attempt, retake open or not; reminds one still at work", async () => {
    const [a, b] = await Promise.all([running(), running()]);
    const [submitted, working] = a.studentIds as [string, string];
    await attempt(a, submitted, "submitted");
    await attempt(a, working, "in_progress");
    const [expired, retaking] = b.studentIds as [string, string];
    await attempt(b, expired, "expired");
    // A retake of an exercise (F-EVAL-15): the first attempt counts already.
    await attempt(b, retaking, "submitted", 1);
    await attempt(b, retaking, "in_progress", 2);

    await sendDeadlineReminders(db, boundary);
    expect(await countsOf(a)).toEqual([0, 1]);
    expect(await countsOf(b)).toEqual([0, 0]);
  });

  it("says nothing for a paused, closed or scheduled evaluation, or a poll", async () => {
    const seeds: Seeded[] = [];
    for (const change of [
      { state: "paused" as const },
      { state: "closed" as const },
      { state: "scheduled" as const },
      { mode: "poll" as const },
    ]) {
      const seed = await running();
      await db.update(evaluations).set(change).where(eq(evaluations.id, seed.evaluationId));
      seeds.push(seed);
    }
    await sendDeadlineReminders(db, boundary);
    for (const seed of seeds) expect(await countsOf(seed)).toEqual([0, 0]);
  });

  it("says nothing for an evaluation without closesAt", async () => {
    const seed = await running();
    await db.update(evaluations).set({ closesAt: null }).where(eq(evaluations.id, seed.evaluationId));
    await sendDeadlineReminders(db, boundary);
    expect(await countsOf(seed)).toEqual([0, 0]);
  });

  it("is in the scheduled catalog, a minute apart, on the injected clock", async () => {
    const task = SCHEDULED_TASKS.find((t) => t.key === "notifications.deadline_reminders");
    expect(task?.defaultIntervalMinutes).toBe(1);
    const seed = await running();
    const app = { db, clock: { now: () => boundary } } as unknown as FastifyInstance;
    await task!.run(app, {} as AppConfig);
    expect(await countsOf(seed)).toEqual([1, 1]);
  });
});
