/**
 * The student's Grades page (`GET /app/api/student/results`, F-RES-04,
 * F-ORG-14) over the real application: the home's Past, by classroom, with a
 * grade only where the feedback policy lets the student read it. What it
 * must never carry — a grade under the policy `none`, a grade before the
 * release — and whom it lists: a staff seat only once it took an attempt
 * (ADR-018 §3), an archived classroom too. Who reads it: the student's
 * portal and an impersonation session (ADR-034), never a `seb` or `kiosk`
 * one (ADR-027, ADR-051).
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudentGrades, type FeedbackPolicy, type SessionKind } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { classrooms, enrollments, evaluations } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { kioskStation } from "../../test/kiosk.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";
import * as results from "../results/service.js";
import * as live from "./service.js";

type Signed = { id: string; headers: Record<string, string> };

let server: TestServer;
let restore: () => void;
let teacher: Signed;
/** On the staff with a staff seat of their own (the self-enrolment, ADR-018). */
let seated: Signed;
let admin: Signed;
let student: Signed;
let evaluationIds: Record<string, string>;
let seeds: Record<string, Seeded>;

const db = () => server.app.db;
const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });

/**
 * One closed evaluation in a classroom of its own: under the policy `when`,
 * taken and handed in by the student when `take`, released when `release`.
 * `staffTakes`: the seated teacher walks it too (ADR-018).
 */
async function closed(
  title: string,
  options: { when: FeedbackPolicy["when"]; take: boolean; release: boolean; staffTakes?: boolean },
) {
  const seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [student.id], questions: 1 });
  seeds[title] = seed;
  evaluationIds[title] = seed.evaluationId;
  await db().insert(enrollments).values({
    id: randomUUID(),
    classroomId: seed.classroomId,
    nom: "Teacher",
    prenom: "Seated",
    email: `seated-${seed.classroomId.slice(0, 6)}@heig.test`,
    userId: seated.id,
    claimedAt: new Date(),
    staff: true,
  });
  const draft = await reload(db(), seed.evaluationId);
  await db()
    .update(evaluations)
    .set({ title, feedbackPolicy: { ...(draft.feedbackPolicy as object), when: options.when } })
    .where(eq(evaluations.id, draft.id));
  const now = server.clock.now();
  const evaluation = await applyState(db(), await reload(db(), draft.id), "running", now);
  const takers = [...(options.take ? [student.id] : []), ...(options.staffTakes ? [seated.id] : [])];
  for (const userId of takers) {
    const participant = (await live.participantOf(db(), evaluation, userId))!;
    const created = await live.ensureAttempt(db(), evaluation, participant, now);
    const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
    await live.submitAttempt(db(), evaluation, attempt, now);
  }
  const ended = await live.closeEvaluation(db(), evaluation, now, "teacher");
  if (options.release) await results.releaseResults(db(), ended, now);
  server.clock.advance(60_000);
}

/** A session of `kind` for `userId`, as the cookies a browser would send. */
async function sessionOf(
  userId: string,
  auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string; deviceId?: string },
) {
  const session = await createSession(db(), userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    deviceId: auth.deviceId ?? null,
  });
  return {
    cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`,
    "x-csrf-token": session.csrf,
  };
}

async function grades(headers: Record<string, string>) {
  const res = await get("/app/api/student/results", headers);
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, groups: StudentGrades.parse(res.json()) };
}

async function rowOf(title: string, headers = student.headers) {
  const { groups } = await grades(headers);
  return groups.flatMap((g) => g.rows).find((r) => r.evaluationId === evaluationIds[title]);
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-28T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  seated = await server.signIn("teacher");
  admin = await server.signIn("admin");
  student = await server.signIn("student");
  evaluationIds = {};
  seeds = {};

  await closed("released on_release", { when: "on_release", take: true, release: true, staffTakes: true });
  await closed("released none", { when: "none", take: true, release: true });
  await closed("released missed", { when: "on_release", take: false, release: true });
  await closed("pending", { when: "on_release", take: true, release: false });
  await closed("immediate", { when: "immediate", take: true, release: false });
  await closed("closed none", { when: "none", take: true, release: false });
  await closed("archived", { when: "on_release", take: true, release: true });
  await db()
    .update(classrooms)
    .set({ archivedAt: server.clock.now() })
    .where(eq(classrooms.id, seeds["archived"]!.classroomId));
});

afterAll(async () => {
  await server.close();
  restore();
});

describe("GET /app/api/student/results — what a row says (F-RES-04)", () => {
  it("shows the points and the grade of a released evaluation, and opens its feedback", async () => {
    expect(await rowOf("released on_release")).toMatchObject({
      status: "released",
      mode: "exam",
      score: { points: 0, totalPoints: expect.any(Number), grade: 1 },
      feedbackAttemptId: expect.any(String),
    });
  });

  it("shows NO grade of a released evaluation under the policy none, on the home neither", async () => {
    const id = evaluationIds["released none"]!;
    const { body, groups } = await grades(student.headers);
    // Every row of it, wherever it sits in the payload, carries no score…
    const rows = groups.flatMap((g) => g.rows).filter((r) => r.evaluationId === id);
    expect(rows).toEqual([expect.objectContaining({ status: "withheld", score: null, feedbackAttemptId: null })]);
    // …and the serialized rows hold no grade nor points key at all.
    const raw = (JSON.parse(body) as { rows: Record<string, unknown>[] }[])
      .flatMap((g) => g.rows)
      .filter((r) => r["evaluationId"] === id);
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw)).not.toMatch(/"(grade|points|totalPoints)"/);
    const home = await live.studentHome(db(), student.id, server.clock.now());
    expect(home.past.find((c) => c.id === id)!.grade).toBeNull();
  });

  it("keeps a released evaluation the student never took, with the scale minimum", async () => {
    expect(await rowOf("released missed")).toMatchObject({
      status: "missed",
      score: { points: 0, grade: 1 },
      feedbackAttemptId: null,
    });
  });

  it("lists a hand-in waiting for its results as pending, without a grade", async () => {
    expect(await rowOf("pending")).toMatchObject({ status: "pending", score: null, feedbackAttemptId: null });
  });

  it("opens the feedback of an immediate one before any release, its points indicative, no grade", async () => {
    const row = await rowOf("immediate");
    expect(row).toMatchObject({
      status: "available",
      score: { points: 0, totalPoints: expect.any(Number), grade: null },
      feedbackAttemptId: expect.any(String),
    });
    // Exactly the points the feedback page shows for that attempt.
    const feedback = await get(`/app/api/attempts/${row!.feedbackAttemptId}/feedback`, student.headers);
    expect(feedback.json()).toMatchObject({
      available: true,
      points: row!.score!.points,
      totalPoints: row!.score!.totalPoints,
    });
  });

  it("says handed in, and promises nothing, under none before the release", async () => {
    expect(await rowOf("closed none")).toMatchObject({ status: "submitted", score: null, feedbackAttemptId: null });
  });
});

describe("GET /app/api/student/results — the groups", () => {
  it("groups by classroom, newest first, an archived classroom included and marked", async () => {
    const { groups } = await grades(student.headers);
    expect(groups.map((g) => g.rows.map((r) => r.evaluationId))).toEqual(
      ["archived", "closed none", "immediate", "pending", "released missed", "released none", "released on_release"]
        .map((title) => [evaluationIds[title]]),
    );
    const archived = groups.find((g) => g.classroom.id === seeds["archived"]!.classroomId)!;
    expect(archived.classroom).toMatchObject({
      name: "A",
      courseName: "Programmation C",
      period: "2026-A",
      archived: true,
    });
    expect(groups.filter((g) => g.classroom.archived)).toHaveLength(1);
  });

  it("lists a staff seat's evaluations only where it took an attempt (ADR-018 §3)", async () => {
    const { groups } = await grades(seated.headers);
    expect(groups.flatMap((g) => g.rows).map((r) => r.evaluationId)).toEqual([
      evaluationIds["released on_release"],
    ]);
  });
});

describe("GET /app/api/student/results — who reads it", () => {
  it("an impersonation session reads exactly what the student reads (ADR-034)", async () => {
    const as = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id });
    expect((await grades(as)).body).toBe((await grades(student.headers)).body);
  });

  it("a seb session is nobody on this route (ADR-027)", async () => {
    const seb = await sessionOf(student.id, { kind: "seb", evaluationId: evaluationIds["pending"]! });
    expect((await get("/app/api/student/results", seb)).statusCode).toBe(401);
  });

  it("a kiosk session is nobody on this route, even from its own station (ADR-051)", async () => {
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(student.id, {
      kind: "kiosk",
      evaluationId: evaluationIds["pending"]!,
      deviceId: station.deviceId,
    });
    const fromStation = { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` };
    expect((await get("/app/api/student/results", fromStation)).statusCode).toBe(401);
  });

  it("an anonymous caller is asked to sign in", async () => {
    expect((await get("/app/api/student/results", {})).statusCode).toBe(401);
  });
});
