/**
 * `activity_scheduled` and `activity_available` (ADR-030, addendum §c and
 * §h; #198 step 6): the students of a classroom hear when an EXERCISE is
 * scheduled for the first time — once in its life, folded per classroom —
 * and when it starts running, by e-mail and Teams only when it is taken at
 * home. Never an exam, never a poll, never a staff seat or an unclaimed line.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { enrollments, evaluations, notifications } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { fakeShort } from "../../test/fakeType.js";
import { testDb } from "../../test/db.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as live from "../live/service.js";
import { closeOutbox, openOutbox, type DeliveryJob } from "../notifications/outbox.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;
const HOUR = 3_600_000;
const now = new Date("2026-10-01T08:00:00.000Z");
const inAnHour = new Date(now.getTime() + HOUR);

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

async function rowsOf(userId: string, kind: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'kind' = ${kind}`));
}

/** Another exercise in the seeded classroom, ready to be scheduled in an hour. */
async function anotherExercise(seed: Seeded, title: string, settings: Partial<EvaluationSettings> = {}) {
  const row = await service.createEvaluation(db, {
    classroomId: seed.classroomId,
    title,
    mode: "exercise",
    createdBy: seed.teacherId,
  });
  await db
    .update(evaluations)
    .set({ opensAt: inAnHour, settings: { ...service.settingsOf(row), ...settings } })
    .where(eq(evaluations.id, row.id));
  await service.addItems(db, await reload(db, row.id), seed.questionIds, () => 1, { attemptCount: 0 });
  return reload(db, row.id);
}

/** A classroom with an exercise, two claimed students, an unclaimed line and a staff seat. */
async function classroom(settings: Partial<EvaluationSettings> = {}) {
  const seed = await seedLive(db, { mode: "exercise", opensAt: inAnHour, settings });
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

describe("activity_scheduled", () => {
  it("tells each claimed student once, whatever reschedules and trips to draft follow", async () => {
    const seed = await classroom();
    const [ann, ben] = seed.studentIds as [string, string];
    const sent = recordOutbox();
    let row = await reload(db, seed.evaluationId);

    row = await service.transition(db, row, "scheduled", now);
    // A reschedule: the opening time moves, the evaluation stays scheduled.
    row = await service.patchEvaluation(db, row, { opensAt: new Date(now.getTime() + 2 * HOUR).toISOString() }, {
      attemptCount: 0,
      now,
    });
    row = await service.transition(db, row, "draft", now);
    row = await service.transition(db, row, "scheduled", now);
    expect(row.state).toBe("scheduled");

    for (const student of [ann, ben]) {
      const rows = await rowsOf(student, "activity_scheduled");
      expect(rows.map((r) => r.payload)).toEqual([
        { kind: "activity_scheduled", classroomId: seed.classroomId, classroomName: "A", count: 1 },
      ]);
      expect(rows[0]!.classroomId).toBe(seed.classroomId);
    }
    expect(await rowsOf(seed.teacherId, "activity_scheduled")).toEqual([]);
    // Off by e-mail and Teams by default (§h.1): the app only.
    expect(sent).toEqual([]);
    expect((await reload(db, seed.evaluationId)).scheduledAnnouncedAt).toEqual(now);
  });

  it("folds a term of exercises into one entry per student, counting them", async () => {
    const seed = await classroom();
    let row = await reload(db, seed.evaluationId);
    await service.transition(db, row, "scheduled", now);
    for (let i = 2; i <= 16; i++) {
      row = await anotherExercise(seed, `Série ${i}`);
      await service.transition(db, row, "scheduled", now);
    }
    for (const student of seed.studentIds) {
      const rows = await rowsOf(student, "activity_scheduled");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ classroomName: "A", count: 16 });
    }
  });

  it("says nothing for an exam", async () => {
    const seed = await seedLive(db, { opensAt: inAnHour });
    await service.transition(db, await reload(db, seed.evaluationId), "scheduled", now);
    for (const student of seed.studentIds) expect(await rowsOf(student, "activity_scheduled")).toEqual([]);
    expect((await reload(db, seed.evaluationId)).scheduledAnnouncedAt).toBeNull();
  });
});

describe("activity_available", () => {
  it("tells the students when the ticker opens a take-home exercise, by e-mail too", async () => {
    const seed = await classroom({ lobby: "skip" });
    const sent = recordOutbox();
    await service.transition(db, await reload(db, seed.evaluationId), "scheduled", now);

    const opened = await live.autoOpenScheduled(db, new Date(inAnHour.getTime() + 1000));
    expect(opened.map((r) => r.id)).toContain(seed.evaluationId);
    // A second pass finds nothing to open, and tells nobody again.
    await live.autoOpenScheduled(db, new Date(inAnHour.getTime() + 2000));

    const payload = {
      kind: "activity_available",
      activityKind: "evaluation",
      activityId: seed.evaluationId,
      activityTitle: "Test évaluation",
    };
    for (const student of seed.studentIds) {
      const rows = await rowsOf(student, "activity_available");
      expect(rows.map((r) => r.payload)).toEqual([payload]);
      expect(rows[0]!.evaluationId).toBe(seed.evaluationId);
    }
    expect(await rowsOf(seed.teacherId, "activity_available")).toEqual([]);
    // No Teams link, so e-mail alone: one job per student, the payload as the
    // bell's. (The ticker opens the other tests' exercises too: the database is shared.)
    const mine = sent.filter((j) => j.payload.kind === "activity_available" && j.payload.activityId === seed.evaluationId);
    expect(mine.map((j) => [j.userId, j.channel, j.payload])).toEqual(
      seed.studentIds.map((id) => [id, "email", payload]),
    );
  });

  it("keeps an in-class exercise started by hand in the app: a bell row, no e-mail job", async () => {
    const seed = await classroom({ lobby: "manual" });
    const sent = recordOutbox();
    const lobby = await service.transition(db, await reload(db, seed.evaluationId), "lobby", now);
    expect((await live.startEvaluation(db, lobby, now)).state).toBe("running");
    // A double click: the second start read the same lobby row, and lost its
    // compare-and-set. It tells nobody.
    await live.startEvaluation(db, lobby, now);

    for (const student of seed.studentIds) {
      expect(await rowsOf(student, "activity_available")).toHaveLength(1);
    }
    expect(sent).toEqual([]);
  });

  it("says nothing for an exam or a poll", async () => {
    const seed = await seedLive(db, { settings: { lobby: "skip" } });
    await live.startEvaluation(db, await reload(db, seed.evaluationId), now);
    const poll = { ...(await reload(db, seed.evaluationId)), mode: "poll" as const };
    await service.announceMove(db, poll, now);
    for (const student of seed.studentIds) expect(await rowsOf(student, "activity_available")).toEqual([]);
  });
});
