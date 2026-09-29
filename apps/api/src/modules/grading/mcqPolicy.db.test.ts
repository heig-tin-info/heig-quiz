/**
 * The MCQ scoring hierarchy, end to end against the real migrations
 * (docs/04 §4.4).
 *
 * Three levels: the teacher's preference seeds the evaluation, the evaluation
 * is what an `inherit` question defers to, and a question that names a policy
 * overrides both. The two halves a unit test cannot prove are here — that the
 * column exists and carries the preference at creation, and that the grading
 * pass actually hands the evaluation's policy to `mcqServer.grade`.
 *
 * The same hierarchy, minus the teacher's preference, holds for `categorize`
 * (ADR-036): its evaluation-level policy lives in `settings.categorizePolicy`.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { McqPolicy } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, evaluations, gradings, questions, users } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, byId, createEvaluation, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import * as poolService from "../pool/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as evaluationService from "../evaluation/service.js";
import { runEvaluationGrading } from "./jobs.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});
afterAll(() => restore());

/** Two keys, two distractors: C = 2, W = 2, so every policy gives its own mark. */
const mcqConfig = (policy: "inherit" | McqPolicy) => ({
  configVersion: 2,
  prompt: "Which declarations are valid in C17?",
  choices: [
    { text: "`int a[] = {1,2,3};`", correct: true },
    { text: "`int a[3] = {0};`", correct: true },
    { text: "`int a[];`", correct: false },
    { text: "`int a[-1];`", correct: false },
  ],
  mode: "multiple",
  policy,
  shuffleChoices: false,
});

async function publishMcq(
  poolId: string,
  ownerId: string,
  name: string,
  policy: "inherit" | McqPolicy,
): Promise<string> {
  const { id } = await poolService.createQuestion(db, {
    poolId,
    type: "mcq",
    internalName: name,
    createdBy: ownerId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config: mcqConfig(policy) });
  await poolService.publishQuestion(db, question!, { userId: ownerId });
  return id;
}

describe("the evaluation is seeded from its creator's preference", () => {
  it("copies the preference at creation, and falls back to all or nothing", async () => {
    const seed = await seedLive(db, { questions: 0 });

    const plain = await createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "No preference",
      mode: "exam",
      createdBy: seed.teacherId,
    });
    expect(plain.mcqPolicy).toBe("all_or_nothing");

    await db
      .update(users)
      .set({ mcqPolicy: "discordance" })
      .where(eq(users.id, seed.teacherId));
    const seeded = await createEvaluation(db, {
      classroomId: seed.classroomId,
      title: "With a preference",
      mode: "exam",
      createdBy: seed.teacherId,
    });
    expect(seeded.mcqPolicy).toBe("discordance");

    // The preference is a SEED: moving it never moves an evaluation that
    // already exists.
    await db.update(users).set({ mcqPolicy: "ripkey" }).where(eq(users.id, seed.teacherId));
    expect((await byId(db, seeded.id))!.mcqPolicy).toBe("discordance");
  });
});

describe("the grading pass applies the hierarchy", () => {
  /**
   * One evaluation scored `true_false`, two mcq items — one inheriting, one
   * overriding with `ripkey` — and a student who ticks exactly one of the two
   * correct choices. The marks then differ by policy and by nothing else:
   * `true_false` gives (1 + 2) / 4 = 0.75, `ripkey` gives 1/2 = 0.5.
   */
  it("uses the evaluation's policy for inherit and the question's otherwise", async () => {
    const app = await testApp(db);
    app.clock.set("2026-09-20T09:00:00.000Z");
    const seed = await seedLive(db, { students: 1, questions: 0 });

    const inheriting = await publishMcq(seed.poolId, seed.teacherId, "mcq-inherit", "inherit");
    const overriding = await publishMcq(seed.poolId, seed.teacherId, "mcq-ripkey", "ripkey");

    await db
      .update(evaluations)
      .set({ mcqPolicy: "true_false" })
      .where(eq(evaluations.id, seed.evaluationId));
    let evaluation = (await byId(db, seed.evaluationId))!;
    await evaluationService.addItems(
      db,
      evaluation,
      [inheriting, overriding],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, { config: version.config, configVersion: version.configVersion }),
        ),
      { attemptCount: 0 },
    );

    evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const items = await joinedItems(db, evaluation.id);
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, item] of items.entries()) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        // One of the two keys, and no distractor.
        payload: { selected: [0] },
        revision: index + 1,
        now: app.clock.now(),
      });
    }
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(2);

    const detailsOf = (itemId: string) =>
      rows.find((r) => r.grading.itemId === itemId)!.grading.details as {
        policy: string;
        fraction: number;
      };
    const byQuestion = new Map(items.map((i) => [i.question.id, i.item.id]));

    const inherited = detailsOf(byQuestion.get(inheriting)!);
    expect(inherited.policy).toBe("true_false");
    expect(inherited.fraction).toBeCloseTo(0.75, 10);

    const overridden = detailsOf(byQuestion.get(overriding)!);
    expect(overridden.policy).toBe("ripkey");
    expect(overridden.fraction).toBeCloseTo(0.5, 10);
  });
});

/** Columns A and B, one target each, and a distractor: T = 2, D = 1. */
const categorizeConfig = (policy: "inherit" | "per_item" | "all_or_nothing") => ({
  configVersion: 1,
  prompt: "Sort the cards.",
  columns: [
    { id: "col4a9xq", label: "A", cards: ["crd7k2ma"] },
    { id: "col8m3wz", label: "B", cards: ["crd1p6vb"] },
  ],
  cards: [
    { id: "crd7k2ma", text: "a" },
    { id: "crd1p6vb", text: "b" },
    { id: "crd5d0zt", text: "distractor" },
  ],
  shuffleCards: false,
  policy,
});

describe("the grading pass hands categorize the evaluation's policy (ADR-036)", () => {
  /**
   * The evaluation says `all_or_nothing`; one item inherits it, one names
   * `per_item`. The student places one target right, leaves the other and the
   * distractor in the tray: all or nothing gives 0, per card (1 + 1) / 3.
   */
  it("uses settings.categorizePolicy for inherit and the question's otherwise", async () => {
    const app = await testApp(db);
    app.clock.set("2026-09-20T09:00:00.000Z");
    const seed = await seedLive(db, { students: 1, questions: 0 });

    const publish = async (name: string, policy: "inherit" | "per_item") => {
      const { id } = await poolService.createQuestion(db, {
        poolId: seed.poolId,
        type: "categorize",
        internalName: name,
        createdBy: seed.teacherId,
      });
      const [question] = await db.select().from(questions).where(eq(questions.id, id));
      await poolService.putDraft(db, question!, { config: categorizeConfig(policy) });
      await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
      return id;
    };
    const inheriting = await publish("categorize-inherit", "inherit");
    const overriding = await publish("categorize-per-item", "per_item");

    let evaluation = (await byId(db, seed.evaluationId))!;
    await db
      .update(evaluations)
      .set({ settings: { ...evaluationService.settingsOf(evaluation), categorizePolicy: "all_or_nothing" } })
      .where(eq(evaluations.id, seed.evaluationId));
    evaluation = (await byId(db, seed.evaluationId))!;
    await evaluationService.addItems(
      db,
      evaluation,
      [inheriting, overriding],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, { config: version.config, configVersion: version.configVersion }),
        ),
      { attemptCount: 0 },
    );

    evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
    const items = await joinedItems(db, evaluation.id);
    const participant = (await live.participantOf(db, evaluation, seed.studentIds[0]!))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    for (const [index, item] of items.entries()) {
      await live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item.item.id,
        payload: { columns: { col4a9xq: ["crd7k2ma"] } },
        revision: index + 1,
        now: app.clock.now(),
      });
    }
    evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluation.id));
    expect(rows).toHaveLength(2);

    const detailsOf = (itemId: string) =>
      rows.find((r) => r.grading.itemId === itemId)!.grading.details as { policy: string; fraction: number };
    const byQuestion = new Map(items.map((i) => [i.question.id, i.item.id]));

    const inherited = detailsOf(byQuestion.get(inheriting)!);
    expect(inherited.policy).toBe("all_or_nothing");
    expect(inherited.fraction).toBe(0);

    const overridden = detailsOf(byQuestion.get(overriding)!);
    expect(overridden.policy).toBe("per_item");
    expect(overridden.fraction).toBeCloseTo(2 / 3, 10);
  });
});
