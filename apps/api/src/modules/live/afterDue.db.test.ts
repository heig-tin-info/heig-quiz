/**
 * Practice after the due date (ADR-122, #985) against the real migrations:
 * a practice attempt starts on an exercise that is over, follows its own
 * deadline, is graded at its hand-in (by the model too, as a practice
 * result), and counts NOWHERE — not the kept attempt, the grade, the
 * release, the grading queue, the dashboard. Its student payload is the
 * student view's like every other (invariant 4).
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FeedbackPolicy, StudentHome } from "@quiz/contracts";
import { PRACTICE_DEFAULT_S } from "@quiz/domain";
import type { GradeResult } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attemptEvents, attempts, classrooms, evaluations, gradings, notifications } from "../../db/schema.js";
import { testApp } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { sessionOf, type TestServer, testServer } from "../../test/http.js";
import { keyOpen } from "../drill/serving.js";
import { keysOf } from "../../test/keys.js";
import { kioskStation } from "../../test/kiosk.js";
import { enterStarted, reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems, setAfterDue, type EvaluationRecord } from "../evaluation/service.js";
import { gradingQueue, keptAttempts, progressOf } from "../grading/service.js";
import type { GradingLlm } from "../llm/service.js";
import { StubLlm } from "../llm/stub.js";
import * as results from "../results/service.js";
import { FORBIDDEN_STUDENT_KEYS } from "./studentView.js";
import * as live from "./service.js";

let server: TestServer;
let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  db = server.app.db;
});
afterAll(async () => {
  await server.close();
  restore();
});

async function appFor() {
  const app = await testApp(db);
  app.clock.set("2026-11-02T09:00:00.000Z");
  return app;
}
type App = Awaited<ReturnType<typeof appFor>>;

const participant = async (evaluation: EvaluationRecord, userId: string) =>
  (await live.participantOf(db, evaluation, userId))!;

/** Answers each item right or wrong, hands the attempt in and grades it, as the submit route does. */
async function answerAndSubmit(app: App, evaluation: EvaluationRecord, attempt: live.AttemptRecord, right: readonly boolean[]) {
  const items = await joinedItems(db, evaluation.id);
  const now = app.clock.now();
  for (const [index, ok] of right.entries()) {
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[index]!.item.id,
      payload: ok ? `answer-q${index}` : "nope",
      revision: 1,
      now,
    });
  }
  const submitted = await live.submitAttempt(db, evaluation, attempt, now, app);
  app.clock.advance(1000);
  return submitted;
}

/**
 * A closed exercise of two one-point questions: the first student sat it
 * (one right, one wrong), the second never came.
 */
async function closedExercise(
  options: {
    feedback?: Partial<FeedbackPolicy>;
    settings?: NonNullable<Parameters<typeof seedLive>[1]>["settings"];
    durationS?: number | null;
    users?: string[];
  } = {},
) {
  const app = await appFor();
  const seed = await seedLive(db, {
    mode: "exercise",
    students: 2,
    questions: 2,
    durationS: options.durationS ?? null,
    settings: { timing: options.durationS ? "duration" : "manual", lobby: "skip", ...options.settings },
    ...(options.users ? { studentIds: options.users } : {}),
  });
  await db
    .update(evaluations)
    .set({ feedbackPolicy: { when: "on_release", showAnswer: true, showKey: true, showExplanation: false, showHiddenCaseNames: true, showTeacherComment: true, ...options.feedback } })
    .where(eq(evaluations.id, seed.evaluationId));
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const student = seed.studentIds[0]!;
  const { attempt } = await enterStarted(db, { evaluation, participant: await participant(evaluation, student), now: app.clock.now() });
  const official = await answerAndSubmit(app, evaluation, attempt, [true, false]);
  evaluation = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
  return { app, seed, evaluation, student, official };
}

async function practise(app: App, evaluation: EvaluationRecord, userId: string) {
  return live.startPractice(db, {
    evaluation: await reload(db, evaluation.id),
    participant: await participant(evaluation, userId),
    archived: null,
    now: app.clock.now(),
  });
}

/** The student home's "Past series" (ADR-122). */
const pastSeries = async (userId: string) => (await live.studentHome(db, userId, new Date())).practice;

const refusal = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof live.PracticeRefused) return error.reason;
    if (error instanceof live.RateLimited) return `rate_limited:${error.retryAfterS}`;
    return `other:${(error as Error).message}`;
  }
};

describe("starting a practice attempt (ADR-122 §2, §3, §5)", () => {
  it("starts on a closed exercise, blank, on its own deadline of eight hours, never the current attempt", async () => {
    const { app, evaluation, student, official } = await closedExercise();
    const { row, created } = await practise(app, evaluation, student);

    expect(created).toBe(true);
    expect(row).toMatchObject({ afterDue: true, state: "in_progress", attemptNumber: 2, acquiredItemIds: [] });
    expect(row.deadlineAt!.getTime() - row.startedAt!.getTime()).toBe(PRACTICE_DEFAULT_S * 1000);
    // The student's current attempt stays the official one.
    expect((await live.attemptOf(db, evaluation.id, student))?.id).toBe(official.id);

    // Its writes pass the gate on an evaluation that is over.
    const view = await live.attemptView(db, evaluation, row, app.clock.now());
    expect(view.attempt).toMatchObject({ practice: true, readOnly: false });
    const items = await joinedItems(db, evaluation.id);
    await expect(
      live.saveAnswer(db, { evaluation, attempt: row, itemId: items[0]!.item.id, payload: "x", revision: 1, now: app.clock.now() }),
    ).resolves.toBeDefined();

    // A second Start resumes it rather than opening another.
    const again = await practise(app, evaluation, student);
    expect(again).toMatchObject({ created: false, row: { id: row.id } });
    // The entry route resumes it too.
    const entry = await live.practiceEntry(db, { evaluation, participant: await participant(evaluation, student), archived: null, now: app.clock.now() });
    expect(entry.kind).toBe("attempt");
  });

  it("takes the exercise's own time limit and the accommodation, never cut at its closing", async () => {
    const { app, evaluation, student } = await closedExercise({ durationS: 1200 });
    const { row } = await practise(app, evaluation, student);
    expect(row.deadlineAt!.getTime() - row.startedAt!.getTime()).toBe(1200 * 1000);
    const entry = await live.practiceEntry(db, {
      evaluation,
      participant: await participant(evaluation, student),
      archived: null,
      now: app.clock.now(),
    });
    expect(entry.kind).toBe("attempt");
  });

  it("answers the ready screen with the practice's conditions before a new one", async () => {
    const { app, evaluation, student } = await closedExercise();
    const entry = await live.practiceEntry(db, { evaluation, participant: await participant(evaluation, student), archived: null, now: app.clock.now() });
    expect(entry.kind).toBe("ready");
    if (entry.kind !== "ready") return;
    const keys = entry.view.conditions.imposed.map((line) => line.key);
    expect(keys).toContain("duration");
    expect(keys).not.toContain("deadline");
    expect(keys).not.toContain("visibility_logged");
  });

  it("refuses where the practice is hidden, not over, archived, or behind a trusted client", async () => {
    // Hidden by the teacher.
    const hidden = await closedExercise();
    await setAfterDue(db, hidden.evaluation, "hidden", hidden.app.clock.now());
    expect(await refusal(practise(hidden.app, hidden.evaluation, hidden.student))).toBe("hidden");
    // Open by default whatever the stored feedback policy: the key is shown at the hand-in (ADR-124).
    const none = await closedExercise({ feedback: { when: "none", showKey: false } });
    expect(await refusal(practise(none.app, none.evaluation, none.student))).toBeNull();
    // Archived classroom.
    const archived = await closedExercise();
    await db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, archived.seed.classroomId));
    expect(await refusal(practise(archived.app, archived.evaluation, archived.student))).toBe("archived");
    // A Safe Exam Browser exercise.
    const seb = await closedExercise({ settings: { safeExamBrowser: true } });
    expect(await refusal(practise(seb.app, seb.evaluation, seb.student))).toBe("hidden");
    // Still running: the ordinary attempt is what the student takes.
    const app = await appFor();
    const seed = await seedLive(db, { mode: "exercise", durationS: null, settings: { timing: "manual", lobby: "skip" } });
    const running = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    expect(await refusal(practise(app, running, seed.studentIds[0]!))).toBe("not_over");
    // An exam never.
    expect(() => setAfterDue(db, { ...running, mode: "exam" }, "open", app.clock.now())).rejects.toThrow();
  });

  it("starts at most one new practice attempt a minute", async () => {
    const { app, evaluation, student } = await closedExercise();
    const { row } = await practise(app, evaluation, student);
    await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);
    expect(await refusal(practise(app, evaluation, student))).toMatch(/^rate_limited:\d+$/);
    app.clock.advance(60_000);
    expect(await refusal(practise(app, evaluation, student))).toBeNull();
  });
});

describe("a practice attempt counts nowhere (ADR-122 §4)", () => {
  it("leaves the kept attempt, the grade table, the release and the student's grade alone", async () => {
    const { app, evaluation, student, official } = await closedExercise({
      settings: { retakes: { enabled: true, keep: "best", maxAttempts: 2 } },
    });
    const { row } = await practise(app, evaluation, student);
    const practice = await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);

    // Graded at its hand-in, the evaluation being closed: 2 / 2.
    const cells = await db.select().from(gradings).where(and(eq(gradings.attemptId, practice.id), eq(gradings.state, "validated")));
    expect(cells.map((c) => c.points).reduce((a, b) => a + b, 0)).toBe(2);

    // The kept attempt is the official one, despite `best` and a higher score.
    expect((await keptAttempts(db, await reload(db, evaluation.id))).get(student)?.id).toBe(official.id);
    const view = await results.resultsView(db, await reload(db, evaluation.id));
    const mine = view.rows.find((r) => r.userId === student)!;
    expect(mine).toMatchObject({ attemptId: official.id, points: 1 });
    expect(view.practisedCount).toBe(1);

    // The grading queue and its progress know nothing of it.
    const queue = await gradingQueue(db, await reload(db, evaluation.id), { anonymous: true });
    expect(queue.entries.some((e) => e.attemptId === practice.id)).toBe(false);
    const progress = await progressOf(db, evaluation.id);
    expect(progress.total).toBe(2 * 1);

    // The dashboard's row is the official attempt.
    const dashboard = await live.dashboardView(db, await reload(db, evaluation.id), {
      now: app.clock.now(),
      includeAnswers: false,
      includeResults: false,
      caller: { id: randomUUID(), reach: "staff" } as never,
    });
    const rowIds = JSON.stringify(dashboard);
    expect(rowIds).toContain(official.id);
    expect(rowIds).not.toContain(practice.id);

    // The release freezes the official points.
    await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
    const released = await reload(db, evaluation.id);
    const frozen = (released.releasedGrades as { rows: { userId: string; attemptId: string; points: number }[] }).rows;
    expect(frozen.find((r) => r.userId === student)).toMatchObject({ attemptId: official.id, points: 1 });
    // …and the release is not marked modified by the practice's grading.
    expect(released.modifiedAfterRelease).toBe(false);

    // The student's card and its grade are the official attempt's.
    const home = await live.studentHome(db, student, app.clock.now());
    const card = home.past.find((c) => c.id === evaluation.id)!;
    expect(card.attemptId).toBe(official.id);
    expect(card.retakes?.attemptCount).toBe(1);
  });

  it("is expired by the ticker at its own deadline, and graded", async () => {
    const { app, evaluation, student } = await closedExercise();
    const { row } = await practise(app, evaluation, student);
    const items = await joinedItems(db, evaluation.id);
    await live.saveAnswer(db, { evaluation, attempt: row, itemId: items[0]!.item.id, payload: "answer-q0", revision: 1, now: app.clock.now() });

    app.clock.advance(PRACTICE_DEFAULT_S * 1000);
    // The database is the file's: other tests' attempts may expire beside it.
    const early = await live.expireDueAttempts(db, app.clock.now(), app);
    expect(early.some((a) => a.id === row.id)).toBe(false);
    app.clock.advance(4000);
    const expired = await live.expireDueAttempts(db, app.clock.now(), app);
    expect(expired.some((a) => a.id === row.id)).toBe(true);
    const cells = await db.select().from(gradings).where(eq(gradings.attemptId, row.id));
    expect(cells.filter((c) => c.state === "validated").map((c) => c.points).sort()).toEqual([0, 1]);
    // A write past the deadline is refused like any attempt's (invariant 5).
    await expect(
      live.saveAnswer(db, { evaluation, attempt: (await live.attemptById(db, row.id))!, itemId: items[1]!.item.id, payload: "x", revision: 1, now: app.clock.now() }),
    ).rejects.toBeInstanceOf(live.AttemptClosedError);
  });

  it("leaves a released exercise unmodified and tells nobody when a practice attempt is graded after the release", async () => {
    const { app, evaluation, student } = await closedExercise();
    await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
    const { row } = await practise(app, evaluation, student);
    await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);
    const graded = await db.select().from(gradings).where(and(eq(gradings.attemptId, row.id), eq(gradings.state, "validated")));
    expect(graded).toHaveLength(2);
    expect((await reload(db, evaluation.id)).modifiedAfterRelease).toBe(false);
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.evaluationId, evaluation.id), sql`${notifications.payload}->>'kind' = 'results_updated'`));
    expect(told).toHaveLength(0);
  });

  it("never hides a drill key the exercise shows while a practice attempt is in progress", async () => {
    const { app, evaluation, student } = await closedExercise({ feedback: { when: "immediate", showKey: true } });
    const card = { evaluationId: evaluation.id, userId: student };
    expect((await keyOpen(db, [card]))(card)).toBe(true);
    await practise(app, evaluation, student);
    expect((await keyOpen(db, [card]))(card)).toBe(true);
  });

  it("accepts a write until its deadline plus the grace, and refuses it after (invariant 5)", async () => {
    const { app, evaluation, student } = await closedExercise({ durationS: 600 });
    const { row } = await practise(app, evaluation, student);
    const [item] = await joinedItems(db, evaluation.id);
    const at = (ms: number) => new Date(row.deadlineAt!.getTime() + ms);
    const write = (revision: number, now: Date) =>
      live.saveAnswer(db, { evaluation, attempt: row, itemId: item!.item.id, payload: `r${revision}`, revision, now });
    await expect(write(1, at(2000))).resolves.toBeDefined();
    await expect(write(2, at(4000))).rejects.toBeInstanceOf(live.AttemptClosedError);
  });
});

describe("what a student reads of a practice attempt (ADR-122 §7, invariant 4)", () => {
  it("passes through the student view: no key while it is written, the key once handed in", async () => {
    const { app, evaluation, student } = await closedExercise({ feedback: { when: "immediate", showKey: false } });
    const { row } = await practise(app, evaluation, student);
    const view = await live.attemptView(db, evaluation, row, app.clock.now());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("answer-q0");
    expect(serialized).not.toContain("answer-q1");
    const keys = keysOf(view);
    for (const key of FORBIDDEN_STUDENT_KEYS) expect(keys.has(key), key).toBe(false);

    // ADR-124: an exercise shows its key at the hand-in, `showKey: false` stored or not.
    const submitted = await answerAndSubmit(app, await reload(db, evaluation.id), row, [false, false]);
    const feedback = await results.studentFeedback(db, await reload(db, evaluation.id), submitted, app.clock.now());
    expect(feedback).toMatchObject({ available: true, practice: true, grade: null, points: 0 });
    const text = JSON.stringify(feedback);
    expect(text).toContain("answer-q0");
    expect(text).toContain("answer-q1");
  });

  it("shows the whole correction at the hand-in, whatever the stored policy (ADR-124)", async () => {
    for (const stored of [{ when: "on_release" }, { when: "none", showKey: false }] as const) {
      const { app, evaluation, student } = await closedExercise({ feedback: stored });
      const { row } = await practise(app, evaluation, student);
      const done = await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, false]);
      const feedback = await results.studentFeedback(db, await reload(db, evaluation.id), done, app.clock.now());
      expect(feedback, stored.when).toMatchObject({ available: true, practice: true, grade: null, points: 1, totalPoints: 2 });
      if (!feedback.available) continue;
      expect(feedback.items.every((item) => item.solution !== null), stored.when).toBe(true);
      // The home's Past series card carries the score too.
      const cards = await pastSeries(student);
      expect(cards.find((c) => c.id === evaluation.id)?.last, stored.when).toMatchObject({
        attemptId: done.id,
        score: { points: 1, totalPoints: 2 },
      });
    }
  });


  it("lists the exercise in the student's Past series, with the latest practice score", async () => {
    const { app, evaluation, student, seed } = await closedExercise();
    expect((await pastSeries(student)).find((c) => c.id === evaluation.id)).toMatchObject({
      openAttemptId: null,
      count: 0,
      last: null,
    });
    const { row } = await practise(app, evaluation, student);
    expect((await pastSeries(student)).find((c) => c.id === evaluation.id)?.openAttemptId).toBe(row.id);
    await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);
    expect((await pastSeries(student)).find((c) => c.id === evaluation.id)).toMatchObject({
      openAttemptId: null,
      count: 1,
      last: { attemptId: row.id, score: { points: 2, totalPoints: 2, pendingCount: 0 } },
    });
    // Hidden: gone from the list.
    await setAfterDue(db, evaluation, "hidden", app.clock.now());
    expect((await pastSeries(seed.studentIds[1]!)).some((c) => c.id === evaluation.id)).toBe(false);
  });
});

describe("the practice routes (ADR-122 §5)", () => {
  it("starts over HTTP, keeps no journal, and answers its refusals with their codes", async () => {
    const student = await server.signIn("student");
    const other = await server.signIn("student");
    const { evaluation } = await closedExercise({ users: [student.id, other.id] });
    const url = `/app/api/evaluations/${evaluation.id}/practice`;

    const ready = await server.app.inject({ method: "POST", url, headers: other.headers });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ kind: "ready" });

    const started = await server.app.inject({ method: "POST", url: `${url}/start`, headers: other.headers });
    expect(started.statusCode).toBe(200);
    const view = started.json() as { kind: string; view: { attempt: { id: string; practice: boolean } } };
    expect(view).toMatchObject({ kind: "attempt", view: { attempt: { practice: true } } });
    const attemptId = view.view.attempt.id;

    // The integrity journal is off: answered, and nothing stored.
    const event = await server.app.inject({
      method: "POST",
      url: `/app/api/attempts/${attemptId}/events`,
      headers: other.headers,
      payload: { kind: "visibility", details: { state: "hidden" } },
    });
    expect(event.statusCode).toBe(204);
    expect(await db.select().from(attemptEvents).where(eq(attemptEvents.attemptId, attemptId))).toHaveLength(0);

    // Handed in, then a new one within the minute: 429.
    const submit = await server.app.inject({ method: "POST", url: `/app/api/attempts/${attemptId}/submit`, headers: other.headers, payload: { confirm: true } });
    expect(submit.statusCode).toBe(200);
    const soon = await server.app.inject({ method: "POST", url: `${url}/start`, headers: other.headers });
    expect(soon.statusCode).toBe(429);
    expect(soon.json()).toMatchObject({ error: "rate_limited" });

    // Hidden by the teacher: 409 practice_refused, with its reason.
    await setAfterDue(db, await reload(db, evaluation.id), "hidden", new Date());
    const refused = await server.app.inject({ method: "POST", url: `${url}/start`, headers: student.headers });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "practice_refused", reason: "hidden" });

    // Somebody with no seat: the 404 of a missing evaluation (invariant 6).
    const stranger = await server.signIn("student");
    const lost = await server.app.inject({ method: "POST", url: `${url}/start`, headers: stranger.headers });
    expect(lost.statusCode).toBe(404);

    // The practice attempt is in no row of the teacher's list either.
    const rows = await db.select().from(attempts).where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.afterDue, true)));
    expect(rows).toHaveLength(1);
  });

  it("refuses a stranger, a confined session and an impersonation (invariant 6, ADR-027, ADR-034)", async () => {
    const student = await server.signIn("student");
    const admin = await server.signIn("admin");
    const { evaluation } = await closedExercise({ users: [student.id, (await server.signIn("student")).id] });
    const url = `/app/api/evaluations/${evaluation.id}/practice`;
    // A student of another classroom: the 404 of a missing evaluation.
    const elsewhere = await server.signIn("student");
    await closedExercise({ users: [elsewhere.id, (await server.signIn("student")).id] });
    for (const path of [url, `${url}/start`]) {
      expect((await server.app.inject({ method: "POST", url: path, headers: elsewhere.headers })).statusCode).toBe(404);
    }
    // A seb or kiosk session is nobody here: an exercise behind a trusted client is hidden after its due date.
    const seb = await sessionOf(db, student.id, { kind: "seb", evaluationId: evaluation.id });
    expect((await server.app.inject({ method: "POST", url: `${url}/start`, headers: seb })).statusCode).toBe(401);
    const station = await kioskStation(server.app);
    const kiosk = await sessionOf(db, student.id, { kind: "kiosk", evaluationId: evaluation.id, deviceId: station.deviceId });
    const fromStation = { ...kiosk, cookie: `${kiosk.cookie}; ${station.cookie}` };
    expect((await server.app.inject({ method: "POST", url: `${url}/start`, headers: fromStation })).statusCode).toBe(401);
    // Acting as the student reads, never writes (ADR-034).
    const as = await sessionOf(db, student.id, { kind: "impersonation", actorUserId: admin.id });
    const acted = await server.app.inject({ method: "POST", url: `${url}/start`, headers: as });
    expect(acted.statusCode).toBe(403);
    expect(acted.json()).toMatchObject({ error: "impersonation_read_only" });
    expect(await db.select().from(attempts).where(and(eq(attempts.evaluationId, evaluation.id), eq(attempts.afterDue, true)))).toHaveLength(0);
  });

  it("lists the Past series on the student's home", async () => {
    const student = await server.signIn("student");
    const { evaluation } = await closedExercise({ users: [student.id, (await server.signIn("student")).id] });
    const home = await server.app.inject({ method: "GET", url: "/app/api/student/home", headers: student.headers });
    expect(home.statusCode).toBe(200);
    expect((home.json() as StudentHome).practice?.map((c) => c.id)).toContain(evaluation.id);
  });

  it("lets a member of the course switch the practice, on an exercise only", async () => {
    const teacher = await server.signIn("teacher");
    const { evaluation } = await closedExercise({});
    const { courseStaff } = await import("../../db/schema.js");
    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, evaluation.classroomId!));
    await db.insert(courseStaff).values({ courseId: room!.courseId, userId: teacher.id });
    const res = await server.app.inject({
      method: "PUT",
      url: `/app/api/evaluations/${evaluation.id}/after-due`,
      headers: teacher.headers,
      payload: { afterDue: "hidden" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ evaluation: { afterDueOpen: false, settings: { afterDue: "hidden" } } });
  });
});

describe("a practice essay graded by the model (ADR-122 §6)", () => {
  /** A `short` that always asks the model. */
  const fakeEssay = {
    ...fakeShort,
    grade(config: { statement: string; answer: string }, answer: string | null, ctx: { itemPoints: number }): GradeResult<unknown> {
      return {
        kind: "pending",
        via: "llm",
        request: { statement: config.statement, form: "free text", rubric: config.answer, answer: answer ?? "", maxPoints: ctx.itemPoints },
        details: { reason: "llm" },
      };
    },
  } as unknown as typeof fakeShort;

  let undo: () => void;
  beforeAll(() => {
    undo = registerForTests(fakeEssay);
  });
  afterAll(() => undo());

  const stub = (): GradingLlm => {
    const llm = new StubLlm();
    return {
      ready: () => Promise.resolve(true),
      grade: (req) => llm.grade(req),
      reviewProject: () => Promise.reject(new Error("no project here")),
    };
  };

  it("validates the model's reply as the practice result, never in the teacher's queue", async () => {
    const { app, evaluation, student } = await closedExercise();
    app.llm = stub();
    const { row } = await practise(app, evaluation, student);
    const done = await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);

    const cells = await db.select().from(gradings).where(eq(gradings.attemptId, done.id));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells.filter((c) => c.state !== "superseded")) {
      expect(cell).toMatchObject({ source: "llm", state: "validated" });
    }
    const queue = await gradingQueue(db, await reload(db, evaluation.id), { anonymous: true });
    expect(queue.entries.some((e) => e.attemptId === done.id)).toBe(false);
  });

  it("leaves the cells not graded without a model", async () => {
    const { app, evaluation, student } = await closedExercise();
    const { row } = await practise(app, evaluation, student);
    const done = await answerAndSubmit(app, await reload(db, evaluation.id), row, [true, true]);
    const validated = await db.select().from(gradings).where(and(eq(gradings.attemptId, done.id), eq(gradings.state, "validated")));
    expect(validated).toHaveLength(0);
    const feedback = await results.studentFeedback(db, await reload(db, evaluation.id), done, app.clock.now());
    expect(feedback).toMatchObject({ available: true, practice: true, pendingCount: 2 });
  });
});
