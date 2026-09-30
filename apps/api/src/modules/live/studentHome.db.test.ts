/**
 * The student home sorts a card by what the student can still DO, and offers
 * "See my results" only when the feedback page has something to show
 * (issue #203), against the real migrations.
 *
 * Every scenario ends with {@link agrees}: `results` on a card is exactly
 * what the feedback route (`studentFeedback`) answers for the attempt the
 * card points at — never `available` where the page says `available: false`,
 * never `pending` where it says `no_feedback`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationCard, FeedbackPolicy, RetakeSettings, StudentHome } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { evaluations } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import * as results from "../results/service.js";
import * as live from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

type App = Awaited<ReturnType<typeof testApp>>;

/** A running evaluation under the given feedback policy. */
async function runningEvaluation(
  when: FeedbackPolicy["when"],
  options: Parameters<typeof seedLive>[1] & { retakes?: Partial<RetakeSettings> } = {},
) {
  const app = await testApp(db);
  app.clock.set("2026-09-28T09:00:00.000Z");
  const { retakes, ...seedOptions } = options;
  const seed = await seedLive(db, {
    students: 1,
    ...seedOptions,
    settings: {
      timing: "manual",
      lobby: "skip",
      ...(retakes ? { retakes: { enabled: true, keep: "best", maxAttempts: null, ...retakes } } : {}),
      ...seedOptions.settings,
    },
  });
  const draft = await reload(db, seed.evaluationId);
  await db
    .update(evaluations)
    .set({ feedbackPolicy: { ...(draft.feedbackPolicy as object), when } })
    .where(eq(evaluations.id, draft.id));
  const evaluation = await applyState(db, await reload(db, draft.id), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  return { app, seed, evaluation, items, student: seed.studentIds[0]! };
}

/** Enters (a new attempt, or the retake given), answers and hands in. */
async function handIn(app: App, evaluation: EvaluationRecord, userId: string, attempt?: live.AttemptRecord) {
  const now = app.clock.now();
  const current =
    attempt ??
    (
      await live.enterEvaluation(db, {
        evaluation,
        participant: (await live.participantOf(db, evaluation, userId))!,
        now,
      })
    ).attempt;
  const submitted = await live.submitAttempt(db, evaluation, current, now);
  await live.gradeAtHandIn(app, evaluation, [submitted.id]);
  app.clock.advance(1000);
  return submitted;
}

/** Where the card of this evaluation sits, and the card. */
async function cardOf(app: App, userId: string, evaluationId: string) {
  const home = await live.studentHome(db, userId, app.clock.now());
  await agrees(app, home);
  for (const section of ["open", "upcoming", "past"] as const) {
    const card = home[section].find((c) => c.id === evaluationId);
    if (card) return { section, card };
  }
  throw new Error("no card");
}

/**
 * `results` says exactly what the feedback route would answer for the
 * attempt the card links to (the kept one with retakes).
 */
async function agrees(app: App, home: StudentHome) {
  const cards: EvaluationCard[] = [...home.open, ...home.upcoming, ...home.past];
  for (const card of cards) {
    const linked = card.retakes ? (card.retakes.kept?.attemptId ?? null) : card.attemptId;
    if (linked === null) {
      expect(card.results, card.title).toBe("none");
      continue;
    }
    const evaluation = await reload(db, card.id);
    const attempt = (await live.attemptById(db, linked))!;
    const feedback = await results.studentFeedback(db, evaluation, attempt, app.clock.now());
    if (feedback.available) expect(card.results, card.title).toBe("available");
    else if (feedback.reason === "no_feedback") expect(card.results, card.title).toBe("none");
    else expect(card.results, card.title).not.toBe("available");
  }
}

describe("the student home after a hand-in (issue #203)", () => {
  it("moves a handed-in quiz still running to Past, without results under on_release", async () => {
    const { app, evaluation, student } = await runningEvaluation("on_release");
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "open",
      card: { attemptState: null, results: "none" },
    });

    await handIn(app, evaluation, student);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "running", attemptState: "submitted", results: "pending" },
    });

    // Closed, not released: still nothing to see.
    const closed = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { results: "pending" },
    });

    // Released: See my results.
    await results.releaseResults(db, closed, app.clock.now());
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "released", results: "available" },
    });
  });

  it("offers the results at once under the immediate policy, while the quiz still runs", async () => {
    const { app, evaluation, student } = await runningEvaluation("immediate");
    await handIn(app, evaluation, student);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "running", attemptState: "submitted", results: "available" },
    });
  });

  it("never offers results under the none policy, even released", async () => {
    const { app, evaluation, student } = await runningEvaluation("none");
    await handIn(app, evaluation, student);
    const closed = await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    await results.releaseResults(db, closed, app.clock.now());
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { results: "none" },
    });
  });

  it("treats an expiry like a hand-in", async () => {
    const { app, evaluation, student } = await runningEvaluation("immediate", {
      durationS: 60,
      settings: { timing: "duration" },
    });
    await live.enterEvaluation(db, {
      evaluation,
      participant: (await live.participantOf(db, evaluation, student))!,
      now: app.clock.now(),
    });
    expect((await cardOf(app, student, evaluation.id)).section).toBe("open");

    app.clock.advance(10 * 60_000);
    expect(await live.expireDueAttempts(db, app.clock.now())).toHaveLength(1);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { attemptState: "expired", results: "available" },
    });
  });

  it("puts the card back under Open now when the teacher reopens the attempt", async () => {
    const { app, evaluation, student } = await runningEvaluation("on_release");
    const submitted = await handIn(app, evaluation, student);
    expect((await cardOf(app, student, evaluation.id)).section).toBe("past");

    await live.reopenAttempt(db, await reload(db, evaluation.id), submitted, app.clock.now());
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "open",
      card: { attemptState: "in_progress", results: "pending" },
    });
  });

  it("keeps a paused quiz handed in under Past", async () => {
    const { app, evaluation, student } = await runningEvaluation("on_release");
    await handIn(app, evaluation, student);
    await live.pauseEvaluation(db, await reload(db, evaluation.id), app.clock.now());
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "paused", results: "pending" },
    });
  });

  it("lists a closed evaluation the student never took under Past, without results", async () => {
    const { app, evaluation, student } = await runningEvaluation("immediate");
    await live.closeEvaluation(db, evaluation, app.clock.now(), "teacher", app);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { attemptId: null, results: "none" },
    });
  });

  it("keeps an exercise with retakes left under Open now, and moves it once none is left", async () => {
    const { app, evaluation, student } = await runningEvaluation("immediate", {
      mode: "exercise",
      durationS: null,
      retakes: { maxAttempts: 2 },
    });
    await handIn(app, evaluation, student);
    // Between two attempts the page is score only (ADR-025): not "available".
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "open",
      card: { attemptState: "submitted", results: "pending", retakes: { canRetake: true } },
    });

    const second = await live.retakeAttempt(db, {
      evaluation: await reload(db, evaluation.id),
      participant: (await live.participantOf(db, evaluation, student))!,
      now: app.clock.now(),
    });
    expect((await cardOf(app, student, evaluation.id)).section).toBe("open");

    await handIn(app, evaluation, student, second);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "running", results: "pending", retakes: { canRetake: false, attemptCount: 2 } },
    });

    // Closed, the teacher's policy decides again: immediate shows the kept one.
    await live.closeEvaluation(db, await reload(db, evaluation.id), app.clock.now(), "teacher", app);
    expect(await cardOf(app, student, evaluation.id)).toMatchObject({
      section: "past",
      card: { results: "available" },
    });
  });

  it("promises nothing under the none policy, closed or between two attempts", async () => {
    const quiz = await runningEvaluation("none");
    await handIn(quiz.app, quiz.evaluation, quiz.student);
    await live.closeEvaluation(db, await reload(db, quiz.evaluation.id), quiz.app.clock.now(), "teacher", quiz.app);
    expect(await cardOf(quiz.app, quiz.student, quiz.evaluation.id)).toMatchObject({
      section: "past",
      card: { state: "closed", results: "none" },
    });

    const drill = await runningEvaluation("none", {
      mode: "exercise",
      durationS: null,
      retakes: {},
    });
    await handIn(drill.app, drill.evaluation, drill.student);
    // Score only between attempts, and no correction after the close either.
    expect(await cardOf(drill.app, drill.student, drill.evaluation.id)).toMatchObject({
      section: "open",
      card: { state: "running", results: "none", retakes: { canRetake: true } },
    });
  });
});
