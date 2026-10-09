/**
 * The LLM half of the grading pass (F-GRADE-02, ADR-045, ADR-063): a type's
 * `pending: llm` goes to the process's LLM service as the type built it, the
 * answer masked of the evaluation's names, and comes back as a batchable
 * proposal with the model's confidence, criteria and name — kept for the
 * teacher, out of every student payload (open question 27), never asked
 * while the evaluation runs (F-LLM-03), nor twice for the same answer.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { justificationOf } from "@quiz/contracts";
import { isBatchable } from "@quiz/domain";
import { aiOf } from "@quiz/contracts";
import type { GradeResult, LlmGradeRequest } from "@quiz/core/server";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { attempts, enrollments, evaluations, gradings, users } from "../../db/schema.js";
import { testApp, testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState, joinedItems } from "../evaluation/service.js";
import * as live from "../live/service.js";
import type { GradingLlm } from "../llm/service.js";
import { LlmError } from "../llm/provider.js";
import { STUB_MODEL, StubLlm } from "../llm/stub.js";
import * as results from "../results/service.js";
import { GRADING_LLM_QUEUE, type JobQueue } from "../../jobs.js";
import { registerGradingJobs, runEvaluationGrading } from "./jobs.js";
import * as service from "./service.js";

/** A term only the rubric holds: no answer, no statement, no key carries it. */
const RUBRIC_TERM = "zebracriterion";

/** A `short` that always asks the model, with a rubric of its own. */
const fakeEssay = {
  ...fakeShort,
  grade(
    config: { statement: string; answer: string },
    answer: string | null,
    ctx: { itemPoints: number },
  ): GradeResult<unknown> {
    return {
      kind: "pending",
      via: "llm",
      request: {
        statement: config.statement,
        form: "free text",
        rubric: `${RUBRIC_TERM}: ${config.answer} explained at length`,
        answer: answer ?? "",
        maxPoints: ctx.itemPoints,
      },
      details: { reason: "llm" },
    };
  },
} as unknown as typeof fakeShort;

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeEssay);
  db = await testDb();
});
afterAll(() => restore());

/** Two students answered the first question: one with the rubric's words, one without. */
async function answered(options: { close: boolean; texts?: (names: string[]) => string[] }) {
  const app = await testApp(db);
  app.clock.set("2026-09-20T09:00:00.000Z");
  const seed = await seedLive(db, { students: 2, questions: 1 });
  let evaluation = await applyState(db, await reload(db, seed.evaluationId), "running", app.clock.now());
  const [item] = await joinedItems(db, evaluation.id);
  const names = (await db.select().from(users).where(inArray(users.id, seed.studentIds))).map((u) => u.givenName);
  const texts = options.texts?.(names) ?? [
    "The answer-q0 is the right one, explained at length as the statement asked for it.",
    "No idea.",
  ];
  for (const [index, userId] of seed.studentIds.entries()) {
    app.clock.advance(1);
    const participant = (await live.participantOf(db, evaluation, userId))!;
    const created = await live.ensureAttempt(db, evaluation, participant, app.clock.now());
    const attempt = await live.beginAttempt(db, evaluation, created, participant, app.clock.now());
    await live.saveAnswer(db, {
      evaluation,
      attempt,
      itemId: item!.item.id,
      payload: texts[index],
      revision: 1,
      now: app.clock.now(),
    });
  }
  if (options.close) evaluation = await live.closeEvaluation(db, evaluation, app.clock.now());
  return { app, seed, evaluation, itemId: item!.item.id };
}

const gradingsOf = async (evaluationId: string) =>
  (
    await db
      .select({ grading: gradings })
      .from(gradings)
      .innerJoin(attempts, eq(gradings.attemptId, attempts.id))
      .where(eq(attempts.evaluationId, evaluationId))
  )
    .map((r) => r.grading)
    .filter((g) => g.state !== "superseded");

/** The stub, with every request it received, and whom it was billed to, kept for inspection. */
function recordingStub(
  options: { ready?: boolean; fail?: LlmError } = {},
): GradingLlm & { requests: LlmGradeRequest[]; billed: (string | null)[] } {
  const stub = new StubLlm();
  const requests: LlmGradeRequest[] = [];
  const billed: (string | null)[] = [];
  return {
    requests,
    billed,
    ready: () => Promise.resolve(options.ready ?? true),
    grade: (req, billedTo) => {
      requests.push(req);
      billed.push(billedTo);
      return options.fail ? Promise.reject(options.fail) : stub.grade(req);
    },
  };
}

describe("grading.evaluation with an LLM service (F-GRADE-02)", () => {
  it("writes a batchable proposal: confidence, and the justification in the details, not the comment", async () => {
    const { app, evaluation } = await answered({ close: true });
    app.llm = recordingStub();

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await gradingsOf(evaluation.id);

    expect(rows).toHaveLength(2);
    for (const grading of rows) {
      expect(grading).toMatchObject({ source: "llm", state: "proposed", details: { reason: "llm" } });
      expect(grading.comment).toBeNull();
      expect(grading.confidence).not.toBeNull();
      expect(justificationOf(grading.details)).toMatch(/^Development stub, not a model/);
      expect(aiOf(grading.details)).toMatchObject({ model: STUB_MODEL, criteria: [{ maxPoints: 1 }] });
      expect(isBatchable({ ...grading, points: Number(grading.points) })).toBe(true);
    }
    expect(rows.map((r) => Number(r.points)).sort()).toEqual([0, 1]);
  });

  it("bills the call to the evaluation's creator", async () => {
    const { app, evaluation } = await answered({ close: true });
    const llm = recordingStub();
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    expect(llm.billed).toEqual([evaluation.createdBy, evaluation.createdBy]);
  });

  it("masks the names of the class wherever a student typed them (N-DATA-05)", async () => {
    const { app, evaluation } = await answered({
      close: true,
      texts: ([mine, theirs]) => [`I am ${mine}, and ${theirs} helped me.`, "No idea."],
    });
    const llm = recordingStub();
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    expect(llm.requests.map((r) => r.answer)).toContain("I am [student], and [student] helped me.");
  });

  it("does not ask twice for the same answer, but asks again on a re-grade", async () => {
    const { app, evaluation } = await answered({ close: true });
    const llm = recordingStub();
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(llm.requests).toHaveLength(2);

    await runEvaluationGrading(app, { evaluationId: evaluation.id, regradeNote: "rubric fixed" });
    expect(llm.requests).toHaveLength(4);
  });

  it("leaves a cell the cap refused as `llm_budget`, which the next pass asks again", async () => {
    const { app, evaluation } = await answered({ close: true });
    app.llm = recordingStub({ fail: new LlmError("budget_exhausted") });

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const refused = await gradingsOf(evaluation.id);
    expect(refused.map((r) => r.details)).toEqual([{ reason: "llm_budget" }, { reason: "llm_budget" }]);
    expect(refused.every((r) => r.source === "llm" && Number(r.points) === 0)).toBe(true);

    const llm = recordingStub();
    app.llm = llm;
    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    expect(llm.requests).toHaveLength(2);
  });

  it("says `grader_error` for any other failure, and `llm_not_configured` for a key gone", async () => {
    const failed = await answered({ close: true });
    failed.app.llm = recordingStub({ fail: new LlmError("provider_error") });
    await runEvaluationGrading(failed.app, { evaluationId: failed.evaluation.id });
    expect((await gradingsOf(failed.evaluation.id)).map((r) => r.details)).toEqual([
      { reason: "grader_error" },
      { reason: "grader_error" },
    ]);

    const gone = await answered({ close: true });
    gone.app.llm = recordingStub({ fail: new LlmError("key_unreadable") });
    await runEvaluationGrading(gone.app, { evaluationId: gone.evaluation.id });
    expect((await gradingsOf(gone.evaluation.id)).map((r) => r.details)).toEqual([
      { reason: "llm_not_configured" },
      { reason: "llm_not_configured" },
    ]);
  });

  it("sends the request exactly as the type built it: nothing that names the student (F-LLM-04)", async () => {
    const { app, seed, evaluation } = await answered({ close: true });
    const llm = recordingStub();
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    expect(llm.requests).toHaveLength(2);
    for (const req of llm.requests) {
      expect(Object.keys(req).sort()).toEqual(["answer", "form", "maxPoints", "rubric", "statement"]);
    }
    const attemptRows = await db.select().from(attempts).where(eq(attempts.evaluationId, evaluation.id));
    const people = await db.select().from(users).where(inArray(users.id, seed.studentIds));
    const seats = await db.select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId));
    const identifying = [
      ...seed.studentIds,
      ...attemptRows.map((a) => a.id),
      evaluation.id,
      ...people.flatMap((u) => [u.email, u.oidcSub, `${u.givenName} ${u.familyName}`]),
      ...seats.flatMap((e) => [e.email, e.nom, e.prenom]),
    ];
    const sent = JSON.stringify(llm.requests);
    for (const value of identifying) expect(sent).not.toContain(value);
  });

  it("asks nothing without a provider: a proposal that says so", async () => {
    const { app, evaluation } = await answered({ close: true });

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const rows = await gradingsOf(evaluation.id);

    expect(rows.map((r) => r.details)).toEqual([
      { reason: "llm_not_configured" },
      { reason: "llm_not_configured" },
    ]);
    expect(rows.every((r) => r.confidence === null && Number(r.points) === 0)).toBe(true);
  });

  it("asks nothing when the service has no key behind it", async () => {
    const { app, evaluation } = await answered({ close: true });
    const llm = recordingStub({ ready: false });
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    expect(llm.requests).toHaveLength(0);
    expect((await gradingsOf(evaluation.id)).map((r) => r.details)).toEqual([
      { reason: "llm_not_configured" },
      { reason: "llm_not_configured" },
    ]);
  });

  it("asks nothing from a job whose evaluation runs again since the pass (F-LLM-03)", async () => {
    const { app, evaluation } = await answered({ close: true });
    const llm = recordingStub();
    app.llm = llm;
    // A queue that keeps what it is sent, and its handlers, for the test to run.
    const sent: { name: string; data: object }[] = [];
    const handlers = new Map<string, (data: object) => Promise<void>>();
    const queue: JobQueue = {
      createQueue: async () => {},
      send: async (name, data) => void sent.push({ name, data }),
      work: async (name, handler) => void handlers.set(name, handler as (data: object) => Promise<void>),
      stop: async () => {},
    };
    app.boss = queue;
    await registerGradingJobs(app, queue, { GRADING_RUNNER_CONCURRENCY: 1 });

    await runEvaluationGrading(app, { evaluationId: evaluation.id });
    const jobs = sent.filter((j) => j.name === GRADING_LLM_QUEUE);
    expect(jobs).toHaveLength(2);
    await db.update(evaluations).set({ state: "running" }).where(eq(evaluations.id, evaluation.id));
    for (const job of jobs) await handlers.get(GRADING_LLM_QUEUE)!(job.data);

    expect(llm.requests).toHaveLength(0);
    expect(await gradingsOf(evaluation.id)).toHaveLength(0);
  });

  it("asks nothing while the evaluation runs (F-LLM-03)", async () => {
    const { app, evaluation } = await answered({ close: false });
    const llm = recordingStub();
    app.llm = llm;

    await runEvaluationGrading(app, { evaluationId: evaluation.id });

    expect(llm.requests).toHaveLength(0);
    expect((await gradingsOf(evaluation.id)).every((r) => r.confidence === null)).toBe(true);
  });
});

describe("the justification never reaches a student (ADR-045, open question 27)", () => {
  for (const showKey of [false, true]) {
    it(`validated one by one or in a batch, it is out of the feedback (showKey ${showKey})`, async () => {
      const { app, evaluation, itemId } = await answered({ close: true });
      app.llm = recordingStub();
      await runEvaluationGrading(app, { evaluationId: evaluation.id });
      await db
        .update(evaluations)
        .set({
          feedbackPolicy: {
            when: "on_release",
            showAnswer: true,
            showKey,
            showExplanation: true,
            showHiddenCaseNames: true,
            showTeacherComment: true,
          },
        })
        .where(eq(evaluations.id, evaluation.id));

      // One proposal validated by a click, the other by the batch.
      const [first, second] = await gradingsOf(evaluation.id);
      const teacher = (await reload(db, evaluation.id)).createdBy!;
      await service.validateGrading(db, first!, {}, teacher, app.clock.now());
      expect(
        await service.batchValidate(db, evaluation.id, { itemId, source: "llm" }, teacher, app.clock.now()),
      ).toBe(1);
      expect(second).toBeDefined();

      await results.releaseResults(db, await reload(db, evaluation.id), app.clock.now());
      const released = await reload(db, evaluation.id);
      const attemptRows = await db.select().from(attempts).where(eq(attempts.evaluationId, evaluation.id));
      for (const attempt of attemptRows) {
        const feedback = await results.studentFeedback(db, released, attempt, app.clock.now());
        expect(feedback.available).toBe(true);
        const payload = JSON.stringify(feedback);
        expect(payload).not.toContain("Development stub");
        expect(payload).not.toContain(STUB_MODEL);
        expect(payload).not.toContain("justification");
        expect(payload).not.toContain(RUBRIC_TERM);
      }
    });
  }
});
