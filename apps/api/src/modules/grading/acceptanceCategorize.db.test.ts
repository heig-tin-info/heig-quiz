/**
 * Accepting a categorize answer (ADR-128) through the generic path: the
 * same route, guard and writer as a cloze's, the type's own hook deciding
 * what a part and an answer are — a card, and where the student put it.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { answerAcceptances, answers, gradings, questions } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { publishQuestion, reload, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as pool from "../pool/service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let students: { id: string; headers: Record<string, string> }[];

beforeAll(async () => {
  server = await testServer();
  server.clock.set("2026-11-10T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = [await server.signIn("student"), await server.signIn("student")];
});
afterAll(async () => {
  await server.close();
});

const db = () => server.app.db;
const send = (method: "POST" | "PUT" | "DELETE", url: string, payload: Payload = {}) =>
  server.app.inject({ method, url, headers: teacher.headers, payload });

/** Integer and Pointer; `double` is keyed in Floating point; `string` is a distractor. */
const COL = { int: "colint", float: "colflt", ptr: "colptr" };
const CARD = { int: "cardint", double: "carddbl", ptr: "cardptr", string: "cardstr" };
const categorize = (over: Record<string, unknown> = {}) => ({
  configVersion: 1,
  prompt: "Sort the C types.",
  columns: [
    { id: COL.int, label: "Integer", cards: [CARD.int] },
    { id: COL.float, label: "Floating point", cards: [CARD.double] },
    { id: COL.ptr, label: "Pointer", cards: [CARD.ptr] },
  ],
  cards: [
    { id: CARD.int, text: "int" },
    { id: CARD.double, text: "double" },
    { id: CARD.ptr, text: "void *" },
    { id: CARD.string, text: "string" },
  ],
  shuffleCards: false,
  policy: "per_item",
  ...over,
});
/** Everything right but `double`, put after `int` in Integer. */
const ANSWER = { columns: { [COL.int]: [CARD.int, CARD.double], [COL.ptr]: [CARD.ptr] } };

/** A closed exam of one categorize item, answered `ANSWER` by both students, graded. */
async function graded(config = categorize(), settings: Record<string, unknown> = {}) {
  const seed = await seedLive(db(), { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0, settings });
  const questionId = await publishQuestion(db(), seed.poolId, teacher.id, "types", { type: "categorize", config });
  const [item] = await evaluationService.addItems(
    db(),
    await reload(db(), seed.evaluationId),
    [questionId],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
  const attempts = [];
  for (const student of students) {
    const now = server.clock.now();
    const participant = (await live.participantOf(db(), evaluation, student.id))!;
    const created = await live.ensureAttempt(db(), evaluation, participant, now);
    const attempt = await live.beginAttempt(db(), evaluation, created, participant, now);
    await live.saveAnswer(db(), { evaluation, attempt, itemId: item!.id, payload: ANSWER, revision: 1, now });
    attempts.push(await live.submitAttempt(db(), evaluation, attempt, now));
    server.clock.advance(1000);
  }
  expect((await send("POST", `/app/api/evaluations/${evaluation.id}/close`, { confirm: true })).statusCode).toBe(200);
  return { evaluationId: evaluation.id, itemId: item!.id, questionId, attempts };
}

const url = (evaluationId: string, itemId: string) => `/app/api/evaluations/${evaluationId}/items/${itemId}/acceptances`;
const DOUBLE_IN_INT = { part: CARD.double, answer: COL.int, attemptId: null };

async function validated(attemptId: string, itemId: string) {
  const [row] = await db()
    .select()
    .from(gradings)
    .where(and(eq(gradings.attemptId, attemptId), eq(gradings.itemId, itemId), eq(gradings.state, "validated")));
  return row!;
}

describe("accepting a categorize card (ADR-128)", () => {
  it("accepts a card where everyone put it: both answers re-graded, the card right and marked", async () => {
    const { evaluationId, itemId, attempts } = await graded();
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(0.75);
    const res = await send("PUT", url(evaluationId, itemId), DOUBLE_IN_INT);
    expect(res.json()).toMatchObject({ accepted: true, regraded: 2, unchanged: 0 });
    for (const attempt of attempts) {
      const row = await validated(attempt.id, itemId);
      expect(row.points).toBe(1);
      const card = (row.details as { cards: { id: string; right: boolean; accepted?: true }[] }).cards.find(
        (c) => c.id === CARD.double,
      );
      expect(card).toMatchObject({ right: true, accepted: true });
    }
  });

  it("in an ordered question, accepts for one answer only: the everyone scope is refused", async () => {
    const { evaluationId, itemId, attempts } = await graded(categorize({ ordered: true }));
    const queue = await server.app.inject({
      method: "GET",
      url: `/app/api/evaluations/${evaluationId}/grading?itemId=${itemId}`,
      headers: teacher.headers,
    });
    expect((queue.json() as { items: { acceptance?: { scopes: string[] } }[] }).items[0]!.acceptance?.scopes).toEqual(["student"]);
    const everyone = await send("PUT", url(evaluationId, itemId), { ...DOUBLE_IN_INT, answer: `${COL.int}#2` });
    expect([everyone.statusCode, everyone.json().error]).toEqual([422, "acceptance_scope"]);
    const one = await send("PUT", url(evaluationId, itemId), {
      part: CARD.double,
      answer: `${COL.int}#2`,
      attemptId: attempts[0]!.id,
    });
    expect(one.json()).toMatchObject({ regraded: 1 });
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(1);
    expect((await validated(attempts[1]!.id, itemId)).points).toBe(0.75);
  });

  it("removes the penalty of negative marking", async () => {
    const { evaluationId, itemId, attempts } = await graded(categorize(), { negativeMarking: true });
    // t = 2, x = 1 over k = 3 columns: (2 − 1/2) / 3.
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(0.5);
    await send("PUT", url(evaluationId, itemId), DOUBLE_IN_INT);
    expect((await validated(attempts[0]!.id, itemId)).points).toBe(1);
  });

  it("drops the rule on a regrade onto a version without the column, the note saying so", async () => {
    const { evaluationId, itemId, attempts, questionId } = await graded();
    await send("PUT", url(evaluationId, itemId), DOUBLE_IN_INT);
    const [question] = await db().select().from(questions).where(eq(questions.id, questionId));
    const without = categorize();
    await pool.putDraft(db(), question!, {
      config: {
        ...without,
        columns: [
          { id: COL.float, label: "Floating point", cards: [CARD.double, CARD.int] },
          { id: COL.ptr, label: "Pointer", cards: [CARD.ptr] },
        ],
      },
    });
    await pool.publishQuestion(db(), question!, { userId: teacher.id });
    const regrade = await send("POST", `/app/api/evaluations/${evaluationId}/items/${itemId}/regrade`, {
      note: "v2",
      toVersionNumber: 2,
    });
    expect(regrade.statusCode).toBe(202);
    expect((await validated(attempts[0]!.id, itemId)).regradeNote).toBe(
      'v2 (re-graded with version 2) (accepted answers dropped: "double → Integer")',
    );
    expect(await db().select().from(answerAcceptances).where(eq(answerAcceptances.itemId, itemId))).toEqual([]);
  });

  it("names every placed card in the queue, a card in the tray never", async () => {
    const { evaluationId, itemId, attempts } = await graded();
    const queue = (await server.app.inject({
      method: "GET",
      url: `/app/api/evaluations/${evaluationId}/grading?itemId=${itemId}`,
      headers: teacher.headers,
    })).json() as {
      items: { acceptance?: { scopes: string[] } }[];
      entries: { attemptId: string; parts?: { part: string }[] }[];
    };
    const parts = queue.entries.find((e) => e.attemptId === attempts[0]!.id)!.parts!;
    expect(parts.map((p) => p.part).sort()).toEqual([CARD.int, CARD.double, CARD.ptr].sort());
    expect(queue.items[0]!.acceptance?.scopes).toEqual(["everyone", "student"]);
    const [answer] = await db().select().from(answers).where(eq(answers.attemptId, attempts[0]!.id));
    expect(answer!.payload).toEqual(ANSWER);
  });
});
