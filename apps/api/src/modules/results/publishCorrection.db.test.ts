/**
 * "Publish the correction" of an exercise that is still open (ADR-050),
 * over the REAL application: the route's refusals and its access rule
 * (invariant 6), the audit, the grading it sends, the class debrief it opens
 * — finished papers only — and what each student reads of their own attempt:
 * since ADR-124 the whole correction at the hand-in, whatever the stored
 * policy, published or not, retakes on and off.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationMode, FeedbackPolicy, RetakeSettings } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { attempts, auditLog, evaluations, gradings, questionVersions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { keyShownTo, releaseResults } from "./service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let stranger: { id: string; headers: Record<string, string> };

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
});
afterAll(async () => {
  await server.close();
  restore();
});

type User = { id: string; headers: Record<string, string> };

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const publish = (id: string, headers = teacher.headers) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${id}/publish-correction`,
    headers,
    payload: { confirm: true },
  });

/** An evaluation of one question, running, with two signed-in students. */
async function running(
  options: {
    mode?: EvaluationMode;
    retakes?: Partial<RetakeSettings>;
    feedback?: Partial<FeedbackPolicy>;
  } = {},
) {
  const db = server.app.db;
  const students: [User, User] = [await server.signIn("student"), await server.signIn("student")];
  const mode = options.mode ?? "exercise";
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: students.map((s) => s.id),
    questions: 1,
    mode,
    ...(mode === "exercise"
      ? {
          durationS: null,
          settings: {
            timing: "manual",
            lobby: "skip",
            ...(options.retakes
              ? { retakes: { enabled: true, keep: "best", maxAttempts: null, ...options.retakes } }
              : {}),
          },
        }
      : {}),
  });
  await setFeedback(seed.evaluationId, options.feedback ?? {});
  const evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", server.clock.now());
  const items = await joinedItems(db, evaluation.id);
  return { evaluation, itemId: items[0]!.item.id, students };
}

/** The policy is patchable while running; the fixture writes it directly. */
async function setFeedback(evaluationId: string, policy: Partial<FeedbackPolicy>) {
  await server.app.db
    .update(evaluations)
    .set({
      feedbackPolicy: {
        when: "on_release",
        showAnswer: true,
        showKey: true,
        showExplanation: false,
        showHiddenCaseNames: true,
        showTeacherComment: true,
        ...policy,
      },
    })
    .where(eq(evaluations.id, evaluationId));
}

/** One attempt, answered, handed in unless `submit` is false. */
async function sit(
  built: { evaluation: EvaluationRecord; itemId: string },
  userId: string,
  payload: string,
  submit = true,
) {
  const db = server.app.db;
  const evaluation = await reload(db, built.evaluation.id);
  const participant = (await live.participantOf(db, evaluation, userId))!;
  const now = server.clock.now();
  const created = await live.ensureAttempt(db, evaluation, participant, now);
  const attempt = await live.beginAttempt(db, evaluation, created, participant, now);
  await live.saveAnswer(db, { evaluation, attempt, itemId: built.itemId, payload, revision: 1, now });
  server.clock.advance(1000);
  return submit ? live.submitAttempt(db, evaluation, attempt, server.clock.now(), server.app) : attempt;
}

const gradingsOf = (attemptId: string) =>
  server.app.db.select().from(gradings).where(eq(gradings.attemptId, attemptId));

const feedbackOf = async (attemptId: string, student: User) =>
  (await get(`/app/api/attempts/${attemptId}/feedback`, student.headers)).json();

const papersOf = (body: { papers: number; outcomes: Record<string, number> }[]) => ({
  papers: body[0]!.papers,
  outcomes: Object.values(body[0]!.outcomes).reduce((a, b) => a + b, 0),
});

describe("POST /evaluations/:id/publish-correction (ADR-050)", () => {
  it("refuses an exam and a poll (422), and an exercise that is not running (409)", async () => {
    const exam = await running({ mode: "exam" });
    const refused = await publish(exam.evaluation.id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "correction_not_allowed", reason: "exam" });

    // A classroom poll, as the poll module stores one: the mode is the point.
    const poll = await running();
    await server.app.db
      .update(evaluations)
      .set({ mode: "poll" })
      .where(eq(evaluations.id, poll.evaluation.id));
    const pollRefused = await publish(poll.evaluation.id);
    expect(pollRefused.statusCode).toBe(422);
    expect(pollRefused.json()).toMatchObject({ error: "correction_not_allowed", reason: "poll" });

    const lobby = await running();
    await server.app.db
      .update(evaluations)
      .set({ state: "lobby" })
      .where(eq(evaluations.id, lobby.evaluation.id));
    const early = await publish(lobby.evaluation.id);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: "correction_not_open" });

    const closed = await running();
    await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${closed.evaluation.id}/close`,
      headers: teacher.headers,
      payload: { confirm: true },
    });
    const late = await publish(closed.evaluation.id);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toMatchObject({ error: "correction_not_open" });

    for (const e of [exam, poll, lobby, closed]) {
      expect((await reload(server.app.db, e.evaluation.id)).correctionPublishedAt).toBeNull();
    }
  });

  it("answers a stranger 404, as if the evaluation did not exist (invariant 6)", async () => {
    const { evaluation } = await running();
    const answer = await publish(evaluation.id, stranger.headers);
    expect(answer.statusCode).toBe(404);
    expect((await reload(server.app.db, evaluation.id)).correctionPublishedAt).toBeNull();
  });

  it("publishes once, audits once, grades the papers handed in, and opens the debrief", async () => {
    const built = await running();
    const [first, second] = built.students;
    // A paper handed in before ADR-067, which nothing graded at hand-in: the
    // submit without `app` sends no pass.
    const handedIn = await live.submitAttempt(
      server.app.db,
      await reload(server.app.db, built.evaluation.id),
      await sit(built, first.id, "answer-q0", false),
      server.clock.now(),
    );
    const writing = await sit(built, second.id, "nope", false);

    // Before: no debrief, nothing graded.
    expect((await get(`/app/api/evaluations/${built.evaluation.id}/results/by-question`, teacher.headers)).json())
      .toMatchObject({ error: "not_over" });
    expect(await gradingsOf(handedIn.id)).toHaveLength(0);
    // ADR-124: the student reads their correction anyway, the cell awaiting its grading.
    expect(await feedbackOf(handedIn.id, first)).toMatchObject({ available: true, pendingCount: 1 });

    const now = server.clock.now().toISOString();
    const published = await publish(built.evaluation.id);
    expect(published.statusCode).toBe(200);
    expect(published.json()).toEqual({ correctionPublishedAt: now, queued: 1 });
    expect(await gradingsOf(handedIn.id)).toHaveLength(1);
    expect(await gradingsOf(writing.id)).toHaveLength(0);

    // Idempotent: the first instant, nothing queued, one audit row.
    server.clock.advance(60_000);
    const again = await publish(built.evaluation.id);
    expect(again.json()).toEqual({ correctionPublishedAt: now, queued: 0 });
    const audited = await server.app.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "evaluation.correction_publish"),
          eq(auditLog.subjectId, built.evaluation.id),
        ),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ actorUserId: teacher.id, payload: { queued: 1 } });

    // The debrief counts the paper handed in, never the one being written.
    const debrief = await get(
      `/app/api/evaluations/${built.evaluation.id}/results/by-question`,
      teacher.headers,
    );
    expect(debrief.statusCode).toBe(200);
    expect(papersOf(debrief.json())).toEqual({ papers: 1, outcomes: 1 });
    expect(debrief.json()[0].outcomes).toMatchObject({ correct: 1 });
    expect(
      (await get(`/app/api/evaluations/${built.evaluation.id}/results/by-question`, stranger.headers))
        .statusCode,
    ).toBe(404);

    // The exercise stays open; the next hand-in is graded alone, at once.
    expect((await reload(server.app.db, built.evaluation.id)).state).toBe("running");
    await live.submitAttempt(
      server.app.db,
      await reload(server.app.db, built.evaluation.id),
      writing,
      server.clock.now(),
      server.app,
    );
    expect(await gradingsOf(writing.id)).toHaveLength(1);
    const later = await get(
      `/app/api/evaluations/${built.evaluation.id}/results/by-question`,
      teacher.headers,
    );
    expect(papersOf(later.json())).toEqual({ papers: 2, outcomes: 2 });
  });

  it("is forgotten when an evaluation nobody entered goes back to draft", async () => {
    const db = server.app.db;
    const { evaluation } = await running();
    expect((await publish(evaluation.id)).statusCode).toBe(200);
    const closed = await applyState(db, await reload(db, evaluation.id), "closed", server.clock.now());
    expect(closed.correctionPublishedAt).not.toBeNull();
    const draft = await applyState(db, closed, "draft", server.clock.now());
    expect(draft.correctionPublishedAt).toBeNull();
  });

  it("forbids reopening an attempt from then on, and the grid stops offering it", async () => {
    const built = await running();
    const handedIn = await sit(built, built.students[0].id, "nope");
    const reopen = () =>
      server.app.inject({
        method: "POST",
        url: `/app/api/evaluations/${built.evaluation.id}/attempts/${handedIn.id}/reopen`,
        headers: teacher.headers,
        payload: {},
      });
    const dashboard = async () =>
      (await get(`/app/api/evaluations/${built.evaluation.id}/dashboard`, teacher.headers)).json();
    expect((await dashboard()).evaluation.reopenable).toBe(true);

    await publish(built.evaluation.id);
    const refused = await reopen();
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: "correction_published" });
    expect((await dashboard()).evaluation.reopenable).toBe(false);
    // Graded at the publication, and left as it was handed in.
    const [row] = await server.app.db.select().from(attempts).where(eq(attempts.id, handedIn.id));
    expect(row!.state).toBe("submitted");
    expect(await gradingsOf(handedIn.id)).toHaveLength(1);
  });
});

describe("a student's own correction of an exercise (ADR-124)", () => {
  const secret = "why-this-is-the-key";
  /** A running exercise whose one question carries `secret` as its explanation. */
  async function explained(options: Parameters<typeof running>[0]) {
    const built = await running(options);
    const [item] = await joinedItems(server.app.db, built.evaluation.id);
    await server.app.db
      .update(questionVersions)
      .set({ explanation: secret })
      .where(eq(questionVersions.id, item!.version.id));
    return built;
  }

  it("shows the whole correction at the hand-in, retakes open, whatever the stored policy", async () => {
    const stored = [
      { when: "on_release", showKey: false },
      { when: "none", showKey: false, showExplanation: false },
      { when: "immediate", showKey: false, showAnswer: false },
    ] as const;
    for (const feedback of stored) {
      for (const retakes of [false, true]) {
        const built = await explained({ ...(retakes ? { retakes: {} } : {}), feedback });
        const [first, second] = built.students;
        const attempt = await sit(built, first.id, "nope");
        const writing = await sit(built, second.id, "nope", false);

        const label = `${feedback.when}, retakes ${retakes}`;
        const body = await feedbackOf(attempt.id, first);
        expect(body, label).toMatchObject({ available: true, points: 0, grade: null, evaluation: { releasedAt: null } });
        expect(body.items[0], label).toMatchObject({
          verdict: "wrong",
          answer: "nope",
          solution: { answer: "answer-q0" },
          explanation: secret,
        });
        if (retakes) expect(body.retake, label).toMatchObject({ refusal: null, attemptCount: 1 });
        else expect(body.retake, label).toBeUndefined();
        // The drill's rule is the feedback page's (ADR-041 §13): it follows.
        expect(keyShownTo(await reload(server.app.db, built.evaluation.id), "submitted"), label).toBe(true);

        // A paper still being written reads nothing, neither key nor explanation.
        const open = await feedbackOf(writing.id, second);
        expect(open, label).toMatchObject({ available: false, reason: "attempt_open" });
        expect(JSON.stringify(open), label).not.toContain("answer-q0");
        expect(JSON.stringify(open), label).not.toContain(secret);
      }
    }
  });

  it("holds the key back from the drill while a retake is written, and the publication changes nothing for the student", async () => {
    const built = await running({ retakes: {}, feedback: { when: "on_release", showKey: true } });
    const [first] = built.students;
    const attempt = await sit(built, first.id, "nope");
    const before = await feedbackOf(attempt.id, first);
    expect(before).toMatchObject({ available: true });

    await publish(built.evaluation.id);
    expect(await feedbackOf(attempt.id, first)).toEqual(before);

    const evaluation = await reload(server.app.db, built.evaluation.id);
    const retake = await live.retakeAttempt(server.app.db, {
      evaluation,
      participant: (await live.participantOf(server.app.db, evaluation, first.id))!,
      now: server.clock.now(),
    });
    expect(retake.attemptNumber).toBe(2);
    expect(keyShownTo(await reload(server.app.db, built.evaluation.id), retake.state)).toBe(false);
    // The debrief keeps the paper handed in, never the one being written.
    const debrief = await get(`/app/api/evaluations/${built.evaluation.id}/results/by-question`, teacher.headers);
    expect(papersOf(debrief.json())).toEqual({ papers: 1, outcomes: 1 });
    const rows = await server.app.db.select().from(attempts).where(eq(attempts.userId, first.id));
    expect(rows.map((r) => r.state).sort()).toEqual(["in_progress", "submitted"]);
  });

  it("leaves an exam's policy as stored: nothing before the close, no key without showKey", async () => {
    const built = await running({ mode: "exam", feedback: { when: "on_release", showKey: false } });
    const [first] = built.students;
    const attempt = await sit(built, first.id, "nope");
    expect(await feedbackOf(attempt.id, first)).toMatchObject({ available: false, reason: "exam_open" });

    const closed = await live.closeEvaluation(
      server.app.db,
      await reload(server.app.db, built.evaluation.id),
      server.clock.now(),
      "teacher",
      server.app,
    );
    expect(await feedbackOf(attempt.id, first)).toMatchObject({ available: false, reason: "results_pending" });
    await releaseResults(server.app.db, closed, server.clock.now());
    const body = await feedbackOf(attempt.id, first);
    expect(body).toMatchObject({ available: true });
    expect(body.items[0]).toMatchObject({ solution: null });
    expect(JSON.stringify(body)).not.toContain("answer-q0");
  });
});
