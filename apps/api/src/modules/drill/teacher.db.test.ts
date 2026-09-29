/**
 * The teacher's view of the drill (ADR-041 §8, #317 slice 4), over HTTP and
 * the real migrations: who reaches it (invariant 6), the contracts
 * (invariant 7), and each rule of the view — the classroom's cards only
 * (06, question 28 (j)), nothing counted after an opt-out while what came
 * before stays (28 (k)), the opt-out's date (§13, item 5), the recall rate
 * on repeated reviews (§10, item 8), the Zurich days, the weekly buckets and
 * the mastery per tag.
 *
 * The cards are created by the production hooks (an exercise handed in).
 * The REVIEWS are written as rows at chosen instants: the view reads
 * history spread over weeks, which the serving rule (one review per card and
 * day, today's session only) would take a week of clock juggling per row to
 * produce, and it reads nothing but those rows.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrillProgress, DrillStudentActivity, DrillTagMastery } from "@quiz/contracts";
import { drillRecallCounts, type DrillReviewFact } from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";
import { registerForTests } from "@quiz/registry/server";

import { classrooms, drillCards, drillReviews, enrollments, questionTags } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { setDrillOptOut } from "../org/service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let other: Seeded;
let teacher: Session;
let stranger: Session;
let alice: Session;
let bob: Session;
let carol: Session;

/** A Monday: the drill is enabled and the exercise handed in then. */
const T0 = "2026-10-05T07:00:00.000Z";
/** When the teacher reads the view. */
const NOW = "2026-11-20T10:00:00.000Z";

const get = (url: string, who: Session) => server.app.inject({ method: "GET", url, headers: who.headers });
const base = () => `/app/api/classrooms/${seed.classroomId}/drill`;

/** Every student of `s` hands its exercise in: the live module's hook creates the cards. */
async function handIn(s: Seeded) {
  const db = server.app.db;
  const evaluation = await applyState(db, await reload(db, s.evaluationId), "running", server.clock.now());
  for (const userId of s.studentIds) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, server.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, server.clock.now());
    await live.submitAttempt(db, evaluation, attempt, server.clock.now());
  }
}

async function cardOf(s: Seeded, userId: string, question: number) {
  const [card] = await server.app.db
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, s.questionIds[question]!)));
  return card!;
}

/** Every review written, for the reference definition of the recall rate. */
const written: (DrillReviewFact & { userId: string })[] = [];

async function review(s: Seeded, userId: string, question: number, at: string, rating: number) {
  const card = await cardOf(s, userId, question);
  const reviewedAt = new Date(at);
  await server.app.db.insert(drillReviews).values({
    id: randomUUID(),
    cardId: card.id,
    rating,
    correctness: rating === 1 ? "wrong" : "right",
    elapsedMs: 20_000,
    deviceClass: "fine",
    reviewedAt,
  });
  if (s === seed) written.push({ cardId: card.id, reviewedAt, rating, userId });
}

async function activity(who: Session = teacher) {
  const res = await get(`${base()}/activity`, who);
  expect(res.statusCode).toBe(200);
  return (res.json() as unknown[]).map((r) => DrillStudentActivity.parse(r));
}
const rowOf = (rows: DrillStudentActivity[], index: number) => rows.find((r) => r.nom === `Nom${index}`)!;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set(T0);
  teacher = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  alice = await server.signIn("student");
  bob = await server.signIn("student");
  carol = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [alice.id, bob.id, carol.id],
    mode: "exercise",
    questions: 2,
  });
  // Alice sits another classroom of the same teacher: its cards are its own (28 (j)).
  other = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [alice.id], mode: "exercise", questions: 1 });
  for (const s of [seed, other]) {
    const on = await server.app.inject({
      method: "PUT",
      url: `/app/api/classrooms/${s.classroomId}/drill`,
      headers: teacher.headers,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    await handIn(s);
  }

  // Alice: q0 on 6 Oct (first), 12 Oct (Again), 18 Nov; q1 on 7 Oct (first, Again), 19 Nov.
  await review(seed, alice.id, 0, "2026-10-06T08:00:00Z", 3);
  await review(seed, alice.id, 1, "2026-10-07T08:00:00Z", 1);
  await review(seed, alice.id, 0, "2026-10-12T08:00:00Z", 1);
  await review(seed, alice.id, 0, "2026-11-18T08:00:00Z", 3);
  await review(seed, alice.id, 1, "2026-11-19T08:00:00Z", 4);
  // Her card of the other classroom: never in this one's view.
  await review(other, alice.id, 0, "2026-11-19T09:00:00Z", 1);
  await review(other, alice.id, 0, "2026-11-20T09:00:00Z", 1);

  // Bob: 08:00 UTC on 6 Oct, then 22:30 UTC the same day — already 7 Oct in Zurich.
  await review(seed, bob.id, 0, "2026-10-06T08:00:00Z", 3);
  await review(seed, bob.id, 1, "2026-10-06T22:30:00Z", 3);

  // Carol: two reviews, an opt-out on 20 Oct, then a review after it.
  await review(seed, carol.id, 0, "2026-10-06T08:00:00Z", 3);
  await review(seed, carol.id, 0, "2026-10-13T08:00:00Z", 3);
  await setDrillOptOut(server.app.db, seed.classroomId, carol.id, true, new Date("2026-10-20T12:00:00Z"));
  await review(seed, carol.id, 1, "2026-10-27T08:00:00Z", 3);

  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("the teacher's view of the drill: access", () => {
  it("is the classroom staff's alone: another teacher gets a 404, a student a 403", async () => {
    for (const path of ["activity", "progress", "mastery"]) {
      expect((await get(`${base()}/${path}`, stranger)).statusCode).toBe(404);
      expect((await get(`${base()}/${path}`, alice)).statusCode).toBe(403);
      expect((await get(`${base()}/${path}`, teacher)).statusCode).toBe(200);
    }
    expect((await get(`/app/api/classrooms/${randomUUID()}/drill/activity`, teacher)).statusCode).toBe(404);
  });

  it("reaches a student's progression only through a seat of this classroom", async () => {
    const [foreign] = await server.app.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.classroomId, other.classroomId));
    expect((await get(`${base()}/progress?student=${foreign!.id}`, teacher)).statusCode).toBe(404);
    expect((await get(`${base()}/progress?student=${randomUUID()}`, teacher)).statusCode).toBe(404);
    expect((await get(`${base()}/progress?student=nope`, teacher)).statusCode).toBe(400);
    const [seat] = await server.app.db.select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId));
    expect((await get(`${base()}/progress?student=${seat!.id}`, stranger)).statusCode).toBe(404);
  });
});

describe("the teacher's view of the drill: activity", () => {
  it("lists every student seat, with this classroom's cards only (28 (j))", async () => {
    const rows = await activity();
    expect(rows.map((r) => r.nom)).toEqual(["Nom0", "Nom1", "Nom2"]);
    const a = rowOf(rows, 0);
    expect(a).toMatchObject({
      questionsSeen: 2,
      sessions: 5,
      lastReviewAt: "2026-11-19T08:00:00.000Z",
      reviews: { last7: 2, last30: 2, all: 5 },
      optedOutAt: null,
    });
  });

  it("counts the recall rate on repeated reviews, the first of each card left out", async () => {
    const a = rowOf(await activity(), 0);
    expect(a.recall).toEqual({
      last30: { repeated: 2, recalled: 2 },
      previous30: { repeated: 1, recalled: 0 },
      all: { repeated: 3, recalled: 2 },
    });
    // The SQL and the reference definition of `@quiz/domain` agree, window by window.
    const now = new Date(NOW).getTime();
    const mine = written.filter((r) => r.userId === alice.id);
    const days = (n: number) => now - n * 86_400_000;
    expect(drillRecallCounts(mine)).toEqual(a.recall.all);
    expect(drillRecallCounts(mine, (r) => r.reviewedAt.getTime() >= days(30))).toEqual(a.recall.last30);
    expect(
      drillRecallCounts(mine, (r) => r.reviewedAt.getTime() >= days(60) && r.reviewedAt.getTime() < days(30)),
    ).toEqual(a.recall.previous30);
  });

  it("counts sessions as days on the Zurich clock", async () => {
    const b = rowOf(await activity(), 1);
    expect(b).toMatchObject({ questionsSeen: 2, sessions: 2, recall: { all: { repeated: 0, recalled: 0 } } });
  });

  it("shows the opt-out with its date, and hides what came after it while what came before stays (28 (k))", async () => {
    const c = rowOf(await activity(), 2);
    expect(c).toMatchObject({
      optedOutAt: "2026-10-20T12:00:00.000Z",
      questionsSeen: 1,
      sessions: 2,
      lastReviewAt: "2026-10-13T08:00:00.000Z",
      reviews: { all: 2 },
      recall: { all: { repeated: 1, recalled: 1 } },
    });
  });

  it("answers a classroom without any review with zeros, not missing rows", async () => {
    const res = await get(`/app/api/classrooms/${other.classroomId}/drill/activity`, teacher);
    const [row] = (res.json() as unknown[]).map((r) => DrillStudentActivity.parse(r));
    expect(row).toMatchObject({ questionsSeen: 1, reviews: { all: 2 } });
  });
});

describe("the teacher's view of the drill: progression", () => {
  async function progress(query = "") {
    const res = await get(`${base()}/progress${query}`, teacher);
    expect(res.statusCode).toBe(200);
    return DrillProgress.parse(res.json()).weeks;
  }

  it("buckets one student's reviews by Zurich week, every week of the drill's span included", async () => {
    const [seat] = await server.app.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.userId, alice.id)));
    const weeks = await progress(`?student=${seat!.id}`);
    // No dated period: from the week the drill was enabled to this one.
    expect(weeks.map((w) => w.weekStart)).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
    expect(weeks[0]).toEqual({
      weekStart: "2026-10-05",
      reviews: 2,
      sessions: 2,
      questions: 2,
      students: 1,
      recall: { repeated: 0, recalled: 0 },
    });
    expect(weeks[1]).toMatchObject({ reviews: 1, recall: { repeated: 1, recalled: 0 } });
    expect(weeks[2]).toMatchObject({ reviews: 0, students: 0 });
    expect(weeks[6]).toMatchObject({ reviews: 2, recall: { repeated: 2, recalled: 2 } });
  });

  it("sums the whole classroom without `student`, the opted-out review left out", async () => {
    const weeks = await progress();
    // Week of 5 Oct: Alice 2, Bob 2 (both days), Carol 1.
    expect(weeks[0]).toMatchObject({ reviews: 5, sessions: 5, students: 3 });
    // Week of 26 Oct: only Carol's review after her opt-out, which is hidden.
    expect(weeks[3]).toMatchObject({ reviews: 0 });
  });

  it("spans the classroom's dated period when it has one", async () => {
    await server.app.db
      .update(classrooms)
      .set({ periodStart: "2026-09", periodEnd: "2027-01" })
      .where(eq(classrooms.id, seed.classroomId));
    const weeks = await progress();
    expect(weeks[0]!.weekStart).toBe("2026-08-31");
    expect(weeks.at(-1)!.weekStart).toBe("2026-11-16");
    await server.app.db
      .update(classrooms)
      .set({ periodStart: null, periodEnd: null })
      .where(eq(classrooms.id, seed.classroomId));
  });
});

describe("the teacher's view of the drill: mastery per tag", () => {
  it("means the retrievability of the classroom's reviewed cards per tag, weakest first", async () => {
    const db = server.app.db;
    await db.insert(questionTags).values([
      { questionId: seed.questionIds[0]!, tag: "pointers" },
      { questionId: seed.questionIds[1]!, tag: "loops" },
      { questionId: other.questionIds[0]!, tag: "pointers" },
    ]);
    // The state the scheduler left: q0 strong for Alice, weak for Bob; q1 reviewed by Alice only.
    const state = async (s: Seeded, userId: string, q: number, stability: number, at: string | null) => {
      const card = await cardOf(s, userId, q);
      await db
        .update(drillCards)
        .set({ stability, difficulty: 5, reps: 2, lastReviewAt: at === null ? null : new Date(at) })
        .where(eq(drillCards.id, card.id));
      return { ...card, stability, difficulty: 5, reps: 2, lastReviewAt: at === null ? null : new Date(at) };
    };
    const now = new Date(NOW);
    const r = (card: Awaited<ReturnType<typeof state>>) => drillRetrievability(card, now);
    const a0 = await state(seed, alice.id, 0, 30, "2026-11-18T08:00:00Z");
    const b0 = await state(seed, bob.id, 0, 2, "2026-10-06T08:00:00Z");
    const a1 = await state(seed, alice.id, 1, 10, "2026-11-19T08:00:00Z");
    await state(seed, bob.id, 1, 5, null); // never reviewed: not in the mean
    await state(other, alice.id, 0, 1, "2026-11-20T09:00:00Z"); // another classroom's card (28 (j))

    const res = await get(`${base()}/mastery`, teacher);
    expect(res.statusCode).toBe(200);
    const tags = (res.json() as unknown[]).map((t) => DrillTagMastery.parse(t));
    const pointers = tags.find((t) => t.tag === "pointers")!;
    const loops = tags.find((t) => t.tag === "loops")!;
    expect(pointers).toMatchObject({ cards: 2, students: 2 });
    expect(pointers.retrievability).toBeCloseTo((r(a0) + r(b0)) / 2, 6);
    expect(loops).toMatchObject({ cards: 1, students: 1 });
    expect(loops.retrievability).toBeCloseTo(r(a1), 6);
    // Every question is tagged: no `null` entry.
    expect(tags.map((t) => t.tag)).toEqual(["pointers", "loops"]);
  });
});
