/**
 * Contestations of an exam's grading (ADR-139, F-GRADE-08) over the REAL
 * application: the routes, the guards, the single writer, the real
 * migrations.
 *
 * The world: an exam of three one-point questions, sat by students A and B
 * and by the teacher on a staff seat (ADR-018). Each attempt is graded by
 * hand — question 0 at 0 points, question 1 at full points, question 2 left a
 * proposal (pending) — then closed and released by the owner, which opens a
 * window of seven days.
 *
 * The window is compared on the DATABASE's clock (invariant 5): the test
 * clock is set to the wall clock's instant, so a release stamps an instant
 * the database's `now()` agrees with.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ContestationResolution,
  GradebookStaff,
  type GradingQueue,
  type GradingSteps,
  type ResultsView,
  type StudentContestation,
  type StudentFeedback,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import {
  attempts,
  auditLog,
  classrooms,
  contestations,
  courseStaff,
  enrollments,
  evaluations,
  gradings,
  notifications,
} from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, sessionOf, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive, type Seeded } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { resolveContestation } from "./contestations.js";
import { GradingError } from "./records.js";
import { writeGrading } from "./writer.js";

type Actor = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let teacher: Actor;
let assistant: Actor;
let a: Actor;
let b: Actor;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  assistant = await server.signIn("teacher");
  a = await server.signIn("student");
  b = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const get = (url: string, who: Actor | Record<string, string> = teacher) =>
  server.app.inject({ method: "GET", url, headers: "headers" in who ? (who.headers as Record<string, string>) : who });
const send = (method: "POST" | "PUT" | "PATCH", url: string, payload: Payload, who: Actor | Record<string, string> = teacher) =>
  server.app.inject({ method, url, headers: "headers" in who ? (who.headers as Record<string, string>) : who, payload });

const DAY_MS = 86_400_000;

interface World {
  seed: Seeded;
  itemIds: string[];
  /** By who sat it: A, B, and the teacher's staff seat. */
  attempt: { a: string; b: string; staff: string };
}

/**
 * The world above. `policy` patches the feedback policy before anyone sits
 * it; `release: false` leaves it closed.
 */
async function world(options: { policy?: Record<string, unknown>; release?: boolean } = {}): Promise<World> {
  server.clock.set(new Date());
  const seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [a.id, b.id], questions: 3 });
  await db().insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
  const joined = await send("POST", `/app/api/classrooms/${seed.classroomId}/self-enroll`, {}, teacher);
  expect(joined.statusCode, joined.body).toBe(201);
  if (options.policy) {
    const patched = await send("PATCH", `/app/api/evaluations/${seed.evaluationId}`, { feedbackPolicy: options.policy });
    expect(patched.statusCode, patched.body).toBe(200);
  }
  const now = server.clock.now();
  let evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", now);
  const itemIds = (await joinedItems(db(), seed.evaluationId)).map((i) => i.item.id);
  const attempt: Record<string, string> = {};
  for (const [who, userId] of [
    ["a", a.id],
    ["b", b.id],
    ["staff", teacher.id],
  ] as const) {
    const participant = (await live.participantOf(db(), evaluation, userId))!;
    const started = await live.beginAttempt(db(), evaluation, await live.ensureAttempt(db(), evaluation, participant, now), participant, now);
    await live.saveAnswer(db(), { evaluation, attempt: started, itemId: itemIds[0]!, payload: "wrong", revision: 1, now });
    await live.submitAttempt(db(), evaluation, started, now);
    attempt[who] = started.id;
    for (const [index, points, state] of [
      [0, 0, "validated"],
      [1, 1, "validated"],
      [2, 0, "proposed"],
    ] as const) {
      await writeGrading(db(), {
        attemptId: started.id,
        itemId: itemIds[index]!,
        answerId: null,
        points,
        maxPoints: 1,
        source: "manual",
        state,
        details: null,
        now,
      });
    }
  }
  evaluation = await live.closeEvaluation(db(), evaluation, now, "teacher");
  if (options.release !== false) {
    const released = await send("POST", `/app/api/evaluations/${seed.evaluationId}/release`, { confirm: true });
    expect(released.statusCode, released.body).toBe(200);
  }
  return { seed, itemIds, attempt: attempt as World["attempt"] };
}

const fileUrl = (attemptId: string, itemId: string) => `/app/api/attempts/${attemptId}/items/${itemId}/contestation`;
const file = (w: World, who: Actor, attemptId: string, item: number, reason = "Question 1 was right.") =>
  send("POST", fileUrl(attemptId, w.itemIds[item]!), { reason }, who);

async function filed(w: World, who: Actor, attemptId: string, item = 0, reason?: string) {
  const res = await file(w, who, attemptId, item, reason);
  expect(res.statusCode, res.body).toBe(200);
  const [row] = await db()
    .select()
    .from(contestations)
    .where(and(eq(contestations.attemptId, attemptId), eq(contestations.itemId, w.itemIds[item]!)));
  return row!;
}

const resolve = (id: string, body: Payload, who: Actor = teacher) => send("POST", `/app/api/contestations/${id}/resolve`, body, who);

const closesAt = async (evaluationId: string) => (await reload(db(), evaluationId)).contestationClosesAt;

async function validated(attemptId: string, itemId: string) {
  const [row] = await db()
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), eq(gradings.state, "validated")));
  return row!;
}

const bells = (userId: string, kind: string) =>
  db()
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'kind' = ${kind}`));

describe("the window (ADR-139)", () => {
  it("is set once by the release that opens it, seven days later, never moved by a re-release or an unrelease", async () => {
    const w = await world();
    const evaluation = await reload(db(), w.seed.evaluationId);
    expect(evaluation.contestationClosesAt!.getTime()).toBe(evaluation.releasedAt!.getTime() + 7 * DAY_MS);
    const first = evaluation.contestationClosesAt!.getTime();

    server.clock.advance(60_000);
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/release`, { confirm: true })).statusCode).toBe(200);
    expect((await closesAt(w.seed.evaluationId))!.getTime()).toBe(first);
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/unrelease`, {})).statusCode).toBe(200);
    expect((await closesAt(w.seed.evaluationId))!.getTime()).toBe(first);
    server.clock.advance(60_000);
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/release`, { confirm: true })).statusCode).toBe(200);
    expect((await closesAt(w.seed.evaluationId))!.getTime()).toBe(first);

    const view = (await get(`/app/api/evaluations/${w.seed.evaluationId}/results`)).json() as ResultsView;
    expect(view.contestationClosesAt).toBe(new Date(first).toISOString());
  });

  it("follows the policy's days, and opens none at 0 nor under `when: none`", async () => {
    const three = await world({ policy: { contestationDays: 3 } });
    const evaluation = await reload(db(), three.seed.evaluationId);
    expect(evaluation.contestationClosesAt!.getTime()).toBe(evaluation.releasedAt!.getTime() + 3 * DAY_MS);
    expect(await closesAt((await world({ policy: { contestationDays: 0 } })).seed.evaluationId)).toBeNull();
    const none = await world({ policy: { when: "none" } });
    expect(await closesAt(none.seed.evaluationId)).toBeNull();
    expect((await file(none, a, none.attempt.a, 0)).json()).toMatchObject({ error: "contestation_closed" });
  });

  it("takes its days by the evaluation patch after the attempts, and a change after the release moves nothing", async () => {
    const w = await world({ release: false });
    const patched = await send("PATCH", `/app/api/evaluations/${w.seed.evaluationId}`, { feedbackPolicy: { contestationDays: 2 } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/release`, { confirm: true })).statusCode).toBe(200);
    const evaluation = await reload(db(), w.seed.evaluationId);
    expect(evaluation.contestationClosesAt!.getTime()).toBe(evaluation.releasedAt!.getTime() + 2 * DAY_MS);
    const later = await send("PATCH", `/app/api/evaluations/${w.seed.evaluationId}`, { feedbackPolicy: { contestationDays: 30 } });
    expect(later.statusCode, later.body).toBe(200);
    expect(await closesAt(w.seed.evaluationId)).toEqual(evaluation.contestationClosesAt);
    expect((await send("PATCH", `/app/api/evaluations/${w.seed.evaluationId}`, { feedbackPolicy: { contestationDays: 61 } })).statusCode).toBe(400);
  });

  it("is copied with the policy by a duplicate, never its instant", async () => {
    const w = await world({ policy: { contestationDays: 4 } });
    const copy = await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/duplicate`, { title: "Copy" });
    expect(copy.statusCode, copy.body).toBe(201);
    const row = await reload(db(), (copy.json() as { id: string }).id);
    expect(row.feedbackPolicy).toMatchObject({ contestationDays: 4 });
    expect(row.contestationClosesAt).toBeNull();
  });

  it("is closed now or extended by the owner only, audited, on a released exam", async () => {
    const w = await world();
    const url = `/app/api/evaluations/${w.seed.evaluationId}/contestation-window`;
    expect((await send("PUT", url, { action: "close" }, assistant)).json()).toMatchObject({ error: "owner_required" });

    const closed = await send("PUT", url, { action: "close" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toEqual({ closesAt: server.clock.now().toISOString() });
    expect((await file(w, a, w.attempt.a, 0)).json()).toMatchObject({ error: "contestation_closed" });

    const past = new Date(server.clock.now().getTime() - 1000).toISOString();
    expect((await send("PUT", url, { action: "extend", closesAt: past })).json()).toMatchObject({ error: "window_instant", reason: "not_future" });
    const far = new Date(server.clock.now().getTime() + 91 * DAY_MS).toISOString();
    expect((await send("PUT", url, { action: "extend", closesAt: far })).json()).toMatchObject({ error: "window_instant", reason: "too_far" });

    // Extending reopens a closed window.
    const ahead = new Date(server.clock.now().getTime() + DAY_MS).toISOString();
    expect((await send("PUT", url, { action: "extend", closesAt: ahead })).statusCode).toBe(200);
    expect((await file(w, a, w.attempt.a, 0)).statusCode).toBe(200);

    const audited = await db().select().from(auditLog).where(and(eq(auditLog.action, "evaluation.contestation_window"), eq(auditLog.subjectId, w.seed.evaluationId)));
    expect(audited.map((row) => row.payload)).toEqual([
      { action: "close", closesAt: closed.json().closesAt },
      { action: "extend", closesAt: ahead },
    ]);

    const unreleased = await world({ release: false });
    expect((await send("PUT", `/app/api/evaluations/${unreleased.seed.evaluationId}/contestation-window`, { action: "close" })).json()).toMatchObject({
      error: "window_unavailable",
    });
  });
});

describe("filing (ADR-139)", () => {
  it("files once, stamped on the database's clock, the grading in force recorded, audited without the reason", async () => {
    const w = await world();
    const res = await file(w, a, w.attempt.a, 0, "  The key accepts Zorglub.  ");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as StudentContestation;
    expect(body).toMatchObject({ state: "open", reason: "The key accepts Zorglub.", reply: null, resolvedAt: null });
    const [row] = await db().select().from(contestations).where(eq(contestations.attemptId, w.attempt.a));
    expect(row!.gradingAtFilingId).toBe((await validated(w.attempt.a, w.itemIds[0]!)).id);
    expect(row!.filedBy).toBe(a.id);

    const [audit] = await db().select().from(auditLog).where(and(eq(auditLog.action, "contestation.file"), eq(auditLog.subjectId, row!.id)));
    expect(audit).toMatchObject({ actorUserId: a.id, actorType: "user" });
    expect(JSON.stringify(audit!.payload)).not.toContain("Zorglub");

    expect((await file(w, a, w.attempt.a, 0)).json()).toMatchObject({ error: "contestation_exists" });
  });

  it("refuses what the student's results do not offer: full points, a pending grading, a neutralized question", async () => {
    const w = await world();
    expect((await file(w, a, w.attempt.a, 1)).json()).toMatchObject({ error: "not_contestable", reason: "full_points" });
    expect((await file(w, a, w.attempt.a, 2)).json()).toMatchObject({ error: "not_contestable", reason: "pending" });
    const neutralized = await send("PUT", `/app/api/evaluations/${w.seed.evaluationId}/items/${w.itemIds[0]}/counting`, { counting: "neutralized" });
    expect(neutralized.statusCode, neutralized.body).toBe(200);
    expect((await file(w, a, w.attempt.a, 0)).json()).toMatchObject({ error: "not_contestable", reason: "not_counting" });
  });

  it("contests an unanswered question: its zero is a grading", async () => {
    const w = await world();
    // Question 0 was answered; question 1 at full points is not; make B's question 1 an unanswered zero.
    await writeGrading(db(), {
      attemptId: w.attempt.b,
      itemId: w.itemIds[1]!,
      answerId: null,
      points: 0,
      maxPoints: 1,
      source: "auto",
      state: "validated",
      details: null,
      now: server.clock.now(),
    });
    expect((await file(w, b, w.attempt.b, 1)).statusCode).toBe(200);
  });

  it("refuses the attempt that does not count", async () => {
    const w = await world();
    const [original] = await db().select().from(attempts).where(eq(attempts.id, w.attempt.a));
    const second = randomUUID();
    await db().insert(attempts).values({ ...original!, id: second, attemptNumber: 2, createdAt: new Date(original!.createdAt.getTime() + 1) });
    for (const itemId of w.itemIds) {
      await writeGrading(db(), { attemptId: second, itemId, answerId: null, points: 1, maxPoints: 1, source: "manual", state: "validated", details: null, now: server.clock.now() });
    }
    // The best of the two counts (ADR-025): the second, at full points.
    expect((await file(w, a, w.attempt.a, 0)).json()).toMatchObject({ error: "not_contestable", reason: "not_counted" });
  });

  it("refuses before the release, after an unrelease, past the window, and in an archived classroom", async () => {
    const before = await world({ release: false });
    expect((await file(before, a, before.attempt.a, 0)).json()).toMatchObject({ error: "contestation_closed" });

    const w = await world();
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/unrelease`, {})).statusCode).toBe(200);
    expect((await file(w, a, w.attempt.a, 0)).json()).toMatchObject({ error: "contestation_closed" });

    const archived = await world();
    await db().update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, archived.seed.classroomId));
    expect((await file(archived, a, archived.attempt.a, 0)).json()).toMatchObject({ error: "classroom_archived" });
  });

  it("decides the window on the database's clock, never on the request's", async () => {
    const w = await world();
    // The server's clock far ahead: the view says closed, the database's says open, and decides.
    const real = server.clock.now();
    server.clock.set(new Date(real.getTime() + 30 * DAY_MS));
    const feedback = (await get(`/app/api/attempts/${w.attempt.a}/feedback`, a)).json() as StudentFeedback;
    if (!feedback.available) throw new Error("feedback expected");
    expect(feedback.items.find((i) => i.itemId === w.itemIds[0])!.contestable).toBe(false);
    expect((await file(w, a, w.attempt.a, 0)).statusCode).toBe(200);

    // The stored instant just passed on the database's clock: refused, whatever the server's says.
    server.clock.set(real);
    await db().update(evaluations).set({ contestationClosesAt: sql`now() - interval '1 second'` }).where(eq(evaluations.id, w.seed.evaluationId));
    expect((await file(w, b, w.attempt.b, 0)).json()).toMatchObject({ error: "contestation_closed" });
  });

  it("is the caller's own attempt, from a portal session, with a reason", async () => {
    const w = await world();
    expect((await file(w, b, w.attempt.a, 0)).statusCode).toBe(404);
    expect((await file(w, a, w.attempt.a, 0, "   ")).statusCode).toBe(400);
    expect((await file(w, a, w.attempt.a, 0, "x".repeat(2001))).statusCode).toBe(400);
    const seb = await sessionOf(db(), a.id, { kind: "seb", evaluationId: w.seed.evaluationId });
    expect((await send("POST", fileUrl(w.attempt.a, w.itemIds[0]!), { reason: "why" }, seb)).statusCode).toBe(401);
    expect(await db().select().from(contestations).where(eq(contestations.attemptId, w.attempt.a))).toEqual([]);
  });

  it("tells the course's staff, folded per evaluation; a staff seat's test tells nobody", async () => {
    const w = await world();
    const unread = async (userId: string) =>
      (await bells(userId, "contestation_filed")).filter((n) => n.evaluationId === w.seed.evaluationId);
    await filed(w, a, w.attempt.a);
    await filed(w, b, w.attempt.b);
    for (const staff of [teacher, assistant]) {
      const rows = await unread(staff.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toMatchObject({ kind: "contestation_filed", count: 2, evaluationId: w.seed.evaluationId });
    }
    await filed(w, teacher, w.attempt.staff);
    expect((await unread(teacher.id))[0]!.payload).toMatchObject({ count: 2 });
  });
});

describe("the hints of a contestation (N-SEC-20)", () => {
  it("tell the course's staff of a filing, never the classroom where every classmate listens", async () => {
    const w = await world();
    const topics: string[] = [];
    const off = subscribe((e) => {
      if (e.kind === "hint") topics.push(...e.topics);
    });
    const row = await filed(w, a, w.attempt.a);
    // The generic hint is the `onResponse` hook's, after the answer is out.
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    const onFiling = [...topics];
    topics.length = 0;
    expect((await resolve(row.id, { verdict: "accepted" })).statusCode).toBe(200);
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    off();
    expect(onFiling).toContain(`course:${w.seed.courseId}`);
    // No classmate, nor the student who filed: they have the POST's reply.
    const students = [`user:${a.id}`, `user:${b.id}`];
    expect(onFiling.filter((t) => t.startsWith("classroom:") || students.includes(t))).toEqual([]);
    // The answer: the staff and the one student it concerns.
    expect(topics).toEqual(expect.arrayContaining([`course:${w.seed.courseId}`, `user:${a.id}`]));
    expect(topics.filter((t) => t.startsWith("classroom:") || t === `user:${b.id}`)).toEqual([]);
  });
});

describe("the staff's reads (ADR-139)", () => {
  it("carry the contestation on the queue's cell, nameless; count the open ones on the steps, the results and the gradebook — a test walk nowhere", async () => {
    const w = await world();
    await filed(w, a, w.attempt.a, 0, "Reason of A");
    await filed(w, b, w.attempt.b, 0, "Reason of B");
    await filed(w, teacher, w.attempt.staff, 0, "Teacher's test");
    const first = (await db().select().from(contestations).where(eq(contestations.attemptId, w.attempt.b)))[0]!;
    expect((await resolve(first.id, { verdict: "accepted" })).statusCode).toBe(200);

    const queue = (await get(`/app/api/evaluations/${w.seed.evaluationId}/grading?itemId=${w.itemIds[0]}`)).json() as GradingQueue;
    const entry = queue.entries.find((e) => e.attemptId === w.attempt.a)!;
    expect(entry.label).toBeNull();
    expect(entry.contestation).toMatchObject({ state: "open", reason: "Reason of A", counted: true });
    expect(JSON.stringify(entry.contestation)).not.toContain("Nom");
    expect(queue.entries.find((e) => e.attemptId === w.attempt.b)!.contestation).toMatchObject({ state: "accepted" });
    expect(queue.entries.find((e) => e.attemptId === w.attempt.staff)).toMatchObject({ staff: true, contestation: { reason: "Teacher's test" } });

    const steps = (await get(`/app/api/evaluations/${w.seed.evaluationId}/grading/steps`)).json() as GradingSteps;
    expect(steps.steps.map((s) => s.contested)).toEqual([1, 0, 0]);

    const view = (await get(`/app/api/evaluations/${w.seed.evaluationId}/results`)).json() as ResultsView;
    expect(view.openContestations).toBe(1);
    expect(view.rows.map((r) => [r.attemptId, r.openContestations])).toEqual(
      expect.arrayContaining([
        [w.attempt.a, 1],
        [w.attempt.b, 0],
        [w.attempt.staff, 0],
      ]),
    );
    const csv = (await get(`/app/api/evaluations/${w.seed.evaluationId}/results.csv`)).body;
    expect(csv).not.toContain("Reason of A");

    const table = GradebookStaff.parse((await get(`/app/api/classrooms/${w.seed.classroomId}/gradebook`)).json());
    expect(table.columns.find((c) => c.activityId === w.seed.evaluationId)!.openContestations).toBe(1);
  });
});

describe("answering (ADR-139)", () => {
  it("is the course owner's, once; a refusal carries a reply; the student is told", async () => {
    const w = await world();
    const row = await filed(w, a, w.attempt.a);
    expect((await resolve(row.id, { verdict: "refused", reply: "No." }, assistant)).json()).toMatchObject({ error: "owner_required" });
    expect((await resolve(row.id, { verdict: "refused" })).statusCode).toBe(400);
    expect((await resolve(row.id, { verdict: "refused", reply: "x".repeat(2001) })).statusCode).toBe(400);

    const refused = await resolve(row.id, { verdict: "refused", reply: "The key holds." });
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json()).toMatchObject({ contestation: { state: "refused", reply: "The key holds.", counted: true }, grading: null });
    const [stored] = await db().select().from(contestations).where(eq(contestations.id, row.id));
    expect(stored).toMatchObject({ state: "refused", resolvedBy: teacher.id, gradingAtResolutionId: (await validated(w.attempt.a, w.itemIds[0]!)).id });
    expect((await resolve(row.id, { verdict: "accepted" })).json()).toMatchObject({ error: "not_open" });

    const told = (await bells(a.id, "contestation_resolved")).filter((n) => n.evaluationId === w.seed.evaluationId);
    expect(told.map((n) => n.payload)).toEqual([
      { kind: "contestation_resolved", evaluationId: w.seed.evaluationId, evaluationTitle: expect.any(String), attemptId: w.attempt.a },
    ]);
    const [audit] = await db().select().from(auditLog).where(and(eq(auditLog.action, "contestation.resolve"), eq(auditLog.subjectId, row.id)));
    expect(audit!.payload).toEqual({
      evaluationId: w.seed.evaluationId,
      verdict: "refused",
      points: false,
      gradingBefore: stored!.gradingAtResolutionId,
      gradingAfter: stored!.gradingAtResolutionId,
    });
  });

  it("accepts with the points unchanged, or with new points written as a manual override in the same act", async () => {
    const w = await world();
    const bare = await filed(w, a, w.attempt.a);
    const accepted = await resolve(bare.id, { verdict: "accepted" });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as ContestationResolution).grading).toBeNull();
    expect((await validated(w.attempt.a, w.itemIds[0]!)).points).toBe(0);

    const row = await filed(w, b, w.attempt.b);
    const before = await validated(w.attempt.b, w.itemIds[0]!);
    expect((await resolve(row.id, { verdict: "accepted", points: 1 })).statusCode).toBe(400);
    expect((await resolve(row.id, { verdict: "refused", points: 1, reply: "x" })).statusCode).toBe(400);
    expect((await resolve(row.id, { verdict: "accepted", points: 5, reply: "Right." })).json()).toMatchObject({ error: "points_out_of_range" });
    expect((await db().select().from(contestations).where(eq(contestations.id, row.id)))[0]!.state).toBe("open");

    const res = await resolve(row.id, { verdict: "accepted", points: 1, reply: "You are right." });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as ContestationResolution;
    expect(body).toMatchObject({ modifiedAfterRelease: true, contestation: { state: "accepted", reply: "You are right." } });
    const after = await validated(w.attempt.b, w.itemIds[0]!);
    expect(after).toMatchObject({ id: body.grading!.id, points: 1, source: "manual", comment: "You are right.", supersedesId: before.id });
    const [stored] = await db().select().from(contestations).where(eq(contestations.id, row.id));
    expect(stored!.gradingAtResolutionId).toBe(after.id);
    expect((await reload(db(), w.seed.evaluationId)).modifiedAfterRelease).toBe(true);
    // Both arrive: the grade moved, and the contestation was answered.
    const ofThis = (rows: { evaluationId: string | null }[]) => rows.filter((n) => n.evaluationId === w.seed.evaluationId);
    expect(ofThis(await bells(b.id, "results_updated"))).toHaveLength(1);
    expect(ofThis(await bells(b.id, "contestation_resolved"))).toHaveLength(1);
    const [audit] = await db().select().from(auditLog).where(and(eq(auditLog.action, "contestation.resolve"), eq(auditLog.subjectId, row.id)));
    expect(audit!.payload).toMatchObject({ points: true, gradingBefore: before.id, gradingAfter: after.id });
  });

  it("rolls the override back when the contestation was answered meanwhile", async () => {
    const w = await world();
    const row = await filed(w, a, w.attempt.a);
    expect((await resolve(row.id, { verdict: "accepted" })).statusCode).toBe(200);
    const evaluation = await reload(db(), w.seed.evaluationId);
    const [item] = (await joinedItems(db(), evaluation.id)).filter((i) => i.item.id === w.itemIds[0]);
    // A second answer that loaded the row while it was still open.
    await expect(
      resolveContestation(db(), {
        contestation: row,
        evaluation,
        item: item!,
        body: { verdict: "accepted", reply: "Late.", points: 1 },
        userId: teacher.id,
        now: server.clock.now(),
      }),
    ).rejects.toThrow(GradingError);
    expect((await validated(w.attempt.a, w.itemIds[0]!)).points).toBe(0);
  });

  it("survives an unrelease and is still answered; a staff seat's test tells nobody", async () => {
    const w = await world();
    const row = await filed(w, a, w.attempt.a);
    const test = await filed(w, teacher, w.attempt.staff);
    expect((await send("POST", `/app/api/evaluations/${w.seed.evaluationId}/unrelease`, {})).statusCode).toBe(200);
    expect((await resolve(row.id, { verdict: "refused", reply: "Still no." }, assistant)).json()).toMatchObject({ error: "owner_required" });
    expect((await resolve(row.id, { verdict: "refused", reply: "Still no." })).statusCode).toBe(200);
    expect((await resolve(test.id, { verdict: "accepted" })).statusCode).toBe(200);
    expect((await bells(teacher.id, "contestation_resolved")).filter((n) => n.evaluationId === w.seed.evaluationId)).toEqual([]);
  });
});

describe("the student exit (invariant 4)", () => {
  const REASON = "SENTINEL-REASON-7f3c";
  const REPLY = "SENTINEL-REPLY-9a1d";
  const PROPOSED = "SENTINEL-PROPOSED-3b7e";

  it("carries a contestation in its own student's feedback only", async () => {
    // Two students with no other history, so that every response of B's may be searched by key.
    a = await server.signIn("student");
    b = await server.signIn("student");
    const w = await world();
    const row = await filed(w, a, w.attempt.a, 0, REASON);
    // An assistant's proposal (ADR-139 §14) reaches no student while it stands: its reply and its points.
    const proposed = await send("PUT", `/app/api/contestations/${row.id}/proposal`, { verdict: "accepted", points: 0.75, reply: PROPOSED });
    expect(proposed.statusCode, proposed.body).toBe(200);
    for (const [url, who] of [
      [`/app/api/attempts/${w.attempt.a}/feedback`, a],
      [`/app/api/attempts/${w.attempt.a}/copy.json`, a],
      ["/app/api/student/results", a],
      ["/app/api/notifications", a],
      ["/app/api/me/export", a],
      [`/app/api/attempts/${w.attempt.b}/feedback`, b],
    ] as const) {
      const res = await get(url, who);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect(res.body, url).not.toContain(PROPOSED);
      expect(res.body, url).not.toMatch(/"proposal"|"proposedAt"|"points":0\.75[,}]/);
    }
    expect((await resolve(row.id, { verdict: "refused", reply: REPLY })).statusCode).toBe(200);

    // A reads their own, and nowhere else.
    const own = (await get(`/app/api/attempts/${w.attempt.a}/feedback`, a)).json() as StudentFeedback;
    if (!own.available) throw new Error("feedback expected");
    expect(own.contestationClosesAt).toBe((await closesAt(w.seed.evaluationId))!.toISOString());
    expect(own.items.find((i) => i.itemId === w.itemIds[0])).toMatchObject({
      contestable: false,
      contestation: { state: "refused", reason: REASON, reply: REPLY },
    });
    for (const url of [
      `/app/api/attempts/${w.attempt.a}/copy.json`,
      "/app/api/student/results",
      "/app/api/student/home",
      "/app/api/notifications",
      `/app/api/student/classrooms/${w.seed.classroomId}/gradebook`,
    ]) {
      const res = await get(url, a);
      expect(res.statusCode, `${url} ${res.body}`).toBe(200);
      expect(res.body, url).not.toContain(REASON);
      expect(res.body, url).not.toContain(REPLY);
    }
    // The copy file carries no contestation by key either (its contract strips them).
    expect((await get(`/app/api/attempts/${w.attempt.a}/copy.json`, a)).body).not.toMatch(/"contestation"|"contestable"|"contestationClosesAt"/);

    // B — by their own session, by an impersonation of B, and the teacher on
    // their staff seat in the student view — never sees A's. Each response's
    // status is asserted, so a refusal cannot pass the search vacuously.
    const theirs = (await get(`/app/api/attempts/${w.attempt.b}/feedback`, b)).json() as StudentFeedback;
    if (!theirs.available) throw new Error("feedback expected");
    expect(theirs.items.map((i) => i.contestation)).toEqual([null, null, null]);
    expect(theirs.items.find((i) => i.itemId === w.itemIds[0])!.contestable).toBe(true);
    const asB: [string, number][] = [
      [`/app/api/attempts/${w.attempt.b}/feedback`, 200],
      [`/app/api/attempts/${w.attempt.b}/copy.json`, 200],
      [`/app/api/attempts/${w.attempt.a}/feedback`, 404],
      ["/app/api/student/results", 200],
      ["/app/api/student/home", 200],
      ["/app/api/notifications", 200],
      [`/app/api/student/classrooms/${w.seed.classroomId}`, 200],
      [`/app/api/student/classrooms/${w.seed.classroomId}/gradebook`, 200],
      [`/app/api/evaluations/${w.seed.evaluationId}/results/by-question`, 403],
      [`/app/api/evaluations/${w.seed.evaluationId}/grading`, 403],
    ];
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(db(), b.id, { kind: "impersonation", actorUserId: admin.id });
    const readers: [string, Actor | Record<string, string>, [string, number][]][] = [
      ["B", b, [...asB, ["/app/api/me/export", 200]]],
      // A copy file is the person's own session's (`session_required`).
      ["an impersonation of B", impersonation, asB.map(([url, status]): [string, number] => [url, url.endsWith("copy.json") ? 403 : status])],
      [
        "the teacher's staff seat",
        teacher,
        [
          [`/app/api/attempts/${w.attempt.staff}/feedback`, 200],
          [`/app/api/attempts/${w.attempt.a}/feedback`, 404],
          ["/app/api/student/results", 200],
          ["/app/api/student/home", 200],
          [`/app/api/student/classrooms/${w.seed.classroomId}/gradebook?view=student`, 200],
        ],
      ],
    ];
    for (const [who, headers, urls] of readers) {
      for (const [url, status] of urls) {
        const res = await get(url, headers);
        expect(res.statusCode, `${who} ${url} ${res.body}`).toBe(status);
        expect(res.body, `${who} ${url}`).not.toContain(REASON);
        expect(res.body, `${who} ${url}`).not.toContain(REPLY);
        expect(res.body, `${who} ${url}`).not.toContain(PROPOSED);
        // By key too: no contestation of anyone's travels to these readers (none filed one).
        expect(res.body, `${who} ${url}`).not.toMatch(/"(filedAt|resolvedAt)"|"contestation":\{/);
      }
    }
    // The class debrief, the staff's projection, carries nothing of it either.
    const debrief = await get(`/app/api/evaluations/${w.seed.evaluationId}/results/by-question`);
    expect(debrief.statusCode).toBe(200);
    expect(debrief.body).not.toContain(REASON);
  });
});
