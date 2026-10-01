/**
 * The drill against the real migrations (ADR-041, #317, slice 2): the life
 * of a card, today's session over real rows, and the review — the server's
 * clock, the idle cap, the rating, the schedule, the key reset and the
 * student view.
 *
 * The world is built through the ordinary services (`seedLive`, the live
 * module's attempt path, the results' release), so a card is created by the
 * very hooks production runs, never by a hand-written insert.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  classrooms,
  drillCards,
  drillReviews,
  enrollments,
  evaluationItems,
  evaluations,
  questions,
} from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { markersIn, publishParameterized } from "../../test/parameterized.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import * as live from "../live/service.js";

import { loadConfig, typeOf, type VersionRow } from "../pool/config.js";
import * as org from "../org/service.js";
import * as poolService from "../pool/service.js";
import { publishCorrection, releaseResults, unreleaseResults } from "../results/service.js";
import * as drill from "./service.js";
import { currentVersions } from "./lifecycle.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

const T0 = "2026-10-05T07:00:00.000Z";

async function appAt(at = T0) {
  const app = await testApp(db);
  app.clock.set(at);
  return app;
}
type App = Awaited<ReturnType<typeof appAt>>;

const points = (type: string, version: VersionRow) =>
  typeOf(type).defaultPoints(loadConfig(type, version));

/**
 * Every student of `seed` sits the evaluation: the first question right, the
 * others wrong. An exercise is handed in by each student; an exam is closed
 * (and released when `release`).
 */
async function sit(
  app: App,
  seed: Seeded,
  opts: { students?: string[]; release?: boolean; answers?: unknown[]; blank?: boolean } = {},
) {
  let evaluation = await evaluationService.applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  for (const userId of opts.students ?? seed.studentIds) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, itemId] of seed.itemIds.entries()) {
      if (opts.blank) break;
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId,
        payload: opts.answers?.[index] ?? (index === 0 ? "answer-q0" : "wrong"),
        revision: 1,
        now: app.clock.now(),
      });
    }
    if (evaluation.mode === "exercise") await live.submitAttempt(db, evaluation, attempt, app.clock.now());
  }
  if (evaluation.mode === "exam") {
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
    if (opts.release) await releaseResults(db, await reload(db, evaluation.id), app.clock.now());
  }
  return reload(db, seed.evaluationId);
}

/** A course with the drill on, and an evaluation of `mode`. */
async function world(
  app: App,
  opts: { mode?: "exam" | "exercise"; allowDrill?: boolean; enabled?: boolean; students?: number } = {},
) {
  const seed = await seedLive(db, { mode: opts.mode ?? "exam", students: opts.students ?? 2, questions: 2 });
  if (opts.enabled ?? true) await org.setClassroomDrill(db, seed.classroomId, true, app.clock.now());
  if (opts.allowDrill !== undefined) {
    await evaluationService.setAllowDrill(db, await reload(db, seed.evaluationId), opts.allowDrill, app.clock.now());
  }
  return seed;
}

const cardsOf = (where: { evaluationId?: string; userId?: string }) =>
  db
    .select()
    .from(drillCards)
    .where(
      and(
        where.evaluationId ? eq(drillCards.evaluationId, where.evaluationId) : undefined,
        where.userId ? eq(drillCards.userId, where.userId) : undefined,
      ),
    );

describe("the life of a card (ADR-041 §1–3)", () => {
  it("creates an exam's cards at the release, never before, one per student and question", async () => {
    const app = await appAt();
    const seed = await world(app, { allowDrill: true });
    await sit(app, seed);
    expect(await cardsOf({ evaluationId: seed.evaluationId })).toHaveLength(0);

    await releaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    const cards = await cardsOf({ evaluationId: seed.evaluationId });
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.classroomId).toBe(seed.classroomId);
      expect(card.lastReviewAt).toBeNull();
      expect(card.reps).toBe(0);
      expect(card.dueAt.toISOString()).toBe(T0);
    }
    // A re-release creates nothing more.
    await releaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    expect(await cardsOf({ evaluationId: seed.evaluationId })).toHaveLength(4);
  });

  it("creates nothing for an exam left at its default, nor with the classroom's drill off", async () => {
    const app = await appAt();
    const byDefault = await world(app);
    await sit(app, byDefault, { release: true });
    expect(await cardsOf({ evaluationId: byDefault.evaluationId })).toHaveLength(0);

    const off = await world(app, { allowDrill: true, enabled: false });
    await sit(app, off, { release: true });
    expect(await cardsOf({ evaluationId: off.evaluationId })).toHaveLength(0);
  });

  it("creates an exercise's cards at the hand-in of each student, on by default", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise" });
    await sit(app, seed, { students: [seed.studentIds[0]!] });
    const cards = await cardsOf({ evaluationId: seed.evaluationId });
    expect(cards.map((c) => c.userId)).toEqual([seed.studentIds[0], seed.studentIds[0]]);
  });

  it("skips a student who opted out, and an exercise that does not allow drill", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise" });
    await org.setDrillOptOut(db, seed.classroomId, seed.studentIds[1]!, true, app.clock.now());
    await sit(app, seed);
    const cards = await cardsOf({ evaluationId: seed.evaluationId });
    expect(new Set(cards.map((c) => c.userId))).toEqual(new Set([seed.studentIds[0]]));

    const refused = await world(app, { mode: "exercise", allowDrill: false });
    await sit(app, refused);
    expect(await cardsOf({ evaluationId: refused.evaluationId })).toHaveLength(0);
  });

  it("takes only a grading that is automatic and final (ADR-041 §3)", async () => {
    const app = await appAt();
    const seed = await world(app, { allowDrill: true });
    await sit(app, seed);
    const proposing = registerForTests({
      ...fakeShort,
      grade: (_config, _answer, ctx) => ({
        kind: "graded",
        points: 0,
        maxPoints: ctx.itemPoints,
        details: { matched: false, expected: "" },
        state: "proposed",
      }),
    });
    try {
      await releaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    } finally {
      proposing();
    }
    expect(await cardsOf({ evaluationId: seed.evaluationId })).toHaveLength(0);
  });

  it("keeps the first classroom and evaluation a question was met in", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    await sit(app, seed);
    // The same questions in a second exercise of the same classroom.
    const second = await evaluationService.createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "Again",
      mode: "exercise",
      createdBy: seed.teacherId,
    });
    const items = await evaluationService.addItems(db, second, seed.questionIds, points, { attemptCount: 0 });
    await sit(app, { ...seed, evaluationId: second.id, itemIds: items.map((i) => i.id) });
    const cards = await cardsOf({ userId: seed.studentIds[0]! });
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.evaluationId === seed.evaluationId)).toBe(true);
  });

  it("removes an evaluation's cards and their reviews on the teacher's action", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    await sit(app, seed);
    const [card] = await cardsOf({ evaluationId: seed.evaluationId });
    await drill.serveCard(db, seed.studentIds[0]!, card!.id, app.clock.now());
    await drill.answerCard(db, seed.studentIds[0]!, card!.id, { answer: "x", deviceClass: "fine" }, app.clock.now());
    expect(await drill.evaluationCardCount(db, seed.evaluationId)).toBe(2);

    expect(await drill.removeEvaluationCards(db, seed.evaluationId)).toBe(2);
    expect(await cardsOf({ evaluationId: seed.evaluationId })).toHaveLength(0);
    expect(await db.select().from(drillReviews).where(eq(drillReviews.cardId, card!.id))).toHaveLength(0);
  });

  it("deletes the drill data of a deleted evaluation, classroom or question (06, question 28 (a))", async () => {
    const app = await appAt();
    const a = await world(app, { mode: "exercise", students: 1 });
    await sit(app, a);
    await evaluationService.deleteEvaluation(db, await reload(db, a.evaluationId));
    expect(await cardsOf({ userId: a.studentIds[0]! })).toHaveLength(0);

    const b = await world(app, { mode: "exercise", students: 1 });
    await sit(app, b);
    await org.deleteClassroom(db, b.classroomId);
    expect(await cardsOf({ userId: b.studentIds[0]! })).toHaveLength(0);

    // A question leaves once no evaluation holds it; its cards go with it.
    const c = await world(app, { mode: "exercise", students: 1 });
    await sit(app, c);
    await db.delete(evaluationItems).where(eq(evaluationItems.evaluationId, c.evaluationId));
    await db.delete(questions).where(eq(questions.id, c.questionIds[0]!));
    expect((await cardsOf({ userId: c.studentIds[0]! })).map((x) => x.questionId)).toEqual([c.questionIds[1]]);
  });

  it("purges reviews and cards five years old, and nothing younger", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    await sit(app, seed);
    const [old, young] = await cardsOf({ evaluationId: seed.evaluationId });
    const sixYears = new Date(new Date(T0).getTime() - 6 * 365 * 86_400_000);
    await db.update(drillCards).set({ createdAt: sixYears, dueAt: sixYears }).where(eq(drillCards.id, old!.id));
    await db.insert(drillReviews).values({
      id: randomUUID(),
      cardId: young!.id,
      rating: 3,
      correctness: "right",
      elapsedMs: 1000,
      deviceClass: "fine",
      reviewedAt: sixYears,
    });
    const purged = await drill.purgeExpiredDrill(db, app.clock.now());
    expect(purged.cards).toBeGreaterThanOrEqual(1);
    const left = await cardsOf({ evaluationId: seed.evaluationId });
    expect(left.map((c) => c.id)).toEqual([young!.id]);
    expect(await db.select().from(drillReviews).where(eq(drillReviews.cardId, young!.id))).toHaveLength(0);
  });
});

/** One student with two new cards of an exercise, fresh. */
async function oneStudent(app: App) {
  const seed = await world(app, { mode: "exercise", students: 1 });
  await sit(app, seed);
  const userId = seed.studentIds[0]!;
  const cards = await cardsOf({ userId });
  const byQuestion = new Map(cards.map((c) => [c.questionId, c]));
  return { seed, userId, right: byQuestion.get(seed.questionIds[0]!)!, other: byQuestion.get(seed.questionIds[1]!)! };
}

describe("today's session (F-DRILL-03)", () => {
  it("serves the new cards, then an empty day with the next due date", async () => {
    const app = await appAt();
    const { userId, right, other } = await oneStudent(app);
    const session = await drill.drillSession(db, userId, "fine", app.clock.now());
    expect(new Set(session.cards.map((c) => c.id))).toEqual(new Set([right.id, other.id]));
    expect(session.cards.every((c) => c.isNew && c.type === "short")).toBe(true);
    expect(session.nextDueAt).toBeNull();

    for (const card of [right, other]) {
      await drill.serveCard(db, userId, card.id, app.clock.now());
      await drill.answerCard(db, userId, card.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
    }
    const empty = await drill.drillSession(db, userId, "fine", app.clock.now());
    expect(empty.cards).toEqual([]);
    expect(new Date(empty.nextDueAt!).getTime()).toBeGreaterThan(app.clock.now().getTime());
  });

  it("drops the cards of an archived classroom and of an opted-out student", async () => {
    const app = await appAt();
    const { seed, userId, right } = await oneStudent(app);
    await org.setArchived(db, seed.classroomId, true);
    expect((await drill.drillSession(db, userId, "fine", app.clock.now())).cards).toEqual([]);
    await expect(drill.serveCard(db, userId, right.id, app.clock.now())).rejects.toBeInstanceOf(drill.DrillCardNotFound);
    // Kept for the retention period (06, question 28 (g)).
    expect(await cardsOf({ userId })).toHaveLength(2);

    await org.setArchived(db, seed.classroomId, false);
    await org.setDrillOptOut(db, seed.classroomId, userId, true, app.clock.now());
    expect((await drill.drillSession(db, userId, "fine", app.clock.now())).cards).toEqual([]);
  });

  it("caps the new cards of one day", async () => {
    const app = await appAt();
    const { seed, userId } = await oneStudent(app);
    // Eleven more new cards, as if met in other evaluations.
    const extra = await seedLive(db, { studentIds: [], questions: 11, teacherId: seed.teacherId });
    await db.insert(drillCards).values(
      extra.questionIds.map((questionId) => ({
        id: randomUUID(),
        userId,
        questionId,
        classroomId: seed.classroomId,
        evaluationId: seed.evaluationId,
        dueAt: app.clock.now(),
        keyHash: "x",
        createdAt: app.clock.now(),
      })),
    );
    // Nine of them introduced today: one new card is left for the day.
    const fresh = (await cardsOf({ userId })).filter((c) => extra.questionIds.includes(c.questionId));
    for (const card of fresh.slice(0, 9)) {
      // Right, so none of them is due again tomorrow.
      const answer = `answer-q${extra.questionIds.indexOf(card.questionId)}`;
      await drill.serveCard(db, userId, card.id, app.clock.now());
      await drill.answerCard(db, userId, card.id, { answer, deviceClass: "fine" }, app.clock.now());
    }
    const session = await drill.drillSession(db, userId, "fine", app.clock.now());
    expect(session.cards).toHaveLength(1);
    expect(session.cards[0]!.isNew).toBe(true);

    // The tenth is served; an eleventh new card is not today's to serve.
    const tenth = session.cards[0]!.id;
    await drill.serveCard(db, userId, tenth, app.clock.now());
    await drill.answerCard(db, userId, tenth, { answer: "wrong", deviceClass: "fine" }, app.clock.now());
    const eleventh = (await cardsOf({ userId })).find((c) => c.lastReviewAt === null)!;
    await expect(drill.serveCard(db, userId, eleventh.id, app.clock.now())).rejects.toBeInstanceOf(
      drill.DrillCardNotFound,
    );

    // The next day, the cap is whole again (the budget of ten minutes holds ten unknown cards).
    app.clock.advance(86_400_000);
    const tomorrow = await drill.drillSession(db, userId, "fine", app.clock.now());
    expect(tomorrow.cards.filter((c) => c.isNew)).toHaveLength(3);
  });
});

describe("a review of a parameterized question (ADR-056 §5)", () => {
  it("serves the values it stores beside the seed, grades on them, keeps them with the review, and keys the card on the template", async () => {
    const app = await appAt();
    const seed = await seedLive(db, { mode: "exercise", students: 1, questions: 0 });
    await org.setClassroomDrill(db, seed.classroomId, true, app.clock.now());
    const questionId = await publishParameterized(db, { poolId: seed.poolId, teacherId: seed.teacherId, type: "mcq" });
    const [item] = await evaluationService.addItems(db, await reload(db, seed.evaluationId), [questionId], (type, version) =>
      typeOf(type).defaultPoints(poolService.exampleConfig(type, version)), { attemptCount: 0 });
    await sit(app, { ...seed, questionIds: [questionId], itemIds: [item!.id] }, { answers: [{ selected: [0] }] });
    const userId = seed.studentIds[0]!;
    const [card] = await cardsOf({ userId });
    const version = (await currentVersions(db, [questionId])).get(questionId)!;
    expect(card!.keyHash).toBe(poolService.templateHash("mcq", version));

    const served = await drill.serveCard(db, userId, card!.id, app.clock.now());
    expect(markersIn(JSON.stringify(served))).toEqual([]);
    const [open] = await db.select().from(drillCards).where(eq(drillCards.id, card!.id));
    expect(open!.serveValues).toMatchObject({ versionId: version.id });
    expect(Object.keys(open!.serveValues!.values).sort()).toEqual(["g", "h", "t"]);
    // A reload serves the same instance.
    expect(await drill.serveCard(db, userId, card!.id, app.clock.now())).toEqual(served);

    const result = await drill.answerCard(db, userId, card!.id, { answer: { selected: [0] }, deviceClass: "fine" }, app.clock.now());
    expect(result.correctness).toBe("right");
    expect(markersIn(JSON.stringify(result))).toEqual([]);
    const [review] = await db.select().from(drillReviews).where(eq(drillReviews.cardId, card!.id));
    expect(review!.values).toEqual(open!.serveValues);
    const [closed] = await db.select().from(drillCards).where(eq(drillCards.id, card!.id));
    expect(closed!.serveSeed).toBeNull();
    expect(closed!.serveValues).toBeNull();
    // A new draw is no new key: the card keeps its schedule.
    expect(closed!.keyHash).toBe(card!.keyHash);
  });
});

describe("a review (F-DRILL-02, ADR-041 §4)", () => {
  it("serves the question through the student view, without its key", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    const served = await drill.serveCard(db, userId, right.id, app.clock.now());
    expect(served.student).toEqual({ statement: "Statement of q0" });
    const text = JSON.stringify(served);
    expect(text).not.toContain("answer-q0");
    for (const key of [...COMMON_FORBIDDEN_STUDENT_KEYS, ...live.FORBIDDEN_STUDENT_KEYS]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it("refuses a review whose grading is not final, and writes nothing", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    await drill.serveCard(db, userId, right.id, app.clock.now());
    const proposing = registerForTests({
      ...fakeShort,
      grade: (_config, _answer, ctx) => ({
        kind: "graded",
        points: 0,
        maxPoints: ctx.itemPoints,
        details: { matched: false, expected: "" },
        state: "proposed",
      }),
    });
    try {
      await expect(
        drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now()),
      ).rejects.toBeInstanceOf(drill.DrillCardNotFound);
    } finally {
      proposing();
    }
    // No review, the card still served: the answer can come again.
    expect(await db.select().from(drillReviews).where(eq(drillReviews.cardId, right.id))).toHaveLength(0);
    const [card] = await db.select().from(drillCards).where(eq(drillCards.id, right.id));
    expect(card!.serveSeed).not.toBeNull();
    const result = await drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
    expect(result.correctness).toBe("right");
  });

  it("refuses an answer to a card that was not served, and another student's card", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    await expect(
      drill.answerCard(db, userId, right.id, { answer: "x", deviceClass: "fine" }, app.clock.now()),
    ).rejects.toBeInstanceOf(drill.DrillNotServed);
    const stranger = (await oneStudent(app)).userId;
    await expect(drill.serveCard(db, stranger, right.id, app.clock.now())).rejects.toBeInstanceOf(
      drill.DrillCardNotFound,
    );
  });

  it("counts the time on screen by the server's clock, the hidden time excluded", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    await drill.serveCard(db, userId, right.id, app.clock.now());
    app.clock.advance(5_000);
    await drill.reportShown(db, userId, right.id, false, app.clock.now());
    app.clock.advance(60_000);
    await drill.reportShown(db, userId, right.id, true, app.clock.now());
    app.clock.advance(3_000);
    const result = await drill.answerCard(
      db,
      userId,
      right.id,
      { answer: "answer-q0", deviceClass: "coarse" },
      app.clock.now(),
    );
    expect(result.activeMs).toBe(8_000);
    const [review] = await db.select().from(drillReviews).where(eq(drillReviews.cardId, right.id));
    expect(review).toMatchObject({ elapsedMs: 8_000, deviceClass: "coarse", correctness: "right", rating: 3 });
    expect(review!.reviewedAt.toISOString()).toBe(app.clock.now().toISOString());
  });

  it("caps an interval left open at the idle cap", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    await drill.serveCard(db, userId, right.id, app.clock.now());
    app.clock.advance(45 * 60_000);
    const result = await drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
    expect(result.activeMs).toBe(600_000);
  });

  it("rates, reschedules and shows the key", async () => {
    const app = await appAt();
    const { userId, right, other } = await oneStudent(app);

    await drill.serveCard(db, userId, other.id, app.clock.now());
    const wrong = await drill.answerCard(db, userId, other.id, { answer: "nope", deviceClass: "fine" }, app.clock.now());
    expect(wrong).toMatchObject({ correctness: "wrong", rating: 1, points: 0, solution: { answer: "answer-q1" } });

    await drill.serveCard(db, userId, right.id, app.clock.now());
    app.clock.advance(20_000);
    const first = await drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
    // No reference yet: a right answer is Good (ADR-041 §10, item 7).
    expect(first).toMatchObject({ correctness: "right", rating: 3, referenceMs: null });
    const [card] = await db.select().from(drillCards).where(eq(drillCards.id, right.id));
    expect(card).toMatchObject({ reps: 1, serveSeed: null, shownSince: null, activeMs: 0 });
    expect(card!.lastReviewAt!.toISOString()).toBe(app.clock.now().toISOString());
    expect(card!.dueAt.getTime()).toBeGreaterThan(app.clock.now().getTime() + 86_400_000);
    expect(first.dueAt).toBe(card!.dueAt.toISOString());

    // Not twice in a day: a card reviewed today is not today's to serve again,
    // nor one not due before the day ends.
    await expect(drill.serveCard(db, userId, right.id, app.clock.now())).rejects.toBeInstanceOf(
      drill.DrillCardNotFound,
    );
    app.clock.advance(86_400_000);
    await expect(drill.serveCard(db, userId, right.id, app.clock.now())).rejects.toBeInstanceOf(
      drill.DrillCardNotFound,
    );

    // The student's own previous time is the reference now: much faster is Easy.
    app.clock.set(card!.dueAt);
    await drill.serveCard(db, userId, right.id, app.clock.now());
    app.clock.advance(5_000);
    const second = await drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
    expect(second).toMatchObject({ rating: 4, referenceMs: 20_000 });
  });

  it("draws a new seed at each review, and keeps it across a reload", async () => {
    const app = await appAt();
    const { userId, right } = await oneStudent(app);
    const seeds = new Set<number>();
    for (let i = 0; i < 4; i++) {
      await drill.serveCard(db, userId, right.id, app.clock.now());
      const [served] = await db.select().from(drillCards).where(eq(drillCards.id, right.id));
      await drill.serveCard(db, userId, right.id, app.clock.now());
      const [again] = await db.select().from(drillCards).where(eq(drillCards.id, right.id));
      expect(again!.serveSeed).toBe(served!.serveSeed);
      seeds.add(served!.serveSeed!);
      await drill.answerCard(db, userId, right.id, { answer: "x", deviceClass: "fine" }, app.clock.now());
      app.clock.advance(30 * 86_400_000);
    }
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("resets a card whose answer key changed, and keeps one only reworded (ADR-041 §7)", async () => {
    const app = await appAt();
    const { seed, userId, right } = await oneStudent(app);
    const review = async () => {
      await drill.serveCard(db, userId, right.id, app.clock.now());
      await drill.answerCard(db, userId, right.id, { answer: "answer-q0", deviceClass: "fine" }, app.clock.now());
      return (await db.select().from(drillCards).where(eq(drillCards.id, right.id)))[0]!;
    };
    const publish = async (config: { statement: string; answer: string }) => {
      const [question] = await db.select().from(questions).where(eq(questions.id, seed.questionIds[0]!));
      await poolService.putDraft(db, question!, { config });
      await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    };
    expect((await review()).reps).toBe(1);

    await publish({ statement: "Reworded", answer: "answer-q0" });
    app.clock.advance(60 * 86_400_000);
    const kept = await review();
    expect(kept.reps).toBe(2);

    await publish({ statement: "Reworded", answer: "answer-q0-new" });
    app.clock.advance(365 * 86_400_000);
    const reset = await review();
    // Reset to new, then reviewed once: the first review of a new card.
    expect(reset.reps).toBe(1);
    expect(reset.keyHash).not.toBe(kept.keyHash);
  });
});

describe("the mcq of a review (06, question 28 (d), (h))", () => {
  it("shuffles the choices with each seed, and never serves the key before the answer", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    const { id } = await poolService.createQuestion(db, {
      poolId: seed.poolId,
      type: "mcq",
      internalName: "mcq-drill",
      createdBy: seed.teacherId,
    });
    const [question] = await db.select().from(questions).where(eq(questions.id, id));
    const choices = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    await poolService.putDraft(db, question!, {
      config: {
        configVersion: 2,
        prompt: "Pick the SECRET-ONE",
        choices: choices.map((text, i) => ({ text, correct: i === 2 })),
        mode: "single",
        policy: "inherit",
        shuffleChoices: true,
      },
    });
    await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
    const items = await evaluationService.addItems(
      db,
      await reload(db, seed.evaluationId),
      [id],
      points,
      { attemptCount: 0 },
    );
    await sit(
      app,
      { ...seed, itemIds: items.map((i) => i.id) },
      { answers: ["answer-q0", "wrong", { selected: [1] }] },
    );
    const userId = seed.studentIds[0]!;
    const [card] = await db
      .select()
      .from(drillCards)
      .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, id)));

    const orders = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const served = await drill.serveCard(db, userId, card!.id, app.clock.now());
      const student = served.student as { choices: { id: number; text: string }[] };
      expect(JSON.stringify(served)).not.toMatch(/"correct"|"solution"/);
      orders.add(student.choices.map((c) => c.id).join(","));
      const result = await drill.answerCard(
        db,
        userId,
        card!.id,
        { answer: { selected: [2] }, deviceClass: "fine" },
        app.clock.now(),
      );
      expect(result.correctness).toBe("right");
      expect(result.solution).toEqual({ correct: [2] });
      app.clock.set((await db.select().from(drillCards).where(eq(drillCards.id, card!.id)))[0]!.dueAt);
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe("the switches (ADR-041 §2, §6)", () => {
  it("keeps 'Allow drill' editable until the release, never on a poll", async () => {
    const app = await appAt();
    const seed = await world(app, { allowDrill: true });
    const evaluation = await sit(app, seed);
    // Closed, attempts taken: still editable.
    const off = await evaluationService.setAllowDrill(db, evaluation, false, app.clock.now());
    expect(evaluationService.drillAllowed(off)).toBe(false);
    await evaluationService.setAllowDrill(db, off, true, app.clock.now());
    await releaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    await expect(
      evaluationService.setAllowDrill(db, await reload(db, seed.evaluationId), false, app.clock.now()),
    ).rejects.toBeInstanceOf(evaluationService.AllowDrillLocked);
    await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, seed.evaluationId));
    await expect(
      evaluationService.setAllowDrill(db, await reload(db, seed.evaluationId), true, app.clock.now()),
    ).rejects.toBeInstanceOf(evaluationService.AllowDrillLocked);
  });

  it("keeps the first instant of an enablement and of an opt-out", async () => {
    const app = await appAt();
    const seed = await world(app);
    const first = await org.setClassroomDrill(db, seed.classroomId, true, new Date("2027-01-01T00:00:00Z"));
    expect(first!.toISOString()).toBe(T0);
    expect(await org.setClassroomDrill(db, seed.classroomId, false, app.clock.now())).toBeNull();
    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, seed.classroomId));
    expect(room!.drillEnabledAt).toBeNull();

    const userId = seed.studentIds[0]!;
    await org.setDrillOptOut(db, seed.classroomId, userId, true, app.clock.now());
    const again = await org.setDrillOptOut(db, seed.classroomId, userId, true, new Date("2027-01-01T00:00:00Z"));
    expect(again!.optedOutAt!.toISOString()).toBe(T0);
    expect(await org.setDrillOptOut(db, seed.classroomId, randomUUID(), true, app.clock.now())).toBeUndefined();
    const [seat] = await db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.userId, userId)));
    expect(seat!.drillOptedOutAt!.toISOString()).toBe(T0);
  });
});

describe("the third round (ADR-041 §13)", () => {
  const serves = async (app: App, userId: string, cardId: string) => {
    try {
      await drill.serveCard(db, userId, cardId, app.clock.now());
      return true;
    } catch (error) {
      if (error instanceof drill.DrillCardNotFound) return false;
      throw error;
    }
  };

  it("backfills a classroom's past evaluations when its drill is enabled, and again at a re-enable", async () => {
    const app = await appAt();
    const exam = await world(app, { allowDrill: true, enabled: false, students: 1 });
    await sit(app, exam, { release: true });
    // An exam not released yet, and one that does not allow drill: nothing.
    const hidden = await seedLive(db, { studentIds: exam.studentIds, questions: 1, teacherId: exam.teacherId });
    await db.update(evaluations).set({ classroomId: exam.classroomId }).where(eq(evaluations.id, hidden.evaluationId));
    await evaluationService.setAllowDrill(db, await reload(db, hidden.evaluationId), true, app.clock.now());
    await sit(app, { ...hidden, classroomId: exam.classroomId });
    const exercise = await evaluationService.createEvaluation(db, {
      classroomId: exam.classroomId,
      title: "Exercise",
      mode: "exercise",
      createdBy: exam.teacherId,
    });
    const items = await evaluationService.addItems(db, exercise, exam.questionIds, points, { attemptCount: 0 });
    await sit(app, { ...exam, evaluationId: exercise.id, itemIds: items.map((i) => i.id) });
    expect(await cardsOf({ userId: exam.studentIds[0]! })).toHaveLength(0);

    await org.setClassroomDrill(db, exam.classroomId, true, app.clock.now());
    expect(await drill.backfillClassroom(db, exam.classroomId, app.clock.now())).toBe(2);
    const cards = await cardsOf({ userId: exam.studentIds[0]! });
    // The exam came first: it is where the questions were met.
    expect(cards.map((c) => c.evaluationId)).toEqual([exam.evaluationId, exam.evaluationId]);

    await org.setClassroomDrill(db, exam.classroomId, false, app.clock.now());
    await org.setClassroomDrill(db, exam.classroomId, true, app.clock.now());
    expect(await drill.backfillClassroom(db, exam.classroomId, app.clock.now())).toBe(0);
  });

  it("serves an exercise's card only once its feedback policy shows the key", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    const policy = (await reload(db, seed.evaluationId)).feedbackPolicy as Record<string, unknown>;
    await db
      .update(evaluations)
      .set({ feedbackPolicy: { ...policy, when: "on_release", showKey: true } })
      .where(eq(evaluations.id, seed.evaluationId));
    await sit(app, seed);
    const userId = seed.studentIds[0]!;
    const [card] = await cardsOf({ userId });
    expect(await serves(app, userId, card!.id)).toBe(false);
    expect((await drill.drillSession(db, userId, "fine", app.clock.now())).cards).toEqual([]);
    await expect(
      drill.answerCard(db, userId, card!.id, { answer: "x", deviceClass: "fine" }, app.clock.now()),
    ).rejects.toBeInstanceOf(drill.DrillCardNotFound);

    const closed = await live.closeEvaluation(db, await reload(db, seed.evaluationId), app.clock.now());
    await releaseResults(db, closed, app.clock.now());
    expect(await serves(app, userId, card!.id)).toBe(true);

    // A key the exercise never shows is never shown by the drill.
    await db
      .update(evaluations)
      .set({ feedbackPolicy: { ...policy, when: "immediate", showKey: false } })
      .where(eq(evaluations.id, seed.evaluationId));
    expect((await drill.drillSession(db, userId, "fine", app.clock.now())).cards).toEqual([]);
  });

  it("serves an exercise's card once its correction is published (ADR-050 §6), never under `none`", async () => {
    const app = await appAt();
    /** A running exercise with retakes, one student, the key per `policy`. */
    const published = async (policy: Record<string, unknown>) => {
      const seed = await seedLive(db, {
        mode: "exercise",
        students: 1,
        questions: 1,
        durationS: null,
        settings: {
          timing: "manual",
          lobby: "skip",
          retakes: { enabled: true, keep: "best", maxAttempts: null },
        },
      });
      await org.setClassroomDrill(db, seed.classroomId, true, app.clock.now());
      const stored = (await reload(db, seed.evaluationId)).feedbackPolicy as Record<string, unknown>;
      await db
        .update(evaluations)
        .set({ feedbackPolicy: { ...stored, ...policy } })
        .where(eq(evaluations.id, seed.evaluationId));
      await sit(app, seed, { answers: ["wrong"] });
      const userId = seed.studentIds[0]!;
      const [card] = await cardsOf({ userId });
      // Retakes open, nothing published: the score only, and no card.
      expect(await serves(app, userId, card!.id)).toBe(false);
      await publishCorrection(db, await reload(db, seed.evaluationId), app.clock.now());
      return { seed, userId, card: card! };
    };

    const shown = await published({ when: "on_release", showKey: true });
    expect(await serves(app, shown.userId, shown.card.id)).toBe(true);
    const review = await drill.answerCard(
      db,
      shown.userId,
      shown.card.id,
      { answer: "wrong", deviceClass: "fine" },
      app.clock.now(),
    );
    expect(review.solution).toEqual({ answer: "answer-q0" });

    // A retake in progress holds the key back again, until it is handed in.
    app.clock.advance(30 * 86_400_000);
    const evaluation = await reload(db, shown.seed.evaluationId);
    const participant = (await live.participantOf(db, evaluation, shown.userId))!;
    const retake = await live.retakeAttempt(db, { evaluation, participant, now: app.clock.now() });
    expect(retake.state).toBe("in_progress");
    expect(await serves(app, shown.userId, shown.card.id)).toBe(false);
    expect((await drill.drillSession(db, shown.userId, "fine", app.clock.now())).cards).toEqual([]);
    await live.submitAttempt(db, await reload(db, shown.seed.evaluationId), retake, app.clock.now());
    expect(await serves(app, shown.userId, shown.card.id)).toBe(true);

    // `none`: the publication shows nothing, and the drill follows.
    const none = await published({ when: "none", showKey: true, showExplanation: true });
    expect(await serves(app, none.userId, none.card.id)).toBe(false);
    expect((await drill.drillSession(db, none.userId, "fine", app.clock.now())).cards).toEqual([]);
    await expect(
      drill.answerCard(db, none.userId, none.card.id, { answer: "x", deviceClass: "fine" }, app.clock.now()),
    ).rejects.toBeInstanceOf(drill.DrillCardNotFound);
  });

  it("suspends an exam's cards while its release is withdrawn, and serves them again at the next", async () => {
    const app = await appAt();
    const seed = await world(app, { allowDrill: true, students: 1 });
    await sit(app, seed, { release: true });
    const userId = seed.studentIds[0]!;
    const [card] = await cardsOf({ userId });
    await drill.serveCard(db, userId, card!.id, app.clock.now());
    await drill.answerCard(db, userId, card!.id, { answer: "x", deviceClass: "fine" }, app.clock.now());

    await unreleaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    app.clock.advance(30 * 86_400_000);
    expect(await serves(app, userId, card!.id)).toBe(false);
    expect((await drill.drillSession(db, userId, "fine", app.clock.now())).cards).toEqual([]);
    // History kept.
    expect(await db.select().from(drillReviews).where(eq(drillReviews.cardId, card!.id))).toHaveLength(1);

    await releaseResults(db, await reload(db, seed.evaluationId), app.clock.now());
    expect(await cardsOf({ userId })).toHaveLength(2);
    expect(await serves(app, userId, card!.id)).toBe(true);
  });

  it("makes cards of the questions left unanswered", async () => {
    const app = await appAt();
    const seed = await world(app, { mode: "exercise", students: 1 });
    await sit(app, seed, { blank: true });
    const cards = await cardsOf({ userId: seed.studentIds[0]! });
    expect(new Set(cards.map((c) => c.questionId))).toEqual(new Set(seed.questionIds));
  });
});
