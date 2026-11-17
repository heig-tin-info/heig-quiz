/**
 * A teacher's staff seat drills its own cards (ADR-018, amended 2026-11-17;
 * ADR-041), over HTTP and the real migrations.
 *
 * What is lifted: the seat's cards come at a hand-in and at a release —
 * never from a backfill of the past — and the student reads open to their
 * owner: the session and a review, the classrooms and the opt-out, the
 * calibration, the concept mastery, targeted revision.
 *
 * What is not, on the seat's CURRENT flag: every class read of the teacher's
 * drill view — the activity, the class mastery, the confidence per question
 * (F-STAT-06), who revised (ADR-115 §9). Each is checked twice: with the seat
 * staff (out), then with the same rows on a student seat (in), so the test
 * would see a leak. The leak test of 05 §5.7 for the mastery exit holds for
 * the seat's own cards: the course's validated concepts only.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrillCalibrationLevel, DrillClassroom, DrillSession, RevisionRoundStart, StudentConceptMastery, StudentRevisionRound } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { concepts, drillCards, drillReviews, enrollments, questionConcepts } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { handIn, publishQuestion, reload, seedLive, type Seeded } from "../../test/live.js";
import { addItems, applyState, byId, createEvaluation, setAllowDrill } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import { releaseResults } from "../results/service.js";
import { classroomActivity, classroomConfidence, classroomMastery, classroomRevision } from "./service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let teacher: Session;
/** Nine students: one under the threshold of F-STAT-06, which the seat would cross. */
let students: Session[];
let seatId: string;

const T0 = "2026-11-17T08:00:00.000Z";
const NOW = "2026-11-20T10:00:00.000Z";
const ids = { solid: randomUUID(), proposed: randomUUID(), foreign: randomUUID() };
const LABELS = { solid: "Pointers", proposed: "Proposed secret label", foreign: "Foreign secret label" };

const db = () => server.app.db;
const inject = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

const cardsOf = (userId: string, classroomId = seed.classroomId) =>
  db()
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, userId), eq(drillCards.classroomId, classroomId)));

/** The seat as a staff one (ADR-018), or — to prove a read would see it — a student one. */
const seatIsStaff = (staff: boolean) => db().update(enrollments).set({ staff }).where(eq(enrollments.id, seatId));

/** What a class read gives with the seat staff, and with the same rows on a student seat. */
async function bothWays<T>(read: () => Promise<T>): Promise<{ staff: T; student: T }> {
  const staff = await read();
  await seatIsStaff(false);
  try {
    return { staff, student: await read() };
  } finally {
    await seatIsStaff(true);
  }
}

let minute = 0;
/** A stated review of `userId`'s card on question `question`, as the drill leaves it. */
async function review(userId: string, question: number, confidence: number) {
  const [card] = await db()
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, seed.questionIds[question]!)));
  await db().insert(drillReviews).values({
    id: randomUUID(),
    cardId: card!.id,
    rating: 1,
    correctness: "wrong",
    confidence,
    elapsedMs: 20_000,
    deviceClass: "fine",
    reviewedAt: new Date(Date.parse(T0) + ++minute * 60_000),
  });
}

/** Every card of `userId` on the course concept's questions reviewed a day before NOW, with this stability. */
async function reviewed(userId: string, stability: number) {
  for (const questionId of seed.questionIds.slice(0, 5)) {
    await db()
      .update(drillCards)
      .set({ stability, difficulty: 5, reps: 2, lastReviewAt: new Date(Date.parse(NOW) - 86_400_000) })
      .where(and(eq(drillCards.userId, userId), eq(drillCards.questionId, questionId)));
  }
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set(T0);
  teacher = await server.signIn("teacher");
  students = [];
  for (let i = 0; i < 9; i++) students.push(await server.signIn("student"));
  seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), mode: "exercise", questions: 6 });
  const on = await inject("PUT", `/app/api/classrooms/${seed.classroomId}/drill`, teacher.headers, { enabled: true });
  expect(on.statusCode, on.body).toBe(200);
  // The teacher joins as a student (ADR-018), then hands the exercise in with the class.
  const joined = await inject("POST", `/app/api/classrooms/${seed.classroomId}/self-enroll`, teacher.headers);
  expect(joined.statusCode, joined.body).toBe(201);
  const [seat] = await db()
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.userId, teacher.id)));
  expect(seat!.staff).toBe(true);
  seatId = seat!.id;
  await handIn(db(), { ...seed, studentIds: [...seed.studentIds, teacher.id] }, server.clock.now());

  const at = new Date(T0);
  const concept = (id: string, status: "validated" | "proposed", label: string) => ({
    id,
    status,
    labelEn: label,
    keyEn: label.toLowerCase(),
    createdAt: at,
    updatedAt: at,
  });
  await db().insert(concepts).values([
    concept(ids.solid, "validated", LABELS.solid),
    concept(ids.proposed, "proposed", LABELS.proposed),
    concept(ids.foreign, "validated", LABELS.foreign),
  ]);
  const q = seed.questionIds;
  await db().insert(questionConcepts).values([
    ...[0, 1, 2, 3, 4].map((i) => ({ questionId: q[i]!, conceptId: ids.solid })),
    ...[0, 1, 2, 3, 4].map((i) => ({ questionId: q[i]!, conceptId: ids.proposed })),
    { questionId: q[5]!, conceptId: ids.foreign },
  ]);
  const put = await inject("PUT", `/app/api/courses/${seed.courseId}/concepts`, teacher.headers, {
    conceptIds: [ids.solid, ids.proposed],
  });
  expect(put.statusCode, put.body).toBe(200);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("a staff seat's own cards (ADR-018, amended 2026-11-17)", () => {
  it("are created at the hand-in, as a student's", async () => {
    const mine = await cardsOf(teacher.id);
    expect(mine).toHaveLength((await cardsOf(students[0]!.id)).length);
    expect(mine.length).toBeGreaterThan(0);
  });

  it("are created at an exam's release", async () => {
    const now = server.clock.now();
    const questionIds = [await publishQuestion(db(), seed.poolId, teacher.id, "exam-q")];
    const created = await createEvaluation(db(), { classroomId: seed.classroomId, title: "Exam", mode: "exam", createdBy: teacher.id });
    await addItems(db(), (await byId(db(), created.id))!, questionIds, (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)), {
      attemptCount: 0,
    });
    await setAllowDrill(db(), await reload(db(), created.id), true, now);
    let evaluation = await applyState(db(), await reload(db(), created.id), "running", now);
    for (const userId of [students[0]!.id, teacher.id]) {
      const participant = (await live.participantOf(db(), evaluation, userId))!;
      await live.beginAttempt(db(), evaluation, await live.ensureAttempt(db(), evaluation, participant, now), participant, now);
    }
    evaluation = await live.closeEvaluation(db(), evaluation, now);
    const onExam = async (userId: string) => (await cardsOf(userId)).filter((c) => c.questionId === questionIds[0]);
    expect(await onExam(teacher.id)).toHaveLength(0);
    await releaseResults(db(), await reload(db(), created.id), now);
    expect(await onExam(teacher.id)).toHaveLength(1);
    expect(await onExam(students[0]!.id)).toHaveLength(1);
  });

  it("never come from the past: enabling the drill backfills the students only", async () => {
    const other = await seedLive(db(), { teacherId: teacher.id, studentIds: [students[0]!.id], mode: "exercise", questions: 2 });
    const joined = await inject("POST", `/app/api/classrooms/${other.classroomId}/self-enroll`, teacher.headers);
    expect(joined.statusCode, joined.body).toBe(201);
    await handIn(db(), { ...other, studentIds: [students[0]!.id, teacher.id] }, server.clock.now());
    expect(await cardsOf(teacher.id, other.classroomId)).toHaveLength(0);
    const on = await inject("PUT", `/app/api/classrooms/${other.classroomId}/drill`, teacher.headers, { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(await cardsOf(students[0]!.id, other.classroomId)).toHaveLength(2);
    expect(await cardsOf(teacher.id, other.classroomId)).toHaveLength(0);
  });

  it("are served and reviewed through the student routes, the classroom listed and its opt-out the seat's own", async () => {
    const mine = new Set((await cardsOf(teacher.id)).map((c) => c.id));
    const session = DrillSession.parse((await inject("GET", "/app/api/drill/session", teacher.headers)).json());
    expect(session.cards.length).toBeGreaterThan(0);
    for (const card of session.cards) expect(mine.has(card.id)).toBe(true);

    const cardId = session.cards[0]!.id;
    expect((await inject("POST", `/app/api/drill/cards/${cardId}/serve`, teacher.headers)).statusCode).toBe(200);
    const answered = await inject("POST", `/app/api/drill/cards/${cardId}/answer`, teacher.headers, { answer: "x", deviceClass: "fine", confidence: 4 });
    expect(answered.statusCode, answered.body).toBe(200);
    const calibration = (await inject("GET", "/app/api/drill/calibration", teacher.headers)).json() as unknown[];
    expect(calibration.map((r) => DrillCalibrationLevel.parse(r)).some((l) => l.answers > 0)).toBe(true);

    const listed = (await inject("GET", "/app/api/drill/classrooms", teacher.headers)).json() as unknown[];
    expect(listed.map((r) => DrillClassroom.parse(r).classroomId)).toContain(seed.classroomId);
    const out = await inject("PUT", `/app/api/drill/classrooms/${seed.classroomId}/opt-out`, teacher.headers, { optedOut: true });
    expect(out.statusCode, out.body).toBe(200);
    expect(DrillClassroom.parse(out.json()).optedOutAt).not.toBeNull();
    const back = await inject("PUT", `/app/api/drill/classrooms/${seed.classroomId}/opt-out`, teacher.headers, { optedOut: false });
    expect(DrillClassroom.parse(back.json()).optedOutAt).toBeNull();
  });
});

describe("a staff seat's own concept mastery, and the class's without it", () => {
  beforeAll(async () => {
    for (const s of students) await reviewed(s.id, 0.5);
    await reviewed(teacher.id, 1000);
    server.clock.set(NOW);
  });

  it("reads the seat's own level, naming nothing but the course's validated concepts (05 §5.7)", async () => {
    const res = await inject("GET", `/app/api/student/classrooms/${seed.classroomId}/drill/mastery`, teacher.headers);
    expect(res.statusCode).toBe(200);
    const body = StudentConceptMastery.parse(res.json());
    expect(body.concepts.map((c) => [c.concept.id, c.level, c.cards])).toEqual([[ids.solid, "solid", 5]]);
    for (const needle of [ids.proposed, LABELS.proposed, ids.foreign, LABELS.foreign, ...seed.questionIds, ...students.map((s) => s.id)]) {
      expect(res.body).not.toContain(needle);
    }
    for (const card of await cardsOf(teacher.id)) expect(res.body).not.toContain(card.id);
  });

  it("keeps the seat out of the class mastery (ADR-098)", async () => {
    const { staff, student } = await bothWays(() => classroomMastery(db(), { id: seed.classroomId, courseId: seed.courseId }, server.clock.now(), "en"));
    const solid = (m: typeof staff) => m.concepts.find((c) => c.concept?.id === ids.solid)!;
    expect(solid(staff)).toMatchObject({ students: 9, cards: 45 });
    expect(solid(student)).toMatchObject({ students: 10, cards: 50 });
  });

  it("keeps the seat out of the activity", async () => {
    const { staff, student } = await bothWays(() => classroomActivity(db(), seed.classroomId, server.clock.now()));
    expect(staff.map((r) => r.enrollmentId)).not.toContain(seatId);
    expect(staff).toHaveLength(9);
    expect(student.map((r) => r.enrollmentId)).toContain(seatId);
  });

  it("keeps the seat out of the confidence per question, which it would bring to ten students (F-STAT-06)", async () => {
    for (const s of [...students, teacher]) await review(s.id, 1, 4);
    const { staff, student } = await bothWays(() => classroomConfidence(db(), seed.classroomId));
    expect(staff.map((r) => r.questionId)).not.toContain(seed.questionIds[1]);
    expect(student.find((r) => r.questionId === seed.questionIds[1])).toMatchObject({ students: 10 });
  });
});

describe("a staff seat's targeted revision (ADR-115)", () => {
  it("revises the seat's own cards, read back by the seat, never by who revised", async () => {
    const roundsUrl = `/app/api/student/classrooms/${seed.classroomId}/revision/rounds`;
    const offer = await inject("GET", `/app/api/student/classrooms/${seed.classroomId}/revision/concepts`, teacher.headers);
    expect(offer.json()).toEqual({ available: true, concepts: [{ id: ids.solid, label: LABELS.solid, qualifier: "" }] });
    const started = RevisionRoundStart.parse((await inject("POST", roundsUrl, teacher.headers, { conceptId: ids.solid })).json());
    const round = started.round!;
    const mine = new Set((await cardsOf(teacher.id)).map((c) => c.id));
    for (const card of round.cards) expect(mine.has(card.id)).toBe(true);
    const cardId = round.cards[0]!.id;
    expect((await inject("POST", `/app/api/student/revision/rounds/${round.id}/serve/${cardId}`, teacher.headers)).statusCode).toBe(200);
    const answered = await inject("POST", `/app/api/student/revision/rounds/${round.id}/cards/${cardId}/answer`, teacher.headers, { answer: "x" });
    expect(answered.statusCode, answered.body).toBe(200);
    const own = (await inject("GET", roundsUrl, teacher.headers)).json() as unknown[];
    expect(own.map((r) => StudentRevisionRound.parse(r).id)).toEqual([round.id]);

    const { staff, student } = await bothWays(() => classroomRevision(db(), { id: seed.classroomId }, "en"));
    expect(staff).toEqual({ students: [], concepts: [] });
    expect(student.students.map((s) => s.enrollmentId)).toEqual([seatId]);
  });
});
