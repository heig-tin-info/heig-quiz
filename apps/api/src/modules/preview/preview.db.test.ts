/**
 * The teacher's stateless evaluation preview (issue #75, ADR-018 fourth
 * addendum), over the REAL application: the guard, the four routes, the
 * student exit and the grading, against the real migrations.
 *
 * What is asserted, in the order the issue asks for it:
 *   - only the staff of the classroom reaches it (404 otherwise, invariant 6);
 *   - nothing is written, whatever is called (no attempt, answer, journal,
 *     grading or audit row);
 *   - the seed is the whole state: the same seed gives the same order and the
 *     same shuffles, and the grading rebuilds everything from it;
 *   - the grading returns points per item, the total and the grade under the
 *     evaluation's settings, runner cases included;
 *   - the start payload goes through `toStudent`: no key value, no forbidden
 *     key, in the serialized output (docs/05 §5.7).
 */
import { randomUUID } from "node:crypto";

import { count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { EvaluationPreview, PreviewCorrection, RunAccepted } from "@quiz/contracts";
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { RunnerUnavailable } from "@quiz/core/server";
import { compilesPerMinute } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  answers,
  attemptEvents,
  attempts,
  auditLog,
  classrooms,
  courseStaff,
  evaluations,
  gradings,
  questions,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { fakeRunnableCode, fakeShort } from "../../test/fakeType.js";
import { reload, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { FORBIDDEN_STUDENT_KEYS } from "../live/studentView.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import * as service from "./service.js";

let server: TestServer;
let db: Db;
const restores: (() => void)[] = [];
let teacher: { id: string; headers: Record<string, string> };
let stranger: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };
let defaultRunner: unknown;

const setRunner = (runner: unknown) => {
  (server.app as unknown as { runner: unknown }).runner = runner;
};

beforeAll(async () => {
  restores.push(registerForTests(fakeShort), registerForTests(fakeRunnableCode));
  server = await testServer();
  server.clock.set("2026-09-20T09:00:00.000Z");
  db = server.app.db as unknown as Db;
  defaultRunner = (server.app as unknown as { runner: unknown }).runner;
  teacher = await server.signIn("teacher");
  stranger = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
  for (const restore of restores.reverse()) restore();
});
beforeEach(() => setRunner(defaultRunner));

const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });

// --- The world ----------------------------------------------------------------

/** Markers sown in the key of every question: none may reach the start payload. */
const SECRETS = {
  explanation: "EXPLANATION-MARKER-7f3a",
  hiddenCase: "hidden-case-marker-91c2",
  hiddenExpected: "HIDDEN-EXPECTED-5b8e",
  internalName: "internal-name-marker",
};

/** Five choices, B and D correct, shuffled per attempt. */
const mcqConfig = {
  configVersion: 2,
  prompt: "Which are prime?",
  choices: [
    { text: "1", correct: false },
    { text: "2", correct: true },
    { text: "4", correct: false },
    { text: "5", correct: true },
    { text: "9", correct: false },
  ],
  mode: "multiple",
  policy: "inherit",
  shuffleChoices: true,
};

/** One visible case, one hidden one: the runner must see both at grading only. */
const codeConfig = {
  template: "int main(void) { return 0; }",
  runsPerMinute: 3,
  cases: [
    { name: "visible-1", expected: "ok", visible: true },
    { name: SECRETS.hiddenCase, expected: SECRETS.hiddenExpected, visible: false },
  ],
};

async function publish(
  poolId: string,
  ownerId: string,
  type: string,
  config: unknown,
  explanation = "",
): Promise<string> {
  const id = await poolService.createQuestion(db, {
    poolId,
    type,
    internalName: `${SECRETS.internalName}-${type}-${randomUUID().slice(0, 6)}`,
    createdBy: ownerId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, { config, explanation });
  await poolService.publishQuestion(db, question!, { userId: ownerId });
  return id;
}

/**
 * An evaluation of four items — two `short` (from the fixture), one `mcq`,
 * one `code` — with the item order and the choices shuffled, 30 minutes long,
 * and one student enrolled. Each call builds its own classroom.
 */
async function world() {
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 2,
    settings: { shuffleItems: true, shuffleChoices: true },
  });
  const mcq = await publish(seed.poolId, teacher.id, "mcq", mcqConfig, SECRETS.explanation);
  const code = await publish(seed.poolId, teacher.id, "code", codeConfig, SECRETS.explanation);
  const evaluation = await reload(db, seed.evaluationId);
  const added = await evaluationService.addItems(
    db,
    evaluation,
    [mcq, code],
    (type, version) =>
      typeOf(type).defaultPoints(
        loadConfig(type, { config: version.config, configVersion: version.configVersion }),
      ),
    { attemptCount: 0 },
  );
  return {
    ...seed,
    shortItemIds: seed.itemIds,
    // `addItems` answers the whole item list, in position order.
    mcqItemId: added.at(-2)!.id,
    codeItemId: added.at(-1)!.id,
    url: `/app/api/evaluations/${seed.evaluationId}/preview`,
  };
}

/** Every row the preview must never write, for one evaluation. */
async function footprint(evaluationId: string) {
  const attemptIds = (
    await db.select({ id: attempts.id }).from(attempts).where(eq(attempts.evaluationId, evaluationId))
  ).map((a) => a.id);
  const within = (ids: string[]) => (ids.length === 0 ? [randomUUID()] : ids);
  const [a] = await db.select({ n: count() }).from(answers).where(inArray(answers.attemptId, within(attemptIds)));
  const [g] = await db.select({ n: count() }).from(gradings).where(inArray(gradings.attemptId, within(attemptIds)));
  const [e] = await db
    .select({ n: count() })
    .from(attemptEvents)
    .where(inArray(attemptEvents.attemptId, within(attemptIds)));
  const [audit] = await db.select({ n: count() }).from(auditLog);
  const [row] = await db.select().from(evaluations).where(eq(evaluations.id, evaluationId));
  return {
    attempts: attemptIds.length,
    answers: a!.n,
    gradings: g!.n,
    events: e!.n,
    audit: audit!.n,
    evaluationUpdatedAt: row!.updatedAt.toISOString(),
  };
}

/** A runner that answers every case with exit 0 and remembers what it got. */
function recorder() {
  const requests: RunnerRequest[] = [];
  return {
    requests,
    runner: {
      run: async (request: RunnerRequest): Promise<RunnerOutcome> => {
        requests.push(request);
        return {
          compile: { ok: true, stdout: "", stderr: "", ms: 1 },
          cases: request.cases.map(() => ({
            exitCode: 0,
            stdout: "ok\n",
            stderr: "",
            ms: 1,
            timedOut: false,
            oom: false,
            truncated: false,
          })),
        };
      },
      health: async () => ({ ok: true, languages: ["c"], queued: 0, avgMs: 1 }),
    },
  };
}

/** The key of the fake `short` question called `name` by the fixture. */
const shortAnswer = (index: number) => `answer-q${index}`;

// --- Access -------------------------------------------------------------------

describe("who may preview", () => {
  it("answers 404 to a teacher off the staff, on all four routes", async () => {
    const w = await world();
    const body = { seed: 1, itemId: w.codeItemId, regions: [] };
    for (const [url, payload] of [
      [w.url, undefined],
      [`${w.url}/run`, body],
      [`${w.url}/simulate`, { seed: 1, itemId: w.codeItemId, answer: {} }],
      [`${w.url}/grade`, { seed: 1, answers: {} }],
    ] as const) {
      const res = await post(url, stranger.headers, payload);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });

  it("refuses a student outright", async () => {
    const w = await world();
    expect((await post(w.url, student.headers)).statusCode).toBe(403);
    expect((await post(`${w.url}/grade`, student.headers, { seed: 1, answers: {} })).statusCode).toBe(403);
  });

  it("is open in every state, a running and a closed evaluation included", async () => {
    const w = await world();
    expect((await post(w.url, teacher.headers)).statusCode).toBe(200);
    const now = server.clock.now();
    await evaluationService.applyState(db, await reload(db, w.evaluationId), "running", now);
    expect((await post(w.url, teacher.headers)).statusCode).toBe(200);
    await evaluationService.applyState(db, await reload(db, w.evaluationId), "closed", now);
    const closed = await post(w.url, teacher.headers);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().view.items).toHaveLength(4);
  });

  it("validates its bodies with the shared schemas", async () => {
    const w = await world();
    const bad = await post(`${w.url}/grade`, teacher.headers, { seed: -1, answers: {} });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("validation");
    const noSeed = await post(`${w.url}/run`, teacher.headers, { itemId: w.codeItemId, regions: [] });
    expect(noSeed.statusCode).toBe(400);
  });
});

// --- Starting -------------------------------------------------------------------

describe("starting a preview", () => {
  it("draws a seed and serves the student's view of it, with the evaluation's clock", async () => {
    const w = await world();
    const res = await post(w.url, teacher.headers);
    expect(res.statusCode).toBe(200);
    const preview = res.json() as EvaluationPreview;
    expect(Number.isInteger(preview.seed)).toBe(true);
    expect(preview.durationS).toBe(1800);
    expect(preview.view.attempt.preview).toBe(true);
    expect(preview.view.attempt.readOnly).toBe(false);
    expect(preview.view.items.map((i) => i.id).sort()).toEqual(
      [...w.shortItemIds, w.mcqItemId, w.codeItemId].sort(),
    );
    // The same call again is a NEW preview: another seed (2^31 values).
    const again = (await post(w.url, teacher.headers)).json() as EvaluationPreview;
    expect(again.seed).not.toBe(preview.seed);
  });

  it("counts down the announced window of a common-deadline evaluation", async () => {
    const w = await world();
    const row = await reload(db, w.evaluationId);
    await db
      .update(evaluations)
      .set({
        settings: { ...evaluationService.settingsOf(row), timing: "deadline" },
        opensAt: new Date("2026-09-21T08:00:00Z"),
        closesAt: new Date("2026-09-21T08:45:00Z"),
      })
      .where(eq(evaluations.id, w.evaluationId));
    const preview = (await post(w.url, teacher.headers)).json() as EvaluationPreview;
    expect(preview.durationS).toBe(45 * 60);
  });

  it("is a pure function of the seed: same seed, same order, same shuffles", async () => {
    const w = await world();
    const row = await reload(db, w.evaluationId);
    const now = server.clock.now();
    const one = await service.startPreview(db, row, now, 424242);
    const two = await service.startPreview(db, row, now, 424242);
    expect(JSON.stringify(two.view.items)).toBe(JSON.stringify(one.view.items));

    // And the seed is what moves them: across twenty seeds, the order of the
    // four items and the order of the five choices both change.
    const orders = new Set<string>();
    const choices = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const view = (await service.startPreview(db, row, now, seed)).view;
      orders.add(view.items.map((i) => i.id).join());
      const mcq = view.items.find((i) => i.id === w.mcqItemId)!.student as {
        choices: { id: number }[];
      };
      choices.add(mcq.choices.map((c) => c.id).join());
    }
    expect(orders.size).toBeGreaterThan(1);
    expect(choices.size).toBeGreaterThan(1);
  });

  it("goes through toStudent: no key value and no forbidden key in the payload", async () => {
    const w = await world();
    const res = await post(w.url, teacher.headers);
    const serialized = res.body;
    for (const marker of [
      ...Object.values(SECRETS),
      shortAnswer(0),
      shortAnswer(1),
      '"correct"',
      '"policy"',
    ]) {
      expect(serialized, marker).not.toContain(marker);
    }
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          walk(child);
        }
      }
    };
    walk((res.json() as EvaluationPreview).view.items.map((i) => i.student));
    for (const key of FORBIDDEN_STUDENT_KEYS) expect(keys.has(key), key).toBe(false);
    // The visible case, on the other hand, IS published (docs/04 §4.7).
    expect(serialized).toContain("visible-1");
  });
});

// --- Running --------------------------------------------------------------------

describe("the Run button of a preview", () => {
  it("runs the visible cases only, from a source rebuilt server-side", async () => {
    const w = await world();
    const fake = recorder();
    setRunner(fake.runner);
    const res = await post(`${w.url}/run`, teacher.headers, {
      seed: 7,
      itemId: w.codeItemId,
      regions: ["int x;"],
    });
    expect(res.statusCode).toBe(200);
    const accepted = res.json() as RunAccepted;
    expect(accepted.result.status).toBe("ok");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.cases.map((c) => c.name)).toEqual(["visible-1"]);
    expect(fake.requests[0]!.priority).toBe("interactive");
    expect(JSON.stringify(accepted)).not.toContain(SECRETS.hiddenCase);
  });

  it("answers 503 when no runner is configured, and 422 on a type with nothing to run", async () => {
    const w = await world();
    setRunner({
      run: async () => {
        throw new RunnerUnavailable("not_configured");
      },
      health: async () => ({ ok: false, languages: [], queued: 0, avgMs: null }),
    });
    const down = await post(`${w.url}/run`, teacher.headers, { seed: 7, itemId: w.codeItemId, regions: [] });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ error: "runner_unavailable", reason: "not_configured" });
    const short = await post(`${w.url}/run`, teacher.headers, {
      seed: 7,
      itemId: w.shortItemIds[0],
      regions: [],
    });
    expect(short.statusCode).toBe(422);
    expect(short.json().error).toBe("not_runnable");
  });

  it("answers 404 for an item of another evaluation", async () => {
    const w = await world();
    const other = await world();
    const res = await post(`${w.url}/run`, teacher.headers, {
      seed: 7,
      itemId: other.codeItemId,
      regions: [],
    });
    expect(res.statusCode).toBe(404);
  });

  it("shares one budget across the items of an evaluation, like an attempt", async () => {
    const w = await world();
    // A second code question in the same evaluation, same budget of 3.
    const second = await publish(w.poolId, teacher.id, "code", codeConfig);
    const added = await evaluationService.addItems(
      db,
      await reload(db, w.evaluationId),
      [second],
      (type, version) =>
        typeOf(type).defaultPoints(
          loadConfig(type, { config: version.config, configVersion: version.configVersion }),
        ),
      { attemptCount: 0 },
    );
    const secondItemId = added.at(-1)!.id;
    setRunner(recorder().runner);
    const run = (itemId: string) =>
      post(`${w.url}/run`, teacher.headers, { seed: 7, itemId, regions: [] });
    expect((await run(w.codeItemId)).statusCode).toBe(200);
    expect((await run(w.codeItemId)).statusCode).toBe(200);
    expect((await run(secondItemId)).statusCode).toBe(200);
    // Three spent over the two items: the second item has none left either.
    expect((await run(secondItemId)).statusCode).toBe(429);
    expect((await run(w.codeItemId)).statusCode).toBe(429);
  });

  it("spends the question's own budget per minute (runsPerMinute: 3)", async () => {
    const w = await world();
    setRunner(recorder().runner);
    const run = () => post(`${w.url}/run`, teacher.headers, { seed: 7, itemId: w.codeItemId, regions: [] });
    for (let i = 0; i < 3; i++) expect((await run()).statusCode).toBe(200);
    const limited = await run();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it("gives Compile a budget of its own (#129)", async () => {
    const w = await world();
    setRunner(recorder().runner);
    const run = (compileOnly?: boolean) =>
      post(`${w.url}/run`, teacher.headers, {
        seed: 7,
        itemId: w.codeItemId,
        regions: [],
        ...(compileOnly ? { compileOnly } : {}),
      });
    // The three test runs spent: a fourth is refused, a compilation is not.
    for (let i = 0; i < 3; i++) expect((await run()).statusCode).toBe(200);
    expect((await run()).statusCode).toBe(429);
    const limit = compilesPerMinute(3);
    for (let i = 0; i < limit; i++) expect((await run(true)).statusCode).toBe(200);
    // Past its own budget, Compile answers 429 in turn.
    const limited = await run(true);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe("rate_limited");
  });

  it("leaves the test runs untouched by compilations (#129)", async () => {
    const w = await world();
    setRunner(recorder().runner);
    const run = (compileOnly?: boolean) =>
      post(`${w.url}/run`, teacher.headers, {
        seed: 7,
        itemId: w.codeItemId,
        regions: [],
        ...(compileOnly ? { compileOnly } : {}),
      });
    for (let i = 0; i < 5; i++) expect((await run(true)).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await run()).statusCode).toBe(200);
  });
});

// --- Grading --------------------------------------------------------------------

describe("grading a preview", () => {
  it("grades every item under the evaluation's settings and returns the full correction", async () => {
    const w = await world();
    const fake = recorder();
    setRunner(fake.runner);
    const started = (await post(w.url, teacher.headers)).json() as EvaluationPreview;

    const res = await post(`${w.url}/grade`, teacher.headers, {
      seed: started.seed,
      answers: {
        [w.shortItemIds[0]!]: shortAnswer(0), // right
        [w.shortItemIds[1]!]: "wrong", // wrong
        [w.mcqItemId]: { selected: [1, 3] }, // both primes: right
        [w.codeItemId]: { regions: ["int x;"] }, // every case exits 0: right
      },
    });
    expect(res.statusCode).toBe(200);
    const correction = res.json() as PreviewCorrection;

    // In the order the preview was played in, which the seed alone decides.
    expect(correction.items.map((i) => i.itemId)).toEqual(started.view.items.map((i) => i.id));
    expect(correction.items.map((i) => i.position)).toEqual([0, 1, 2, 3]);
    const byId = new Map(correction.items.map((i) => [i.itemId, i]));
    expect(byId.get(w.shortItemIds[0]!)).toMatchObject({ status: "graded", points: 1, verdict: "correct" });
    expect(byId.get(w.shortItemIds[1]!)).toMatchObject({ status: "graded", points: 0, verdict: "wrong" });
    expect(byId.get(w.mcqItemId)).toMatchObject({ status: "graded", points: 1, maxPoints: 1 });
    expect(byId.get(w.codeItemId)).toMatchObject({ status: "graded", points: 2, maxPoints: 2 });

    // The final grading runs the WHOLE request, the hidden case included.
    expect(fake.requests.at(-1)!.cases.map((c) => c.name)).toEqual(["visible-1", SECRETS.hiddenCase]);

    // The full correction, whatever the feedback policy: key and explanation.
    expect(byId.get(w.mcqItemId)!.solution).not.toBeNull();
    expect(byId.get(w.mcqItemId)!.explanation).toBe(SECRETS.explanation);
    // The student payload is the one the player showed, same shuffle.
    expect(byId.get(w.mcqItemId)!.student).toEqual(
      started.view.items.find((i) => i.id === w.mcqItemId)!.student,
    );

    expect(correction).toMatchObject({ seed: started.seed, points: 4, totalPoints: 5, ungraded: 0 });
    // Linear Swiss scale: 1 + 5 × 4/5 = 5.
    expect(correction.grade).toBe(5);
  });

  it("counts an untouched item as zero, and names a runner that is not there", async () => {
    const w = await world();
    const correction = (
      await post(`${w.url}/grade`, teacher.headers, {
        seed: 3,
        answers: { [w.codeItemId]: { regions: [] } },
      })
    ).json() as PreviewCorrection;
    const byId = new Map(correction.items.map((i) => [i.itemId, i]));
    expect(byId.get(w.shortItemIds[0]!)).toMatchObject({ status: "graded", points: 0, details: null });
    expect(byId.get(w.codeItemId)).toMatchObject({ status: "runner_unavailable", points: null, verdict: null });
    expect(correction.ungraded).toBe(1);
    expect(correction.points).toBe(0);
    expect(correction.grade).toBe(1);
  });

  it("ignores an answer to an item the evaluation does not hold, and flags an invalid one", async () => {
    const w = await world();
    const correction = (
      await post(`${w.url}/grade`, teacher.headers, {
        seed: 3,
        answers: { [randomUUID()]: "stray", [w.mcqItemId]: { selected: "B" } },
      })
    ).json() as PreviewCorrection;
    expect(correction.items).toHaveLength(4);
    expect(correction.items.find((i) => i.itemId === w.mcqItemId)).toMatchObject({
      status: "answer_invalid",
      points: 0,
    });
  });

  it("applies the evaluation's mcq policy", async () => {
    const w = await world();
    const answersOf = { [w.mcqItemId]: { selected: [1] } };
    await db.update(evaluations).set({ mcqPolicy: "all_or_nothing" }).where(eq(evaluations.id, w.evaluationId));
    const strict = (await post(`${w.url}/grade`, teacher.headers, { seed: 3, answers: answersOf })).json();
    await db.update(evaluations).set({ mcqPolicy: "ripkey" }).where(eq(evaluations.id, w.evaluationId));
    const lenient = (await post(`${w.url}/grade`, teacher.headers, { seed: 3, answers: answersOf })).json();
    const points = (c: PreviewCorrection) => c.items.find((i) => i.itemId === w.mcqItemId)!.points;
    expect(points(strict)).toBe(0);
    expect(points(lenient)).toBe(0.5);
  });

  it("limits gradings per minute and teacher", async () => {
    const w = await world();
    const colleague = await server.signIn("teacher");
    const [row] = await db.select().from(evaluations).where(eq(evaluations.id, w.evaluationId));
    // A colleague on the same course's staff: the budget is per teacher.
    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, row!.classroomId));
    await db.insert(courseStaff).values({ courseId: room!.courseId, userId: colleague.id });
    const grade = () => post(`${w.url}/grade`, colleague.headers, { seed: 3, answers: {} });
    for (let i = 0; i < service.GRADES_PER_MINUTE; i++) expect((await grade()).statusCode).toBe(200);
    expect((await grade()).statusCode).toBe(429);
  });
});

// --- Nothing is written -----------------------------------------------------------

describe("a preview writes nothing", () => {
  it("leaves no attempt, answer, journal, grading or audit row behind", async () => {
    const w = await world();
    const now = server.clock.now();
    // A running evaluation with a real attempt beside it, so the counts are
    // taken where rows COULD appear.
    await evaluationService.applyState(db, await reload(db, w.evaluationId), "running", now);
    const entered = await post(`/app/api/evaluations/${w.evaluationId}/attempt`, student.headers, {});
    expect(entered.statusCode).toBe(200);
    setRunner(recorder().runner);

    const before = await footprint(w.evaluationId);
    const started = (await post(w.url, teacher.headers)).json() as EvaluationPreview;
    await post(`${w.url}/run`, teacher.headers, { seed: started.seed, itemId: w.codeItemId, regions: [] });
    await post(`${w.url}/run`, teacher.headers, {
      seed: started.seed,
      itemId: w.codeItemId,
      regions: [],
      stdin: "42",
    });
    const graded = await post(`${w.url}/grade`, teacher.headers, {
      seed: started.seed,
      answers: { [w.shortItemIds[0]!]: shortAnswer(0), [w.codeItemId]: { regions: [] } },
    });
    expect(graded.statusCode).toBe(200);
    expect(await footprint(w.evaluationId)).toEqual(before);
    expect(before.attempts).toBe(1);
  });
});
