/**
 * The item analysis of a question (ADR-038): which answers are counted, the
 * threshold, the reset — and the time spent on it (ADR-039).
 */
import { randomUUID } from "node:crypto";

import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  answers,
  attempts,
  enrollments,
  evaluations,
  gradings,
  guestParticipants,
  questions,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testDb } from "../../test/db.js";
import { seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { writeGrading } from "../grading/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { poolQuestionStats } from "./service.js";

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
  /** False by default: an attempt of before ADR-039, the rule ADR-038 was written for. */
  tracked?: boolean;
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
    displayTracked: o.tracked ?? false,
  });
  return id;
}

/** The answer row of an item as the player leaves it: shown (or not), and for how long. */
async function shown(attemptId: string, itemId: string, dwellMs: number, o: { shown?: boolean } = {}) {
  await db.insert(answers).values({
    id: randomUUID(),
    attemptId,
    itemId,
    payload: sql`'null'::jsonb`,
    firstShownAt: o.shown === false ? null : BEFORE,
    dwellMs,
  });
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

/** The pool list's entry for a question, without its id; null when it is absent. */
async function entryOf(seed: Seeded, index = 0) {
  const { items } = await poolQuestionStats(db, seed.poolId);
  const entry = items.find((i) => i.questionId === seed.questionIds[index]);
  return entry ? { n: entry.n, p: entry.p, since: entry.since } : null;
}

/** Its time alone; undefined when the question is absent. */
async function timeOf(seed: Seeded, index = 0) {
  const { items } = await poolQuestionStats(db, seed.poolId);
  return items.find((i) => i.questionId === seed.questionIds[index])?.time;
}

/** Its numbers alone. */
async function statsOf(seed: Seeded, index = 0) {
  const entry = await entryOf(seed, index);
  return entry ? { n: entry.n, p: entry.p } : null;
}

/** A second exam of the seed's classroom on its first question (or `questionIds`), at their latest version. */
async function anotherEvaluation(seed: Seeded, questionIds = [seed.questionIds[0]!]) {
  const evaluation = await evaluationService.createEvaluation(db, {
    classroomId: seed.classroomId,
    title: `Another ${randomUUID().slice(0, 4)}`,
    mode: "exam",
    createdBy: seed.teacherId,
  });
  const items = await evaluationService.addItems(
    db,
    evaluation,
    questionIds,
    (type, version) =>
      typeOf(type).defaultPoints(loadConfig(type, { config: version.config, configVersion: version.configVersion })),
    { attemptCount: 0 },
  );
  return { evaluationId: evaluation.id, itemId: items[0]!.id, itemIds: items.map((i) => i.id) };
}

const ten = Array.from({ length: 10 }, () => 1);

describe("what a question's statistics count (ADR-038)", () => {
  it("reports n and the mean success rate, in the pool list too", async () => {
    const seed = await seedLive(db, { students: 12 });
    await sitAll(seed, [1, 1, 1, 1, 1, 1, 0, 0, 0.5, 0.5, 1, 0]);

    expect(await poolQuestionStats(db, seed.poolId)).toEqual({
      items: [{ questionId: seed.questionIds[0], n: 12, p: 0.67, since: null, time: null, discrimination: null }],
    });
  });

  it("shows nothing below ten answers, and shows them from ten", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, ten.slice(0, 9));
    expect(await statsOf(seed)).toBeNull();
    expect((await poolQuestionStats(db, seed.poolId)).items).toEqual([]);

    await sitAll({ ...seed, studentIds: [seed.studentIds[9]!] }, [1]);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
  });

  it("pools every version of the question", async () => {
    const seed = await seedLive(db, { students: 6 });
    await sitAll(seed, [1, 1, 1, 1, 1, 1]);
    const [question] = await db.select().from(questions).where(eq(questions.id, seed.questionIds[0]!));
    await poolService.putDraft(db, question!, { config: { statement: "v2", answer: "v2" } });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    const second = await anotherEvaluation(seed);
    await sitAll(seed, [0, 0, 0, 0, 0, 0], second.evaluationId, second.itemId);

    expect(await statsOf(seed)).toEqual({ n: 12, p: 0.5 });
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

    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
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

    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
  });

  it("counts an expired attempt, and an unanswered item as 0", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll({ ...seed, studentIds: seed.studentIds.slice(0, 9) }, ten.slice(0, 9));
    // `answerId: null`: the student never answered (F-GRADE-01).
    await grade(await attempt(seed.evaluationId, seed.studentIds[9]!, { state: "expired" }), seed.itemIds[0]!, 0);

    expect(await statsOf(seed)).toEqual({ n: 10, p: 0.9 });
  });

  it("keeps a negative rate signed", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, Array.from({ length: 10 }, () => -0.5));
    expect(await statsOf(seed)).toEqual({ n: 10, p: -0.5 });
  });

  it("lists only the pool's own questions", async () => {
    const seed = await seedLive(db, { students: 10 });
    await sitAll(seed, ten);
    const other = await seedLive(db, { students: 1 });
    expect((await poolQuestionStats(db, other.poolId)).items).toEqual([]);
  });
});

/*
 * Ten students: how many of the five other items each earned, and what
 * they earned on the question. The expected indexes are worked out by hand
 * (Pearson of the item against rest / 5): `good` 0.5528, `inverse` its
 * opposite, `mixed` 0.2462.
 */
const rests = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5];
const good = [0, 0, 1, 0, 1, 0, 1, 1, 1, 1];
const inverse = good.map((x) => 1 - x);
const mixed = [0, 1, 0, 0, 1, 1, 0, 1, 1, 0];
const GOOD = { r: 0.55, evaluations: 1, n: 10 };

interface ExamOptions {
  evaluationId?: string;
  itemIds?: readonly string[];
  startedAt?: Date;
  /** The student whose last other item is still a proposal. */
  pending?: number;
  /** Tracked attempts on which only the question was ever on screen. */
  tracked?: boolean;
}

/** Each student sits the exam once: `item[i]` on the question (item 0), 1 on the first `rests[i]` others. */
async function sitExam(seed: Seeded, item: readonly number[], o: ExamOptions = {}) {
  const itemIds = o.itemIds ?? seed.itemIds;
  for (const [i, points] of item.entries()) {
    const id = await attempt(o.evaluationId ?? seed.evaluationId, seed.studentIds[i]!, {
      startedAt: o.startedAt ?? BEFORE,
      tracked: o.tracked ?? false,
    });
    if (o.tracked) await shown(id, itemIds[0]!, 1000);
    await grade(id, itemIds[0]!, points);
    for (const [k, other] of itemIds.slice(1).entries()) {
      const state = o.pending === i && k === itemIds.length - 2 ? "proposed" : "validated";
      await grade(id, other, k < (rests[i] ?? 0) ? 1 : 0, { state });
    }
  }
}

async function discriminationOf(seed: Seeded) {
  const { items } = await poolQuestionStats(db, seed.poolId);
  return items.find((i) => i.questionId === seed.questionIds[0])?.discrimination;
}

describe("exams only (ADR-038 §2)", () => {
  it("never counts an exercise, retaken or not, in any series, alone or beside an exam", async () => {
    const seed = await seedLive(db, {
      students: 10,
      questions: 6,
      mode: "exercise",
      settings: { retakes: { enabled: true, keep: "best", maxAttempts: null } },
    });
    // Tracked and graded in full: as an exam, it would show p, a time and an index.
    await sitExam(seed, good, { tracked: true });
    // A retake, validated.
    await grade(await attempt(seed.evaluationId, seed.studentIds[0]!, { number: 2, startedAt: AFTER }), seed.itemIds[0]!, 0);
    expect((await poolQuestionStats(db, seed.poolId)).items).toEqual([]);

    // An exam on the same question: only its answers count.
    const exam = await anotherEvaluation(seed);
    await sitAll(seed, [...ten.slice(0, 9), 0], exam.evaluationId, exam.itemId);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 0.9 });
    expect(await timeOf(seed)).toBeNull();
    expect(await discriminationOf(seed)).toBeNull();
  });
});

describe("the reset (F-STAT-05)", () => {
  it("counts only attempts started since, even after a regrade, and deletes nothing", async () => {
    const seed = await seedLive(db, { students: 10 });
    const old = await sitAll(seed, ten);
    const before = await db.select({ n: count() }).from(gradings);

    const reset = new Date("2026-09-05T08:00:00.000Z");
    await poolService.resetQuestionStats(db, seed.questionIds[0]!, reset);
    expect(await statsOf(seed)).toBeNull();
    expect(await db.select({ n: count() }).from(gradings)).toEqual(before);

    // A regrade of a pre-reset attempt moves `graded_at`, not the attempt's start.
    await grade(old[0]!, seed.itemIds[0]!, 0, { now: AFTER });
    expect(await statsOf(seed)).toBeNull();

    const second = await anotherEvaluation(seed);
    for (const userId of seed.studentIds) {
      await grade(await attempt(second.evaluationId, userId, { startedAt: AFTER }), second.itemId, 0.5);
    }
    expect(await entryOf(seed)).toEqual({ n: 10, p: 0.5, since: reset.toISOString() });
  });
});

describe("not reached (ADR-039)", () => {
  it("leaves out a tracked question never on screen, counts a shown blank 0, and keeps the old rule before tracking", async () => {
    const seed = await seedLive(db, { students: 12 });
    // Ten tracked students saw the question: nine earned 1, one left it blank.
    for (const [i, userId] of seed.studentIds.slice(0, 10).entries()) {
      const id = await attempt(seed.evaluationId, userId, { tracked: true });
      await shown(id, seed.itemIds[0]!, 1000);
      await grade(id, seed.itemIds[0]!, i === 9 ? 0 : 1);
    }
    // A tracked student who never reached it: no row, then a row never shown.
    const unreached = await attempt(seed.evaluationId, seed.studentIds[10]!, { tracked: true });
    await grade(unreached, seed.itemIds[0]!, 0);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 0.9 });
    // A legacy attempt still counts its unanswered question 0.
    await grade(await attempt(seed.evaluationId, seed.studentIds[11]!), seed.itemIds[0]!, 0);
    expect(await statsOf(seed)).toEqual({ n: 11, p: 0.82 });
  });

  it("leaves out a row the player wrote but never showed", async () => {
    const seed = await seedLive(db, { students: 11 });
    await sitAll(seed, ten);
    const id = await attempt(seed.evaluationId, seed.studentIds[10]!, { tracked: true });
    await shown(id, seed.itemIds[0]!, 0, { shown: false });
    await grade(id, seed.itemIds[0]!, 0);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
  });
});

describe("the time spent (ADR-039)", () => {
  /** `dwells.length` tracked students sit the seed's exam, earn 1 and spent `dwells[i]` on the first item. */
  async function timed(seed: Seeded, dwells: readonly number[], evaluationId = seed.evaluationId, itemId = seed.itemIds[0]!) {
    for (const [i, dwell] of dwells.entries()) {
      const id = await attempt(evaluationId, seed.studentIds[i]!, { tracked: true });
      await shown(id, itemId, dwell);
      await grade(id, itemId, 1);
    }
  }

  const minutes = [60, 70, 80, 90, 100, 110, 120, 130, 140, 150].map((s) => s * 1000);

  it("shows from ten timed answers, in whole seconds", async () => {
    const seed = await seedLive(db, { students: 10 });
    await timed(seed, minutes);
    expect(await timeOf(seed)).toEqual({ n: 10, meanS: 105, medianS: 105, p25S: 83, p75S: 128 });
  });

  it("stays null at nine timed answers while n and p show", async () => {
    const seed = await seedLive(db, { students: 10 });
    await timed(seed, [...minutes.slice(0, 9), 0]);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
    expect(await timeOf(seed)).toBeNull();
  });

  it("leaves out staff seats, guests and unfinished attempts", async () => {
    const seed = await seedLive(db, { students: 11 });
    await timed(seed, minutes.slice(0, 9));
    const running = await attempt(seed.evaluationId, seed.studentIds[9]!, { tracked: true, state: "in_progress" });
    await shown(running, seed.itemIds[0]!, 5000);
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    await shown(await attempt(seed.evaluationId, seed.teacherId, { tracked: true }), seed.itemIds[0]!, 5000);
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
    await shown(guestAttempt, seed.itemIds[0]!, 5000);
    // One more real student for n, untimed, keeps the question listed.
    await grade(await attempt(seed.evaluationId, seed.studentIds[10]!), seed.itemIds[0]!, 1);
    expect(await statsOf(seed)).toEqual({ n: 10, p: 1 });
    expect(await timeOf(seed)).toBeNull();
  });

  // A row never shown carries no dwell by construction (only an interval on
  // screen credits one), so the positive dwell is the one filter.
  it("leaves out legacy attempts, a zero dwell and a row never shown", async () => {
    const seed = await seedLive(db, { students: 12 });
    await timed(seed, minutes.slice(0, 9));
    const legacy = await attempt(seed.evaluationId, seed.studentIds[9]!);
    await shown(legacy, seed.itemIds[0]!, 5000);
    await grade(legacy, seed.itemIds[0]!, 1);
    const zero = await attempt(seed.evaluationId, seed.studentIds[10]!, { tracked: true });
    await shown(zero, seed.itemIds[0]!, 0);
    await grade(zero, seed.itemIds[0]!, 1);
    const unshown = await attempt(seed.evaluationId, seed.studentIds[11]!, { tracked: true });
    await shown(unshown, seed.itemIds[0]!, 0, { shown: false });
    expect(await timeOf(seed)).toBeNull();
  });

  it("counts only attempts started since the reset", async () => {
    const seed = await seedLive(db, { students: 10 });
    await timed(seed, minutes);
    await poolService.resetQuestionStats(db, seed.questionIds[0]!, new Date("2026-09-05T08:00:00.000Z"));
    const second = await anotherEvaluation(seed);
    for (const [i, userId] of seed.studentIds.entries()) {
      const id = await attempt(second.evaluationId, userId, { tracked: true, startedAt: AFTER });
      await shown(id, second.itemId, 30_000 + i * 1000);
      await grade(id, second.itemId, 1);
    }
    expect(await timeOf(seed)).toMatchObject({ n: 10, medianS: 35 });
  });
});

describe("the discrimination index (ADR-042)", () => {
  it("correlates the question with the rest of the exam, signed", async () => {
    const seed = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(seed, good);
    expect(await discriminationOf(seed)).toEqual(GOOD);

    const other = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(other, inverse);
    expect(await discriminationOf(other)).toEqual({ r: -0.55, evaluations: 1, n: 10 });
  });

  it("drops an attempt whose other items are not all validated, then the exam below ten", async () => {
    const seed = await seedLive(db, { students: 11, questions: 6 });
    await sitExam(seed, [...good, 1], { pending: 10 });
    // The student with a pending proposal counts in p, not in the index.
    expect(await statsOf(seed)).toMatchObject({ n: 11 });
    expect(await discriminationOf(seed)).toEqual(GOOD);

    const short = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(short, good, { pending: 3 });
    expect(await statsOf(short)).toMatchObject({ n: 10 });
    expect(await discriminationOf(short)).toBeNull();
  });

  it("keeps the validated 0 of an other item never reached in the rest of the test", async () => {
    // Every attempt is tracked and only the question was ever on screen: the
    // other items were never reached, and their validated grades — 0 for the
    // items not earned — still make the rest of the test, unchanged.
    const seed = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(seed, good, { tracked: true });
    expect(await discriminationOf(seed)).toEqual(GOOD);
  });

  it("needs five other items", async () => {
    const seed = await seedLive(db, { students: 10, questions: 5 });
    await sitExam(seed, good);
    expect(await statsOf(seed)).toMatchObject({ n: 10 });
    expect(await discriminationOf(seed)).toBeNull();
  });

  it("leaves out staff seats and tracked attempts that never reached the question", async () => {
    const seed = await seedLive(db, { students: 11, questions: 6 });
    await sitExam(seed, good);
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    const staffWalk = await attempt(seed.evaluationId, seed.teacherId);
    const unreached = await attempt(seed.evaluationId, seed.studentIds[10]!, { tracked: true });
    await shown(unreached, seed.itemIds[1]!, 1000);
    for (const id of [staffWalk, unreached]) {
      for (const itemId of seed.itemIds) await grade(id, itemId, itemId === seed.itemIds[0] ? 0 : 1);
    }

    expect(await discriminationOf(seed)).toEqual(GOOD);
  });

  it("counts only the exams started since the reset", async () => {
    const seed = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(seed, inverse);
    await poolService.resetQuestionStats(db, seed.questionIds[0]!, new Date("2026-09-05T08:00:00.000Z"));
    const second = await anotherEvaluation(seed, seed.questionIds);
    await sitExam(seed, good, { ...second, startedAt: AFTER });
    expect(await discriminationOf(seed)).toEqual(GOOD);
  });

  it("combines several exams by Fisher's z, and skips one with too few attempts", async () => {
    const seed = await seedLive(db, { students: 10, questions: 6 });
    await sitExam(seed, good);
    const second = await anotherEvaluation(seed, seed.questionIds);
    await sitExam(seed, mixed, second);
    const third = await anotherEvaluation(seed, seed.questionIds);
    await sitExam(seed, good.slice(0, 9), third);

    // tanh((7 atanh 0.5528 + 7 atanh 0.2462) / 14) = 0.4110
    expect(await discriminationOf(seed)).toEqual({ r: 0.41, evaluations: 2, n: 20 });
  });

  it("counts one exam and its attempts once when the question sits in it twice", async () => {
    const seed = await seedLive(db, { students: 10, questions: 6 });
    const twice = await anotherEvaluation(seed, [...seed.questionIds, seed.questionIds[0]!]);
    const [first, ...others] = twice.itemIds;
    const last = others.pop()!;
    for (const [i, points] of good.entries()) {
      const id = await attempt(twice.evaluationId, seed.studentIds[i]!);
      await grade(id, first!, points);
      await grade(id, last, points);
      for (const [k, other] of others.entries()) await grade(id, other, k < rests[i]! ? 1 : 0);
    }
    // Two samples, each against the five items and the other copy:
    // Pearson(good, (rests + good) / 6) = 0.7158.
    expect(await discriminationOf(seed)).toEqual({ r: 0.72, evaluations: 1, n: 10 });
  });
});
