/**
 * The agreement figures (ADR-139 §15) against the real migrations: each
 * path the grading history can take, written by the very functions the
 * routes call, and how it is counted.
 *
 * The world: an exam of two questions worth 3 points — `q0` an essay graded
 * by two criteria, `q1` a free rubric — sat by eight students, a teacher's
 * test walk on a staff seat (ADR-018) and an attempt a paper copy replaced
 * (ADR-125 §12). Each cell of `q0` takes one path:
 *
 * | attempt | proposal        | then                                   | counted          |
 * |---------|-----------------|----------------------------------------|------------------|
 * | s0      | 2, high         | validated as is                        | unchanged        |
 * | s1      | 2, high         | validated adjusted to 2.5              | changed by 0.5   |
 * | s2      | 2, medium       | validated as is, overridden later to 1 | changed by 1     |
 * | s3      | 2, medium       | criteria re-split 1 + 1, same total    | unchanged        |
 * | s5      | 2, low          | still a proposal                       | not compared     |
 * | s6      | failed call     | overridden to 2                        | not compared     |
 * | staff   | 2, high         | validated adjusted                     | left out         |
 * | paper   | 2, high         | validated adjusted                     | left out         |
 *
 * and `s4` alone answers `q1`: a proposal of 1 (low) validated as is, then
 * a regrade, a new proposal of 2.5 (high), validated at 3 — compared with
 * the regrade's proposal, changed by 0.5 under `high`.
 */
import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ByQuestion, GradingQueue } from "@quiz/contracts";
import type { LlmRequestCriterion } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, attempts, contestations, enrollments } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { closedWithAnswers, reload } from "../../test/live.js";
import * as results from "../results/service.js";
import { aiAgreementByItem, gradingFigures } from "./agreement.js";
import * as service from "./service.js";

const CRITERIA: LlmRequestCriterion[] = [
  { id: "thesis", title: "Thesis", weight: 2, prompt: "" },
  { id: "sources", title: "Sources", weight: 1, prompt: "" },
];

/** `short` worth 3 points, with criteria on `q0` only. */
const fakeEssay = {
  ...fakeShort,
  defaultPoints: () => 3,
  gradingCriteria: (config: { statement: string }) => (config.statement.endsWith("q0") ? CRITERIA : []),
} as unknown as typeof fakeShort;

let db: Db;
let restore: () => void;
beforeAll(async () => {
  restore = registerForTests(fakeEssay);
  db = await testDb();
});
afterAll(() => restore());

/** A model's reply on `q0`: 1.5 + 0.5 by criterion. */
const ESSAY_REPLY = {
  reason: "llm",
  justification: "Why.",
  ai: {
    model: "m",
    criteria: [
      { id: "thesis", criterion: "Thesis", points: 1.5, maxPoints: 2, comment: "" },
      { id: "sources", criterion: "Sources", points: 0.5, maxPoints: 1, comment: "" },
    ],
  },
};

async function world() {
  const app = await testApp(db);
  app.clock.set("2026-11-20T09:00:00.000Z");
  const now = () => app.clock.now();
  const { seed, evaluation, items, attempts: rows } = await closedWithAnswers(
    db,
    app.clock,
    { students: 9, questions: 2 },
    (student, item) => (item === 0 && student !== 4) || (item === 1 && student === 4) ? "An answer." : null,
  );
  const teacher = (await reload(db, evaluation.id)).createdBy!;
  const [q0, q1] = items;
  const criteria = service.criteriaOf(q0!);
  const id = (n: number) => rows[n]!.id;
  // Attempt 7 is a staff seat's; attempt 8 was replaced by a paper copy (attempt 0 stands in).
  await db.update(enrollments).set({ staff: true }).where(eq(enrollments.userId, seed.studentIds[7]!));
  await db.update(attempts).set({ supersededBy: id(0) }).where(eq(attempts.id, id(8)));

  const answerRows = await db.select().from(answers).where(inArray(answers.attemptId, rows.map((r) => r.id)));
  const answerOf = (attemptId: string, itemId: string) =>
    answerRows.find((a) => a.attemptId === attemptId && a.itemId === itemId)?.id ?? null;
  const propose = (n: number, item: typeof q0, input: { points: number; confidence?: "high" | "medium" | "low"; details?: object; regradeNote?: string }) =>
    service.writeGrading(db, {
      attemptId: id(n),
      itemId: item!.item.id,
      answerId: answerOf(id(n), item!.item.id),
      maxPoints: 3,
      source: "llm",
      state: "proposed",
      details: input.details ?? ESSAY_REPLY,
      ...(input.confidence ? { confidence: input.confidence } : {}),
      ...(input.regradeNote ? { regradeNote: input.regradeNote } : {}),
      points: input.points,
      now: now(),
    });
  const validate = (proposal: Awaited<ReturnType<typeof propose>>, input: Parameters<typeof service.validateGrading>[3] = {}, declared = criteria) =>
    service.validateGrading(db, proposal, declared, input, teacher, now());
  const override = (n: number, item: typeof q0, input: { points?: number; criteria?: { id: string; points: number }[] }, declared = criteria) =>
    service.manualOverride(
      db,
      { attemptId: id(n), itemId: item!.item.id, answerId: answerOf(id(n), item!.item.id), maxPoints: 3, criteria: declared },
      { ...input, comment: "Seen." },
      teacher,
      now(),
    );

  const s0 = await validate(await propose(0, q0, { points: 2, confidence: "high" }));
  const s1 = await validate(await propose(1, q0, { points: 2, confidence: "high" }), {
    criteria: [{ id: "thesis", points: 2 }, { id: "sources", points: 0.5 }],
  });
  app.clock.advance(1000);
  const s2First = await validate(await propose(2, q0, { points: 2, confidence: "medium" }));
  app.clock.advance(1000);
  await override(2, q0, { criteria: [{ id: "thesis", points: 1 }, { id: "sources", points: 0 }] });
  const s3 = await validate(await propose(3, q0, { points: 2, confidence: "medium" }), {
    criteria: [{ id: "thesis", points: 1 }, { id: "sources", points: 1 }],
  });
  await propose(5, q0, { points: 2, confidence: "low" });
  await propose(6, q0, { points: 0, details: { reason: "grader_error" } });
  app.clock.advance(1000);
  await override(6, q0, { criteria: [{ id: "thesis", points: 2 }, { id: "sources", points: 0 }] });
  const staff = await validate(await propose(7, q0, { points: 2, confidence: "high" }), {
    criteria: [{ id: "thesis", points: 0 }, { id: "sources", points: 0 }],
  });
  await validate(await propose(8, q0, { points: 2, confidence: "high" }), {
    criteria: [{ id: "thesis", points: 0 }, { id: "sources", points: 0 }],
  });

  // q1: a free rubric, validated, regraded, proposed again and adjusted.
  await validate(await propose(4, q1, { points: 1, confidence: "low", details: { reason: "llm", justification: "Why." } }), {}, []);
  app.clock.advance(1000);
  const note = await service.regradeItem(
    db,
    { evaluationId: evaluation.id, itemId: q1!.item.id, questionId: q1!.question.id, variables: null },
    { note: "Rubric fixed." },
  );
  expect(note).toBe("Rubric fixed.");
  app.clock.advance(1000);
  await validate(
    await propose(4, q1, { points: 2.5, confidence: "high", details: { reason: "llm", justification: "Why." }, regradeNote: note! }),
    { points: 3 },
    [],
  );

  // Contestations: s0 on the AI's grading (open), s1 on the teacher's
  // (accepted), s2 on the AI's validated grading before the override
  // (refused), the staff seat's (left out).
  const contest = (n: number, grading: { id: string }, state: "open" | "accepted" | "refused") =>
    db.insert(contestations).values({
      id: randomUUID(),
      attemptId: id(n),
      itemId: q0!.item.id,
      reason: "Please.",
      filedAt: now(),
      gradingAtFilingId: grading.id,
      state,
    });
  await contest(0, s0, "open");
  await contest(1, s1, "accepted");
  await contest(2, s2First, "refused");
  await contest(7, staff, "refused");

  return { app, evaluation, q0: q0!, q1: q1!, history: { s0, s1, s3 } };
}

describe("the agreement figures (ADR-139 §15)", () => {
  it("count each history path as the record says, the staff seat and a replaced attempt left out", async () => {
    const { evaluation, q0, q1, history } = await world();
    // The paths left the history the writer promises.
    expect(history.s0).toMatchObject({ source: "llm", points: 2 });
    expect(history.s1).toMatchObject({ source: "manual", points: 2.5 });
    expect(history.s3).toMatchObject({ source: "manual", points: 2 });

    const { byItem, total } = await gradingFigures(db, evaluation.id, [q0.item.id, q1.item.id]);

    expect(byItem.get(q0.item.id)!.agreement).toEqual({
      compared: 4,
      unchanged: 2,
      changed: 2,
      meanAbsDelta: 0.75,
      byConfidence: {
        high: { compared: 2, unchanged: 1, changed: 1, meanAbsDelta: 0.5 },
        medium: { compared: 2, unchanged: 1, changed: 1, meanAbsDelta: 1 },
        low: null,
      },
    });
    // The regrade's proposal, not the first one.
    expect(byItem.get(q1.item.id)!.agreement).toEqual({
      compared: 1,
      unchanged: 0,
      changed: 1,
      meanAbsDelta: 0.5,
      byConfidence: { high: { compared: 1, unchanged: 0, changed: 1, meanAbsDelta: 0.5 }, medium: null, low: null },
    });
    expect(total.agreement).toMatchObject({ compared: 5, unchanged: 2, changed: 3, meanAbsDelta: 0.67 });

    // Over the graded cells of the class: q0's s0, s1, s2, s3, s6 (s5 waits).
    expect(byItem.get(q0.item.id)!.contestations).toEqual({
      filed: 3,
      accepted: 1,
      graded: 5,
      open: 1,
      refused: 1,
      bySource: { auto: { filed: 0, accepted: 0 }, llm: { filed: 2, accepted: 0 }, manual: { filed: 1, accepted: 1 } },
    });
    expect(byItem.get(q1.item.id)!.contestations).toBeNull();
    expect(total.contestations).toMatchObject({ filed: 3, graded: 6 });
  });

  it("travel on the per-question results and the grading queue, in their contracts", async () => {
    const { evaluation, q0, q1 } = await world();
    const loaded = await reload(db, evaluation.id);

    const questions = (await results.byQuestion(db, loaded)).map((q) => ByQuestion.parse(q));
    const first = questions.find((q) => q.item.id === q0.item.id)!;
    expect(first.figures.agreement).toMatchObject({ compared: 4, unchanged: 2 });
    expect(first.figures.contestations).toMatchObject({ filed: 3, graded: 5 });
    for (const q of questions) expect(q.totalFigures.agreement).toMatchObject({ compared: 5 });

    const queue = GradingQueue.parse(await service.gradingQueue(db, loaded, { itemId: q1.item.id, anonymous: true }, null));
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.agreement).toMatchObject({ compared: 1, changed: 1 });
  });

  it("are null with nothing to compare nor contested", async () => {
    const app = await testApp(db);
    app.clock.set("2026-11-20T09:00:00.000Z");
    const { evaluation, items } = await closedWithAnswers(db, app.clock, { students: 1, questions: 1 }, () => "x");
    const { byItem, total } = await gradingFigures(db, evaluation.id, [items[0]!.item.id]);
    expect(byItem.get(items[0]!.item.id)).toEqual({ agreement: null, contestations: null });
    expect(total).toEqual({ agreement: null, contestations: null });
    const queue = await service.gradingQueue(db, evaluation, { itemId: items[0]!.item.id, anonymous: true }, null);
    expect(queue.items[0]!.agreement).toBeNull();
    // A selection of no item reads nothing.
    expect(await aiAgreementByItem(db, evaluation.id, [])).toEqual(new Map());
  });
});
