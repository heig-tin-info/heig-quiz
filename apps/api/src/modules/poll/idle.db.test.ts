/**
 * A poll left open by mistake ends on its own (#190, ADR-014 addendum
 * 2026-09-28): `running`, and neither the poll nor any answer moved for
 * `POLL_IDLE_MS`. The ticker pass is called with explicit instants — the
 * server's clock, never a sleep (invariant 5).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";

import { attempts, auditLog, evaluations, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { SCHEDULED_TASKS } from "../system/catalog.js";
import * as poolService from "../pool/service.js";
import { answerPoll, createPoll, endIdlePolls, endPoll, join, POLL_IDLE_MS } from "./service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let classroomId: string;
let questionId: string;

const T0 = new Date("2026-09-28T08:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  const seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    questions: 0,
    studentIds: [student.id],
  });
  classroomId = seed.classroomId;
  const created = await server.app.inject({
    method: "POST",
    url: "/app/api/polls/questions",
    headers: teacher.headers,
    payload: { type: "mcq", internalName: "Idle poll" },
  });
  expect(created.statusCode).toBe(201);
  questionId = created.json().meta.id as string;
  const [question] = await server.app.db.select().from(questions).where(eq(questions.id, questionId));
  await poolService.putDraft(server.app.db, question!, {
    config: {
      configVersion: 2,
      prompt: "Oui ou non ?",
      choices: [
        { text: "Oui", correct: true },
        { text: "Non", correct: false },
      ],
      mode: "single",
    },
  });
  await poolService.publishQuestion(server.app.db, question!, { userId: teacher.id });
});
afterAll(async () => {
  await server.close();
});

const launch = (now: Date) =>
  createPoll(server.app.db, { classroomId, questionId, createdBy: teacher.id, now });

const stateOf = async (id: string) =>
  (await server.app.db.select().from(evaluations).where(eq(evaluations.id, id)))[0]!;

const endEntries = (id: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "poll.end"), eq(auditLog.subjectId, id)));

/** Ends whatever is idle at `now`, and says whether `id` was among them. */
const passEnds = async (id: string, now: Date) =>
  (await endIdlePolls(server.app, now)).some((row) => row.id === id);

describe("a poll nobody answers", () => {
  it("stays open at 11 h 59 and ends at 12 h, as the teacher's End would", async () => {
    const scope = await launch(T0);
    const id = scope.evaluation.id;
    // A join is not an answer: the phone that scanned the QR keeps nothing alive.
    await join(server.app.db, scope.evaluation, { userId: student.id, guestId: null }, at(11 * HOUR));

    expect(await passEnds(id, at(POLL_IDLE_MS - MINUTE))).toBe(false);
    expect((await stateOf(id)).state).toBe("running");

    expect(await passEnds(id, at(POLL_IDLE_MS))).toBe(true);
    const row = await stateOf(id);
    expect(row).toMatchObject({ state: "closed", closedAt: at(POLL_IDLE_MS) });
    // The open attempt is expired by the server, as `closeEvaluation` does.
    const [attempt] = await server.app.db.select().from(attempts).where(eq(attempts.evaluationId, id));
    expect(attempt).toMatchObject({ state: "expired", closedBy: "server" });
    // The same audit action as the End button, with the system as its actor.
    const entries = await endEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "system", actorUserId: null });
    expect(entries[0]!.payload).toMatchObject({ reason: "idle" });
  });

  it("is ended once: a second pass finds nothing", async () => {
    const scope = await launch(T0);
    const id = scope.evaluation.id;
    expect(await passEnds(id, at(POLL_IDLE_MS + HOUR))).toBe(true);
    expect(await passEnds(id, at(POLL_IDLE_MS + 2 * HOUR))).toBe(false);
    expect(await endEntries(id)).toHaveLength(1);
    expect((await stateOf(id)).closedAt).toEqual(at(POLL_IDLE_MS + HOUR));
  });
});

describe("a poll nobody answers, in no classroom", () => {
  it("ends at 12 h like a classroom's", async () => {
    const scope = await createPoll(server.app.db, {
      classroomId: null,
      questionId,
      createdBy: teacher.id,
      now: T0,
    });
    expect(await passEnds(scope.evaluation.id, at(POLL_IDLE_MS - MINUTE))).toBe(false);
    expect(await passEnds(scope.evaluation.id, at(POLL_IDLE_MS))).toBe(true);
  });
});

describe("a race with the teacher's End", () => {
  it("leaves the one that lost silent: no second audit entry", async () => {
    const scope = await launch(T0);
    const id = scope.evaluation.id;
    const ended = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${id}/poll/end`,
      headers: teacher.headers,
    });
    expect(ended.statusCode).toBe(200);
    // The pass read the poll as running just before the teacher's End landed.
    const late = await endPoll(server.app, scope.evaluation, at(POLL_IDLE_MS), "server");
    expect(late.ended).toBe(false);
    expect(late.evaluation.state).toBe("closed");
    const entries = await endEntries(id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "user", actorUserId: teacher.id });
  });
});

describe("a poll that was answered", () => {
  it("counts its 12 hours from the last answer", async () => {
    const scope = await launch(T0);
    const id = scope.evaluation.id;
    const attempt = await join(server.app.db, scope.evaluation, { userId: student.id, guestId: null }, at(HOUR));
    await answerPoll(server.app.db, scope, attempt, { selected: [0] }, at(6 * HOUR));

    // Twelve hours after the launch, six after the answer: still open.
    expect(await passEnds(id, at(POLL_IDLE_MS))).toBe(false);
    expect((await stateOf(id)).state).toBe("running");
    expect(await passEnds(id, at(6 * HOUR + POLL_IDLE_MS - MINUTE))).toBe(false);
    expect(await passEnds(id, at(6 * HOUR + POLL_IDLE_MS))).toBe(true);
  });

  it("leaves a poll its teacher ended alone", async () => {
    const scope = await launch(T0);
    const id = scope.evaluation.id;
    await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${id}/poll/end`,
      headers: teacher.headers,
    });
    const before = await stateOf(id);
    expect(before.state).toBe("closed");
    expect(await passEnds(id, at(10 * POLL_IDLE_MS))).toBe(false);
    expect((await stateOf(id)).closedAt).toEqual(before.closedAt);
    expect(await endEntries(id)).toHaveLength(1);
  });
});

describe("registration", () => {
  it("is in the scheduled catalog every deployment runs", () => {
    expect(SCHEDULED_TASKS.map((t) => t.key)).toContain("poll.end_idle");
  });
});
