/**
 * The item analysis of a question (ADR-038): which answers are counted, the
 * threshold, the reset — and the two predicates it shares with the rest of
 * the API (`isStaffAttempt`, `keptAttemptIdsOf`), held equal to their
 * single-evaluation twins.
 */
import { randomUUID } from "node:crypto";

import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  attempts,
  enrollments,
  evaluations,
  gradings,
  guestParticipants,
  questions,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testDb } from "../../test/db.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { keptAttemptIdsOf, keptAttempts, writeGrading } from "../grading/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { poolQuestionStats, questionStats } from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});

afterAll(() => restore());

const BEFORE = new Date("2026-09-01T08:00:00.000Z");
const AFTER = new Date("2026-09-10T08:00:00.000Z");

interface AttemptOptions {
  state?: "in_progress" | "submitted" | "expired";
  startedAt?: Date | null;
  number?: number;
}

async function attempt(evaluationId: string, userId: string, o: AttemptOptions = {}) {
  const id = randomUUID();
  await db.insert(attempts).values({
    id,
    evaluationId,
    userId,
    seed: 1,
    state: o.state ?? "submitted",
    attemptNumber: o.number ?? 1,
    startedAt: o.startedAt === undefined ? BEFORE : o.startedAt,
  });
  return id;
}

async function grade(
  attemptId: string,
  itemId: string,
  points: number,
  o: { max?: number; state?: "validated" | "proposed"; now?: Date } = {},
) {
  await writeGrading(db, {
    attemptId,
    itemId,
    answerId: null,
    points,
    maxPoints: o.max ?? 1,
    source: "manual",
    state: o.state ?? "validated",
    now: o.now ?? BEFORE,
  });
}

/** The first `points.length` students each sit once and earn `points[i]` on the first item. */
async function sitAll(seed: Seeded, points: readonly number[], evaluationId = seed.evaluationId, itemId = seed.itemIds[0]!) {
  const ids: string[] = [];
  for (const [i, p] of points.entries()) {
    const id = await attempt(evaluationId, seed.studentIds[i]!);
    await grade(id, itemId, p);
    ids.push(id);
  }
  return ids;
}

async function statsOf(seed: Seeded, index = 0) {
  const [question] = await db.select().from(questions).where(eq(questions.id, seed.questionIds[index]!));
  return questionStats(db, question!);
}

/** A second evaluation of the seed's classroom on its first question, at its latest version. */
async function anotherEvaluation(seed: Seeded) {
  const evaluation = await evaluationService.createEvaluation(db, {
    classroomId: seed.classroomId,
    title: `Another ${randomUUID().slice(0, 4)}`,
    mode: "exam",
    createdBy: seed.teacherId,
  });
  const [item] = await evaluationService.addItems(
    db,
    evaluation,
    [seed.questionIds[0]!],
    (type, version) =>
      typeOf(type).defaultPoints(loadConfig(type, { config: version.config, configVersion: version.configVersion })),
    { attemptCount: 0 },
  );
  return { evaluationId: evaluation.id, itemId: item!.id };
}

const ten = Array.from({ length: 10 }, () => 1);

describe("what a question's statistics count (ADR-038)", () => {
  it("reports n and the mean success rate, in the pool list too", async () => {
    const seed = await seedLive(db, { students: 12 });
    await sitAll(seed, [1, 1, 1, 1, 1, 1, 0, 0, 0.5, 0.5, 1, 0]);

    expect((await statsOf(seed)).stats).toEqual({ n: 12, p: 0.67 });
    expect((await statsOf(seed)).since).toBeNull();
    expect(await poolQuestionStats(db, seed.poolId)).toEqual({
      items: [{ questionId: seed.questionIds[0], n: 12, p: 0.67 }],
    });
  });

  it("shows nothing below ten answers, and shows them from ten", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, ten.slice(0, 9));
    expect((await statsOf(seed)).stats).toBeNull();
    expect((await poolQuestionStats(db, seed.poolId)).items).toEqual([]);

    await sitAll({ ...seed, studentIds: [seed.studentIds[9]!] }, [1]);
    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: 1 });
  });

  it("pools every version of the question", async () => {
    const seed = await seedLive(db, { students: 6 });
    await sitAll(seed, [1, 1, 1, 1, 1, 1]);
    const [question] = await db.select().from(questions).where(eq(questions.id, seed.questionIds[0]!));
    await poolService.putDraft(db, question!, { config: { statement: "v2", answer: "v2" } });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    const second = await anotherEvaluation(seed);
    await sitAll(seed, [0, 0, 0, 0, 0, 0], second.evaluationId, second.itemId);

    expect((await statsOf(seed)).stats).toEqual({ n: 12, p: 0.5 });
  });

  it("counts a validated grading once, never a proposal alone", async () => {
    const seed = await seedLive(db, { students: 11 });
    for (const userId of seed.studentIds.slice(0, 10)) {
      const id = await attempt(seed.evaluationId, userId);
      await grade(id, seed.itemIds[0]!, 0, { state: "proposed" });
      await grade(id, seed.itemIds[0]!, 1); // supersedes the proposal
    }
    const pending = await attempt(seed.evaluationId, seed.studentIds[10]!);
    await grade(pending, seed.itemIds[0]!, 0, { state: "proposed" });

    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: 1 });
  });

  it("leaves out polls, guests, staff seats, unfinished or unstarted attempts and zero-point items", async () => {
    const seed = await seedLive(db, { students: 13 });
    await sitAll(seed, ten);

    // An unfinished attempt, and one that never started.
    await grade(await attempt(seed.evaluationId, seed.studentIds[10]!, { state: "in_progress" }), seed.itemIds[0]!, 0);
    await grade(await attempt(seed.evaluationId, seed.studentIds[11]!, { startedAt: null }), seed.itemIds[0]!, 0);
    // An item worth nothing.
    await grade(await attempt(seed.evaluationId, seed.studentIds[12]!), seed.itemIds[0]!, 0, { max: 0 });
    // A teacher's own test walk from a staff seat (ADR-018).
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    await grade(await attempt(seed.evaluationId, seed.teacherId), seed.itemIds[0]!, 0);
    // A guest.
    const guestId = randomUUID();
    await db.insert(guestParticipants).values({ id: guestId, evaluationId: seed.evaluationId, tokenHash: guestId });
    const guestAttempt = randomUUID();
    await db.insert(attempts).values({
      id: guestAttempt,
      evaluationId: seed.evaluationId,
      guestId,
      seed: 1,
      state: "submitted",
      startedAt: BEFORE,
    });
    await grade(guestAttempt, seed.itemIds[0]!, 0);
    // A poll on the same question.
    const poll = await anotherEvaluation(seed);
    await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, poll.evaluationId));
    await sitAll(seed, [0, 0], poll.evaluationId, poll.itemId);

    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: 1 });
  });

  it("counts an expired attempt, and an unanswered item as 0", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll({ ...seed, studentIds: seed.studentIds.slice(0, 9) }, ten.slice(0, 9));
    // `answerId: null`: the student never answered (F-GRADE-01).
    await grade(await attempt(seed.evaluationId, seed.studentIds[9]!, { state: "expired" }), seed.itemIds[0]!, 0);

    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: 0.9 });
  });

  it("keeps a negative rate signed", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, Array.from({ length: 10 }, () => -0.5));
    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: -0.5 });
  });

  it("lists only the pool's own questions", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, ten);
    const other = await seedLive(db, { students: 1 });
    expect((await poolQuestionStats(db, other.poolId)).items).toEqual([]);
  });
});

describe("retakes (F-EVAL-15, ADR-025)", () => {
  /**
   * Eleven students: ten sit once and earn 1; the first one sits twice,
   * 1 then 0 on the first item (and 0 on the second both times).
   */
  async function retaken(keep: "best" | "last", secondState: "validated" | "proposed" = "validated") {
    const seed = await seedLive(db, {
      students: 11,
      mode: "exercise",
      settings: { retakes: { enabled: true, keep, maxAttempts: null } },
    });
    await sitAll({ ...seed, studentIds: seed.studentIds.slice(1) }, ten);
    const student = seed.studentIds[0]!;
    const first = await attempt(seed.evaluationId, student);
    await grade(first, seed.itemIds[0]!, 1);
    await grade(first, seed.itemIds[1]!, 0);
    const second = await attempt(seed.evaluationId, student, { number: 2, startedAt: AFTER });
    await grade(second, seed.itemIds[0]!, 0, { state: secondState });
    await grade(second, seed.itemIds[1]!, 0);
    return seed;
  }

  it("counts only the kept attempt, best", async () => {
    expect((await statsOf(await retaken("best"))).stats).toEqual({ n: 11, p: 1 });
  });

  it("counts only the kept attempt, last", async () => {
    expect((await statsOf(await retaken("last"))).stats).toEqual({ n: 11, p: 0.91 });
  });

  it("leaves the student out while the kept attempt is not validated, never falling back", async () => {
    expect((await statsOf(await retaken("last", "proposed"))).stats).toEqual({ n: 10, p: 1 });
  });

  it("agrees with keptAttempts on which attempt is kept", async () => {
    for (const keep of ["best", "last"] as const) {
      const seed = await retaken(keep);
      const evaluation = await reload(db, seed.evaluationId);
      const one = await keptAttempts(db, evaluation);
      expect(await keptAttemptIdsOf(db, [evaluation])).toEqual(new Set([...one.values()].map((a) => a.id)));
    }
  });
});

describe("the reset (F-STAT-05)", () => {
  it("counts only attempts started since, even after a regrade, and deletes nothing", async () => {
    const seed = await seedLive(db, { students: 10 });
    const old = await sitAll(seed, ten);
    const before = await db.select({ n: count() }).from(gradings);

    const reset = new Date("2026-09-05T08:00:00.000Z");
    expect(await poolService.resetQuestionStats(db, seed.questionIds[0]!, reset)).toEqual(reset);
    expect(await statsOf(seed)).toEqual({ since: reset.toISOString(), stats: null });
    expect(await db.select({ n: count() }).from(gradings)).toEqual(before);

    // A regrade of a pre-reset attempt moves `graded_at`, not the attempt's start.
    await grade(old[0]!, seed.itemIds[0]!, 0, { now: AFTER });
    expect((await statsOf(seed)).stats).toBeNull();

    const second = await anotherEvaluation(seed);
    for (const userId of seed.studentIds) {
      await grade(await attempt(second.evaluationId, userId, { startedAt: AFTER }), second.itemId, 0.5);
    }
    expect((await statsOf(seed)).stats).toEqual({ n: 10, p: 0.5 });
  });
});

describe("isStaffAttempt (ADR-018)", () => {
  it("names the same attempts as staffAttemptIds", async () => {
    const seed = await seedLive(db, { students: 2 });
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    await attempt(seed.evaluationId, seed.teacherId);
    await attempt(seed.evaluationId, seed.studentIds[0]!);

    const evaluation = await reload(db, seed.evaluationId);
    const rows = await db
      .select({ id: attempts.id })
      .from(attempts)
      .innerJoin(evaluations, eq(evaluations.id, attempts.evaluationId))
      .where(sql`${eq(attempts.evaluationId, seed.evaluationId)} and ${evaluationService.isStaffAttempt}`);
    const expected = await evaluationService.staffAttemptIds(db, evaluation);
    expect(expected.size).toBe(1);
    expect(new Set(rows.map((r) => r.id))).toEqual(expected);
  });
});
