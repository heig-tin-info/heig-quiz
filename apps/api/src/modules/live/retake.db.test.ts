/**
 * Several attempts on an exercise (F-EVAL-15, ADR-025, #92) against the real
 * migrations: the retake rule, the database guarantees behind it, the
 * grading of every attempt, the kept attempt in the results, the score-only
 * feedback between attempts, and the screens that must not break with
 * several attempts per student.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RetakeSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, gradings } from "../../db/schema.js";
import { testApp, testDb, type TestDb } from "../../test/db.js";
import { testServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import {
  applyState,
  joinedItems,
  patchEvaluation,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { gradingQueue } from "../grading/service.js";
import { resultsCsv } from "../results/csv.js";
import * as results from "../results/service.js";
import { answersOf } from "./attempt.js";
import * as live from "./service.js";

let raw: TestDb;
let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  raw = await testDb();
  db = raw as unknown as Db;
});
afterAll(() => restore());

async function appFor() {
  const app = await testApp(raw);
  app.clock.set("2026-09-25T09:00:00.000Z");
  return app;
}

type App = Awaited<ReturnType<typeof appFor>>;

/** A running exercise of two one-point questions, retakes as asked. */
async function exercise(
  retakes: Partial<RetakeSettings> = {},
  options: Parameters<typeof seedLive>[1] = {},
) {
  const app = await appFor();
  const seed = await seedLive(db, {
    mode: "exercise",
    students: 2,
    questions: 2,
    durationS: null,
    settings: {
      timing: "manual",
      lobby: "skip",
      retakes: { enabled: true, keep: "best", maxAttempts: null, ...retakes },
    },
    ...options,
  });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  return { app, seed, evaluation, items };
}

const participant = async (evaluation: EvaluationRecord, userId: string) =>
  (await live.participantOf(db, evaluation, userId))!;

/**
 * One whole attempt through the services the routes call: enter (or the
 * attempt given), answer, submit, and the grading the submit route asks for.
 */
async function sit(
  app: App,
  evaluation: EvaluationRecord,
  items: Awaited<ReturnType<typeof joinedItems>>,
  userId: string,
  right: readonly boolean[],
  attempt?: live.AttemptRecord,
) {
  const now = app.clock.now();
  let current = attempt;
  if (!current) {
    const entered = await live.enterEvaluation(db, {
      evaluation,
      participant: await participant(evaluation, userId),
      now,
    });
    current = entered.attempt;
  }
  for (const [index, ok] of right.entries()) {
    await live.saveAnswer(db, {
      evaluation,
      attempt: current,
      itemId: items[index]!.item.id,
      payload: ok ? `answer-q${index}` : "nope",
      revision: 1,
      now,
    });
  }
  const submitted = await live.submitAttempt(db, evaluation, current, now);
  await live.gradeFinishedRetakes(app, evaluation, [submitted.id]);
  app.clock.advance(1000);
  return submitted;
}

async function retake(app: App, evaluation: EvaluationRecord, userId: string) {
  return live.retakeAttempt(db, {
    evaluation: await reload(db, evaluation.id),
    participant: await participant(evaluation, userId),
    now: app.clock.now(),
  });
}

const refusal = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof live.RetakeRefused ? error.reason : `other:${(error as Error).message}`;
  }
};

const attemptsOf = (evaluationId: string, userId: string) =>
  db
    .select()
    .from(attempts)
    .where(and(eq(attempts.evaluationId, evaluationId), eq(attempts.userId, userId)));

describe("a retake (F-EVAL-15)", () => {
  it("is a new blank attempt with a new number and a new seed, started at once", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    const first = await sit(app, evaluation, items, student, [true, false]);
    expect(first.attemptNumber).toBe(1);

    const second = await retake(app, evaluation, student);
    expect(second.attemptNumber).toBe(2);
    expect(second.state).toBe("in_progress");
    expect(second.id).not.toBe(first.id);
    expect(second.startedAt).not.toBeNull();
    expect(await answersOf(db, second.id)).toHaveProperty("size", 0);
    // The seed is drawn again: 1 chance in 2^31 of a false alarm.
    expect(second.seed).not.toBe(first.seed);

    // The student's CURRENT attempt is the new one, for every reader.
    expect((await live.attemptOf(db, evaluation.id, student))!.id).toBe(second.id);
    const entered = await live.enterEvaluation(db, {
      evaluation,
      participant: await participant(evaluation, student),
      now: app.clock.now(),
    });
    expect(entered.attempt.id).toBe(second.id);
    expect(entered.kind).toBe("attempt");
  });

  it("serves the second attempt through toStudent, with no key in it", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, true]);
    const second = await retake(app, evaluation, student);
    const view = await live.attemptView(db, evaluation, second, app.clock.now());
    const text = JSON.stringify(view);
    expect(text).not.toContain("answer-q0");
    expect(text).not.toContain("answer-q1");
    expect(view.items.every((i) => i.answer === null)).toBe(true);
  });

  it("is refused while the attempt is open, without a first attempt, and past the maximum", async () => {
    const { app, seed, evaluation, items } = await exercise({ maxAttempts: 2 });
    const student = seed.studentIds[0]!;
    expect(await refusal(retake(app, evaluation, student))).toBe("no_attempt");

    const entered = await live.enterEvaluation(db, {
      evaluation,
      participant: await participant(evaluation, student),
      now: app.clock.now(),
    });
    expect(await refusal(retake(app, evaluation, student))).toBe("unfinished");

    await sit(app, evaluation, items, student, [false, false], entered.attempt);
    const second = await retake(app, evaluation, student);
    await sit(app, evaluation, items, student, [true, true], second);
    expect(await refusal(retake(app, evaluation, student))).toBe("max_attempts");
    expect(await attemptsOf(evaluation.id, student)).toHaveLength(2);
  });

  it("is refused on an exam, with the setting off, when paused and after the common end", async () => {
    const exam = await exercise({}, { mode: "exam", settings: { retakes: { enabled: true, keep: "best", maxAttempts: null } } });
    await sit(exam.app, exam.evaluation, exam.items, exam.seed.studentIds[0]!, [true, true]);
    expect(await refusal(retake(exam.app, exam.evaluation, exam.seed.studentIds[0]!))).toBe(
      "not_allowed",
    );

    const off = await exercise({ enabled: false });
    await sit(off.app, off.evaluation, off.items, off.seed.studentIds[0]!, [true, true]);
    expect(await refusal(retake(off.app, off.evaluation, off.seed.studentIds[0]!))).toBe(
      "not_allowed",
    );

    const paused = await exercise();
    await sit(paused.app, paused.evaluation, paused.items, paused.seed.studentIds[0]!, [true, true]);
    await applyState(db, await reload(db, paused.evaluation.id), "paused", paused.app.clock.now());
    expect(await refusal(retake(paused.app, paused.evaluation, paused.seed.studentIds[0]!))).toBe(
      "not_open",
    );

    const due = await exercise({}, { closesAt: new Date("2026-09-25T09:00:30.000Z") });
    await sit(due.app, due.evaluation, due.items, due.seed.studentIds[0]!, [true, true]);
    due.app.clock.advance(60_000);
    expect(await refusal(retake(due.app, due.evaluation, due.seed.studentIds[0]!))).toBe("closed");
  });

  it("opens ONE attempt when two retakes race", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, true]);
    const [a, b] = await Promise.all([
      retake(app, evaluation, student),
      retake(app, evaluation, student),
    ]);
    expect(a.id).toBe(b.id);
    const rows = await attemptsOf(evaluation.id, student);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.state === "in_progress")).toHaveLength(1);
  });

  it("keeps at most one unfinished attempt per student in the schema itself", async () => {
    const { app, seed, evaluation } = await exercise();
    const student = seed.studentIds[0]!;
    await live.enterEvaluation(db, {
      evaluation,
      participant: await participant(evaluation, student),
      now: app.clock.now(),
    });
    await expect(
      db.insert(attempts).values({
        id: randomUUID(),
        evaluationId: evaluation.id,
        userId: student,
        attemptNumber: 2,
        state: "in_progress",
        seed: 1,
      }),
    ).rejects.toThrow();
  });

  it("replaces reopening: a teacher reopens no attempt of such an exercise", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const first = await sit(app, evaluation, items, seed.studentIds[0]!, [true, true]);
    await expect(live.reopenAttempt(db, evaluation, first, app.clock.now())).rejects.toBeInstanceOf(
      live.RetakesEnabled,
    );
  });
});

describe("the settings (F-EVAL-15)", () => {
  it("refuses retakes on an exam and accepts them on an exercise", async () => {
    const examSeed = await seedLive(db, { mode: "exam" });
    const exam = await reload(db, examSeed.evaluationId);
    await expect(
      patchEvaluation(db, exam, { settings: { retakes: { enabled: true, keep: "best", maxAttempts: null } } }, { attemptCount: 0 }),
    ).rejects.toMatchObject({ code: "retakes_not_allowed", status: 422 });
    // Switching them OFF on an exam always passes.
    await patchEvaluation(db, exam, { settings: { retakes: { enabled: false, keep: "best", maxAttempts: null } } }, { attemptCount: 0 });

    const exSeed = await seedLive(db, { mode: "exercise" });
    const ex = await reload(db, exSeed.evaluationId);
    const next = await patchEvaluation(
      db,
      ex,
      { settings: { retakes: { enabled: true, keep: "last", maxAttempts: 3 } } },
      { attemptCount: 0 },
    );
    expect((next.settings as { retakes: RetakeSettings }).retakes).toEqual({
      enabled: true,
      keep: "last",
      maxAttempts: 3,
    });
    // Frozen like every structural setting once an attempt exists.
    await expect(
      patchEvaluation(db, next, { settings: { retakes: { enabled: false, keep: "best", maxAttempts: null } } }, { attemptCount: 1 }),
    ).rejects.toMatchObject({ code: "locked" });
  });
});

describe("grading and results with several attempts", () => {
  it("grades each attempt as it ends, and shows its score only while the exercise is open", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    const first = await sit(app, evaluation, items, student, [true, false]);

    const graded = await db.select().from(gradings).where(eq(gradings.attemptId, first.id));
    expect(graded).toHaveLength(2);

    // `immediate` feedback with the key: still the score only, while open.
    const feedback = await results.studentFeedback(db, await reload(db, evaluation.id), first);
    expect(feedback).toEqual({
      available: false,
      reason: "retakes_open",
      evaluation: { id: evaluation.id, title: evaluation.title },
      score: { points: 1, totalPoints: 2, pending: false },
    });
    expect(JSON.stringify(feedback)).not.toContain("answer-q");

    // Closed: the policy applies again, `immediate` with the key.
    const closed = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    const after = await results.studentFeedback(db, closed, first);
    expect(after.available).toBe(true);
  });

  it("grades every attempt at the close, the unfinished one included", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, true]);
    const second = await retake(app, evaluation, student);
    await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    const graded = await db.select().from(gradings).where(eq(gradings.attemptId, second.id));
    expect(graded).toHaveLength(items.length);
  });

  it("grades an attempt the ticker expires", async () => {
    const { app, seed, evaluation, items } = await exercise(
      {},
      { durationS: 60, settings: { timing: "duration", lobby: "skip", retakes: { enabled: true, keep: "best", maxAttempts: null } } },
    );
    const student = seed.studentIds[0]!;
    const entered = await live.enterEvaluation(db, {
      evaluation,
      participant: await participant(evaluation, student),
      now: app.clock.now(),
    });
    await live.saveAnswer(db, {
      evaluation,
      attempt: entered.attempt,
      itemId: items[0]!.item.id,
      payload: "answer-q0",
      revision: 1,
      now: app.clock.now(),
    });
    app.clock.advance(120_000);
    const expired = await live.expireDueAttempts(db, app.clock.now(), app);
    expect(expired.map((e) => e.id)).toEqual([entered.attempt.id]);
    const graded = await db.select().from(gradings).where(eq(gradings.attemptId, entered.attempt.id));
    expect(graded).toHaveLength(items.length);
  });

  async function twoAttempts(keep: "best" | "last") {
    const built = await exercise({ keep });
    const { app, seed, evaluation, items } = built;
    const student = seed.studentIds[0]!;
    // Attempt 1: both right. Attempt 2: both wrong.
    const first = await sit(app, evaluation, items, student, [true, true]);
    const second = await sit(app, evaluation, items, student, [false, false], await retake(app, evaluation, student));
    // The other student: one attempt, one right answer.
    await sit(app, evaluation, items, seed.studentIds[1]!, [true, false]);
    const closed = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    return { ...built, student, first, second, closed };
  }

  it("keeps the BEST attempt in the grades, the CSV, the statistics and the release", async () => {
    const { closed, student, first } = await twoAttempts("best");
    const view = await results.resultsView(db, closed);
    const row = view.rows.find((r) => r.userId === student)!;
    expect(row.attemptId).toBe(first.id);
    expect(row.points).toBe(2);
    // The rates are over one attempt per student: (1 + 1) / 2 and (1 + 0) / 2.
    expect(view.items.map((i) => i.successRate)).toEqual([1, 0.5]);
    expect(resultsCsv(view)).toContain(";2;");

    const released = await results.releaseResults(db, closed, closed.closedAt!);
    expect(released.rows).toBe(2);
    const reloaded = await reload(db, closed.id);
    const snapshot = reloaded.releasedGrades as { rows: { userId: string; attemptId: string }[] };
    expect(snapshot.rows.find((r) => r.userId === student)!.attemptId).toBe(first.id);

    const byQuestion = await results.byQuestion(db, reloaded);
    // One answer per student and question: the kept attempts only.
    expect(byQuestion.map((q) => q.answered)).toEqual([2, 2]);
  });

  it("keeps the LAST attempt when the teacher said so", async () => {
    const { closed, student, second } = await twoAttempts("last");
    const view = await results.resultsView(db, closed);
    const row = view.rows.find((r) => r.userId === student)!;
    expect(row.attemptId).toBe(second.id);
    expect(row.points).toBe(0);
  });

  it("serves the student's cards from the kept attempt", async () => {
    const { closed, student, first } = await twoAttempts("best");
    await results.releaseResults(db, closed, closed.closedAt!);
    const cards = await results.studentResultCards(db, student);
    const card = cards.find((c) => c.evaluationId === closed.id)!;
    expect(card.attemptId).toBe(first.id);
    expect(card.points).toBe(2);
  });
});

describe("the screens with several attempts", () => {
  it("shows the student the kept score, the count and the Retake action", async () => {
    const { app, seed, evaluation, items } = await exercise({ maxAttempts: 3 });
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, false]);
    let home = await live.studentHome(db, student, app.clock.now());
    let card = home.open.find((c) => c.id === evaluation.id)!;
    expect(card.retakes).toMatchObject({
      keep: "best",
      maxAttempts: 3,
      attemptCount: 1,
      canRetake: true,
      kept: { attemptNumber: 1, score: { points: 1, totalPoints: 2, pending: false } },
    });

    // During the retake: no Retake, the score of attempt 1 still stands.
    const second = await retake(app, evaluation, student);
    home = await live.studentHome(db, student, app.clock.now());
    card = home.open.find((c) => c.id === evaluation.id)!;
    expect(card.attemptId).toBe(second.id);
    expect(card.attemptState).toBe("in_progress");
    expect(card.retakes).toMatchObject({ attemptCount: 2, canRetake: false, kept: { attemptNumber: 1 } });

    // A better second attempt becomes the kept one.
    await sit(app, evaluation, items, student, [true, true], second);
    home = await live.studentHome(db, student, app.clock.now());
    card = home.open.find((c) => c.id === evaluation.id)!;
    expect(card.retakes).toMatchObject({
      attemptCount: 2,
      canRetake: true,
      kept: { attemptNumber: 2, score: { points: 2 } },
    });

    // Every other card carries no retake block.
    const examSeed = await seedLive(db, { mode: "exam", studentIds: [student] });
    await applyState(db, await reload(db, examSeed.evaluationId), "running", app.clock.now());
    home = await live.studentHome(db, student, app.clock.now());
    expect(home.open.find((c) => c.id === examSeed.evaluationId)!.retakes).toBeNull();
  });

  it("shows the latest attempt in the live grid, with the count", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, true]);
    const second = await retake(app, evaluation, student);
    const view = await live.dashboardView(db, await reload(db, evaluation.id), {
      now: app.clock.now(),
      includeAnswers: false,
      includeResults: false,
    });
    expect(view.evaluation.retakes).toBe(true);
    const row = view.rows.find((r) => r.userId === student)!;
    expect(row.attemptId).toBe(second.id);
    expect(row.state).toBe("in_progress");
    expect(row.attemptCount).toBe(2);
    // The fresh attempt is blank, and the rates do not count attempt 1.
    expect(row.cells.every((c) => c.status === "empty")).toBe(true);
    expect(view.totals.every((t) => t.successRate === null)).toBe(true);
    expect(view.rows.find((r) => r.userId === seed.studentIds[1])!.attemptCount).toBe(0);
  });

  it("lets the grading panel reach every attempt, numbered", async () => {
    const { app, seed, evaluation, items } = await exercise();
    const student = seed.studentIds[0]!;
    await sit(app, evaluation, items, student, [true, true]);
    await sit(app, evaluation, items, student, [false, true], await retake(app, evaluation, student));
    await sit(app, evaluation, items, seed.studentIds[1]!, [true, true]);
    const queue = await gradingQueue(db, await reload(db, evaluation.id), {
      by: "student",
      anonymous: false,
    });
    const labels = [...new Set(queue.entries.map((e) => e.label))];
    expect(labels).toHaveLength(3);
    expect(labels.filter((l) => l.endsWith(" · #1"))).toHaveLength(1);
    expect(labels.filter((l) => l.endsWith(" · #2"))).toHaveLength(1);
    // A student with one attempt carries no number.
    expect(labels.filter((l) => !l.includes("#"))).toHaveLength(1);
    expect(queue.counts.total).toBe(3 * items.length);
  });
});

describe("POST /evaluations/:id/retake", () => {
  it("answers the new attempt, a 409 with the reason, and a 404 to a stranger", async () => {
    const server = await testServer();
    try {
      const student = await server.signIn("student");
      const stranger = await server.signIn("student");
      const sdb = server.app.db;
      const seed = await seedLive(sdb, {
        mode: "exercise",
        studentIds: [student.id],
        questions: 1,
        durationS: null,
        settings: {
          timing: "manual",
          lobby: "skip",
          retakes: { enabled: true, keep: "best", maxAttempts: 2 },
        },
      });
      await applyState(sdb, await reload(sdb, seed.evaluationId), "running", server.clock.now());
      const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
        server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

      const entered = await post(`/app/api/evaluations/${seed.evaluationId}/attempt`, student.headers, {});
      expect(entered.statusCode).toBe(200);
      const firstId = entered.json().view.attempt.id as string;

      const early = await post(`/app/api/evaluations/${seed.evaluationId}/retake`, student.headers);
      expect(early.statusCode).toBe(409);
      expect(early.json()).toMatchObject({ error: "retake_refused", reason: "unfinished" });

      await post(`/app/api/attempts/${firstId}/submit`, student.headers, { confirm: true });
      const again = await post(`/app/api/evaluations/${seed.evaluationId}/retake`, student.headers);
      expect(again.statusCode).toBe(200);
      expect(again.json().kind).toBe("attempt");
      const secondId = again.json().view.attempt.id as string;
      expect(secondId).not.toBe(firstId);
      expect(again.json().view.attempt.readOnly).toBe(false);

      // The first attempt's feedback: the score only, while the exercise is open.
      const feedback = await server.app.inject({
        method: "GET",
        url: `/app/api/attempts/${firstId}/feedback`,
        headers: student.headers,
      });
      expect(feedback.json()).toMatchObject({ available: false, reason: "retakes_open", score: { totalPoints: 1 } });

      await post(`/app/api/attempts/${secondId}/submit`, student.headers, { confirm: true });
      const max = await post(`/app/api/evaluations/${seed.evaluationId}/retake`, student.headers);
      expect(max.json()).toMatchObject({ error: "retake_refused", reason: "max_attempts" });

      const denied = await post(`/app/api/evaluations/${seed.evaluationId}/retake`, stranger.headers);
      expect(denied.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});
