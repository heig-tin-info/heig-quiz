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
  attempts,
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
import { acceptanceGuard, type RuleBound } from "./acceptanceRules.js";
import { boundCell, checkGrading, readConfig, runEvaluationGrading } from "./evaluationPass.js";
import { passGuard } from "./passCommon.js";
import { pairKey } from "./records.js";
import { writeGradings } from "./writer.js";

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
 * Closed and graded. By default student 0 and 1 chose `invalid` (canonical 1), student 2
 * chose `long`; everyone wrote the text blank right. Student 1's grading is
 * then a teacher's manual override; other `blanks`, no override.
 */
async function graded(
  blanks: (string | null)[][] = [
    ["1", "zorglub"],
    ["1", "Zorglub"],
    ["2", "zorglub"],
  ],
) {
  const built = await build();
  const attempts = [];
  for (const [student, given] of blanks.entries()) attempts.push(await sit(built.evaluation.id, student, given));
  expect((await send("POST", `/app/api/evaluations/${built.evaluation.id}/close`, { confirm: true })).statusCode).toBe(200);
  if (attempts[1] && blanks.length === 3) {
    const [answer] = await db().select().from(answers).where(eq(answers.attemptId, attempts[1].id));
    const override = await send("POST", `/app/api/answers/${answer!.id}/gradings`, { points: 0.5, comment: "half" });
    expect(override.statusCode).toBe(200);
  }
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

  });

  it("shows the student the blank right, accepted, and never the key nor another student's accepted answer (05 §5.7)", async () => {
    const { evaluation, itemId, attempts: sat } = await graded([
      ["1", "zorg"],
      ["1", "gloubiboulga"],
    ]);
    expect((await send("PUT", url(evaluation.id, itemId), INVALID)).statusCode).toBe(200);
    const own = { part: "b1", answer: "gloubiboulga", attemptId: sat[1]!.id };
    expect((await send("PUT", url(evaluation.id, itemId), own)).statusCode).toBe(200);
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);
    const feedback = await get(`/app/api/attempts/${sat[0]!.id}/feedback`, students[0]!);
    const body = feedback.json() as StudentFeedback;
    if (!body.available) throw new Error("feedback expected");
    expect(firstBlank(body.items[0]!.details)).toMatchObject({ ok: true, accepted: true });
    for (const key of ['"expected"', '"given"', '"correct"']) expect(feedback.body).not.toContain(key);
    // The text blank's key, and the other student's own accepted text. The
    // dropdown's right label, `int`, is one of the options every student is
    // shown: which option is right is the key, and `correct` is checked above.
    expect(feedback.body).not.toContain("zorglub");
    expect(feedback.body).not.toContain("gloubiboulga");
  });
});

/**
 * The act's serialization (ADR-128 §6): what reaches the single writer is
 * decided under the item's lock, by `acceptanceGuard`. True concurrency is
 * not reproducible on PGlite (one connection), so these tests hand the guard
 * a grading computed BEFORE the competing write landed — exactly what a
 * request that lost the race holds — and check what the guard lets through.
 */
describe("the act's serialization", () => {
  /** Student 0's cell graded now, bound to `rules`: what a racing writer computed. */
  async function stale(evaluationId: string, attemptId: string, rules: { part: string; answer: string; attemptId: string | null }[]) {
    const evaluation = await reload(db(), evaluationId);
    const [item] = await joinedItems(db(), evaluationId);
    const attempt = (await db().select().from(attempts).where(eq(attempts.id, attemptId)))[0]!;
    const [answer] = await db().select().from(answers).where(eq(answers.attemptId, attemptId));
    const { graded, bound } = await boundCell(server.app, {
      evaluation,
      job: { evaluationId },
      item: item!,
      config: readConfig(server.app, item!).configOf(attempt),
      attempt,
      answer: answer!,
      llm: false,
      rules,
    });
    if (!("write" in graded)) throw new Error("a grading expected");
    return { write: graded.write, bound: new Map<ReturnType<typeof pairKey>, RuleBound>([[pairKey(attemptId, item!.item.id), bound]]) };
  }

  it("never unseats a manual override that landed after the reach was read", async () => {
    const { evaluation, itemId, attempts: sat } = await graded();
    await send("PUT", url(evaluation.id, itemId), INVALID);
    // The act's grading of student 0, computed; then the teacher overrides it.
    const { write, bound } = await stale(evaluation.id, sat[0]!.id, [INVALID]);
    const [answer] = await db().select().from(answers).where(eq(answers.attemptId, sat[0]!.id));
    expect((await send("POST", `/app/api/answers/${answer!.id}/gradings`, { points: 1.5, comment: "mine" })).statusCode).toBe(200);
    const written = await writeGradings(db(), [write], acceptanceGuard(passGuard(), bound, { leaveManual: true }));
    expect(written).toEqual([]);
    expect(await validated(sat[0]!.id, itemId)).toMatchObject({ source: "manual", points: 1.5 });
  });

  it("writes a grading computed before a second acceptance with both: an answer carrying both keeps both", async () => {
    const { evaluation, itemId, attempts: sat } = await graded([["1", "zorg"]]);
    const ZORG = { part: "b1", answer: "zorg", attemptId: null };
    expect((await send("PUT", url(evaluation.id, itemId), INVALID)).json()).toMatchObject({ regraded: 1 });
    // A pass (or the first act) that read the rules before the second act.
    const { write, bound } = await stale(evaluation.id, sat[0]!.id, [INVALID]);
    expect(write.points).toBe(1);
    expect((await send("PUT", url(evaluation.id, itemId), ZORG)).json()).toMatchObject({ regraded: 1 });
    expect((await validated(sat[0]!.id, itemId)).points).toBe(2);
    const [written] = await writeGradings(db(), [write], acceptanceGuard(passGuard(), bound));
    expect(written!.points).toBe(2);
    expect((await validated(sat[0]!.id, itemId)).points).toBe(2);
  });

  it("heals on a retried PUT: a rule whose re-grade never ran is applied", async () => {
    const { evaluation, itemId, attempts: sat } = await graded();
    // The first act wrote its rule, then failed before its re-grade.
    await db().insert(answerAcceptances).values({ id: crypto.randomUUID(), itemId, ...INVALID, createdBy: teacher.id });
    expect((await validated(sat[0]!.id, itemId)).points).toBe(1);
    const retried = await send("PUT", url(evaluation.id, itemId), INVALID);
    expect(retried.json()).toMatchObject({ accepted: true, regraded: 1, unchanged: 1 });
    expect((await validated(sat[0]!.id, itemId)).points).toBe(2);
    // The act changed no rule: it audits nothing.
    const audited = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "evaluation.answer_accepted"), eq(auditLog.subjectId, evaluation.id)));
    expect(audited).toEqual([]);
  });
});
