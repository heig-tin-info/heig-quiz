/**
 * The feedback policy over the REAL question types (finding H1 of the
 * security review, docs/05 §5.7).
 *
 * `gradings.details` is the one payload that does not travel through
 * `toStudent`: it is written by the grader FOR THE TEACHER and holds the
 * correct choices, the expected blanks, the matcher that fired and the hidden
 * cases' output. This file walks one evaluation with one question of each of
 * the four types through `GET /attempts/:id/feedback`, once with
 * `showKey: false` and once with `showKey: true`, and asserts the key is
 * absent in the first and present in the second.
 *
 * Nothing is faked here: the configs are real, the answers go through the
 * autosave route, and the grading is the automatic pass the close enqueues.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy } from "@quiz/contracts";
import { finalizeRunnerCode, type CodeConfig, type CodeDetails } from "@quiz/qt-code/server";

import { evaluations, questions } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { addItems, byId } from "../evaluation/service.js";
import { writeGrading } from "../grading/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let built: Awaited<ReturnType<typeof gradedEvaluation>>;

/** The key values the student must never read while `showKey` is false. */
const MCQ_CORRECT = 0;
const CLOZE_EXPECTED = "Lutece";
const HIDDEN_CASE_NAME = "hidden-limit";
const HIDDEN_EXPECTED = "42";

const CONFIGS: Record<string, unknown> = {
  mcq: {
    configVersion: 2,
    prompt: "Which one is the capital of France?",
    choices: [
      { text: "Paris", correct: true },
      { text: "Lyon", correct: false },
    ],
    mode: "single",
  },
  short: {
    configVersion: 1,
    prompt: "Capital of France?",
    kind: "text",
    matchers: [
      { kind: "exact", value: "Lutece" },
      { kind: "exact", value: "Paris" },
    ],
  },
  cloze: {
    configVersion: 1,
    text: `The capital of France is {{${CLOZE_EXPECTED}}}.`,
  },
  code: {
    configVersion: 1,
    prompt: "Print 42.",
    language: "c",
    template: "int main(void) { return 0; }",
    tests: {
      mode: "io",
      cases: [
        { name: "shown", stdin: "", expected: "shown-output", visible: true, points: 1 },
        { name: HIDDEN_CASE_NAME, stdin: "", expected: HIDDEN_EXPECTED, visible: false, points: 1 },
      ],
    },
  },
};

const ANSWERS: Record<string, unknown> = {
  mcq: { selected: [MCQ_CORRECT] },
  short: { text: "Paris" },
  cloze: { blanks: ["Paris"] },
  code: { regions: ["return 42;"] },
};

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

/** One published question of `type`, with the config above. */
async function publish(poolId: string, type: string): Promise<string> {
  const db = server.app.db;
  const id = await poolService.createQuestion(db, {
    poolId,
    type,
    internalName: `feedback-${type}`,
    createdBy: teacher.id,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config: CONFIGS[type] });
  await poolService.publishQuestion(db, question!, { userId: teacher.id });
  return id;
}

/**
 * One evaluation with the four types, answered, closed (which grades it) and
 * released. The `code` cell is finalised by hand from a runner outcome: the
 * test runner is the unavailable stub (decision D14), and what is under test
 * is the redaction of a real `CodeDetails`, not the runner.
 */
async function gradedEvaluation() {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 0,
  });

  const questionIds: string[] = [];
  for (const type of ["mcq", "short", "cloze", "code"]) {
    questionIds.push(await publish(seed.poolId, type));
  }
  await addItems(
    db,
    (await byId(db, seed.evaluationId))!,
    questionIds,
    (type, version) =>
      typeOf(type).defaultPoints(
        loadConfig(type, { config: version.config, configVersion: version.configVersion }),
      ),
    { attemptCount: 0 },
  );

  await post(`/app/api/evaluations/${seed.evaluationId}/start`, teacher.headers, { confirm: true });
  const entered = await post(`/app/api/evaluations/${seed.evaluationId}/attempt`, student.headers, {});
  const view = entered.json().view as {
    attempt: { id: string };
    items: { id: string; type: string }[];
  };
  const itemOf = (type: string) => view.items.find((i) => i.type === type)!.id;

  for (const item of view.items) {
    const saved = await server.app.inject({
      method: "PUT",
      url: `/app/api/attempts/${view.attempt.id}/answers/${item.id}`,
      headers: student.headers,
      payload: {
        payload: ANSWERS[item.type],
        revision: 1,
        clientTs: server.clock.now().toISOString(),
      },
    });
    expect(saved.statusCode).toBe(200);
  }

  // Closing runs the automatic pass inline (no queue in a route test).
  await post(`/app/api/evaluations/${seed.evaluationId}/close`, teacher.headers);

  const codeItem = itemOf("code");
  const details = codeDetails();
  await writeGrading(db, {
    attemptId: view.attempt.id,
    itemId: codeItem,
    answerId: null,
    points: 1,
    maxPoints: 2,
    source: "auto",
    state: "validated",
    details,
    now: server.clock.now(),
  });

  await post(`/app/api/evaluations/${seed.evaluationId}/release`, teacher.headers, { confirm: true });
  return { seed, attemptId: view.attempt.id, itemOf };
}

/** A real `CodeDetails`: the pure second half of the `code` grading. */
function codeDetails(): CodeDetails {
  const config = typeOf("code").configSchema.parse(CONFIGS["code"]) as CodeConfig;
  const graded = finalizeRunnerCode(
    config,
    { regions: ["return 42;"] },
    {
      seed: 0,
      itemId: "00000000-0000-4000-8000-000000000000",
      attemptId: "00000000-0000-4000-8000-000000000001",
      itemPoints: 2,
      now: server.clock.now(),
    },
    {
      compile: { ok: true, stdout: "", stderr: "", ms: 3 },
      cases: [
        { exitCode: 0, stdout: "shown-output", stderr: "", ms: 1, timedOut: false, oom: false, truncated: false },
        { exitCode: 0, stdout: "wrong", stderr: "", ms: 1, timedOut: false, oom: false, truncated: false },
      ],
    },
  );
  return graded.details;
}

/** The feedback of one item, by question type. */
async function feedbackOf(type: string): Promise<Record<string, unknown>> {
  const res = await get(`/app/api/attempts/${built.attemptId}/feedback`, student.headers);
  expect(res.statusCode).toBe(200);
  expect(res.json().available).toBe(true);
  const itemId = built.itemOf(type);
  return (res.json().items as Record<string, unknown>[]).find((i) => i["itemId"] === itemId)!;
}

/** Rewrites the policy of the evaluation under test. */
async function setPolicy(patch: Partial<FeedbackPolicy>): Promise<void> {
  await server.app.db
    .update(evaluations)
    .set({ feedbackPolicy: FeedbackPolicy.parse(patch) })
    .where(eq(evaluations.id, built.seed.evaluationId));
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  built = await gradedEvaluation();
});
afterAll(async () => {
  await server.close();
});

describe("the answer key never rides in `details` (H1)", () => {
  beforeAll(() => setPolicy({ showKey: false }));

  it("hides the correct choices of an mcq", async () => {
    const item = await feedbackOf("mcq");
    const details = item["details"] as Record<string, unknown>;
    expect(details["correct"]).toBeUndefined();
    // The student's own score stays: it IS the feedback.
    expect(details["selected"]).toEqual([MCQ_CORRECT]);
    expect(details["fraction"]).toBe(1);
    expect(item["solution"]).toBeNull();
  });

  it("hides the expected value of every cloze blank", async () => {
    const item = await feedbackOf("cloze");
    const details = item["details"] as { perBlank: Record<string, unknown>[] };
    expect(details.perBlank).toHaveLength(1);
    expect(details.perBlank[0]!["expected"]).toBeUndefined();
    // What the student typed stays; what they should have typed does not.
    expect(details.perBlank[0]!["given"]).toBe("Paris");
    expect(details.perBlank[0]!["ok"]).toBe(false);
    expect(JSON.stringify(item["details"])).not.toContain(CLOZE_EXPECTED);
  });

  it("hides which matcher accepted a short answer", async () => {
    const item = await feedbackOf("short");
    const details = item["details"] as Record<string, unknown>;
    expect(details["matchedIndex"]).toBeUndefined();
    expect(details["matchedKind"]).toBeUndefined();
    expect(details["fraction"]).toBe(1);
  });

  it("keeps a code question's hidden case opaque and its visible case whole", async () => {
    await setPolicy({ showKey: false, showHiddenCaseNames: false });
    const item = await feedbackOf("code");
    const details = item["details"] as { cases: Record<string, unknown>[] };
    const [shown, hidden] = details.cases;
    expect(shown!["name"]).toBe("shown");
    // The visible case publishes its expected output already (deviation W3-4).
    expect(shown!["expected"]).toBe("shown-output");
    expect(hidden!["name"]).toBe("#2");
    expect(hidden!["ok"]).toBe(false);
    expect(hidden!["expected"]).toBeUndefined();
    expect(hidden!["actual"]).toBeUndefined();
    expect(JSON.stringify(details)).not.toContain(HIDDEN_CASE_NAME);
    expect(JSON.stringify(details)).not.toContain(HIDDEN_EXPECTED);
  });
});

describe("`showKey: true` publishes the key the teacher chose to publish", () => {
  beforeAll(() => setPolicy({ showKey: true }));

  it("gives every type its breakdown whole", async () => {
    const mcq = (await feedbackOf("mcq"))["details"] as Record<string, unknown>;
    expect(mcq["correct"]).toEqual([MCQ_CORRECT]);

    const cloze = (await feedbackOf("cloze"))["details"] as {
      perBlank: Record<string, unknown>[];
    };
    expect(cloze.perBlank[0]!["expected"]).toBe(CLOZE_EXPECTED);

    const short = (await feedbackOf("short"))["details"] as Record<string, unknown>;
    expect(short["matchedIndex"]).toBe(1);
    expect(short["matchedKind"]).toBe("exact");

    const code = (await feedbackOf("code"))["details"] as { cases: Record<string, unknown>[] };
    expect(code.cases[1]!["name"]).toBe(HIDDEN_CASE_NAME);
    expect(code.cases[1]!["expected"]).toBe(HIDDEN_EXPECTED);

    // …and the solutions travel with it.
    expect((await feedbackOf("mcq"))["solution"]).toEqual({ correct: [MCQ_CORRECT] });
  });
});
