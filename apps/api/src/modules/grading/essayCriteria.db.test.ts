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
import { closedWithAnswers, reload } from "../../test/live.js";
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
const PROPOSED = [
  { id: "thesis", criterion: TITLE, points: 1.5, maxPoints: 2, comment: COMMENT },
  { id: "sources", criterion: "Sources", points: 0.5, maxPoints: 1, comment: COMMENT },
];

const proposalOf = (essay: boolean, replied: object[] = PROPOSED) =>
  essay
    ? {
        points: 2,
        details: { reason: "llm", chars: 30, justification: SENTENCE, ai: { model: MODEL, criteria: replied } },
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

/**
 * Two students answered both questions; the model proposed for every cell
 * (its criteria `replied` on the essay), unless `proposals` is false.
 */
async function proposed(options: { proposals?: boolean; replied?: object[] } = {}) {
  const app = await testApp(db);
  app.clock.set("2026-10-27T09:00:00.000Z");
  const { evaluation, items, attempts: attemptRows } = await closedWithAnswers(
    db,
    app.clock,
    { students: 2, questions: 2 },
    () => "An essay of some length.",
  );
  const answerRows = await db.select().from(answers);
  const cells = attemptRows.flatMap((attempt) =>
    items.map((item, index) => ({
      attemptId: attempt.id,
      itemId: item.item.id,
      answerId: answerRows.find((a) => a.attemptId === attempt.id && a.itemId === item.item.id)!.id,
      maxPoints: item.item.points,
      criteria: service.criteriaOf(item),
      essay: index === 0,
    })),
  );
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
        ...proposalOf(c.essay, options.replied),
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
    const cell = cells.find((c) => c.essay)!;

    const row = await service.validateGrading(db, await standing(cell), cell.criteria, {}, teacher, app.clock.now());

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
      expect(breakdownOf(row.details)).toEqual(cell.essay ? BREAKDOWN : null);
    }
  });

  it("adjusted per criterion: the total is derived, and the grading becomes the teacher's", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.essay)!;

    const row = await service.validateGrading(
      db,
      await standing(cell),
      cell.criteria,
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
    const essay = cells.find((c) => c.essay)!;
    const withCriteria = await standing(essay);
    const free = await standing(cells.find((c) => !c.essay)!);
    const refused = (grading: typeof withCriteria, input: Parameters<typeof service.validateGrading>[3]) =>
      service.validateGrading(db, grading, grading === free ? [] : essay.criteria, input, teacher, app.clock.now()).then(
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
    expect((await standing(cells.find((c) => c.essay)!)).state).toBe("proposed");
  });

  it("makes the grading the teacher's when points only move between criteria", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.essay)!;

    // The proposal's 1.5 + 0.5, split 1 + 1: the same total.
    const row = await service.validateGrading(
      db,
      await standing(cell),
      cell.criteria,
      { criteria: [{ id: "thesis", points: 1 }, { id: "sources", points: 1 }] },
      teacher,
      app.clock.now(),
    );

    expect(row).toMatchObject({ points: 2, source: "manual" });
  });

  it("keeps the proposal's split as the model's when the teacher sends it unchanged", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.essay)!;

    const row = await service.validateGrading(
      db,
      await standing(cell),
      cell.criteria,
      { criteria: [{ id: "thesis", points: 1.5 }, { id: "sources", points: 0.5 }] },
      teacher,
      app.clock.now(),
    );

    expect(row).toMatchObject({ points: 2, source: "llm" });

    // Three criteria of weight 1 on a 1-point item, two earned: the parts are
    // 0.33 + 0.33 + 0 = 0.66, the proposal's total 0.67 (from the raw sum).
    // Sent back unchanged, the total stays the proposal's.
    const thirds = ["a", "b", "c"].map((id) => ({ id, title: id.toUpperCase(), weight: 1 }));
    const other = cells.find((c) => c.essay && c.attemptId !== cell.attemptId)!;
    const [proposal] = await service.writeGradings(db, [
      {
        attemptId: other.attemptId,
        itemId: other.itemId,
        answerId: other.answerId,
        points: 0.67,
        maxPoints: 1,
        source: "llm",
        state: "proposed",
        confidence: "high",
        now: app.clock.now(),
        details: {
          reason: "llm",
          chars: 30,
          ai: {
            model: MODEL,
            criteria: [
              { id: "a", criterion: "A", points: 0.33, maxPoints: 0.33, comment: COMMENT },
              { id: "b", criterion: "B", points: 0.33, maxPoints: 0.33, comment: COMMENT },
              { id: "c", criterion: "C", points: 0, maxPoints: 0.33, comment: COMMENT },
            ],
          },
        },
      },
    ]);
    const kept = await service.validateGrading(
      db,
      proposal!,
      thirds,
      { criteria: [{ id: "a", points: 0.33 }, { id: "b", points: 0.33 }, { id: "c", points: 0 }] },
      teacher,
      app.clock.now(),
    );
    expect(kept).toMatchObject({ points: 0.67, source: "llm" });
  });

  for (const [what, replied] of [
    ["a criterion without an id", [{ ...PROPOSED[0]!, id: undefined }, PROPOSED[1]!]],
    ["ids that are not the item's", [PROPOSED[0]!, { ...PROPOSED[1]!, id: "style" }]],
    ["one criterion missing", [PROPOSED[0]!]],
  ] as const) {
    it(`writes no breakdown for a proposal with ${what}, and keeps its total`, async () => {
      const { app, cells, teacher } = await proposed({ replied: [...replied] });
      const cell = cells.find((c) => c.essay)!;

      const row = await service.validateGrading(db, await standing(cell), cell.criteria, {}, teacher, app.clock.now());

      expect(row).toMatchObject({ points: 2, source: "llm", state: "validated" });
      expect(breakdownOf(row.details)).toBeNull();
    });
  }
});

describe("an override of an essay with criteria (F-GRADE-05)", () => {
  it("keeps the model's reply, writes the new breakdown and derives the total", async () => {
    const { app, cells, teacher } = await proposed();
    const cell = cells.find((c) => c.essay)!;
    await service.validateGrading(db, await standing(cell), cell.criteria, {}, teacher, app.clock.now());
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
    const cell = cells.find((c) => c.essay)!;

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
    const cell = cells.find((c) => !c.essay)!;

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
        const feedback = await results.studentFeedback(db, released, attempt, app.clock.now());
        const payload = JSON.stringify(feedback);
        for (const secret of [SENTENCE, COMMENT, MODEL, PROMPT]) expect(payload).not.toContain(secret);
        // A weight is the config's, never the breakdown's: no key names one.
        expect(payload).not.toContain('"weight"');
        if (showKey) expect(payload).toContain(TITLE);
        else expect(payload).not.toContain(TITLE);
        // The essay's details: the breakdown's own fields, the model's reply gone.
        const essay = feedback.available ? feedback.items.find((i) => breakdownOf(i.details) !== null) : undefined;
        if (showKey) {
          expect(essay?.details).toEqual({ reason: "llm", chars: 30, breakdown: BREAKDOWN });
        } else {
          expect(essay).toBeUndefined();
        }
      }
    });
  }
});
