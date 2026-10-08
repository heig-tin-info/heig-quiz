/**
 * What stated confidences add up to (ADR-085 §8, issue #453 part 2), over
 * HTTP and the real migrations: the student's own calibration, and the
 * teacher's 2×2 per question — who reaches each (invariant 6), the
 * contracts (invariant 7), the threshold in distinct students applied on
 * the server, the opt-out cut, and that a student's calibration holds their
 * rows only.
 *
 * As in `teacher.db.test.ts`, the cards come from the production hook (an
 * exercise handed in) and the reviews are written as rows: the reads read
 * nothing else.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrillCalibrationLevel, DrillQuestionConfidence } from "@quiz/contracts";
import { DRILL_CONFIDENCE_MIN_STUDENTS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { drillCards, drillReviews } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { setDrillOptOut } from "../org/service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;
type Correctness = "right" | "partial" | "wrong";

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let other: Seeded;
let teacher: Session;
let stranger: Session;
/** Eleven students: one more than the threshold, the last one opted out before stating. */
let students: Session[];

const T0 = "2026-10-05T07:00:00.000Z";

const get = (url: string, who: Session) => server.app.inject({ method: "GET", url, headers: who.headers });
const confidenceUrl = (s: Seeded) => `/app/api/classrooms/${s.classroomId}/drill/confidence`;

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

let minute = 0;
async function review(s: Seeded, who: Session, question: number, correctness: Correctness, confidence: number | null) {
  const [card] = await server.app.db
    .select()
    .from(drillCards)
    .where(and(eq(drillCards.userId, who.id), eq(drillCards.questionId, s.questionIds[question]!)));
  await server.app.db.insert(drillReviews).values({
    id: randomUUID(),
    cardId: card!.id,
    rating: correctness === "wrong" ? 1 : 3,
    correctness,
    confidence,
    elapsedMs: 20_000,
    deviceClass: "fine",
    reviewedAt: new Date(Date.parse("2026-10-10T08:00:00Z") + ++minute * 60_000),
  });
}

async function confidence(s: Seeded, who: Session = teacher) {
  const res = await get(confidenceUrl(s), who);
  expect(res.statusCode).toBe(200);
  return (res.json() as unknown[]).map((r) => DrillQuestionConfidence.parse(r));
}

async function calibration(who: Session) {
  const res = await get("/app/api/drill/calibration", who);
  expect(res.statusCode).toBe(200);
  return (res.json() as unknown[]).map((r) => DrillCalibrationLevel.parse(r));
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set(T0);
  teacher = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  students = [];
  for (let i = 0; i < 11; i++) students.push(await server.signIn("student"));
  const [alice, bob] = students as [Session, Session];
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: students.map((s) => s.id),
    mode: "exercise",
    questions: 2,
  });
  // Alice and Bob sit a second, small classroom.
  other = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [alice.id, bob.id],
    mode: "exercise",
    questions: 1,
  });
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

  // q0, ten students stating: six right and Certain, two wrong and Sure, one
  // wrong and Unsure, one right with No idea; Alice also once unstated.
  for (const s of students.slice(0, 6)) await review(seed, s, 0, "right", 4);
  for (const s of students.slice(6, 8)) await review(seed, s, 0, "wrong", 3);
  await review(seed, students[8]!, 0, "wrong", 1);
  await review(seed, students[9]!, 0, "right", 0);
  await review(seed, alice, 0, "wrong", null);
  // The eleventh opts out, then states: never counted, so q0 stays at ten.
  await setDrillOptOut(server.app.db, seed.classroomId, students[10]!.id, true, new Date("2026-10-09T08:00:00Z"));
  await review(seed, students[10]!, 0, "partial", 2);

  // q1: nine students, one of them many times — nine students, below ten.
  for (const s of students.slice(1, 9)) await review(seed, s, 1, "wrong", 4);
  for (let i = 0; i < 5; i++) await review(seed, alice, 1, "wrong", 3);

  // The small classroom: Alice and Bob, each stating.
  await review(other, alice, 0, "right", 4);
  await review(other, bob, 0, "partial", 2);
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("the teacher's confidence per question: access", () => {
  // Every staff route is also swept by `accessSweep.db.test.ts`.
  it("is the classroom staff's; another teacher gets the 404 of a missing classroom", async () => {
    expect((await get(confidenceUrl(seed), teacher)).statusCode).toBe(200);
    const foreign = await get(confidenceUrl(seed), stranger);
    const missing = await get(`/app/api/classrooms/${randomUUID()}/drill/confidence`, stranger);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
  });

  it("is refused to a student of the classroom, who reads only their own calibration", async () => {
    const res = await get(confidenceUrl(seed), students[0]!);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("rightSure");
  });
});

describe("the teacher's confidence per question: the aggregate", () => {
  it("gives the 2×2 of a question stated by enough students, the opt-out cut applied", async () => {
    const rows = await confidence(seed);
    expect(DRILL_CONFIDENCE_MIN_STUDENTS).toBe(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      questionId: seed.questionIds[0],
      students: 10,
      split: { rightSure: 6, rightUnsure: 1, wrongSure: 2, wrongUnsure: 1 },
    });
  });

  it("returns nothing for a question below ten students, however many reviews it has", async () => {
    const rows = await confidence(seed);
    expect(rows.some((r) => r.questionId === seed.questionIds[1])).toBe(false);
    // The small classroom has two students: nothing at all travels.
    const res = await get(confidenceUrl(other), teacher);
    expect(res.json()).toEqual([]);
  });

  it("carries no student's identity", async () => {
    const res = await get(confidenceUrl(seed), teacher);
    for (const s of students) expect(res.body).not.toContain(s.id);
  });
});

describe("the student's calibration", () => {
  it("holds the student's own stated reviews only, every classroom pooled", async () => {
    const levels = await calibration(students[0]!);
    expect(levels.map((l) => l.confidence)).toEqual([0, 1, 2, 3, 4]);
    // Alice: Certain right twice (both classrooms), Sure wrong five times; her unstated review is out.
    expect(levels).toEqual([
      { confidence: 0, answers: 0, right: 0 },
      { confidence: 1, answers: 0, right: 0 },
      { confidence: 2, answers: 0, right: 0 },
      { confidence: 3, answers: 5, right: 0 },
      { confidence: 4, answers: 2, right: 2 },
    ]);
  });

  it("is another student's own, partial answers counted as not right", async () => {
    // Bob: Certain right on q0, Certain wrong on q1, Fairly sure partial in the small classroom.
    expect(await calibration(students[1]!)).toEqual([
      { confidence: 0, answers: 0, right: 0 },
      { confidence: 1, answers: 0, right: 0 },
      { confidence: 2, answers: 1, right: 0 },
      { confidence: 3, answers: 0, right: 0 },
      { confidence: 4, answers: 2, right: 1 },
    ]);
  });

  it("is all zeros for a student who never stated", async () => {
    const levels = await calibration(await server.signIn("student"));
    expect(levels.every((l) => l.answers === 0)).toBe(true);
  });
});
