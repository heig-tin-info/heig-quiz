/**
 * The partial retake of an exercise (ADR-090) against the real migrations:
 * a retake of the questions to review carries the acquired ones over —
 * values, answer and validated grading — as a whole new attempt; the
 * student cannot write to them; the hand-in pass leaves them alone and a
 * regrade does not; the refusals; the settings rule; and the standing each
 * question has on the results page, which carries nothing else.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RetakeSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, evaluations, gradings } from "../../db/schema.js";
import { testApp } from "../../test/db.js";
import { type Payload, type TestServer, testServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { enterStarted, reload, seedLive } from "../../test/live.js";
import {
  applyState,
  feedbackOf,
  joinedItems,
  patchEvaluation,
  settingsOf,
  type EvaluationRecord,
} from "../evaluation/service.js";
import { keptAttempts, regradeItem } from "../grading/service.js";
import { runEvaluationGrading } from "../grading/jobs.js";
import * as results from "../results/service.js";
import { answersOf, orderItems } from "./attempt.js";
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
  app.clock.set("2026-10-09T09:00:00.000Z");
  return app;
}

type App = Awaited<ReturnType<typeof appFor>>;
type Items = Awaited<ReturnType<typeof joinedItems>>;

/** A running exercise of three one-point questions, a partial retake allowed. */
async function exercise(retakes: Partial<RetakeSettings> = {}) {
  const app = await appFor();
  const seed = await seedLive(db, {
    mode: "exercise",
    students: 1,
    questions: 3,
    durationS: null,
    settings: {
      timing: "manual",
      lobby: "skip",
      shuffleItems: true,
      retakes: { enabled: true, keep: "best", maxAttempts: null, scope: "to_review", ...retakes },
    },
  });
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  return { app, student: seed.studentIds[0]!, evaluation, items };
}

const participant = async (evaluation: EvaluationRecord, userId: string) =>
  (await live.participantOf(db, evaluation, userId))!;

/** Answers (right or wrong, per item; `null` leaves it), hands in, grades. */
async function sit(
  app: App,
  evaluation: EvaluationRecord,
  items: Items,
  userId: string,
  right: readonly (boolean | null)[],
  attempt?: live.AttemptRecord,
) {
  const now = app.clock.now();
  const current =
    attempt ??
    (await enterStarted(db, { evaluation, participant: await participant(evaluation, userId), now })).attempt;
  for (const [index, ok] of right.entries()) {
    if (ok === null) continue;
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
  await live.gradeAtHandIn(app, evaluation, [submitted.id]);
  app.clock.advance(1000);
  return submitted;
}

async function retake(app: App, evaluation: EvaluationRecord, userId: string, scope: "all" | "to_review") {
  return live.retakeAttempt(db, {
    evaluation: await reload(db, evaluation.id),
    participant: await participant(evaluation, userId),
    scope,
    now: app.clock.now(),
  });
}

const refusal = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof live.RetakeRefused) return error.reason;
    return `other:${(error as { code?: string }).code ?? (error as Error).message}`;
  }
};

const validatedOf = (attemptId: string) =>
  db
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")));

describe("a partial retake (ADR-090)", () => {
  it("is a whole new attempt that carries the acquired questions over", async () => {
    const { app, student, evaluation, items } = await exercise();
    const [q0, q1, q2] = items.map((i) => i.item.id) as [string, string, string];
    const first = await sit(app, evaluation, items, student, [true, false, true]);
    // A value drawn for an acquired item and one to review (ADR-056 §5):
    // the first is carried as it stood, the second drawn anew.
    const stored = { versionId: items[0]!.version.id, values: { x: 3 } };
    await db
      .update(attempts)
      .set({ instances: { [q0]: stored, [q1]: { ...stored, values: { x: 7 } } } })
      .where(eq(attempts.id, first.id));

    const second = await retake(app, evaluation, student, "to_review");
    expect(second.attemptNumber).toBe(2);
    expect(second.state).toBe("in_progress");
    expect(second.seed).not.toBe(first.seed);
    expect([...second.acquiredItemIds].sort()).toEqual([q0, q2].sort());
    expect(second.instances[q0]).toEqual(stored);
    expect(second.instances[q1]).toBeUndefined();

    // The answers: copies, new ids, the same payload, no time on screen yet.
    const original = await answersOf(db, first.id);
    const copied = await answersOf(db, second.id);
    expect([...copied.keys()].sort()).toEqual([q0, q2].sort());
    for (const itemId of [q0, q2]) {
      const copy = copied.get(itemId)!;
      expect(copy.id).not.toBe(original.get(itemId)!.id);
      expect(copy.payload).toEqual(original.get(itemId)!.payload);
      expect(copy.firstShownAt).toEqual(original.get(itemId)!.firstShownAt);
      expect(copy.dwellMs).toBe(0);
      expect(copy.markedDone).toBe(false);
    }

    // The validated gradings: copies, pointing at the copied answers.
    const before = await validatedOf(first.id);
    const carried = await validatedOf(second.id);
    expect(carried).toHaveLength(2);
    for (const grading of carried) {
      expect(before.map((g) => g.id)).not.toContain(grading.id);
      expect(grading.answerId).toBe(copied.get(grading.itemId)!.id);
      expect(grading.points).toBe(1);
      expect(grading.supersedesId).toBeNull();
    }
    // Attempt 1 is untouched.
    expect(await validatedOf(first.id)).toHaveLength(3);
  });

  it("shows the acquired questions read-only and refuses every write to them", async () => {
    const { app, student, evaluation, items } = await exercise();
    const [q0, q1] = items.map((i) => i.item.id) as [string, string];
    await sit(app, evaluation, items, student, [true, false, true]);
    const second = await retake(app, evaluation, student, "to_review");
    const now = app.clock.now();

    const view = await live.attemptView(db, evaluation, second, now);
    expect(view.items.filter((i) => i.acquired).map((i) => i.id).sort()).toEqual(
      [...second.acquiredItemIds].sort(),
    );
    // Not a navigation lock: the acquired question stays reachable.
    expect(view.items.every((i) => !i.locked)).toBe(true);

    const code = async (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string; status?: number }) => `${error.status} ${error.code}`,
      );
    const target = { evaluation, attempt: second, itemId: q0, now };
    expect(await code(live.saveAnswer(db, { ...target, payload: "nope", revision: 9 }))).toBe("409 item_acquired");
    expect(await code(live.setFlagged(db, { ...target, flagged: true }))).toBe("409 item_acquired");
    expect(await code(live.setSkipped(db, { ...target, skipped: true }))).toBe("409 item_acquired");
    expect(await code(live.markDone(db, { ...target, done: false }))).toBe("409 item_acquired");
    expect((await answersOf(db, second.id)).get(q0)!.payload).toBe("answer-q0");
    // A question to review takes writes as usual.
    const saved = await live.saveAnswer(db, { ...target, itemId: q1, payload: "answer-q1", revision: 1 });
    expect(saved.accepted).toBe(true);
  });

  it("is not regraded at hand-in, counts in the kept attempt, and a regrade reaches it", async () => {
    const { app, student, evaluation, items } = await exercise();
    const q0 = items[0]!.item.id;
    await sit(app, evaluation, items, student, [true, false, false]);
    const second = await retake(app, evaluation, student, "to_review");
    const copy = (await validatedOf(second.id)).find((g) => g.itemId === q0)!;
    const submitted = await sit(app, evaluation, items, student, [null, true, false], second);

    // The hand-in pass skipped the carried cell: the copy still stands.
    const graded = await validatedOf(submitted.id);
    expect(graded).toHaveLength(3);
    expect(graded.find((g) => g.itemId === q0)!.id).toBe(copy.id);
    // 2 points against 1: the partial retake is the kept attempt.
    expect((await keptAttempts(db, await reload(db, evaluation.id))).get(student)!.id).toBe(submitted.id);

    // A regrade of the item stands the copy down like any cell, and grades
    // the copied answer again.
    const item = items[0]!;
    const note = await regradeItem(
      db,
      { evaluationId: evaluation.id, itemId: q0, questionId: item.question.id, variables: null },
      { note: "typo" },
    );
    await runEvaluationGrading(app, { evaluationId: evaluation.id, itemIds: [q0], regradeNote: note! });
    const regraded = (await validatedOf(submitted.id)).find((g) => g.itemId === q0)!;
    expect(regraded.id).not.toBe(copy.id);
    expect(regraded.points).toBe(1);
    expect(regraded.regradeNote).toBe("typo");
  });

  it("does not carry a question still awaiting a correction", async () => {
    const { app, student, evaluation, items } = await exercise();
    const [q0, , q2] = items.map((i) => i.item.id) as [string, string, string];
    const first = await sit(app, evaluation, items, student, [true, false, true]);
    // q2 waits for the teacher: a proposal, nothing validated.
    await db
      .update(gradings)
      .set({ state: "proposed" })
      .where(and(eq(gradings.attemptId, first.id), eq(gradings.itemId, q2)));
    const second = await retake(app, evaluation, student, "to_review");
    expect(second.acquiredItemIds).toEqual([q0]);
    expect(await validatedOf(second.id)).toHaveLength(1);
  });

  it("leaves Redo everything a blank retake", async () => {
    const { app, student, evaluation, items } = await exercise();
    await sit(app, evaluation, items, student, [true, false, true]);
    const second = await retake(app, evaluation, student, "all");
    expect(second.acquiredItemIds).toEqual([]);
    expect(await answersOf(db, second.id)).toHaveProperty("size", 0);
    expect(await validatedOf(second.id)).toHaveLength(0);
  });

  it("is refused under the scope all, with nothing to review, and after the retake rule", async () => {
    const all = await exercise({ scope: "all" });
    await sit(all.app, all.evaluation, all.items, all.student, [true, false, true]);
    expect(await refusal(retake(all.app, all.evaluation, all.student, "to_review"))).toBe("scope_all");

    const { app, student, evaluation, items } = await exercise({ maxAttempts: 3 });
    // The retake rule comes first: no attempt yet.
    expect(await refusal(retake(app, evaluation, student, "to_review"))).toBe("no_attempt");
    await sit(app, evaluation, items, student, [true, true, true]);
    expect(await refusal(retake(app, evaluation, student, "to_review"))).toBe("nothing_to_review");
    // Nothing written by the refusal, and Redo everything remains.
    expect(await refusal(retake(app, evaluation, student, "all"))).toBeNull();
  });
});

describe("the settings (ADR-090)", () => {
  const NOW = new Date("2026-10-09T09:00:00.000Z");
  const retakes = { enabled: true, keep: "best" as const, maxAttempts: null, scope: "to_review" as const };

  it("needs free navigation, whichever half moves", async () => {
    const seed = await seedLive(db, { mode: "exercise" });
    const ex = await reload(db, seed.evaluationId);
    await expect(
      patchEvaluation(db, ex, { settings: { navigation: "forward_only", retakes } }, { attemptCount: 0, now: NOW }),
    ).rejects.toMatchObject({ code: "retake_scope_navigation", status: 422 });

    const next = await patchEvaluation(db, ex, { settings: { retakes } }, { attemptCount: 0, now: NOW });
    expect((next.settings as { retakes: RetakeSettings }).retakes).toEqual(retakes);
    await expect(
      patchEvaluation(db, next, { settings: { navigation: "milestones" } }, { attemptCount: 0, now: NOW }),
    ).rejects.toMatchObject({ code: "retake_scope_navigation" });
    // Retakes off: the scope is inert, and the navigation free to move.
    const off = await patchEvaluation(
      db,
      next,
      { settings: { retakes: { ...retakes, enabled: false }, navigation: "milestones" } },
      { attemptCount: 0, now: NOW },
    );
    expect((off.settings as { navigation: string }).navigation).toBe("milestones");
  });

  it("states the rule among the conditions", async () => {
    const { app, student, evaluation } = await exercise();
    const entered = await enterStarted(db, {
      evaluation,
      participant: await participant(evaluation, student),
      now: app.clock.now(),
    });
    expect(entered.kind).toBe("attempt");
    const view = entered.kind === "attempt" ? entered.view : null;
    expect(view!.conditions.imposed.map((l) => l.key)).toContain("partial_retake");
  });
});

describe("the results page under the scope to_review (ADR-090)", () => {
  it("states each question's standing in the student's order, and nothing else, under the policy none", async () => {
    const { app, student, evaluation, items } = await exercise();
    const [q0, q1, q2] = items.map((i) => i.item.id) as [string, string, string];
    await db
      .update(evaluations)
      .set({ feedbackPolicy: { ...feedbackOf(evaluation), when: "none" } })
      .where(eq(evaluations.id, evaluation.id));
    const running = await reload(db, evaluation.id);
    const first = await sit(app, running, items, student, [true, false, true]);
    await db
      .update(gradings)
      .set({ state: "proposed" })
      .where(and(eq(gradings.attemptId, first.id), eq(gradings.itemId, q2)));

    const feedback = await results.studentFeedback(db, running, first, app.clock.now());
    expect(feedback.available).toBe(false);
    if (feedback.available) return;
    expect(feedback.retake).toMatchObject({ scope: "to_review", refusal: null });
    const order = orderItems(items, settingsOf(running), first.seed, evaluation.id).map((o) => o.item.id);
    expect(feedback.review!.map((r) => r.itemId)).toEqual(order);
    expect(feedback.review!.map((r) => r.rank)).toEqual([0, 1, 2]);
    const standing = new Map(feedback.review!.map((r) => [r.itemId, r.standing]));
    expect(standing.get(q0)).toBe("acquired");
    expect(standing.get(q1)).toBe("to_review");
    expect(standing.get(q2)).toBe("pending");
    // An id, a rank and a word per question: no points, no answer, no key.
    for (const row of feedback.review!) expect(Object.keys(row).sort()).toEqual(["itemId", "rank", "standing"]);
    const text = JSON.stringify(feedback);
    expect(text).not.toContain("answer-q");
    expect(text).not.toContain("nope");
    expect(text).not.toContain("Statement of");

    // Once a later attempt exists, an earlier one's page lists nothing:
    // the next partial retake would follow the latest.
    const second = await retake(app, running, student, "to_review");
    await sit(app, running, items, student, [null, true, null], second);
    const older = await results.studentFeedback(db, running, first, app.clock.now());
    expect(older.available === false && older.review).toBeUndefined();
    const latest = await results.studentFeedback(db, running, (await live.attemptOf(db, evaluation.id, student))!, app.clock.now());
    expect(latest.available === false && latest.review?.filter((r) => r.standing !== "acquired")).toHaveLength(1);
  });

  it("keeps the standings beside a published correction (ADR-050)", async () => {
    const { app, student, evaluation, items } = await exercise();
    const first = await sit(app, evaluation, items, student, [true, false, true]);
    await results.publishCorrection(db, await reload(db, evaluation.id), app.clock.now());
    const feedback = await results.studentFeedback(db, await reload(db, evaluation.id), first, app.clock.now());
    expect(feedback.available).toBe(true);
    expect(feedback.retake).toMatchObject({ scope: "to_review", refusal: null });
    expect(feedback.review?.map((r) => r.standing).sort()).toEqual(["acquired", "acquired", "to_review"]);
  });

  it("sends the card to the results page under the scope to_review", async () => {
    const { app, student, evaluation, items } = await exercise();
    await sit(app, evaluation, items, student, [true, false, true]);
    const card = (await live.studentHome(db, student, app.clock.now())).open.find((c) => c.id === evaluation.id)!;
    expect(card.retakes).toMatchObject({ scope: "to_review", canRetake: true });
  });
});

describe("POST /evaluations/:id/retake with a scope (ADR-090)", () => {
  it("validates the body, carries the acquired questions over, and refuses writes to them", async () => {
    const student = await server.signIn("student");
    const seed = await seedLive(db, {
      mode: "exercise",
      studentIds: [student.id],
      questions: 2,
      durationS: null,
      settings: {
        timing: "manual",
        lobby: "skip",
        retakes: { enabled: true, keep: "last", maxAttempts: null, scope: "to_review" },
      },
    });
    await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
    const call = (method: "POST" | "PUT", url: string, payload?: Payload) =>
      server.app.inject({ method, url, headers: student.headers, ...(payload === undefined ? {} : { payload }) });

    const clientTs = server.clock.now().toISOString();
    const entered = await call("POST", `/app/api/evaluations/${seed.evaluationId}/attempt/start`, {});
    const firstId = entered.json().view.attempt.id as string;
    const [q0, q1] = seed.itemIds as [string, string];
    await call("PUT", `/app/api/attempts/${firstId}/answers/${q0}`, { payload: "answer-q0", revision: 1, clientTs });
    await call("PUT", `/app/api/attempts/${firstId}/answers/${q1}`, { payload: "nope", revision: 1, clientTs });
    await call("POST", `/app/api/attempts/${firstId}/submit`, { confirm: true });

    const bad = await call("POST", `/app/api/evaluations/${seed.evaluationId}/retake`, { scope: "some" });
    expect(bad.statusCode).toBe(400);

    const partial = await call("POST", `/app/api/evaluations/${seed.evaluationId}/retake`, { scope: "to_review" });
    expect(partial.statusCode).toBe(200);
    const view = partial.json().view;
    const secondId = view.attempt.id as string;
    expect(secondId).not.toBe(firstId);
    const byId = new Map((view.items as { id: string; acquired: boolean; answer: unknown }[]).map((i) => [i.id, i]));
    expect(byId.get(q0)).toMatchObject({ acquired: true, answer: "answer-q0" });
    expect(byId.get(q1)).toMatchObject({ acquired: false, answer: null });

    const write = await call("PUT", `/app/api/attempts/${secondId}/answers/${q0}`, { payload: "x", revision: 5, clientTs });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ error: "item_acquired" });

    // Everything right now: nothing left to review.
    await call("PUT", `/app/api/attempts/${secondId}/answers/${q1}`, { payload: "answer-q1", revision: 1, clientTs });
    await call("POST", `/app/api/attempts/${secondId}/submit`, { confirm: true });
    const none = await call("POST", `/app/api/evaluations/${seed.evaluationId}/retake`, { scope: "to_review" });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ error: "retake_refused", reason: "nothing_to_review" });
    // No body: Redo everything, as before ADR-090.
    const blank = await call("POST", `/app/api/evaluations/${seed.evaluationId}/retake`);
    expect(blank.statusCode).toBe(200);
    expect((blank.json().view.items as { acquired: boolean }[]).every((i) => !i.acquired)).toBe(true);
  });
});
