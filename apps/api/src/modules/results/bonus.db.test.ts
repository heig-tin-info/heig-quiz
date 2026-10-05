/**
 * Bonus questions (ADR-052) over the REAL application: the whole plugin
 * chain, the real guards, the real migrations.
 *
 * A bonus item's points are left out of the evaluation's total, so they can
 * only lift a student, and the grade is capped at 6. Under negative marking
 * (ADR-026) a bonus item is scored with the negative rule, its score floored
 * at 0. The flag is locked like the points, refused as the only thing that
 * counts, marked in the CSV and carried by a template.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttemptOrLobby, GradingQueue, ResultsView, StudentFeedback } from "@quiz/contracts";
import { evaluationTotal } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { gradings } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { enterStarted, publishQuestion, reload, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import * as templates from "../evaluation/templates.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as live from "../live/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let students: { id: string; headers: Record<string, string> }[];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-30T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = [await server.signIn("student"), await server.signIn("student")];
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const get = (url: string, who = teacher) => server.app.inject({ method: "GET", url, headers: who.headers });
const send = (method: "POST" | "PATCH", url: string, payload: Payload = {}, who = teacher) =>
  server.app.inject({ method, url, headers: who.headers, payload });

/** Two keys, two distractors: under negative marking, both distractors cost the whole item. */
const MULTIPLE = {
  configVersion: 2,
  prompt: "Which declarations are valid in C17?",
  choices: [
    { text: "`int a[] = {1,2,3};`", correct: true },
    { text: "`int a[3] = {0};`", correct: true },
    { text: "`int a[];`", correct: false },
    { text: "`int a[-1];`", correct: false },
  ],
  mode: "multiple",
  policy: "all_or_nothing",
  shuffleChoices: false,
};

/**
 * An exam with negative marking and two items: the fixture's `short`
 * question (2 points) and a multiple-answer mcq (4 points), a BONUS, through
 * the teacher's route. Its total is 2.
 */
async function build() {
  const seed = await seedLive(db(), {
    teacherId: teacher.id,
    studentIds: students.map((s) => s.id),
    questions: 1,
    settings: { negativeMarking: true },
  });
  const mcq = await publishQuestion(db(), seed.poolId, teacher.id, "mcq-bonus", {
    type: "mcq",
    config: MULTIPLE,
  });
  const [, bonus] = await evaluationService.addItems(
    db(),
    await reload(db(), seed.evaluationId),
    [mcq],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  const items = `/app/api/evaluations/${seed.evaluationId}/items`;
  expect((await send("PATCH", `${items}/${seed.itemIds[0]}`, { points: 2 })).statusCode).toBe(200);
  expect((await send("PATCH", `${items}/${bonus!.id}`, { points: 4, bonus: true })).statusCode).toBe(200);
  return { seed, items: await joinedItems(db(), seed.evaluationId) };
}

/** Enters, answers both items and submits, through the services the routes call. */
async function sit(evaluation: EvaluationRecord, userId: string, short: string, selected: number[]) {
  const items = await joinedItems(db(), evaluation.id);
  const participant = (await live.participantOf(db(), evaluation, userId))!;
  const now = server.clock.now();
  let { attempt } = await enterStarted(db(), { evaluation, participant, now });
  if (attempt.state === "not_started") {
    attempt = await live.beginAttempt(db(), evaluation, attempt, participant, now);
  }
  for (const [index, payload] of [short, { selected }].entries()) {
    const itemId = items[index]!.item.id;
    await live.saveAnswer(db(), { evaluation, attempt, itemId, payload, revision: 1, now });
  }
  const submitted = await live.submitAttempt(db(), evaluation, attempt, now);
  server.clock.advance(1000);
  return submitted;
}

/**
 * Student 0 guesses: the short answer wrong, both distractors of the bonus
 * (−4 by the negative rule, floored at 0). Student 1 answers everything
 * right: 2 + 4 = 6 points of a total of 2.
 */
async function sat() {
  const { seed, items } = await build();
  const running = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
  const guesser = await sit(running, students[0]!.id, "nope", [2, 3]);
  const good = await sit(running, students[1]!.id, "answer-q0", [0, 1]);
  expect((await send("POST", `/app/api/evaluations/${running.id}/close`, { confirm: true })).statusCode).toBe(200);
  return { evaluation: await reload(db(), running.id), items, guesser, good };
}

describe("a bonus item", () => {
  it("is left out of the total, the same in SQL, and lifts a student to a grade capped at 6", async () => {
    const { evaluation, items, good } = await sat();
    expect(evaluationTotal(items.map((i) => i.item))).toBe(2);
    const inSql = await evaluationService.totalPointsByEvaluation(db(), [evaluation.id]);
    expect(inSql.get(evaluation.id)).toBe(2);

    const view = (await get(`/app/api/evaluations/${evaluation.id}/results`)).json() as ResultsView;
    expect(view.totalPoints).toBe(2);
    expect(view.items.map((i) => i.bonus)).toEqual([false, true]);
    const row = view.rows.find((r) => r.attemptId === good.id)!;
    expect(row.perItem[items[1]!.item.id]).toBe(4);
    expect([row.points, row.grade]).toEqual([6, 6]);
  });

  it("is scored with negative marking, but never below 0, and corrected within [0, max]", async () => {
    const { evaluation, items, guesser } = await sat();
    const stored = await db()
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, guesser.id), eq(gradings.state, "validated")));
    expect(stored.find((g) => g.itemId === items[1]!.item.id)!.points).toBe(0);
    const queue = (await get(`/app/api/evaluations/${evaluation.id}/grading`)).json() as GradingQueue;
    expect(queue.items.map((i) => [i.points, i.minPoints])).toEqual([
      [2, 0],
      [4, 0],
    ]);
  });

  it("marks its CSV column and counts in the student's total", async () => {
    const { evaluation } = await sat();
    const csv = (await get(`/app/api/evaluations/${evaluation.id}/results.csv`)).body;
    const [header, ...lines] = csv.replace(/^﻿/, "").split(/\r\n/);
    expect(header!.split(";").slice(-4)).toEqual(["q0", "mcq-bonus (bonus)", "total", "grade"]);
    expect(lines.find((l) => l.endsWith(";2;4;6;6.0"))).toBeDefined();
  });

  it("is labelled for the student while answering, and on the released feedback", async () => {
    const { seed } = await build();
    await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const entered = (
      await send("POST", `/app/api/evaluations/${seed.evaluationId}/attempt/start`, {}, students[0])
    ).json() as AttemptOrLobby;
    if (entered.kind !== "attempt") throw new Error("attempt expected");
    expect(entered.view.evaluation.totalPoints).toBe(2);
    expect(entered.view.items.map((i) => i.bonus)).toEqual([false, true]);

    const { evaluation, good } = await sat();
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);
    const feedback = (await get(`/app/api/attempts/${good.id}/feedback`, students[1])).json() as StudentFeedback;
    if (!feedback.available) throw new Error("feedback expected");
    expect([feedback.points, feedback.totalPoints, feedback.grade]).toEqual([6, 2, 6]);
    expect(feedback.items.map((i) => i.bonus)).toEqual([false, true]);
  });
});

describe("the bonus flag", () => {
  it("is locked with the points once an attempt exists", async () => {
    const { seed, items } = await build();
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    await sit(evaluation, students[0]!.id, "nope", []);
    const url = `/app/api/evaluations/${seed.evaluationId}/items/${items[1]!.item.id}`;
    expect((await send("PATCH", url, { bonus: false })).statusCode).toBe(409);
    expect((await joinedItems(db(), seed.evaluationId))[1]!.item.bonus).toBe(true);
  });

  it("refuses to open an exam whose every question is a bonus", async () => {
    const { seed, items } = await build();
    const url = `/app/api/evaluations/${seed.evaluationId}`;
    await send("PATCH", `${url}/items/${items[0]!.item.id}`, { bonus: true });
    const res = await send("POST", `${url}/state`, { to: "lobby" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "illegal_transition", reason: "no_graded_points" });
  });

  it("travels into a template and moves its revision", async () => {
    const { seed } = await build();
    const { template } = await templates.saveAsTemplate(db(), await reload(db(), seed.evaluationId), {
      courseId: seed.courseId,
      title: "Modèle bonus",
      createdBy: teacher.id,
    });
    const copied = await joinedItems(db(), template.id);
    expect(copied.map((i) => i.item.bonus)).toEqual([false, true]);
    expect(template.revision).toBe(1);

    const { row, revised } = await templates.editTemplate(db(), template, (tx, locked, ctx) =>
      evaluationService.patchItem(tx, locked, copied[1]!.item.id, { bonus: false }, ctx),
    );
    expect([revised, row.revision]).toEqual([true, 2]);
  });
});
