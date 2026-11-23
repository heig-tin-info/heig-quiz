/**
 * Practice of a released exam (ADR-142, issue #1037) against the real
 * migrations: the teacher's switch and its refusals, who may practise and
 * when, the trusted clients and the allow-list left to the sitting, what a
 * student reads of a practice attempt (invariant 4), and — above all — that
 * practice rows on an exam change NOTHING the exam's results, grades,
 * gradebook, statistics, drill cards and personal export read.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FeedbackPolicy, StudentHome } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, classrooms, drillCards, evaluations, users } from "../../db/schema.js";
import { testApp } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Actor, sessionOf, type TestServer, testServer } from "../../test/http.js";
import { keysOf } from "../../test/keys.js";
import { enterStarted, reload, seedLive } from "../../test/live.js";
import { backfillClassroom } from "../drill/lifecycle.js";
import { applyState, joinedItems, setAfterDue, setAllowDrill, toEvaluation, type EvaluationRecord } from "../evaluation/service.js";
import { staffGradebook } from "../gradebook/service.js";
import * as org from "../org/service.js";
import { personalDataExport } from "../privacy/service.js";
import { resultsCsv } from "../results/csv.js";
import * as results from "../results/service.js";
import { poolQuestionStats } from "../stats/service.js";
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

/** The policy that lets an exam's practice open: the key at the release (ADR-142 §2). */
const SHOWN: FeedbackPolicy = {
  when: "on_release",
  showAnswer: true,
  showKey: true,
  showExplanation: false,
  showHiddenCaseNames: false,
  showTeacherComment: true,
  contestationDays: 7,
};

async function appFor() {
  const app = await testApp(db);
  app.clock.set("2026-11-23T09:00:00.000Z");
  return app;
}
type App = Awaited<ReturnType<typeof appFor>>;

const participant = async (evaluation: EvaluationRecord, userId: string) =>
  (await live.participantOf(db, evaluation, userId))!;

/** Answers the two items (`right` per item), hands the attempt in, as the submit route does. */
async function answerAndSubmit(app: App, evaluation: EvaluationRecord, attempt: live.AttemptRecord, right: readonly boolean[]) {
  const items = await joinedItems(db, evaluation.id);
  for (const [index, ok] of right.entries()) {
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: items[index]!.item.id,
      payload: ok ? `answer-q${index}` : "nope",
      revision: 1,
      now: app.clock.now(),
    });
  }
  const submitted = await live.submitAttempt(db, evaluation, attempt, app.clock.now(), app);
  app.clock.advance(1000);
  return submitted;
}

/**
 * An exam of two one-point questions in a classroom with the drill on: the
 * first student sat it (one right, one wrong), the second never came. Closed,
 * graded and — unless `release: false` — released; its practice switch is
 * left as `afterDue` says (absent: the default, closed).
 */
async function sitExam(
  options: {
    feedback?: Partial<FeedbackPolicy>;
    settings?: NonNullable<Parameters<typeof seedLive>[1]>["settings"];
    release?: boolean;
    afterDue?: "open" | "hidden";
  } = {},
) {
  const app = await appFor();
  const teacher = await server.signIn("teacher");
  const taker = await server.signIn("student");
  const absent = await server.signIn("student");
  const seed = await seedLive(db, {
    mode: "exam",
    teacherId: teacher.id,
    studentIds: [taker.id, absent.id],
    questions: 2,
    durationS: 1800,
    settings: { timing: "duration", lobby: "skip", ...options.settings },
  });
  await db
    .update(evaluations)
    .set({ feedbackPolicy: { ...SHOWN, ...options.feedback } })
    .where(eq(evaluations.id, seed.evaluationId));
  await org.setClassroomDrill(db, seed.classroomId, true, app.clock.now());
  await setAllowDrill(db, await reload(db, seed.evaluationId), true, app.clock.now());
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const { attempt } = await enterStarted(db, { evaluation, participant: await participant(evaluation, taker.id), now: app.clock.now() });
  const official = await answerAndSubmit(app, evaluation, attempt, [true, false]);
  evaluation = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
  if (options.release !== false) await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
  if (options.afterDue) await setAfterDue(db, await reload(db, evaluation.id), options.afterDue, app.clock.now());
  return { app, seed, teacher, taker, absent, official, evaluation: await reload(db, evaluation.id) };
}

async function practise(app: App, evaluation: EvaluationRecord, userId: string) {
  return live.startPractice(db, {
    evaluation: await reload(db, evaluation.id),
    participant: await participant(evaluation, userId),
    archived: null,
    now: app.clock.now(),
  });
}

const refusal = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof live.PracticeRefused) return error.reason;
    return `other:${(error as Error).message}`;
  }
};

const pastSeries = async (userId: string) => (await live.studentHome(db, userId, new Date())).practice;

const putAfterDue = (teacher: Actor, evaluationId: string, afterDue: "open" | "hidden") =>
  server.app.inject({
    method: "PUT",
    url: `/app/api/evaluations/${evaluationId}/after-due`,
    headers: teacher.headers,
    payload: { afterDue },
  });

describe("the teacher's switch on an exam (ADR-142 §1, §2)", () => {
  it("is closed by default, and opens only under a policy that shows the key at the release", async () => {
    const { app, evaluation, teacher, taker } = await sitExam();
    expect(toEvaluation(evaluation).afterDueOpen).toBe(false);
    expect(await refusal(practise(app, evaluation, taker.id))).toBe("hidden");

    await db.update(evaluations).set({ feedbackPolicy: { ...SHOWN, showKey: false } }).where(eq(evaluations.id, evaluation.id));
    const hidden = await putAfterDue(teacher, evaluation.id, "open");
    expect(hidden.statusCode).toBe(422);
    expect(hidden.json()).toMatchObject({ error: "practice_key_hidden" });
    await db.update(evaluations).set({ feedbackPolicy: { ...SHOWN, when: "none" } }).where(eq(evaluations.id, evaluation.id));
    expect((await putAfterDue(teacher, evaluation.id, "open")).statusCode).toBe(422);
    // Closing it is never refused.
    expect((await putAfterDue(teacher, evaluation.id, "hidden")).statusCode).toBe(200);

    // The key alone is asked: the student's own answer hidden opens it all the same.
    await db.update(evaluations).set({ feedbackPolicy: { ...SHOWN, showAnswer: false } }).where(eq(evaluations.id, evaluation.id));
    const opened = await putAfterDue(teacher, evaluation.id, "open");
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({ evaluation: { afterDueOpen: true } });
    expect(await refusal(practise(app, evaluation, taker.id))).toBeNull();
  });

  it("closes the practice when the teacher later hides the key: no oracle of points", async () => {
    const { app, evaluation, taker } = await sitExam({ afterDue: "open" });
    expect((await pastSeries(taker.id)).map((c) => c.id)).toContain(evaluation.id);
    await db.update(evaluations).set({ feedbackPolicy: { ...SHOWN, showKey: false } }).where(eq(evaluations.id, evaluation.id));
    expect(toEvaluation(await reload(db, evaluation.id)).afterDueOpen).toBe(false);
    expect(await refusal(practise(app, evaluation, taker.id))).toBe("hidden");
    expect((await pastSeries(taker.id)).map((c) => c.id)).not.toContain(evaluation.id);
  });

  it("does not carry an exercise's switch over a change of mode", async () => {
    const teacher = await server.signIn("teacher");
    const seed = await seedLive(db, { mode: "exercise", teacherId: teacher.id, settings: { afterDue: "open" } });
    await db.update(evaluations).set({ feedbackPolicy: SHOWN }).where(eq(evaluations.id, seed.evaluationId));
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/evaluations/${seed.evaluationId}`,
      headers: teacher.headers,
      payload: { mode: "exam" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const exam = await reload(db, seed.evaluationId);
    expect((exam.settings as { afterDue?: string }).afterDue).toBeUndefined();
    expect(toEvaluation(exam).afterDueOpen).toBe(false);
  });
});

describe("who may practise an exam, and when (ADR-142 §1, §3)", () => {
  it("refuses before the release, a student who did not take it, and after the release is withdrawn", async () => {
    const closed = await sitExam({ release: false, afterDue: "open" });
    expect(await refusal(practise(closed.app, closed.evaluation, closed.taker.id))).toBe("not_released");
    expect((await pastSeries(closed.taker.id)).map((c) => c.id)).not.toContain(closed.evaluation.id);

    const { app, evaluation, taker, absent } = await sitExam({ afterDue: "open" });
    expect(await refusal(practise(app, evaluation, absent.id))).toBe("not_taken");
    expect((await pastSeries(absent.id)).map((c) => c.id)).not.toContain(evaluation.id);
    expect((await pastSeries(taker.id)).find((c) => c.id === evaluation.id)).toMatchObject({ printable: false, count: 0 });

    // An unfinished practice attempt outlives the withdrawn release: resumed,
    // its correction then waiting for the results like the exam's own.
    const { row } = await practise(app, evaluation, taker.id);
    await results.unreleaseResults(db, await reload(db, evaluation.id), app.clock.now());
    const withdrawn = await reload(db, evaluation.id);
    expect(await refusal(practise(app, withdrawn, taker.id))).toBeNull();
    const entry = await live.practiceEntry(db, { evaluation: withdrawn, participant: await participant(withdrawn, taker.id), archived: null, now: app.clock.now() });
    expect(entry).toMatchObject({ kind: "attempt", view: { attempt: { id: row.id, practice: true } } });
    const done = await answerAndSubmit(app, withdrawn, row, [true, true]);
    expect(await results.studentFeedback(db, await reload(db, evaluation.id), done, app.clock.now())).toMatchObject({
      available: false,
      reason: "results_pending",
    });
    // A new one is refused while the results are withdrawn.
    app.clock.advance(60_000);
    expect(await refusal(practise(app, withdrawn, taker.id))).toBe("not_released");
  });
});

describe("the sitting's conditions are not a practice's (ADR-142 §4)", () => {
  it("lets the portal practise an exam behind Safe Exam Browser and an allow-list, never a confined session", async () => {
    const { evaluation, taker } = await sitExam({ settings: { safeExamBrowser: true }, afterDue: "open" });
    await db.update(evaluations).set({ ipAllowlist: ["10.20.0.0/16"] }).where(eq(evaluations.id, evaluation.id));
    const url = `/app/api/evaluations/${evaluation.id}/practice`;
    const outside = { ...taker.headers, "x-forwarded-for": "203.0.113.9" };

    const ready = await server.app.inject({ method: "POST", url, headers: outside });
    expect(ready.statusCode, ready.body).toBe(200);
    const conditions = (ready.json() as { view: { conditions: { imposed: { key: string; maxAttempts?: number | null }[] } } }).view.conditions;
    expect(conditions.imposed.some((line) => line.key === "trusted_client")).toBe(false);
    expect(conditions.imposed.find((line) => line.key === "attempts")).toMatchObject({ maxAttempts: null });

    const started = await server.app.inject({ method: "POST", url: `${url}/start`, headers: outside });
    expect(started.statusCode, started.body).toBe(200);
    const attemptId = (started.json() as { view: { attempt: { id: string } } }).view.attempt.id;
    const again = await server.app.inject({ method: "GET", url: `/app/api/attempts/${attemptId}`, headers: outside });
    expect(again.statusCode, again.body).toBe(200);
    // The official attempt keeps the sitting's rules: the portal does not reach it.
    const officialId = (await live.attemptOf(db, evaluation.id, taker.id))!.id;
    expect((await server.app.inject({ method: "GET", url: `/app/api/attempts/${officialId}`, headers: outside })).statusCode).toBe(404);

    // A SEB session never practises, not even its own exam.
    const seb = await sessionOf(db, taker.id, { kind: "seb", evaluationId: evaluation.id });
    expect((await server.app.inject({ method: "POST", url: `${url}/start`, headers: seb })).statusCode).toBe(401);
    expect((await server.app.inject({ method: "GET", url: `/app/api/attempts/${attemptId}`, headers: seb })).statusCode).toBe(404);

    // The student's home lists it over HTTP.
    const home = await server.app.inject({ method: "GET", url: "/app/api/student/home", headers: taker.headers });
    expect(home.statusCode).toBe(200);
    expect((home.json() as StudentHome).practice?.map((c) => c.id)).toContain(evaluation.id);
  });
});

describe("what a student reads of an exam's practice (invariant 4)", () => {
  it("carries no key while written, the key at the hand-in, and nothing the policy hides once it hides the key", async () => {
    const { app, evaluation, taker, official } = await sitExam({ afterDue: "open" });
    const { row } = await practise(app, evaluation, taker.id);
    const view = await live.attemptView(db, evaluation, row, app.clock.now());
    const written = JSON.stringify(view);
    expect(written).not.toContain("answer-q0");
    expect(written).not.toContain("answer-q1");
    for (const key of FORBIDDEN_STUDENT_KEYS) expect(keysOf(view).has(key), key).toBe(false);

    // Handed in, all wrong: the key reaches the student through the policy, never a grade.
    const done = await answerAndSubmit(app, evaluation, row, [false, false]);
    const shown = await results.studentFeedback(db, await reload(db, evaluation.id), done, app.clock.now());
    expect(shown).toMatchObject({ available: true, practice: true, grade: null, points: 0, totalPoints: 2 });
    expect(JSON.stringify(shown)).toContain("answer-q0");
    // The contestation window is open on the official attempt, never on a practice one (ADR-139).
    const own = await results.studentFeedback(db, await reload(db, evaluation.id), official, app.clock.now());
    expect(own.available && own.items.some((item) => item.contestable)).toBe(true);
    expect(shown.available && shown.items.every((item) => !item.contestable)).toBe(true);

    // A practice attempt left open, then the key hidden: resumed, handed in, keyless.
    app.clock.advance(60_000);
    const { row: next } = await practise(app, evaluation, taker.id);
    await db.update(evaluations).set({ feedbackPolicy: { ...SHOWN, showKey: false } }).where(eq(evaluations.id, evaluation.id));
    const hidden = await answerAndSubmit(app, await reload(db, evaluation.id), next, [false, false]);
    const keyless = await results.studentFeedback(db, await reload(db, evaluation.id), hidden, app.clock.now());
    expect(keyless).toMatchObject({ available: true, practice: true, grade: null });
    expect(JSON.stringify(keyless)).not.toContain("answer-q");
  });
});

describe("practice rows on an exam count nowhere (ADR-142, ADR-122 §4)", () => {
  /** Everything the exam's results, grades and statistics read, as one comparable value. */
  async function readings(s: Awaited<ReturnType<typeof sitExam>>, now: Date) {
    const evaluation = await reload(db, s.evaluation.id);
    const { practisedCount: _apart, ...table } = await results.resultsView(db, evaluation);
    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, s.seed.classroomId));
    const [user] = await db.select().from(users).where(eq(users.id, s.taker.id));
    const file = await personalDataExport(
      db,
      { caller: { id: s.taker.id, role: "student", reach: "seats" }, user: user! },
      now,
      { lang: "en", codespace: false },
    );
    const cards = await db
      .select({ userId: drillCards.userId, questionId: drillCards.questionId })
      .from(drillCards)
      .where(eq(drillCards.evaluationId, evaluation.id))
      .orderBy(drillCards.userId, drillCards.questionId);
    const home = await live.studentHome(db, s.taker.id, now);
    return {
      table,
      csv: resultsCsv(await results.resultsView(db, evaluation)),
      released: evaluation.releasedGrades,
      modified: evaluation.modifiedAfterRelease,
      gradebook: await staffGradebook(db, room!),
      stats: await poolQuestionStats(db, s.seed.poolId),
      cards,
      export: file,
      card: home.past.find((c) => c.id === evaluation.id),
    };
  }

  it("leaves the results, CSV, release, gradebook, statistics, drill cards and personal export unchanged", async () => {
    const s = await sitExam({ afterDue: "open" });
    const at = s.app.clock.now();
    const before = await readings(s, at);
    expect(before.cards).toHaveLength(2);

    // Two practice attempts — one handed in with every answer right, one left open —
    // then a re-release and the drill's backfill, which read the attempts again.
    const { row } = await practise(s.app, s.evaluation, s.taker.id);
    await answerAndSubmit(s.app, s.evaluation, row, [true, true]);
    s.app.clock.advance(60_000);
    await practise(s.app, s.evaluation, s.taker.id);
    await results.releaseResults(db, await reload(db, s.evaluation.id), s.app.clock.now());
    await backfillClassroom(db, s.seed.classroomId, s.app.clock.now());

    const after = await readings(s, at);
    expect(after).toEqual(before);
    expect((await results.resultsView(db, await reload(db, s.evaluation.id))).practisedCount).toBe(1);
    const practice = await db
      .select()
      .from(attempts)
      .where(and(eq(attempts.evaluationId, s.evaluation.id), eq(attempts.afterDue, true)));
    expect(practice).toHaveLength(2);
  });

  it("gives no drill card for a practice row alone, at the release or the backfill", async () => {
    const s = await sitExam({ release: false });
    // A stand-in for a practice row of someone who never handed the exam in.
    await db.update(attempts).set({ afterDue: true }).where(eq(attempts.id, s.official.id));
    await results.releaseResults(db, await reload(db, s.evaluation.id), s.app.clock.now());
    await backfillClassroom(db, s.seed.classroomId, s.app.clock.now());
    expect(await db.select().from(drillCards).where(eq(drillCards.evaluationId, s.evaluation.id))).toHaveLength(0);
  });
});
