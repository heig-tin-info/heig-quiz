/**
 * How an item counts — bonus (ADR-052) and neutralized (ADR-108) — over the
 * REAL application: the whole plugin chain, the real guards, the real
 * migrations.
 *
 * A bonus item's points are left out of the evaluation's total, so they can
 * only lift a student, and the grade is capped at 6. Under negative marking
 * (ADR-026) a bonus item is scored with the negative rule, its score floored
 * at 0. The builder's flag is locked like the points, refused as the only
 * thing that counts, marked in the CSV and carried by a template.
 *
 * Once the item list is frozen, the grading-time act (ADR-108) moves an item
 * between normal, bonus and neutralized: stored gradings never change, the
 * sums apply the counting, a released evaluation becomes "modified after
 * publication" and only the students whose grade moved are told.
 */
import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AttemptOrLobby, GradingQueue, ResultsView, StudentFeedback } from "@quiz/contracts";
import { evaluationTotal } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, courseStaff, evaluations, gradings, notifications } from "../../db/schema.js";
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
const send = (method: "POST" | "PATCH" | "PUT", url: string, payload: Payload = {}, who = teacher) =>
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
  expect((await send("PATCH", `${items}/${bonus!.id}`, { points: 4, counting: "bonus" })).statusCode).toBe(200);
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

const results = async (evaluationId: string) =>
  (await get(`/app/api/evaluations/${evaluationId}/results`)).json() as ResultsView;

describe("a bonus item", () => {
  it("is left out of the total, the same in SQL, and lifts a student to a grade capped at 6", async () => {
    const { evaluation, items, good } = await sat();
    expect(evaluationTotal(items.map((i) => i.item))).toBe(2);
    const inSql = await evaluationService.totalPointsByEvaluation(db(), [evaluation.id]);
    expect(inSql.get(evaluation.id)).toBe(2);

    const view = (await get(`/app/api/evaluations/${evaluation.id}/results`)).json() as ResultsView;
    expect(view.totalPoints).toBe(2);
    expect(view.items.map((i) => i.counting)).toEqual(["normal", "bonus"]);
    const row = view.rows.find((r) => r.attemptId === good.id)!;
    expect(row.perItem[items[1]!.item.id]).toBe(4);
    expect([row.points, row.grade]).toEqual([6, 6]);
  });

  it("is scored with negative marking, stored raw, shown and summed at 0, and corrected within [0, max]", async () => {
    const { evaluation, items, guesser } = await sat();
    const stored = await db()
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, guesser.id), eq(gradings.state, "validated")));
    // ONE floor, at sum time (ADR-108): the grading keeps the negative rule's −4.
    expect(stored.find((g) => g.itemId === items[1]!.item.id)!.points).toBe(-4);
    const row = (await results(evaluation.id)).rows.find((r) => r.attemptId === guesser.id)!;
    expect([row.perItem[items[1]!.item.id], row.points]).toEqual([0, 0]);
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
    expect(entered.view.items.map((i) => i.counting)).toEqual(["normal", "bonus"]);

    const { evaluation, good } = await sat();
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);
    const feedback = (await get(`/app/api/attempts/${good.id}/feedback`, students[1])).json() as StudentFeedback;
    if (!feedback.available) throw new Error("feedback expected");
    expect([feedback.points, feedback.totalPoints, feedback.grade]).toEqual([6, 2, 6]);
    expect(feedback.items.map((i) => i.counting)).toEqual(["normal", "bonus"]);
  });
});

describe("the bonus flag", () => {
  it("is locked with the points once an attempt exists", async () => {
    const { seed, items } = await build();
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    await sit(evaluation, students[0]!.id, "nope", []);
    const url = `/app/api/evaluations/${seed.evaluationId}/items/${items[1]!.item.id}`;
    expect((await send("PATCH", url, { counting: "normal" })).statusCode).toBe(409);
    expect((await joinedItems(db(), seed.evaluationId))[1]!.item.counting).toBe("bonus");
  });

  it("refuses to open an exam whose every question is a bonus", async () => {
    const { seed, items } = await build();
    const url = `/app/api/evaluations/${seed.evaluationId}`;
    await send("PATCH", `${url}/items/${items[0]!.item.id}`, { counting: "bonus" });
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
    expect(copied.map((i) => i.item.counting)).toEqual(["normal", "bonus"]);
    expect(template.revision).toBe(1);

    const { row, revised } = await templates.editTemplate(db(), template, (tx, locked, ctx) =>
      evaluationService.patchItem(tx, locked, copied[1]!.item.id, { counting: "normal" }, ctx),
    );
    expect([revised, row.revision]).toEqual([true, 2]);
  });
});

// --- The grading-time act (ADR-108) ------------------------------------------

/** `PUT …/items/:itemId/counting`, as the teacher unless told otherwise. */
const setCounting = (evaluationId: string, itemId: string, counting: string, who = teacher) =>
  send("PUT", `/app/api/evaluations/${evaluationId}/items/${itemId}/counting`, { counting }, who);

/**
 * The same exam with the mcq a NORMAL item while it is graded: both students
 * get the short answer right; the guesser picks both distractors of the mcq,
 * STORED at −4 by the negative rule, so the sum 2 − 4 is floored at 0. The
 * other student scores 2 + 4 = 6 of a total of 6.
 */
async function satNormal() {
  const { seed, items } = await build();
  const mcqUrl = `/app/api/evaluations/${seed.evaluationId}/items/${items[1]!.item.id}`;
  expect((await send("PATCH", mcqUrl, { counting: "normal" })).statusCode).toBe(200);
  const running = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
  const guesser = await sit(running, students[0]!.id, "answer-q0", [2, 3]);
  const good = await sit(running, students[1]!.id, "answer-q0", [0, 1]);
  expect((await send("POST", `/app/api/evaluations/${running.id}/close`, { confirm: true })).statusCode).toBe(200);
  const evaluation = await reload(db(), running.id);
  return { evaluation, courseId: seed.courseId, short: items[0]!.item.id, mcq: items[1]!.item.id, guesser, good };
}

const pointsOf = (view: ResultsView, attemptId: string) => {
  const row = view.rows.find((r) => r.attemptId === attemptId)!;
  return [row.points, row.grade];
};

describe("changing how an item counts at grading time (ADR-108)", () => {
  it("is refused while the item list is still editable: the builder's toggle owns it", async () => {
    const { seed, items } = await build();
    const res = await setCounting(seed.evaluationId, items[1]!.item.id, "neutralized");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "counting_not_frozen" });
    expect((await joinedItems(db(), seed.evaluationId))[1]!.item.counting).toBe("bonus");
  });

  it("is refused on a poll", async () => {
    const seed = await seedLive(db(), { teacherId: teacher.id, studentIds: [], questions: 1 });
    // A poll is not made by `createEvaluation` (D7): the mode is set on the row.
    await db().update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, seed.evaluationId));
    const res = await setCounting(seed.evaluationId, seed.itemIds[0]!, "bonus");
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "counting_poll" });
  });

  it("refuses a change that would leave nothing in the total, and a foreign item", async () => {
    const { evaluation, short, mcq } = await satNormal();
    expect((await setCounting(evaluation.id, short, "neutralized")).statusCode).toBe(200);
    const res = await setCounting(evaluation.id, mcq, "bonus");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "illegal_transition", reason: "no_graded_points" });
    expect((await setCounting(evaluation.id, randomUUID(), "bonus")).statusCode).toBe(404);
  });

  it("floors a bonus cell and leaves a neutralized one out of every sum, never rewriting a grading", async () => {
    const { evaluation, mcq, guesser, good } = await satNormal();
    let view = await results(evaluation.id);
    expect(view.totalPoints).toBe(6);
    expect(pointsOf(view, guesser.id)).toEqual([0, 1]);

    const bonus = await setCounting(evaluation.id, mcq, "bonus");
    expect(bonus.statusCode).toBe(200);
    expect(bonus.json()).toEqual({ counting: "bonus", modifiedAfterRelease: false });
    view = await results(evaluation.id);
    expect(view.items.map((i) => i.counting)).toEqual(["normal", "bonus"]);
    expect(view.totalPoints).toBe(2);
    // A bonus never reads "−4 / 4": the cell shows what it counts.
    expect(view.rows.find((r) => r.attemptId === guesser.id)!.perItem[mcq]).toBe(0);
    // 2 + max(0, −4): the floor is the cell's, not only the total's.
    expect(pointsOf(view, guesser.id)).toEqual([2, 6]);
    expect(pointsOf(view, good.id)).toEqual([6, 6]);

    expect((await setCounting(evaluation.id, mcq, "neutralized")).statusCode).toBe(200);
    view = await results(evaluation.id);
    expect(view.totalPoints).toBe(2);
    expect(pointsOf(view, guesser.id)).toEqual([2, 6]);
    expect(pointsOf(view, good.id)).toEqual([2, 6]);
    // A neutralized cell still shows what it was graded, struck through on screen.
    expect(view.rows.find((r) => r.attemptId === guesser.id)!.perItem[mcq]).toBe(-4);

    const csv = (await get(`/app/api/evaluations/${evaluation.id}/results.csv`)).body;
    const [header, ...lines] = csv.replace(/^\uFEFF/, "").split(/\r\n/);
    expect(header!.split(";").slice(-4)).toEqual(["q0", "mcq-bonus (not counted)", "total", "grade"]);
    expect(lines.find((l) => l.endsWith(";2;-4;2;6.0"))).toBeDefined();

    // Reversible: back to normal, the stored −4 counts again.
    expect((await setCounting(evaluation.id, mcq, "normal")).statusCode).toBe(200);
    expect(pointsOf(await results(evaluation.id), guesser.id)).toEqual([0, 1]);
    const stored = await db()
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, guesser.id), eq(gradings.itemId, mcq), eq(gradings.state, "validated")));
    expect(stored.map((g) => g.points)).toEqual([-4]);
  });

  it("is audited with the item, before and after", async () => {
    const { evaluation, mcq } = await satNormal();
    await setCounting(evaluation.id, mcq, "neutralized");
    // The same counting again changes nothing and audits nothing.
    await setCounting(evaluation.id, mcq, "neutralized");
    const rows = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "evaluation.item_counting"), eq(auditLog.subjectId, evaluation.id)));
    expect(rows.map((r) => r.payload)).toEqual([
      { itemId: mcq, before: "normal", after: "neutralized", modifiedAfterRelease: false },
    ]);
  });

  it("after the release: the owner's alone, the snapshot stops, and only a changed grade is told", async () => {
    const { evaluation, courseId, mcq, guesser } = await satNormal();
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);

    const assistant = await server.signIn("teacher");
    await db().insert(courseStaff).values({ courseId, userId: assistant.id, role: "assistant" });
    const refused = await setCounting(evaluation.id, mcq, "bonus", assistant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "owner_required" });

    // guesser: 0 / 6 → 2 / 2, a 1.0 becomes a 6.0; the other: 6 / 6 → 6 / 2, a 6.0 still.
    const res = await setCounting(evaluation.id, mcq, "bonus");
    expect(res.json()).toEqual({ counting: "bonus", modifiedAfterRelease: true });
    const view = await results(evaluation.id);
    expect(view.modifiedAfterRelease).toBe(true);
    expect(pointsOf(view, guesser.id)).toEqual([2, 6]);

    const feedback = (await get(`/app/api/attempts/${guesser.id}/feedback`, students[0])).json() as StudentFeedback;
    if (!feedback.available) throw new Error("feedback expected");
    expect([feedback.points, feedback.totalPoints, feedback.grade]).toEqual([2, 2, 6]);

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

  it("is never copied: a duplicate or a template counts a neutralized item normally", async () => {
    const { evaluation, courseId, mcq } = await satNormal();
    expect((await setCounting(evaluation.id, mcq, "neutralized")).statusCode).toBe(200);
    const { template } = await templates.saveAsTemplate(db(), await reload(db(), evaluation.id), {
      courseId,
      title: "Modèle neutralisé",
      createdBy: teacher.id,
    });
    expect((await joinedItems(db(), template.id)).map((i) => i.item.counting)).toEqual(["normal", "normal"]);
    expect((await joinedItems(db(), evaluation.id)).map((i) => i.item.counting)).toEqual(["normal", "neutralized"]);
  });

  it("answers 404 to a teacher of another course and for another evaluation's item; a student is refused by role", async () => {
    const { evaluation, mcq } = await satNormal();
    const other = await satNormal();
    const stranger = await server.signIn("teacher");
    expect((await setCounting(evaluation.id, mcq, "bonus", stranger)).statusCode).toBe(404);
    // Every grading route is teacher-only before any load: a student session is a 403 `forbidden`.
    const asStudent = await setCounting(evaluation.id, mcq, "bonus", students[0]!);
    expect([asStudent.statusCode, asStudent.json().error]).toEqual([403, "forbidden"]);
    expect((await setCounting(evaluation.id, other.mcq, "bonus")).statusCode).toBe(404);
    expect((await joinedItems(db(), other.evaluation.id))[1]!.item.counting).toBe("normal");
  });

  it("awaits no grade of a neutralized item: the student's pending count and the grading progress", async () => {
    const { evaluation, mcq, guesser } = await satNormal();
    // The guesser's mcq answer back to "not graded yet".
    await db()
      .update(gradings)
      .set({ state: "superseded" })
      .where(and(eq(gradings.attemptId, guesser.id), eq(gradings.itemId, mcq)));
    const progress = async () =>
      (await get(`/app/api/evaluations/${evaluation.id}/grading/progress`)).json() as { done: number; total: number };
    expect(await progress()).toMatchObject({ done: 3, total: 4 });
    expect((await send("POST", `/app/api/evaluations/${evaluation.id}/release`, { confirm: true })).statusCode).toBe(200);
    const feedback = async () =>
      (await get(`/app/api/attempts/${guesser.id}/feedback`, students[0])).json() as StudentFeedback;
    let shown = await feedback();
    if (!shown.available) throw new Error("feedback expected");
    expect([shown.pendingCount, shown.grade]).toEqual([1, null]);

    expect((await setCounting(evaluation.id, mcq, "neutralized")).statusCode).toBe(200);
    expect(await progress()).toMatchObject({ done: 2, total: 2 });
    shown = await feedback();
    if (!shown.available) throw new Error("feedback expected");
    expect([shown.pendingCount, shown.points, shown.totalPoints, shown.grade]).toEqual([0, 2, 2, 6]);
  });
});
