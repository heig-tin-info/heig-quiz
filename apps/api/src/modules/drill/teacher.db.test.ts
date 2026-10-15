/**
 * The teacher's view of the drill (ADR-041 §8, #317 slice 4), over HTTP and
 * the real migrations: who reaches it (invariant 6), the contracts
 * (invariant 7), and each rule of the view — the classroom's cards only
 * (06, question 28 (j)), nothing counted after an opt-out while what came
 * before stays (28 (k)), the opt-out's date (§13, item 5), the recall rate
 * on repeated reviews (§10, item 8), the Zurich days, the weekly buckets,
 * the hours of the week (amendment of 2026-10-14) and the mastery per
 * concept.
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

import { DrillClassroomMastery, DrillClassroomRevision, DrillHours, DrillProgress, DrillStudentActivity } from "@quiz/contracts";
import { drillRecallCounts, type DrillReviewFact } from "@quiz/domain";
import { drillRetrievability } from "@quiz/domain/drillSchedule";
import { registerForTests } from "@quiz/registry/server";

import { classrooms, conceptRelations, concepts, courseStaff, drillCards, drillReviews, drillRevisionRounds, enrollments, evaluations, questionConcepts } from "../../db/schema.js";
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
  // A dated period, September to January: its weeks span it.
  await server.app.db
    .update(classrooms)
    .set({ periodStart: "2026-09", periodEnd: "2027-01" })
    .where(eq(classrooms.id, other.classroomId));
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
  // Another teacher's 404 and a student's 403: `accessSweep.db.test.ts`.
  it("is served to the classroom's staff, and a 404 for an unknown classroom", async () => {
    const [seat] = await server.app.db.select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId));
    for (const path of ["activity", `progress?student=${seat!.id}`, "mastery"]) {
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
    expect((await get(`${base()}/progress`, teacher)).statusCode).toBe(400);
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
      reviews: { last30: 2, all: 5 },
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
  async function weeksOf(s: Seeded, userId: string) {
    const [seat] = await server.app.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, s.classroomId), eq(enrollments.userId, userId)));
    const res = await get(`/app/api/classrooms/${s.classroomId}/drill/progress?student=${seat!.id}`, teacher);
    expect(res.statusCode).toBe(200);
    return DrillProgress.parse(res.json()).weeks;
  }

  it("buckets one student's reviews by Zurich week, every week of the drill's span included", async () => {
    const weeks = await weeksOf(seed, alice.id);
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
    expect(weeks[0]).toEqual({ weekStart: "2026-10-05", reviews: 2, recall: { repeated: 0, recalled: 0 } });
    expect(weeks[1]).toEqual({ weekStart: "2026-10-12", reviews: 1, recall: { repeated: 1, recalled: 0 } });
    expect(weeks[2]).toMatchObject({ reviews: 0 });
    expect(weeks[6]).toMatchObject({ reviews: 2, recall: { repeated: 2, recalled: 2 } });
  });

  it("leaves out the weeks after an opt-out, the ones before kept (28 (k))", async () => {
    const weeks = await weeksOf(seed, carol.id);
    expect(weeks[0]).toMatchObject({ reviews: 1 });
    expect(weeks[1]).toMatchObject({ reviews: 1, recall: { repeated: 1, recalled: 1 } });
    // Week of 26 Oct: only her review after the opt-out, which is hidden.
    expect(weeks[3]).toMatchObject({ weekStart: "2026-10-26", reviews: 0 });
  });

  it("spans the classroom's dated period when it has one", async () => {
    // `other` is dated September to January: from the week of 1 September to this one.
    const weeks = await weeksOf(other, alice.id);
    expect(weeks[0]!.weekStart).toBe("2026-08-31");
    expect(weeks.at(-1)).toMatchObject({ weekStart: "2026-11-16", reviews: 2 });
  });
});

describe("the teacher's view of the drill: mastery per concept", () => {
  it("means the retrievability of the classroom's reviewed cards per concept, weakest first, in the reader's language", async () => {
    const db = server.app.db;
    const [pointersId, loopsId] = [randomUUID(), randomUUID()];
    const at = new Date(NOW);
    await db.insert(concepts).values([
      { id: pointersId, status: "validated", labelFr: "pointeurs", keyFr: "pointeur", labelEn: "pointers", keyEn: "pointer", createdAt: at, updatedAt: at },
      { id: loopsId, status: "proposed", labelEn: "loops", keyEn: "loop", createdAt: at, updatedAt: at },
    ]);
    await db.insert(questionConcepts).values([
      { questionId: seed.questionIds[0]!, conceptId: pointersId },
      { questionId: seed.questionIds[1]!, conceptId: loopsId },
      { questionId: other.questionIds[0]!, conceptId: pointersId },
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

    const res = await get(`${base()}/mastery`, { ...teacher, headers: { ...teacher.headers, "accept-language": "fr" } });
    expect(res.statusCode).toBe(200);
    const body = DrillClassroomMastery.parse(res.json());
    // The course lists no concept: the flat view of today, with its hint on the client.
    expect(body).toMatchObject({ declared: false, outside: null });
    const rows = body.concepts;
    const pointers = rows.find((t) => t.concept?.id === pointersId)!;
    const loops = rows.find((t) => t.concept?.id === loopsId)!;
    // French for the reader; a concept without a French label falls back to English.
    expect(pointers.concept).toMatchObject({ label: "pointeurs", status: "validated" });
    expect(loops.concept).toMatchObject({ label: "loops", status: "proposed" });
    expect(pointers).toMatchObject({ cards: 2, students: 2 });
    expect(pointers.retrievability).toBeCloseTo((r(a0) + r(b0)) / 2, 6);
    expect(loops).toMatchObject({ cards: 1, students: 1 });
    expect(loops.retrievability).toBeCloseTo(r(a1), 6);
    // Every question has a concept: no `null` entry.
    expect(rows.map((t) => t.concept?.id)).toEqual([pointersId, loopsId]);
  });

  const putConcepts = (ids: string[], who: Session = teacher) =>
    server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${seed.courseId}/concepts`,
      headers: who.headers,
      payload: { conceptIds: ids },
    });
  const mastery = async (lang = "en", who: Session = teacher) => {
    const res = await get(`${base()}/mastery`, { ...who, headers: { ...who.headers, "accept-language": lang } });
    expect(res.statusCode).toBe(200);
    return DrillClassroomMastery.parse(res.json());
  };

  it("counts a card toward every listed concept that covers it, shows an unexercised one as no evidence, and gathers the rest outside", async () => {
    const db = server.app.db;
    const at = new Date(NOW);
    const [pointers, loops] = (await db.select().from(concepts)).filter((c) => c.keyEn === "pointer" || c.keyEn === "loop");
    const memoryId = randomUUID();
    const idleId = randomUUID();
    await db.insert(concepts).values([
      { id: memoryId, status: "validated", labelEn: "memory", keyEn: "memory", createdAt: at, updatedAt: at },
      { id: idleId, status: "validated", labelEn: "idle", keyEn: "idle", createdAt: at, updatedAt: at },
    ]);
    // q0 carries pointers (listed) and memory (listed): it counts toward both.
    await db.insert(questionConcepts).values({ questionId: seed.questionIds[0]!, conceptId: memoryId });
    expect((await putConcepts([pointers!.id, memoryId, idleId])).statusCode).toBe(200);

    const body = await mastery("fr");
    expect(body.declared).toBe(true);
    const byId = new Map(body.concepts.map((c) => [c.concept!.id, c]));
    expect(byId.get(pointers!.id)).toMatchObject({ cards: 2, students: 2 });
    expect(byId.get(memoryId)).toMatchObject({ cards: 2, students: 2 });
    expect(byId.get(memoryId)!.retrievability).toBeCloseTo(byId.get(pointers!.id)!.retrievability!, 9);
    // Listed, exercised by nothing: no evidence, last.
    expect(byId.get(idleId)).toMatchObject({ cards: 0, students: 0, retrievability: null });
    expect(body.concepts.at(-1)!.concept!.id).toBe(idleId);
    // Labels in the reader's language.
    expect(byId.get(pointers!.id)!.concept!.label).toBe("pointeurs");
    // q1 (loops, not listed) is outside, once; the rest of the class is not.
    expect(body.outside).toMatchObject({ cards: 1, students: 1 });
    expect(body.outside!.concepts.map((c) => c.concept?.id)).toEqual([loops!.id]);
    expect(body.outside!.concepts[0]).toMatchObject({ cards: 1, students: 1 });
  });

  it("puts a card whose question has no concept outside, and no outside bucket when nothing is", async () => {
    const db = server.app.db;
    const [q1] = [seed.questionIds[1]!];
    await db.delete(questionConcepts).where(eq(questionConcepts.questionId, q1));
    const body = await mastery();
    expect(body.outside).toMatchObject({ cards: 1 });
    expect(body.outside!.concepts).toEqual([expect.objectContaining({ concept: null, cards: 1 })]);
    // Attach it to a listed concept: nothing is left outside.
    const [first] = body.concepts;
    await db.insert(questionConcepts).values({ questionId: q1, conceptId: first!.concept!.id });
    expect((await mastery()).outside).toBeNull();
  });

  it("leaves out a suspended card (the evaluation no longer shows its key)", async () => {
    const db = server.app.db;
    const [before] = await db.select().from(evaluations).where(eq(evaluations.id, seed.evaluationId));
    try {
      await db
        .update(evaluations)
        .set({ feedbackPolicy: { ...(before!.feedbackPolicy as object), showKey: false } })
        .where(eq(evaluations.id, seed.evaluationId));
      const body = await mastery();
      expect(body.concepts.every((c) => c.cards === 0 && c.retrievability === null)).toBe(true);
      expect(body.outside).toBeNull();
    } finally {
      await db.update(evaluations).set({ feedbackPolicy: before!.feedbackPolicy }).where(eq(evaluations.id, seed.evaluationId));
    }
    expect((await mastery()).concepts.some((c) => c.cards > 0)).toBe(true);
  });

  it("counts a card of a narrower concept toward the listed broader one, which then leaves the outside (7d)", async () => {
    const db = server.app.db;
    const at = new Date(NOW);
    const loops = (await db.select().from(concepts)).find((c) => c.keyEn === "loop")!;
    const parentId = randomUUID();
    await db.insert(concepts).values({ id: parentId, status: "validated", labelEn: "control", keyEn: "control", createdAt: at, updatedAt: at });
    await db.insert(questionConcepts).values({ questionId: seed.questionIds[1]!, conceptId: loops.id }).onConflictDoNothing();
    await db.insert(conceptRelations).values({ conceptId: loops.id, targetId: parentId, kind: "broader" });
    expect((await putConcepts([parentId])).statusCode).toBe(200);

    const body = await mastery();
    // q1 carries loops, narrower than the listed concept: its one card counts there.
    expect(body.concepts.find((c) => c.concept!.id === parentId)).toMatchObject({ cards: 1, students: 1 });
    // The loops are covered, so no longer outside; q0's pointers still are.
    expect(body.outside!.concepts.map((c) => c.concept?.id)).not.toContain(loops.id);
    await db.delete(conceptRelations).where(eq(conceptRelations.targetId, parentId));
  });
});

describe("the teacher's view of the drill: hours of the week", () => {
  /** Monday first: 0 Monday … 6 Sunday, as the grid's rows. */
  const [WED, THU, SAT] = [2, 3, 5];

  async function seatOf(s: Seeded, userId: string) {
    const [seat] = await server.app.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, s.classroomId), eq(enrollments.userId, userId)));
    return seat!.id;
  }
  async function hours(query = "", who: Session = teacher) {
    const res = await get(`${base()}/hours${query}`, who);
    expect(res.statusCode).toBe(200);
    return DrillHours.parse(res.json());
  }
  /** The non-empty cells, as `weekday/hour: n`. */
  const cells = (h: DrillHours) =>
    Object.fromEntries(h.days.flatMap((row, d) => row.flatMap((n, hour) => (n > 0 ? [[`${d}/${hour}`, n]] : []))));

  beforeAll(async () => {
    // The window is NOW minus 30 days: from 2026-10-21T10:00Z. Alice already
    // has Wed 18 Nov and Thu 19 Nov at 08:00Z (09:00 in Zurich, CET).
    await review(seed, alice.id, 0, "2026-11-11T08:15:00Z", 3); // Wed 09:15: her second review of that slot
    await review(seed, bob.id, 0, "2026-11-18T08:30:00Z", 3); // Wed 09:30: a second student in it
    // Fri 23 Oct 22:30Z is Sat 00:30 in Zurich on summer time (+02:00), the
    // last weekend of it; on winter time it would be Fri 23:30.
    await review(seed, bob.id, 1, "2026-10-23T22:30:00Z", 3);
    await review(seed, bob.id, 1, "2026-10-21T11:00:00Z", 3); // Wed 13:00, inside the window
    await review(seed, bob.id, 1, "2026-10-21T09:00:00Z", 3); // an hour before it: out
    // Carol opted out on 20 Oct: a review now is not counted (28 (k)).
    await review(seed, carol.id, 1, "2026-11-18T08:45:00Z", 3);
  });

  it("is served to the classroom's staff only, one student through a seat of this classroom", async () => {
    expect((await get(`${base()}/hours`, stranger)).statusCode).toBe(404);
    const seat = await seatOf(seed, alice.id);
    expect((await get(`${base()}/hours?student=${seat}`, stranger)).statusCode).toBe(404);
    expect((await get(`${base()}/hours?student=${await seatOf(other, alice.id)}`, teacher)).statusCode).toBe(404);
    expect((await get(`${base()}/hours?student=${randomUUID()}`, teacher)).statusCode).toBe(404);
    expect((await get(`${base()}/hours?student=nope`, teacher)).statusCode).toBe(400);
    expect((await get(`/app/api/classrooms/${randomUUID()}/drill/hours`, teacher)).statusCode).toBe(404);
  });

  it("is served to an assistant of the course, for the class and for one student", async () => {
    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
    expect((await get(`${base()}/hours`, assistant)).statusCode).toBe(200);
    expect((await get(`${base()}/hours?student=${await seatOf(seed, bob.id)}`, assistant)).statusCode).toBe(200);
  });

  it("counts the distinct students of each Zurich weekday and hour over the last 30 days", async () => {
    const h = await hours();
    expect(h.since).toBe("2026-10-21");
    expect(cells(h)).toEqual({ [`${WED}/9`]: 2, [`${THU}/9`]: 1, [`${SAT}/0`]: 1, [`${WED}/13`]: 1 });
    expect(h.offHoursShare).toBeCloseTo(1 / 5, 9);
  });

  it("counts one student's reviews, in the same unit for the share", async () => {
    const a = await hours(`?student=${await seatOf(seed, alice.id)}`);
    expect(cells(a)).toEqual({ [`${WED}/9`]: 2, [`${THU}/9`]: 1 });
    expect(a.offHoursShare).toBe(0);
    const b = await hours(`?student=${await seatOf(seed, bob.id)}`);
    expect(cells(b)).toEqual({ [`${WED}/9`]: 1, [`${SAT}/0`]: 1, [`${WED}/13`]: 1 });
    expect(b.offHoursShare).toBeCloseTo(1 / 3, 9);
  });

  it("leaves out what came after an opt-out (28 (k)), and answers an empty grid with a null share", async () => {
    const c = await hours(`?student=${await seatOf(seed, carol.id)}`);
    expect(c.offHoursShare).toBeNull();
    expect(c.days.flat().every((n) => n === 0)).toBe(true);
  });
});

describe("the teacher's view of the drill: who revised (ADR-115)", () => {
  const ARRAYS = randomUUID();
  const PROPOSED = randomUUID();
  const MERGED = randomUUID();

  async function seat(s: Seeded, userId: string) {
    const [row] = await server.app.db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, s.classroomId), eq(enrollments.userId, userId)));
    return row!.id;
  }
  /** A round as the student's answers leave it: the view reads nothing else. */
  async function round(s: Seeded, userId: string, conceptId: string | null, at: string, cardsServed = 1) {
    await server.app.db.insert(drillRevisionRounds).values({
      id: randomUUID(),
      userId,
      classroomId: s.classroomId,
      conceptId,
      cardIds: [randomUUID(), randomUUID(), randomUUID()],
      startedAt: new Date(at),
      cardsServed,
      cardsCorrect: Math.min(1, cardsServed),
    });
  }

  beforeAll(async () => {
    const at = new Date(T0);
    const concept = (id: string, status: "validated" | "proposed", label: string) => ({
      id,
      status,
      labelEn: label,
      keyEn: label.toLowerCase(),
      createdAt: at,
      updatedAt: at,
    });
    await server.app.db.insert(concepts).values([
      concept(ARRAYS, "validated", "Arrays revised"),
      concept(PROPOSED, "proposed", "Proposed revised"),
      concept(MERGED, "validated", "Merged revised"),
    ]);
    // Alice: two rounds on Arrays, one on a concept merged into it since.
    await round(seed, alice.id, ARRAYS, "2026-11-10T08:00:00Z", 3);
    await round(seed, alice.id, ARRAYS, "2026-11-12T08:00:00Z");
    await round(seed, alice.id, MERGED, "2026-11-11T08:00:00Z");
    await server.app.db.update(concepts).set({ status: "merged", mergedInto: ARRAYS }).where(eq(concepts.id, MERGED));
    // Her round in the other classroom: never in this one's view.
    await round(other, alice.id, ARRAYS, "2026-11-19T08:00:00Z");
    // Bob: a proposed concept, a deleted one, and a round started with nothing answered.
    await round(seed, bob.id, PROPOSED, "2026-11-15T08:00:00Z");
    await round(seed, bob.id, null, "2026-11-16T08:00:00Z");
    await round(seed, bob.id, ARRAYS, "2026-11-18T08:00:00Z", 0);
    // Carol: one round before her opt-out of 20 Oct, one after it.
    await round(seed, carol.id, ARRAYS, "2026-10-15T08:00:00Z");
    await round(seed, carol.id, ARRAYS, "2026-11-01T08:00:00Z");
  });

  it("counts each student's rounds with a card answered and names their concepts, a merge followed, nothing after an opt-out", async () => {
    const res = await get(`${base()}/revision`, teacher);
    expect(res.statusCode).toBe(200);
    const view = DrillClassroomRevision.parse(res.json());
    const arrays = { id: ARRAYS, label: "Arrays revised", qualifier: "", status: "validated" };
    const proposed = { id: PROPOSED, label: "Proposed revised", qualifier: "", status: "proposed" };
    expect(view.students).toEqual([
      { enrollmentId: await seat(seed, bob.id), rounds: 2, lastAt: "2026-11-16T08:00:00.000Z", concepts: [proposed] },
      { enrollmentId: await seat(seed, alice.id), rounds: 3, lastAt: "2026-11-12T08:00:00.000Z", concepts: [arrays] },
      { enrollmentId: await seat(seed, carol.id), rounds: 1, lastAt: "2026-10-15T08:00:00.000Z", concepts: [arrays] },
    ]);
    expect(view.concepts).toEqual([
      { concept: arrays, students: 2, rounds: 4, lastAt: "2026-11-12T08:00:00.000Z" },
      { concept: proposed, students: 1, rounds: 1, lastAt: "2026-11-15T08:00:00.000Z" },
      { concept: null, students: 1, rounds: 1, lastAt: "2026-11-16T08:00:00.000Z" },
    ]);
    expect(res.body).not.toMatch(/cardIds|cardsServed|cardsCorrect|questionId/);
  });

  it("is served to the classroom's staff only", async () => {
    expect((await get(`${base()}/revision`, stranger)).statusCode).toBe(404);
    expect((await get(`${base()}/revision`, alice)).statusCode).toBe(403);
    expect((await get(`/app/api/classrooms/${randomUUID()}/drill/revision`, teacher)).statusCode).toBe(404);
  });
});
