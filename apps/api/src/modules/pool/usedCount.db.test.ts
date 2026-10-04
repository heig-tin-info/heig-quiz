/**
 * The pool list's "Used" count (ADR-013, amendment of 2026-10-04): the live
 * questions of a pool a student has met in an exam or an exercise — distinct
 * across versions, never a poll, a guest, a staff walk or an attempt that
 * never started, and with no `stats_since` reset.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationMode } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  attempts,
  enrollments,
  evaluations,
  guestParticipants,
  pools,
  questions,
} from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { publishQuestion, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { loadConfig, typeOf } from "./config.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});

afterAll(() => restore());

const STARTED = new Date("2026-09-01T08:00:00.000Z");

/** An evaluation of the seed's classroom on `questionIds`, at their latest version. */
async function evaluationOn(seed: Seeded, questionIds: string[], mode: EvaluationMode = "exam") {
  const evaluation = await evaluationService.createEvaluation(db, {
    classroomId: seed.classroomId,
    title: `On ${randomUUID().slice(0, 4)}`,
    mode: "exam",
    createdBy: seed.teacherId,
  });
  // As the item analysis does: the mode is set after the items, so a poll
  // goes through the same item path.
  await evaluationService.addItems(
    db,
    evaluation,
    questionIds,
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  if (mode !== "exam") {
    await db.update(evaluations).set({ mode }).where(eq(evaluations.id, evaluation.id));
  }
  return evaluation.id;
}

async function sit(
  evaluationId: string,
  who: { userId: string } | { guestId: string },
  startedAt: Date | null = STARTED,
) {
  await db.insert(attempts).values({
    id: randomUUID(),
    evaluationId,
    ...who,
    seed: 1,
    state: startedAt ? "submitted" : "not_started",
    startedAt,
  });
}

async function listed(seed: Seeded) {
  const [pool] = await service.listPools(db, eq(pools.id, seed.poolId), {
    id: seed.teacherId,
    reach: "seats",
  });
  return pool!;
}

describe("the pool list's used count", () => {
  it("counts the questions a student met in an exam or an exercise, and nothing else", async () => {
    const seed = await seedLive(db, { students: 1, questions: 0 });
    const student = { userId: seed.studentIds[0]! };
    const q = await Promise.all(
      ["exam", "exercise", "poll", "guest", "staff", "unstarted", "draft", "deleted"].map((name) =>
        publishQuestion(db, seed.poolId, seed.teacherId, name),
      ),
    );
    const [exam, exercise, poll, guest, staff, unstarted, draft, deleted] = q as [
      string, string, string, string, string, string, string, string,
    ];

    // Counted: an exam and an exercise, each with a started student attempt.
    await sit(await evaluationOn(seed, [exam]), student);
    await sit(await evaluationOn(seed, [exercise], "exercise"), student);

    // Not counted: a poll, however many answered it.
    await sit(await evaluationOn(seed, [poll], "poll"), student);
    // A guest's attempt.
    const ofGuest = await evaluationOn(seed, [guest]);
    const guestId = randomUUID();
    await db.insert(guestParticipants).values({ id: guestId, evaluationId: ofGuest, tokenHash: guestId });
    await sit(ofGuest, { guestId });
    // A teacher's own walk from a staff seat (ADR-018).
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    await sit(await evaluationOn(seed, [staff]), { userId: seed.teacherId });
    // An attempt that never started.
    await sit(await evaluationOn(seed, [unstarted]), student, null);
    // A draft evaluation nobody sat.
    await evaluationOn(seed, [draft]);
    // A question met by a student, then soft-deleted: the delete route refuses
    // a question in use, so the row is written as a later cleanup would leave it.
    await sit(await evaluationOn(seed, [deleted]), student);
    await db.update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, deleted));

    const pool = await listed(seed);
    expect(pool.questionCount).toBe(7);
    expect(pool.usedCount).toBe(2);
  });

  it("counts a question once across its versions and its evaluations", async () => {
    const seed = await seedLive(db, { students: 2, questions: 1 });
    const questionId = seed.questionIds[0]!;
    await sit(seed.evaluationId, { userId: seed.studentIds[0]! });

    const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
    await service.putDraft(db, question!, { config: { statement: "v2", answer: "v2" } });
    await service.publishQuestion(db, question!, { userId: seed.teacherId });
    await sit(await evaluationOn(seed, [questionId]), { userId: seed.studentIds[1]! });

    const pool = await listed(seed);
    expect(pool.questionCount).toBe(1);
    expect(pool.usedCount).toBe(1);
  });

  it("ignores the statistics reset: being used is a historical fact", async () => {
    const seed = await seedLive(db, { students: 1, questions: 1 });
    await sit(seed.evaluationId, { userId: seed.studentIds[0]! });
    await db
      .update(questions)
      .set({ statsSince: new Date("2030-01-01T00:00:00.000Z") })
      .where(eq(questions.id, seed.questionIds[0]!));

    expect((await listed(seed)).usedCount).toBe(1);
  });

  it("travels with a question moved to another pool", async () => {
    const seed = await seedLive(db, { students: 1, questions: 1 });
    await sit(seed.evaluationId, { userId: seed.studentIds[0]! });
    const elsewhere = randomUUID();
    await db.insert(pools).values({ id: elsewhere, name: "Elsewhere", ownerId: seed.teacherId });
    await db.update(questions).set({ poolId: elsewhere }).where(eq(questions.id, seed.questionIds[0]!));

    expect((await listed(seed)).usedCount).toBe(0);
    const [moved] = await service.listPools(db, eq(pools.id, elsewhere), {
      id: seed.teacherId,
      reach: "seats",
    });
    expect(moved!.usedCount).toBe(1);
  });
});

describe("the pool list's owner and roles", () => {
  it("names the owner for the avatar, and shows an admin with Super Powers their own role", async () => {
    const seed = await seedLive(db, { students: 0, questions: 0 });
    const asOwner = await listed(seed);
    expect(asOwner).toMatchObject({
      role: "owner",
      heldRole: "owner",
      ownerName: "Test teacher",
      ownerGivenName: "Test",
      ownerFamilyName: "teacher",
      ownerAvatarUrl: null,
    });

    // An admin with Super Powers, neither owner nor seated: every action
    // (the effective role), but the list says what they hold in their own
    // right — with no seat and no course, a reader.
    const [asAdmin] = await service.listPools(db, eq(pools.id, seed.poolId), {
      id: randomUUID(),
      reach: "all",
    });
    expect(asAdmin).toMatchObject({ role: "owner", heldRole: "reader" });
  });
});
