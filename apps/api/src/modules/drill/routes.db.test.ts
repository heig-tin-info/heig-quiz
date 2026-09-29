/**
 * The routes of the drill (ADR-041, #317): who reaches what (invariant 6),
 * the contracts on both sides (invariant 7), the audit of the teacher's
 * writes (invariant 9), and a whole review over HTTP with the key held back
 * until the answer (invariant 4).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DrillActivity,
  DrillClassroom,
  DrillMastery,
  DrillReviewResult,
  DrillServed,
  DrillSession,
  EvaluationDrill,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, drillCards } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as live from "../live/service.js";

type Session = Awaited<ReturnType<TestServer["signIn"]>>;
type Method = "GET" | "POST" | "PUT" | "DELETE";

let server: TestServer;
let restore: () => void;
let seed: Seeded;
let teacher: Session;
let stranger: Session;
let student: Session;
let classmate: Session;
let outsider: Session;

const call = (method: Method, url: string, who: Session, payload?: Payload) =>
  server.app.inject({ method, url, headers: who.headers, ...(payload === undefined ? {} : { payload }) });

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-10-05T07:00:00.000Z");
  teacher = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  student = await server.signIn("student");
  classmate = await server.signIn("student");
  outsider = await server.signIn("student");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id, classmate.id],
    mode: "exercise",
    questions: 2,
  });
});

afterAll(async () => {
  await server.close();
  restore();
});

/** Both students hand the exercise in: their cards are created by the live module's hook. */
async function handIn() {
  const db = server.app.db;
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  for (const userId of seed.studentIds) {
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, server.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, server.clock.now());
    await live.submitAttempt(db, evaluation, attempt, server.clock.now());
  }
}

const audited = async (action: string) =>
  server.app.db.select().from(auditLog).where(eq(auditLog.action, action));

describe("the drill over HTTP", () => {
  it("lets the classroom's staff, and nobody else, switch the drill on", async () => {
    const url = `/app/api/classrooms/${seed.classroomId}/drill`;
    expect((await call("PUT", url, stranger, { enabled: true })).statusCode).toBe(404);
    expect((await call("GET", url, stranger)).statusCode).toBe(404);
    expect((await call("PUT", url, student, { enabled: true })).statusCode).toBe(403);
    expect((await call("PUT", url, teacher, { enabled: "yes" })).statusCode).toBe(400);

    const on = await call("PUT", url, teacher, { enabled: true });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toEqual({ enabled: true, enabledAt: server.clock.now().toISOString() });
    expect((await call("GET", url, teacher)).json().enabled).toBe(true);
    expect(await audited("drill.enable")).toHaveLength(1);
    await handIn();
  });

  it("serves the student their session, and the classrooms of the tab", async () => {
    const session = DrillSession.parse((await call("GET", "/app/api/drill/session?device=coarse", student)).json());
    expect(session.cards).toHaveLength(2);
    expect(session.cards[0]).toMatchObject({ isNew: true, type: "short", courseName: "Programmation C" });
    expect((await call("GET", "/app/api/drill/session?device=tablet", student)).statusCode).toBe(400);
    expect(DrillSession.parse((await call("GET", "/app/api/drill/session", outsider)).json()).cards).toEqual([]);

    const rooms = (await call("GET", "/app/api/drill/classrooms", student)).json();
    expect(rooms.map((r: unknown) => DrillClassroom.parse(r).classroomId)).toEqual([seed.classroomId]);
    expect((await call("GET", "/app/api/drill/classrooms", outsider)).json()).toEqual([]);
  });

  it("keeps a student's cards from every other student", async () => {
    const [card] = await server.app.db
      .select()
      .from(drillCards)
      .where(eq(drillCards.userId, student.id));
    for (const who of [classmate, outsider, teacher]) {
      expect((await call("POST", `/app/api/drill/cards/${card!.id}/serve`, who)).statusCode).toBe(404);
      expect((await call("POST", `/app/api/drill/cards/${card!.id}/shown`, who, { shown: false })).statusCode).toBe(404);
      expect(
        (await call("POST", `/app/api/drill/cards/${card!.id}/answer`, who, { answer: "x", deviceClass: "fine" }))
          .statusCode,
      ).toBe(404);
    }
  });

  it("walks one review: the question without its key, then the rating and the key", async () => {
    const [card] = await server.app.db
      .select()
      .from(drillCards)
      .where(and(eq(drillCards.userId, student.id), eq(drillCards.questionId, seed.questionIds[0]!)));
    const base = `/app/api/drill/cards/${card!.id}`;
    expect((await call("POST", `${base}/answer`, student, { answer: "answer-q0", deviceClass: "fine" })).statusCode).toBe(409);

    const served = await call("POST", `${base}/serve`, student);
    expect(served.statusCode).toBe(200);
    expect(DrillServed.parse(served.json()).student).toEqual({ statement: "Statement of q0" });
    expect(served.body).not.toContain("answer-q0");

    server.clock.advance(4_000);
    expect((await call("POST", `${base}/shown`, student, { shown: false })).statusCode).toBe(204);
    server.clock.advance(30_000);
    expect((await call("POST", `${base}/shown`, student, { shown: true })).statusCode).toBe(204);
    server.clock.advance(2_000);
    expect((await call("POST", `${base}/answer`, student, { deviceClass: "phone" })).statusCode).toBe(400);
    const answered = await call("POST", `${base}/answer`, student, { answer: "answer-q0", deviceClass: "fine" });
    expect(answered.statusCode).toBe(200);
    const result = DrillReviewResult.parse(answered.json());
    expect(result).toMatchObject({ correctness: "right", rating: 3, activeMs: 6_000, solution: { answer: "answer-q0" } });
  });

  it("gives the staff each student's activity and the mastery, and nobody else", async () => {
    for (const path of ["activity", "mastery"]) {
      const url = `/app/api/classrooms/${seed.classroomId}/drill/${path}`;
      expect((await call("GET", url, stranger)).statusCode).toBe(404);
      expect((await call("GET", url, student)).statusCode).toBe(403);
    }
    const activity = DrillActivity.parse(
      (await call("GET", `/app/api/classrooms/${seed.classroomId}/drill/activity`, teacher)).json(),
    );
    const mine = activity.students.find((s) => s.userId === student.id)!;
    expect(mine).toMatchObject({ cards: 2, all: { reviews: 1, questionsSeen: 1, sessions: 1 } });
    DrillMastery.parse((await call("GET", `/app/api/classrooms/${seed.classroomId}/drill/mastery`, teacher)).json());
  });

  it("lets the student opt out, which empties the session and the tab's switch says so", async () => {
    const url = `/app/api/drill/classrooms/${seed.classroomId}/opt-out`;
    expect((await call("PUT", url, outsider, { optedOut: true })).statusCode).toBe(404);
    const out = await call("PUT", url, classmate, { optedOut: true });
    expect(out.statusCode).toBe(200);
    expect(DrillClassroom.parse(out.json()).optedOutAt).toBe(server.clock.now().toISOString());
    expect(DrillSession.parse((await call("GET", "/app/api/drill/session", classmate)).json()).cards).toEqual([]);
    const back = await call("PUT", url, classmate, { optedOut: false });
    expect(back.json().optedOutAt).toBeNull();
  });

  it("sets 'Allow drill' and removes an evaluation's cards, for the staff only, audited", async () => {
    const url = `/app/api/evaluations/${seed.evaluationId}/drill`;
    expect((await call("GET", url, stranger)).statusCode).toBe(404);
    expect((await call("PUT", url, stranger, { allowDrill: false })).statusCode).toBe(404);
    expect((await call("DELETE", `${url}/cards`, stranger)).statusCode).toBe(404);

    expect(EvaluationDrill.parse((await call("GET", url, teacher)).json())).toEqual({ allowDrill: true, cards: 4 });
    const off = await call("PUT", url, teacher, { allowDrill: false });
    // Turning it off keeps the cards (ADR-041 §10, item 3).
    expect(off.json()).toEqual({ allowDrill: false, cards: 4 });
    expect((await audited("evaluation.update")).some((r) => (r.payload as { allowDrill?: boolean })?.allowDrill === false)).toBe(true);

    const removed = await call("DELETE", `${url}/cards`, teacher);
    expect(removed.json()).toEqual({ removed: 4 });
    expect(await audited("drill.cards_remove")).toHaveLength(1);
    expect(DrillSession.parse((await call("GET", "/app/api/drill/session", student)).json()).cards).toEqual([]);
  });
});
