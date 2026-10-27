/**
 * The per-criterion grading of an essay (ADR-118 §6, amendment of
 * 2026-10-27) against the real migrations: every validation path — one
 * click, the batch, an adjustment, an override — writes the validated
 * breakdown when the proposal names every criterion of the item, derives
 * the total from the teacher's points per criterion, and keeps the model's
 * reply out of the breakdown and out of every student payload.
 *
 * The type is the fake `short` with criteria on its first question only: the
 * second one stands for a free rubric (or a diagram), which a proposal
 * breaks down without ids and which never gets a breakdown.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { breakdownOf, type FeedbackPolicy } from "@quiz/contracts";
import type { LlmRequestCriterion } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, attempts, evaluations, gradings } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import { typeOf } from "../pool/config.js";
import * as results from "../results/service.js";
import * as service from "./service.js";

const TITLE = "BREAKDOWN-TITLE Thesis";
const SENTENCE = "MODEL-SENTENCE";
const COMMENT = "MODEL-COMMENT";
const MODEL = "claude-sonnet-5-5";
const PROMPT = "PROMPT-SECRET";

const CRITERIA: LlmRequestCriterion[] = [
  { id: "thesis", title: TITLE, weight: 2, prompt: PROMPT },
  { id: "sources", title: "Sources", weight: 1, prompt: "" },
];

/** `short`, worth 3 points, with criteria on `q0` and the essay's student view of its details. */
const fakeEssay = {
  ...fakeShort,
  defaultPoints: () => 3,
  gradingCriteria: (config: { statement: string }) => (config.statement.endsWith("q0") ? CRITERIA : []),
  studentDetails: typeOf("rich").studentDetails,
} as unknown as typeof fakeShort;

let db: Db;
let restore: () => void;
beforeAll(async () => {
  restore = registerForTests(fakeEssay);
  db = await testDb();
});
afterAll(() => restore());

/** What `askGrader` writes for the criteria item (ids) and the free one (none). */
const proposalOf = (criteria: boolean) =>
  criteria
    ? {
        points: 2,
        details: {
          reason: "llm",
          chars: 30,
          justification: SENTENCE,
          ai: {
            model: MODEL,
            criteria: [
              { id: "thesis", criterion: TITLE, points: 1.5, maxPoints: 2, comment: COMMENT },
              { id: "sources", criterion: "Sources", points: 0.5, maxPoints: 1, comment: COMMENT },
            ],
          },
        },
      }
    : {
        points: 1,
        details: {
          reason: "llm",
          chars: 30,
          justification: SENTENCE,
          ai: { model: MODEL, criteria: [{ criterion: "Coverage", points: 1, maxPoints: 3, comment: COMMENT }] },
        },
      };

/** Two students answered both questions; the model proposed for every cell, unless `proposals` is false. */
async function proposed(options: { proposals?: boolean } = {}) {
  const app = await testApp(db);
  app.clock.set("2026-10-27T09:00:00.000Z");
  const seed = await seedLive(db, { students: 2, questions: 2 });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const items = await joinedItems(db, evaluation.id);
  for (const userId of seed.studentIds) {
    app.clock.advance(1);
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const item of items) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        payload: "An essay of some length.",
        revision: 1,
        now: app.clock.now(),
      });
    }
  }
  evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
  const attemptRows = await db.select().from(attempts).where(eq(attempts.evaluationId, evaluation.id));
  const cells = [];
  for (const attempt of attemptRows) {
    for (const [index, item] of items.entries()) {
      const [answer] = await db
        .select()
        .from(answers)
        .where(eq(answers.attemptId, attempt.id))
        .then((rows) => rows.filter((a) => a.itemId === item.item.id));
      cells.push({
        attemptId: attempt.id,
        itemId: item.item.id,
        answerId: answer!.id,
        maxPoints: item.item.points,
        criteria: index === 0,
      });
    }
  }
  if (options.proposals !== false) {
    await service.writeGradings(
      db,
      cells.map((c) => ({
        attemptId: c.attemptId,
        itemId: c.itemId,
        answerId: c.answerId,
        maxPoints: c.maxPoints,
        source: "llm" as const,
        state: "proposed" as const,
        confidence: "high" as const,
        now: app.clock.now(),
        ...proposalOf(c.criteria),
      })),
    );
  }
  const teacher = (await reload(db, evaluation.id)).createdBy!;
  return { app, evaluation, items, cells, teacher };
}

const standing = async (cell: { attemptId: string; itemId: string }) => {
  const rows = await db.select().from(gradings).where(eq(gradings.attemptId, cell.attemptId));
  return rows.find((g) => g.itemId === cell.itemId && g.state !== "superseded")!;
};

const BREAKDOWN = [
  { id: "thesis", title: TITLE, points: 1.5, maxPoints: 2 },
  { id: "sources", title: "Sources", points: 0.5, maxPoints: 1 },
];

describe("a validation writes the breakdown (ADR-118 §6)", () => {
  it("as-is: the proposal's points per criterion, its total, its reply kept beside", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.criteria)!;

    const row = await service.validateGrading(db, await standing(cell), {}, teacher, app.clock.now());

    expect(row).toMatchObject({ points: 2, source: "llm", state: "validated" });
    expect(breakdownOf(row.details)).toEqual(BREAKDOWN);
    expect(row.details).toMatchObject({ justification: SENTENCE, ai: { model: MODEL } });
    // Titles and points only: never the model's sentence, its name, a prompt or a weight.
    const breakdown = JSON.stringify(breakdownOf(row.details));
    for (const secret of [SENTENCE, COMMENT, MODEL, PROMPT, "weight"]) expect(breakdown).not.toContain(secret);
  });

  it("in a batch, for the criteria item only: a free rubric gets none", async () => {
    const { app, evaluation, cells, teacher } = await proposed();

    expect(await service.batchValidate(db, evaluation.id, {}, teacher, app.clock.now())).toBe(4);

    for (const cell of cells) {
      const row = await standing(cell);
      expect(row.state).toBe("validated");
      expect(breakdownOf(row.details)).toEqual(cell.criteria ? BREAKDOWN : null);
    }
  });

  it("adjusted per criterion: the total is derived, and the grading becomes the teacher's", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.criteria)!;

    const row = await service.validateGrading(
      db,
      await standing(cell),
      { criteria: [{ id: "sources", points: 0.25 }, { id: "thesis", points: 2 }] },
      teacher,
      app.clock.now(),
    );

    expect(row).toMatchObject({ points: 2.25, source: "manual", state: "validated" });
    expect(breakdownOf(row.details)).toEqual([
      { id: "thesis", title: TITLE, points: 2, maxPoints: 2 },
      { id: "sources", title: "Sources", points: 0.25, maxPoints: 1 },
    ]);
  });

  it("refuses points per criterion that are not the item's, and a bare total for a criteria essay", async () => {
    const { app, cells, teacher } = await proposed();
    const withCriteria = await standing(cells.find((c) => c.criteria)!);
    const free = await standing(cells.find((c) => !c.criteria)!);
    const refused = (grading: typeof withCriteria, input: Parameters<typeof service.validateGrading>[2]) =>
      service.validateGrading(db, grading, input, teacher, app.clock.now()).then(
        () => null,
        (err: { code?: string }) => err.code,
      );

    const thesis = { id: "thesis", points: 1 };
    expect(await refused(withCriteria, { criteria: [thesis] })).toBe("criteria_invalid");
    expect(await refused(withCriteria, { criteria: [thesis, { id: "style", points: 1 }] })).toBe("criteria_invalid");
    expect(await refused(withCriteria, { criteria: [thesis, thesis] })).toBe("criteria_invalid");
    expect(await refused(withCriteria, { criteria: [thesis, { id: "sources", points: 1.5 }] })).toBe(
      "criteria_invalid",
    );
    expect(await refused(withCriteria, { points: 1 })).toBe("criteria_invalid");
    expect(await refused(free, { criteria: [thesis] })).toBe("criteria_invalid");
    // Nothing was written.
    expect((await standing(cells.find((c) => c.criteria)!)).state).toBe("proposed");
  });
});

describe("an override of an essay with criteria (F-GRADE-05)", () => {
  it("keeps the model's reply, writes the new breakdown and derives the total", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.criteria)!;
    await service.validateGrading(db, await standing(cell), {}, teacher, app.clock.now());
    app.clock.advance(1000);

    const row = await service.manualOverride(
      db,
      cell,
      { criteria: [{ id: "thesis", points: 1 }, { id: "sources", points: 1 }], comment: "Read again." },
      teacher,
      app.clock.now(),
    );

    expect(row).toMatchObject({ points: 2, source: "manual", state: "validated", comment: "Read again." });
    expect(row.details).toMatchObject({ manual: true, justification: SENTENCE, ai: { model: MODEL } });
    expect(breakdownOf(row.details)).toEqual([
      { id: "thesis", title: TITLE, points: 1, maxPoints: 2 },
      { id: "sources", title: "Sources", points: 1, maxPoints: 1 },
    ]);
  });

  it("grades by criteria a cell no model proposed for", async () => {
    const { app, cells, teacher } = await proposed({ proposals: false });
    const cell = cells.find((c) => c.criteria)!;

    const row = await service.manualOverride(
      db,
      cell,
      { criteria: [{ id: "thesis", points: 0.5 }, { id: "sources", points: 0 }], comment: "By hand." },
      teacher,
      app.clock.now(),
    );

    expect(row.points).toBe(0.5);
    expect(row.details).toEqual({
      manual: true,
      breakdown: [
        { id: "thesis", title: TITLE, points: 0.5, maxPoints: 2 },
        { id: "sources", title: "Sources", points: 0, maxPoints: 1 },
      ],
    });
  });

  it("writes `{ manual: true }` for an item without criteria, as before", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => !c.criteria)!;

    const row = await service.manualOverride(db, cell, { points: 2, comment: "Fine." }, teacher, app.clock.now());

    expect(row.details).toEqual({ manual: true });
    expect(row.points).toBe(2);
  });
});

describe("the breakdown reaches a student under a shown key only (ADR-118 §5)", () => {
  const policy = (showKey: boolean): FeedbackPolicy => ({
    when: "on_release",
    showAnswer: true,
    showKey,
    showExplanation: true,
    showHiddenCaseNames: true,
    showTeacherComment: true,
  });

  for (const showKey of [false, true]) {
    it(`never the model's reply; the criteria's titles with the key (showKey ${showKey})`, async () => {
      const { app, evaluation, teacher } = await proposed();
      await service.batchValidate(db, evaluation.id, {}, teacher, app.clock.now());
      await db.update(evaluations).set({ feedbackPolicy: policy(showKey) }).where(eq(evaluations.id, evaluation.id));
      await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
      const released = await reload(db, evaluation.id);

      for (const attempt of await db.select().from(attempts).where(eq(attempts.evaluationId, evaluation.id))) {
        const payload = JSON.stringify(await results.studentFeedback(db, released, attempt, app.clock.now()));
        for (const secret of [SENTENCE, COMMENT, MODEL, PROMPT]) expect(payload).not.toContain(secret);
        if (showKey) expect(payload).toContain(TITLE);
        else expect(payload).not.toContain(TITLE);
      }
    });
  }
});
