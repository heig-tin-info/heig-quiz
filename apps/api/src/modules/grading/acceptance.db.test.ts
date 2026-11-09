/**
 * Accepting an answer at grading time (ADR-128) over the REAL application:
 * the routes, the guards, the grading pass and the single writer.
 *
 * A cloze of two blanks — a dropdown keyed `int` whose `invalid` is
 * defensible, and a text blank keyed `zorglub` — answered by three students.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AnswerAcceptanceResult, GradingQueue, StudentFeedback } from "@quiz/contracts";

import {
  answerAcceptances,
  answers,
  auditLog,
  courseStaff,
  gradings,
  notifications,
  questions,
} from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { publishQuestion, reload, seedLive, shownAnswer } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as pool from "../pool/service.js";
import { checkGrading, runEvaluationGrading } from "./evaluationPass.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let students: { id: string; headers: Record<string, string> }[];

beforeAll(async () => {
  server = await testServer();
  server.clock.set("2026-11-09T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = [await server.signIn("student"), await server.signIn("student"), await server.signIn("student")];
});
afterAll(async () => {
  await server.close();
});

const db = () => server.app.db;
const get = (url: string, who = teacher) => server.app.inject({ method: "GET", url, headers: who.headers });
const send = (method: "POST" | "PUT" | "DELETE", url: string, payload: Payload = {}, who = teacher) =>
  server.app.inject({ method, url, headers: who.headers, payload });

const CLOZE = {
  configVersion: 2,
  text: "Type {{=int|invalid|long}}, name {{zorglub}}.",
  caseSensitive: false,
  shuffleOptions: true,
};

/** An evaluation holding the cloze alone, running (unless `draft`), with nobody in it yet. */
async function build(mode: "exam" | "exercise" = "exam", draft = false) {
  const seed = await seedLive(db(), {
    teacherId: teacher.id,
    studentIds: students.map((s) => s.id),
    questions: 0,
    mode,
  });
  const cloze = await publishQuestion(db(), seed.poolId, teacher.id, "cloze", { type: "cloze", config: CLOZE });
  const [item] = await evaluationService.addItems(
    db(),
    await reload(db(), seed.evaluationId),
    [cloze],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const stored = await reload(db(), seed.evaluationId);
  const evaluation = draft ? stored : await applyState(db(), stored, "running", server.clock.now());
  return { seed, evaluation, itemId: item!.id, questionId: cloze };
}

/** One student enters, answers the two blanks (canonical answers) and hands in. */
async function sit(evaluationId: string, student: number, blanks: (string | null)[]) {
  const evaluation = await reload(db(), evaluationId);
  const [item] = await joinedItems(db(), evaluationId);
  const now = server.clock.now();
  const participant = (await live.participantOf(db(), evaluation, students[student]!.id))!;
  const created = await live.ensureAttempt(db(), evaluation, participant, now);
  const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
  // Sent as the student's view shows the options (ADR-097), stored canonical.
  const payload = await shownAnswer(db(), evaluationId, item!.item.id, attempt, { blanks });
  await live.saveAnswer(db(), { evaluation, attempt, itemId: item!.item.id, payload, coordinates: "position", revision: 1, now });
  const submitted = await live.submitAttempt(db(), evaluation, attempt, now);
  server.clock.advance(1000);
  return submitted;
}

/**
 * Closed and graded: student 0 and 1 chose `invalid` (canonical 1), student 2
 * chose `long`; everyone wrote the text blank right. Student 1's grading is
 * then a teacher's manual override.
 */
async function graded() {
  const built = await build();
  const attempts = [await sit(built.evaluation.id, 0, ["1", "zorglub"]), await sit(built.evaluation.id, 1, ["1", "Zorglub"]), await sit(built.evaluation.id, 2, ["2", "zorglub"])];
  expect((await send("POST", `/app/api/evaluations/${built.evaluation.id}/close`, { confirm: true })).statusCode).toBe(200);
  const [answer] = await db().select().from(answers).where(eq(answers.attemptId, attempts[1]!.id));
  const override = await send("POST", `/app/api/answers/${answer!.id}/gradings`, { points: 0.5, comment: "half" });
  expect(override.statusCode).toBe(200);
  return { ...built, evaluation: await reload(db(), built.evaluation.id), attempts };
}

const url = (evaluationId: string, itemId: string) => `/app/api/evaluations/${evaluationId}/items/${itemId}/acceptances`;
const INVALID = { part: "b0", answer: "1", attemptId: null };

/** The validated grading of a cell. */
async function validated(attemptId: string, itemId: string) {
  const [row] = await db()
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), eq(gradings.state, "validated")));
  return row!;
}

const firstBlank = (details: unknown) => (details as { perBlank: { ok: boolean; accepted?: true }[] }).perBlank[0]!;

describe("accepting an answer (ADR-128)", () => {
  it("counts it right for everyone who gave it, leaves a manual override and other answers alone", async () => {
    const { evaluation, itemId, attempts } = await graded();
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(1);

    const res = await send("PUT", url(evaluation.id, itemId), INVALID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accepted: true,
      regraded: 1,
      unchanged: 1,
      modifiedAfterRelease: false,
    } satisfies AnswerAcceptanceResult);

    const regraded = await validated(attempts[0]!.id, itemId);
    expect(regraded.points).toBe(2);
    expect(firstBlank(regraded.details)).toMatchObject({ ok: true, accepted: true });
    expect((await validated(attempts[1]!.id, itemId)).source).toBe("manual");
    expect((await validated(attempts[2]!.id, itemId)).points).toBe(1);

    // The queue carries the rule, its label and what each answer gave.
    const queue = (await get(`/app/api/evaluations/${evaluation.id}/grading?itemId=${itemId}`)).json() as GradingQueue;
    expect(queue.items[0]!.acceptance).toEqual({
      scopes: ["everyone", "student"],
      accepted: [{ part: "b0", answer: "1", label: "invalid", attemptId: null }],
    });
    const entry = queue.entries.find((e) => e.attemptId === attempts[1]!.id)!;
    expect(entry.parts).toEqual([
      { part: "b0", answer: "1", label: "invalid", right: false },
      { part: "b1", answer: "zorglub", label: "zorglub", right: true },
    ]);

    // Once more changes nothing and audits nothing.
    expect((await send("PUT", url(evaluation.id, itemId), INVALID)).json()).toMatchObject({ regraded: 0 });
    const audited = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "evaluation.answer_accepted"), eq(auditLog.subjectId, evaluation.id)));
    expect(audited.map((a) => a.payload)).toEqual([
      { itemId, ...INVALID, accepted: true, regraded: 1, unchanged: 1, modifiedAfterRelease: false },
    ]);
  });

  it("stops accepting it with the same body, and the grade goes back", async () => {
    const { evaluation, itemId, attempts } = await graded();
    await send("PUT", url(evaluation.id, itemId), INVALID);
    const res = await send("DELETE", url(evaluation.id, itemId), INVALID);
    expect(res.json()).toMatchObject({ accepted: false, regraded: 1 });
    const back = await validated(attempts[0]!.id, itemId);
    expect(back.points).toBe(1);
    expect(firstBlank(back.details)).toEqual(expect.objectContaining({ ok: false }));
    expect(await db().select().from(answerAcceptances).where(eq(answerAcceptances.itemId, itemId))).toEqual([]);
  });

  it("accepts it for one student only", async () => {
    const { evaluation, itemId, attempts } = await graded();
    const res = await send("PUT", url(evaluation.id, itemId), { ...INVALID, attemptId: attempts[0]!.id });
    expect(res.json()).toMatchObject({ regraded: 1, unchanged: 0 });
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(2);
    // A text answer, folded as its blank matches: "Zorglub" and "zorglub" are one.
    const text = await send("PUT", url(evaluation.id, itemId), { part: "b1", answer: "Zorglub", attemptId: null });
    expect([text.statusCode, text.json().error]).toEqual([422, "acceptance_invalid"]);
    // An attempt of another evaluation is not one of this item's.
    const other = await graded();
    const foreign = await send("PUT", url(evaluation.id, itemId), { ...INVALID, attemptId: other.attempts[0]!.id });
    expect(foreign.statusCode).toBe(404);
  });

  it("is kept by a regrade, and dropped by one onto a version without the option, the note saying so", async () => {
    const { evaluation, itemId, attempts, questionId } = await graded();
    await send("PUT", url(evaluation.id, itemId), INVALID);
    const regrade = (body: Payload) => send("POST", `/app/api/evaluations/${evaluation.id}/items/${itemId}/regrade`, body);
    expect((await regrade({ note: "again" })).statusCode).toBe(202);
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(2);

    const [question] = await db().select().from(questions).where(eq(questions.id, questionId));
    await pool.putDraft(db(), question!, { config: { ...CLOZE, text: "Type {{=int|long|short}}, name {{zorglub}}." } });
    await pool.publishQuestion(db(), question!, { userId: teacher.id });
    expect((await regrade({ note: "v2", toVersionNumber: 2 })).statusCode).toBe(202);
    const after = await validated(attempts[0]!.id, itemId);
    expect(after.points).toBe(1);
    expect(after.regradeNote).toBe('v2 (re-graded with version 2) (accepted answers dropped: "invalid")');
    expect(await db().select().from(answerAcceptances).where(eq(answerAcceptances.itemId, itemId))).toEqual([]);
  });

  it("grades an attempt handed in after the act with it, and the check of an exercise; never a practice attempt", async () => {
    const built = await build("exercise");
    const first = await sit(built.evaluation.id, 0, ["0", "zorglub"]);
    expect(first.state).toBe("submitted");
    const res = await send("PUT", url(built.evaluation.id, built.itemId), INVALID);
    expect(res.statusCode).toBe(200);
    const later = await sit(built.evaluation.id, 1, ["1", "zorglub"]);
    // The hand-in's own pass (ADR-067), as the hand-in route sends it.
    await runEvaluationGrading(server.app, { evaluationId: built.evaluation.id, attemptIds: [later.id] });
    expect((await validated(later.id, built.itemId)).points).toBe(2);

    const evaluation = await reload(db(), built.evaluation.id);
    const [item] = await joinedItems(db(), evaluation.id);
    const [answer] = await db().select().from(answers).where(eq(answers.attemptId, later.id));
    const check = await checkGrading(server.app, { evaluation, item: item!, attempt: later, answer: answer! });
    expect(check && "write" in check ? check.write.points : null).toBe(2);
    const practice = await checkGrading(server.app, {
      evaluation,
      item: item!,
      attempt: { ...later, afterDue: true },
      answer: answer!,
    });
    expect(practice && "write" in practice ? practice.write.points : null).toBe(1);
  });

  it("refuses a part the question cannot hold, and a list not frozen yet", async () => {
    const built = await build();
    // No attempt yet, but running: the list is frozen by the state.
    const absent = await send("PUT", url(built.evaluation.id, built.itemId), { part: "b9", answer: "1", attemptId: null });
    expect([absent.statusCode, absent.json().error]).toEqual([422, "acceptance_invalid"]);
    const draft = await build("exam", true);
    const notFrozen = await send("PUT", url(draft.evaluation.id, draft.itemId), INVALID);
    expect([notFrozen.statusCode, notFrozen.json().error]).toEqual([409, "acceptance_not_frozen"]);
  });
});

describe("access and release (ADR-068 §3, ADR-108 §6)", () => {
  it("answers 404 to a teacher of another course, 403 to a student", async () => {
    const { evaluation, itemId } = await graded();
    const stranger = await server.signIn("teacher");
    expect((await send("PUT", url(evaluation.id, itemId), INVALID, stranger)).statusCode).toBe(404);
    const asStudent = await send("PUT", url(evaluation.id, itemId), INVALID, students[0]!);
    expect([asStudent.statusCode, asStudent.json().error]).toEqual([403, "forbidden"]);
  });

  it("after the release: the owner's alone, and only a student whose grade moved is told", async () => {
    const { evaluation, itemId, seed, attempts } = await graded();
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);

    const assistant = await server.signIn("teacher");
    await db().insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
    const refused = await send("PUT", url(evaluation.id, itemId), INVALID, assistant);
    expect([refused.statusCode, refused.json().error]).toEqual([403, "owner_required"]);

    const res = await send("PUT", url(evaluation.id, itemId), INVALID);
    expect(res.json()).toMatchObject({ regraded: 1, unchanged: 1, modifiedAfterRelease: true });
    const told = await db()
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.evaluationId, evaluation.id),
          sql`${notifications.payload}->>'kind' = 'results_updated'`,
        ),
      );
    expect(told.map((n) => n.userId)).toEqual([students[0]!.id]);

    // The student reads the blank right, accepted, and never the key.
    const feedback = await get(`/app/api/attempts/${attempts[0]!.id}/feedback`, students[0]!);
    const body = feedback.json() as StudentFeedback;
    if (!body.available) throw new Error("feedback expected");
    expect(firstBlank(body.items[0]!.details)).toMatchObject({ ok: true, accepted: true });
    expect(feedback.body).not.toContain('"expected"');
    expect(feedback.body).not.toContain('"given"');
  });
});
