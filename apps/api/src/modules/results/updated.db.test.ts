/**
 * `results_updated` (ADR-030, addendum §c and §h.4–5; F-NOTIF-07) against the
 * real migrations: a correction after the release tells a student only when
 * their FINAL GRADE — the one the results page shows — changes, once per
 * grading write, folded per evaluation, never with the grade in it.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy, type NotificationPayload } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { enrollments, evaluationItems, evaluations, notifications } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as grading from "../grading/service.js";
import * as live from "../live/service.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

const ITEM_POINTS = 5;

interface Options {
  students: number;
  items: number;
  /** The points each cell holds at release; null leaves a high-confidence proposal of full marks. */
  points: number | null;
  release?: boolean;
  policy?: Partial<FeedbackPolicy>;
  /** The teacher holds a staff seat and takes the exam too (ADR-018). */
  teacherTest?: boolean;
}

/**
 * A closed exam of `items` items worth 5 points each, answered by every
 * student, graded, then released (unless `release: false`).
 */
async function releasedExam(options: Options) {
  const app = await testApp(db);
  app.clock.set("2026-09-28T09:00:00.000Z");
  const seed = await seedLive(db, { students: options.students, questions: options.items });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  await db
    .update(evaluationItems)
    .set({ points: ITEM_POINTS })
    .where(eq(evaluationItems.evaluationId, evaluation.id));
  if (options.policy) {
    await db
      .update(evaluations)
      .set({ feedbackPolicy: { ...FeedbackPolicy.parse(evaluation.feedbackPolicy), ...options.policy } })
      .where(eq(evaluations.id, evaluation.id));
  }
  const takers = [...seed.studentIds];
  if (options.teacherTest) {
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Prof",
      prenom: "Test",
      email: `staff-${seed.classroomId.slice(0, 8)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    takers.push(seed.teacherId);
  }
  const attemptOf = new Map<string, string>();
  for (const userId of takers) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    attemptOf.set(userId, attempt.id);
  }
  evaluation = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now());
  const joined = await joinedItems(db, evaluation.id);
  const itemIds = joined.map((i) => i.item.id);
  const questionIds = joined.map((i) => i.question.id);
  await grading.writeGradings(
    db,
    [...attemptOf.values()].flatMap((attemptId) =>
      itemIds.map((itemId) => ({
        attemptId,
        itemId,
        answerId: null,
        points: options.points ?? ITEM_POINTS,
        maxPoints: ITEM_POINTS,
        source: "auto" as const,
        state: options.points === null ? ("proposed" as const) : ("validated" as const),
        confidence: "high" as const,
        now: app.clock.now(),
      })),
    ),
  );
  if (options.release !== false) {
    await service.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
  }
  return { app, seed, evaluationId: evaluation.id, itemIds, questionIds, attemptOf };
}

type Built = Awaited<ReturnType<typeof releasedExam>>;

/** A teacher's override of one cell (F-GRADE-05): the write a correction makes. */
async function override(built: Built, userId: string, item: number, points: number) {
  await grading.manualOverride(
    db,
    {
      attemptId: built.attemptOf.get(userId)!,
      itemId: built.itemIds[item]!,
      answerId: null,
      maxPoints: ITEM_POINTS,
    },
    { points, comment: "re-read" },
    built.seed.teacherId,
    built.app.clock.now(),
  );
}

/** The `results_updated` rows of the evaluation, per recipient. */
async function notices(built: Built) {
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.evaluationId, built.evaluationId),
        sql`${notifications.payload}->>'kind' = 'results_updated'`,
      ),
    );
  return rows.map((r) => ({ userId: r.userId, payload: r.payload as NotificationPayload }));
}

describe("results_updated (F-NOTIF-07)", () => {
  it("tells the student whose final grade a correction changed, and nobody else", async () => {
    // 4 items × 5 points, 3 points each: 12 / 20 → 4.0 for both students.
    const built = await releasedExam({ students: 2, items: 4, points: 3 });
    const [changed, untouched] = built.seed.studentIds as [string, string];

    await override(built, changed, 0, 5); // 14 / 20 → 4.5

    const told = await notices(built);
    expect(told.map((n) => n.userId)).toEqual([changed]);
    // The ids and the title, never a grade, old or new (invariant 4).
    expect(told[0]!.payload).toEqual({
      kind: "results_updated",
      evaluationId: built.evaluationId,
      evaluationTitle: "Test évaluation",
      attemptId: built.attemptOf.get(changed),
      count: 1,
    });
    expect(told.some((n) => n.userId === untouched)).toBe(false);

    // A withdrawn release takes the bell back: its page shows nothing now.
    await service.unreleaseResults(db, await reload(db, built.evaluationId), built.app.clock.now());
    expect(await notices(built)).toEqual([]);
  });

  it("tells nobody when the points move and the rounded grade does not", async () => {
    const built = await releasedExam({ students: 1, items: 4, points: 3 });
    const [student] = built.seed.studentIds as [string];

    await override(built, student, 0, 3.1); // 12.1 / 20 → 4.025 → still 4.0
    expect(await notices(built)).toEqual([]);
    // The grade shown is the new one all the same (F-GRADE-09).
    const shown = await service.shownGrades(db, await reload(db, built.evaluationId), [student]);
    expect(shown.get(student)).toMatchObject({ points: 12.1, grade: 4 });
  });

  it("tells nobody when the correction lands before the release", async () => {
    const built = await releasedExam({ students: 1, items: 2, points: 3, release: false });
    await override(built, built.seed.studentIds[0]!, 0, 5);
    expect(await notices(built)).toEqual([]);
  });

  it("tells nobody when the same points are validated again", async () => {
    const built = await releasedExam({ students: 2, items: 2, points: 3 });
    for (const userId of built.seed.studentIds) await override(built, userId, 0, 3);
    expect(await notices(built)).toEqual([]);
  });

  it("tells nobody under the feedback policy `none`: they cannot read a grade", async () => {
    const built = await releasedExam({ students: 1, items: 2, points: 3, policy: { when: "none" } });
    await override(built, built.seed.studentIds[0]!, 0, 5);
    expect(await notices(built)).toEqual([]);
  });

  it("a batch of 20 cells across 5 students is one entry per student, folded afterwards", async () => {
    // Released with every cell still a proposal: each student is shown a 1.0.
    const built = await releasedExam({ students: 5, items: 4, points: null });

    const validated = await grading.batchValidate(
      db,
      built.evaluationId,
      {},
      built.seed.teacherId,
      built.app.clock.now(),
    );
    expect(validated).toBe(20);
    let told = await notices(built);
    expect(told.map((n) => n.userId).sort()).toEqual([...built.seed.studentIds].sort());
    expect(told.every((n) => "count" in n.payload && n.payload.count === 1)).toBe(true);

    // A second correction of one student folds into their unread entry.
    const first = built.seed.studentIds[0]!;
    await override(built, first, 0, 0); // 15 / 20 → 4.75 → 4.8
    told = await notices(built);
    expect(told).toHaveLength(5);
    expect(told.find((n) => n.userId === first)!.payload).toMatchObject({ count: 2 });
  });

  it("tells nobody of a correction of a teacher's own test (ADR-018)", async () => {
    const built = await releasedExam({ students: 1, items: 2, points: 3, teacherTest: true });
    await override(built, built.seed.teacherId, 0, 5);
    expect(await notices(built)).toEqual([]);
  });
});

describe("results_updated across a regrade (F-GRADE-06)", () => {
  /**
   * The regrade route's own steps: the item's gradings stood down, the flag
   * raised at once; then the pass writes the new gradings through the one
   * writer, as `runEvaluationGrading` does, with the points given here.
   */
  async function regrade(built: Built, item: number, points: (userId: string) => number) {
    const now = built.app.clock.now();
    const note = await grading.regradeItem(
      db,
      {
        evaluationId: built.evaluationId,
        itemId: built.itemIds[item]!,
        questionId: built.questionIds[item]!,
        variables: null,
      },
      { note: "key fixed" },
    );
    await service.markModifiedAfterRelease(db, await reload(db, built.evaluationId), now);
    await grading.writeGradings(
      db,
      built.seed.studentIds.map((userId) => ({
        attemptId: built.attemptOf.get(userId)!,
        itemId: built.itemIds[item]!,
        answerId: null,
        points: points(userId),
        maxPoints: ITEM_POINTS,
        source: "auto" as const,
        state: "validated" as const,
        regradeNote: note!,
        now,
      })),
    );
  }

  it("tells nobody when the regrade gives the same points back", async () => {
    const built = await releasedExam({ students: 3, items: 2, points: 3 });
    await regrade(built, 0, () => 3);
    expect(await notices(built)).toEqual([]);
  });

  it("tells the students whose final grade the regrade changed", async () => {
    const built = await releasedExam({ students: 3, items: 2, points: 3 });
    const [changed] = built.seed.studentIds as [string];
    await regrade(built, 0, (userId) => (userId === changed ? 5 : 3));
    expect((await notices(built)).map((n) => n.userId)).toEqual([changed]);
  });

  it("compares a proposal validated after the regrade with the grade before it", async () => {
    const built = await releasedExam({ students: 2, items: 2, points: 3 });
    const now = built.app.clock.now();
    await grading.regradeItem(
      db,
      {
        evaluationId: built.evaluationId,
        itemId: built.itemIds[0]!,
        questionId: built.questionIds[0]!,
        variables: null,
      },
      { note: "key fixed" },
    );
    await service.markModifiedAfterRelease(db, await reload(db, built.evaluationId), now);
    // The pass leaves proposals; the teacher validates them all, unchanged.
    await grading.writeGradings(
      db,
      built.seed.studentIds.map((userId) => ({
        attemptId: built.attemptOf.get(userId)!,
        itemId: built.itemIds[0]!,
        answerId: null,
        points: 3,
        maxPoints: ITEM_POINTS,
        source: "auto" as const,
        state: "proposed" as const,
        confidence: "high" as const,
        now,
      })),
    );
    await grading.batchValidate(db, built.evaluationId, {}, built.seed.teacherId, now);
    expect(await notices(built)).toEqual([]);
  });
});
