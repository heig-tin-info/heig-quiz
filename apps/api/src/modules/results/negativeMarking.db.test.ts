/**
 * Negative marking (ADR-026, #130) over the REAL application: the whole
 * plugin chain, the real guards, the real migrations.
 *
 * What a unit test cannot prove is here: that the evaluation's setting
 * reaches the grader, that negative points per question are STORED and
 * SHOWN as such, and that every total the platform serves — the grade table,
 * the CSV, the release snapshot, the student's feedback, cards and home, the
 * kept attempt of a retake — is the same one, floored at 0, with the grade
 * computed from it. Plus the setting's own rules: refused on a poll, frozen
 * once somebody has started, and the range of a manual correction.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  AttemptOrLobby,
  EvaluationSettings,
  GradingQueue,
  ReleasedGrades,
  ResultsView,
  StudentFeedback,
  StudentHome,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { answers, attempts, evaluations, gradings, questions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { applyState, joinedItems, type EvaluationRecord } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as pool from "../pool/service.js";
import * as live from "../live/service.js";

let server: TestServer;
let restore: () => void;
let teacher: { id: string; headers: Record<string, string> };
let students: { id: string; headers: Record<string, string> }[];

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  server.clock.set("2026-09-25T09:00:00.000Z");
  teacher = await server.signIn("teacher");
  students = [await server.signIn("student"), await server.signIn("student")];
});
afterAll(async () => {
  await server.close();
  restore();
});

const db = () => server.app.db;
const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });
const send = (
  method: "POST" | "PATCH",
  url: string,
  headers: Record<string, string>,
  payload: unknown = {},
) => server.app.inject({ method, url, headers, payload: payload as object });

/** A single-answer question with four choices, the key second: a distractor costs a third. */
const SINGLE = {
  configVersion: 2,
  prompt: "Let `int *p` point at `0x1000`. What is `p + 1`?",
  choices: [
    { text: "0x1001", correct: false },
    { text: "0x1004", correct: true },
    { text: "0x1008", correct: false },
    { text: "0x1010", correct: false },
  ],
  mode: "single",
  policy: "inherit",
  shuffleChoices: false,
};

/** Two keys, two distractors, a policy of its own that negative marking overrides. */
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
  policy: "ripkey",
  shuffleChoices: false,
};

async function publishMcq(poolId: string, name: string, config: object): Promise<string> {
  const id = await pool.createQuestion(db(), {
    poolId,
    type: "mcq",
    internalName: name,
    createdBy: teacher.id,
  });
  const [question] = await db().select().from(questions).where(eq(questions.id, id));
  await pool.putDraft(db(), question!, { config });
  await pool.publishQuestion(db(), question!, { userId: teacher.id });
  return id;
}

/**
 * An evaluation of three items, in this order: the fake `short` question of
 * the fixture (1 point), the single-answer mcq (3 points) and the
 * multiple-answer one (4 points). 8 points in all.
 */
async function build(options: {
  mode?: "exam" | "exercise";
  settings?: Partial<EvaluationSettings>;
  negativeMarking?: boolean;
}) {
  const seed = await seedLive(db(), {
    teacherId: teacher.id,
    studentIds: students.map((s) => s.id),
    questions: 1,
    mode: options.mode ?? "exam",
    settings: { ...options.settings, negativeMarking: options.negativeMarking ?? true },
    ...(options.mode === "exercise" ? { durationS: null } : {}),
  });
  const single = await publishMcq(seed.poolId, "mcq-single", SINGLE);
  const multiple = await publishMcq(seed.poolId, "mcq-multiple", MULTIPLE);
  await evaluationService.addItems(
    db(),
    await reload(db(), seed.evaluationId),
    [single, multiple],
    (type, version) =>
      typeOf(type).defaultPoints(
        loadConfig(type, { config: version.config, configVersion: version.configVersion }),
      ),
    { attemptCount: 0 },
  );
  const items = await joinedItems(db(), seed.evaluationId);
  for (const [item, points] of [
    [items[1]!, 3],
    [items[2]!, 4],
  ] as const) {
    await evaluationService.patchItem(db(), await reload(db(), seed.evaluationId), item.item.id, {
      points,
    }, { attemptCount: 0 });
  }
  return { seed, items: await joinedItems(db(), seed.evaluationId) };
}

type Answers = [short: string, single: number[], multiple: number[]];

/** Enters, answers the three items and submits, through the services the routes call. */
async function sit(evaluation: EvaluationRecord, userId: string, answers: Answers) {
  const items = await joinedItems(db(), evaluation.id);
  const participant = (await live.participantOf(db(), evaluation, userId))!;
  const entered = await live.enterEvaluation(db(), {
    evaluation,
    participant,
    now: server.clock.now(),
  });
  let attempt = entered.attempt;
  if (attempt.state === "not_started") {
    attempt = await live.beginAttempt(db(), evaluation, attempt, participant, server.clock.now());
  }
  const payloads = [answers[0], { selected: answers[1] }, { selected: answers[2] }];
  for (const [index, payload] of payloads.entries()) {
    await live.saveAnswer(db(), {
      evaluation,
      attempt,
      itemId: items[index]!.item.id,
      payload,
      revision: 1,
      now: server.clock.now(),
    });
  }
  const submitted = await live.submitAttempt(db(), evaluation, attempt, server.clock.now());
  await live.gradeFinishedRetakes(server.app, evaluation, [submitted.id]);
  server.clock.advance(1000);
  return submitted;
}

/** Closes through the route the teacher presses: the grading pass runs inline. */
async function close(evaluationId: string) {
  const closed = await send("POST", `/app/api/evaluations/${evaluationId}/close`, teacher.headers, {
    confirm: true,
  });
  expect(closed.statusCode).toBe(200);
}

const pointsOf = async (attemptId: string) =>
  (
    await db()
      .select()
      .from(gradings)
      .where(and(eq(gradings.attemptId, attemptId), eq(gradings.state, "validated")))
  ).map((g) => ({ itemId: g.itemId, points: g.points, details: g.details }));

describe("an exam with negative marking", () => {
  /*
   * Student 0 guesses and loses: the short answer wrong (0), a distractor on
   * the single question (−1 of 3), both distractors on the multiple one (−4
   * of 4). −5 in all, brought back to 0: a 1.0.
   * Student 1: short right (1), the single key (3), one key of two (2): 6 of
   * 8, a 4.8.
   */
  async function sat() {
    const { seed, items } = await build({});
    let evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const guesser = await sit(evaluation, students[0]!.id, ["nope", [0], [2, 3]]);
    const good = await sit(evaluation, students[1]!.id, ["answer-q0", [1], [0]]);
    await close(evaluation.id);
    evaluation = await reload(db(), evaluation.id);
    return { evaluation, items, guesser, good };
  }

  it("stores the negative points of each choice question, and 0 elsewhere", async () => {
    const { items, guesser, good } = await sat();
    const mine = new Map((await pointsOf(guesser.id)).map((g) => [g.itemId, g]));
    expect(mine.get(items[0]!.item.id)!.points).toBe(0);
    expect(mine.get(items[1]!.item.id)!.points).toBe(-1);
    expect(mine.get(items[2]!.item.id)!.points).toBe(-4);
    expect(mine.get(items[1]!.item.id)!.details).toMatchObject({
      negativeMarking: true,
      fraction: -1 / 3,
    });
    const theirs = new Map((await pointsOf(good.id)).map((g) => [g.itemId, g.points]));
    expect([...items.map((i) => theirs.get(i.item.id))]).toEqual([1, 3, 2]);
  });

  it("floors the total at 0 in the grade table and the statistics, per-item negatives kept", async () => {
    const { evaluation, items, guesser } = await sat();
    const view = (await get(`/app/api/evaluations/${evaluation.id}/results`, teacher.headers)).json() as ResultsView;
    const row = view.rows.find((r) => r.attemptId === guesser.id)!;
    expect(row.perItem[items[1]!.item.id]).toBe(-1);
    expect(row.perItem[items[2]!.item.id]).toBe(-4);
    expect(row.points).toBe(0);
    expect(row.grade).toBe(1);
    const other = view.rows.find((r) => r.attemptId !== guesser.id && r.attemptId !== null)!;
    expect([other.points, other.grade]).toEqual([6, 4.8]);
    expect(view.stats.min).toBe(1);
    // The single question: (−1/3 + 1) / 2 for the class.
    expect(view.items[1]!.successRate).toBe(0.33);
  });

  it("writes the negative items and the floored total into the CSV", async () => {
    const { evaluation } = await sat();
    const csv = (await get(`/app/api/evaluations/${evaluation.id}/results.csv`, teacher.headers)).body;
    const line = csv.split(/\r?\n/).find((l) => l.includes("-4"));
    expect(line).toBeDefined();
    const cells = line!.split(";");
    // …; short; single; multiple; total; grade — numbers, never the text
    // `'-1` the formula guard of a name would make of them.
    expect(cells.slice(-5)).toEqual(["0", "-1", "-4", "0", "1.0"]);
  });

  it("freezes the floored total in the release, and serves it to the student", async () => {
    const { evaluation, items, guesser } = await sat();
    const released = await send("POST", `/app/api/evaluations/${evaluation.id}/release`, teacher.headers, {
      confirm: true,
    });
    expect(released.statusCode).toBe(200);
    const snapshot = (await reload(db(), evaluation.id)).releasedGrades as ReleasedGrades;
    const frozen = snapshot.rows.find((r) => r.attemptId === guesser.id)!;
    expect(frozen).toMatchObject({ points: 0, grade: 1 });
    expect(frozen.perItem[items[2]!.item.id]).toBe(-4);

    const feedback = (await get(`/app/api/attempts/${guesser.id}/feedback`, students[0]!.headers)).json() as StudentFeedback;
    expect(feedback.available).toBe(true);
    if (!feedback.available) return;
    expect([feedback.points, feedback.grade]).toEqual([0, 1]);
    expect(feedback.items.map((i) => i.points)).toEqual([0, -1, -4]);
    expect(feedback.items[1]!.verdict).toBe("wrong");

    const cards = (await get("/app/api/student/results", students[0]!.headers)).json() as {
      evaluationId: string;
      points: number;
      grade: number;
    }[];
    expect(cards.find((c) => c.evaluationId === evaluation.id)).toMatchObject({ points: 0, grade: 1 });

    const home = (await get("/app/api/student/home", students[0]!.headers)).json() as StudentHome;
    const card = [...home.open, ...home.upcoming, ...home.past].find((c) => c.id === evaluation.id)!;
    expect(card.grade).toBe(1);
  });

  it("recomputes the same floored total once the release is out of date", async () => {
    const { evaluation, guesser } = await sat();
    await send("POST", `/app/api/evaluations/${evaluation.id}/release`, teacher.headers, { confirm: true });
    await db()
      .update(evaluations)
      .set({ modifiedAfterRelease: true })
      .where(eq(evaluations.id, evaluation.id));
    const feedback = (await get(`/app/api/attempts/${guesser.id}/feedback`, students[0]!.headers)).json() as StudentFeedback;
    if (!feedback.available) throw new Error("feedback expected");
    expect([feedback.points, feedback.grade]).toEqual([0, 1]);
    const cards = (await get("/app/api/student/results", students[0]!.headers)).json() as {
      evaluationId: string;
      points: number;
    }[];
    expect(cards.find((c) => c.evaluationId === evaluation.id)!.points).toBe(0);
  });

  it("regrades with the evaluation's setting", async () => {
    const { evaluation, items, guesser } = await sat();
    const regraded = await send(
      "POST",
      `/app/api/evaluations/${evaluation.id}/items/${items[1]!.item.id}/regrade`,
      teacher.headers,
      { note: "again" },
    );
    expect(regraded.statusCode).toBe(202);
    const mine = new Map((await pointsOf(guesser.id)).map((g) => [g.itemId, g.points]));
    expect(mine.get(items[1]!.item.id)).toBe(-1);
  });

  it("lets a correction go down to −max on a choice question, and to 0 elsewhere", async () => {
    const { evaluation, items, guesser } = await sat();
    const queue = (await get(`/app/api/evaluations/${evaluation.id}/grading`, teacher.headers)).json() as GradingQueue;
    expect(queue.items.map((i) => [i.points, i.minPoints])).toEqual([
      [1, 0],
      [3, -3],
      [4, -4],
    ]);
    const cell = (index: number) =>
      queue.entries.find((e) => e.attemptId === guesser.id && e.itemId === items[index]!.item.id)!;
    const override = (index: number, points: number) =>
      send("POST", `/app/api/gradings/${cell(index).grading!.id}/override`, teacher.headers, {
        points,
        comment: "by hand",
      });

    expect((await override(1, -3)).statusCode).toBe(200);
    const below = await override(2, -4.5);
    expect(below.statusCode).toBe(422);
    expect(below.json()).toMatchObject({ error: "points_out_of_range" });
    expect((await override(2, 4.5)).statusCode).toBe(422);
    expect((await override(0, -0.5)).statusCode).toBe(422);
    expect((await override(0, 1)).statusCode).toBe(200);
  });
});

describe("a single-answer question takes ONE choice", () => {
  it("refuses a crafted write of several choices, and grades it wrong if one got through", async () => {
    const { seed, items } = await build({});
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const participant = (await live.participantOf(db(), evaluation, students[0]!.id))!;
    const entered = await live.enterEvaluation(db(), { evaluation, participant, now: server.clock.now() });
    let attempt = entered.attempt;
    if (attempt.state === "not_started") {
      attempt = await live.beginAttempt(db(), evaluation, attempt, participant, server.clock.now());
    }
    const write = (payload: unknown) =>
      live
        .saveAnswer(db(), {
          evaluation,
          attempt,
          itemId: items[1]!.item.id,
          payload,
          revision: 1,
          now: server.clock.now(),
        })
        .then(
          () => null,
          (error: { code?: string; status?: number }) => [error.code, error.status],
        );
    // The key (1) and a distractor (0): +1.33 of 2 unguarded, under negative marking.
    expect(await write({ selected: [0, 1] })).toEqual(["answer_invalid", 422]);
    expect(await write({ selected: [1] })).toBeNull();
    // A multiple-answer question still takes several.
    const multiple = await live
      .saveAnswer(db(), {
        evaluation,
        attempt,
        itemId: items[2]!.item.id,
        payload: { selected: [0, 1] },
        revision: 1,
        now: server.clock.now(),
      })
      .then(() => "ok");
    expect(multiple).toBe("ok");

    // Defence in depth: a row written before the gate is graded wrong, −1/3.
    await db()
      .update(answers)
      .set({ payload: { selected: [0, 1] } })
      .where(and(eq(answers.attemptId, attempt.id), eq(answers.itemId, items[1]!.item.id)));
    await live.submitAttempt(db(), evaluation, attempt, server.clock.now());
    await close(evaluation.id);
    const mine = new Map((await pointsOf(attempt.id)).map((g) => [g.itemId, g.points]));
    expect(mine.get(items[1]!.item.id)).toBe(-1);
  });
});

describe("the live dashboard", () => {
  it("shows the floored total of a row", async () => {
    const { seed } = await build({});
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const guesser = await sit(evaluation, students[0]!.id, ["nope", [0], [2, 3]]);
    await close(evaluation.id);
    const view = (await get(`/app/api/evaluations/${seed.evaluationId}/dashboard`, teacher.headers)).json() as {
      rows: { attemptId: string | null; points: number | null }[];
    };
    expect(view.rows.find((r) => r.attemptId === guesser.id)!.points).toBe(0);
  });
});

describe("the student is told before answering", () => {
  it("in the waiting room, and on each choice question only", async () => {
    const { seed } = await build({ settings: { lobby: "manual" } });
    const url = `/app/api/evaluations/${seed.evaluationId}/attempt`;
    await applyState(db(), await reload(db(), seed.evaluationId), "lobby", server.clock.now());
    const lobby = (await send("POST", url, students[0]!.headers)).json() as AttemptOrLobby;
    expect(lobby.kind).toBe("lobby");
    if (lobby.kind === "lobby") expect(lobby.view.negativeMarking).toBe(true);

    await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const entered = (await send("POST", url, students[0]!.headers)).json() as AttemptOrLobby;
    if (entered.kind !== "attempt") throw new Error("attempt expected");
    const flags = entered.view.items.map(
      (i) => (i.student as { negativeMarking?: boolean }).negativeMarking,
    );
    expect(flags).toEqual([undefined, true, true]);
    // The flag, and nothing else of the scoring.
    const body = JSON.stringify(entered.view.items.map((i) => i.student));
    expect(body).not.toContain("ripkey");
    expect(body).not.toContain('"correct"');
  });

  it("nowhere when the evaluation does not use it", async () => {
    const { seed } = await build({ negativeMarking: false, settings: { lobby: "manual" } });
    const url = `/app/api/evaluations/${seed.evaluationId}/attempt`;
    await applyState(db(), await reload(db(), seed.evaluationId), "lobby", server.clock.now());
    const lobby = (await send("POST", url, students[0]!.headers)).json() as AttemptOrLobby;
    if (lobby.kind === "lobby") expect(lobby.view.negativeMarking).toBe(false);
    await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const entered = (await send("POST", url, students[0]!.headers)).json() as AttemptOrLobby;
    if (entered.kind !== "attempt") throw new Error("attempt expected");
    expect(JSON.stringify(entered.view.items)).not.toContain("negativeMarking");
  });
});

describe("without negative marking", () => {
  it("scores the same guesses 0, never below", async () => {
    const { seed, items } = await build({ negativeMarking: false });
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const guesser = await sit(evaluation, students[0]!.id, ["nope", [0], [2, 3]]);
    await close(evaluation.id);
    const mine = new Map((await pointsOf(guesser.id)).map((g) => [g.itemId, g.points]));
    expect(items.map((i) => mine.get(i.item.id))).toEqual([0, 0, 0]);
    const queue = (await get(`/app/api/evaluations/${evaluation.id}/grading`, teacher.headers)).json() as GradingQueue;
    expect(queue.items.every((i) => i.minPoints === 0)).toBe(true);
  });
});

describe("retakes keep the best or the last FLOORED total (ADR-025)", () => {
  async function exercise(keep: "best" | "last") {
    const { seed } = await build({
      mode: "exercise",
      settings: {
        timing: "manual",
        lobby: "skip",
        retakes: { enabled: true, keep, maxAttempts: null },
      },
    });
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    const student = students[0]!.id;
    // Attempt 1: −1 in all. Attempt 2: −5 in all. Both totals are 0.
    const first = await sit(evaluation, student, ["nope", [0], []]);
    await live.retakeAttempt(db(), {
      evaluation: await reload(db(), evaluation.id),
      participant: (await live.participantOf(db(), evaluation, student))!,
      now: server.clock.now(),
    });
    const second = await sit(await reload(db(), evaluation.id), student, ["nope", [0], [2, 3]]);
    return { evaluation, first, second };
  }

  it("keeps the latest of two attempts both worth 0 under `best`", async () => {
    const { evaluation, second } = await exercise("best");
    // Unfloored, attempt 1 (−1) would beat attempt 2 (−5); floored, they tie
    // at 0 and the tie goes to the latest.
    const view = (await get(`/app/api/evaluations/${evaluation.id}/results`, teacher.headers)).json() as ResultsView;
    const row = view.rows.find((r) => r.userId === students[0]!.id)!;
    expect(row.attemptId).toBe(second.id);
    expect([row.points, row.grade]).toEqual([0, 1]);

    const home = (await get("/app/api/student/home", students[0]!.headers)).json() as StudentHome;
    const card = [...home.open, ...home.upcoming, ...home.past].find((c) => c.id === evaluation.id)!;
    expect(card.retakes?.kept?.attemptId).toBe(second.id);
    expect(card.retakes?.kept?.score?.points).toBe(0);
  });

  it("serves a floored score between attempts", async () => {
    const { first } = await exercise("last");
    const feedback = (await get(`/app/api/attempts/${first.id}/feedback`, students[0]!.headers)).json() as StudentFeedback;
    expect(feedback.available).toBe(false);
    if (feedback.available) return;
    expect(feedback.score?.points).toBe(0);
    const rows = await db().select().from(attempts).where(eq(attempts.id, first.id));
    expect(rows).toHaveLength(1);
  });
});

describe("the setting", () => {
  const patch = (id: string, body: unknown) =>
    send("PATCH", `/app/api/evaluations/${id}`, teacher.headers, body);

  it("is set in a settings patch while nothing is frozen", async () => {
    const { seed } = await build({ negativeMarking: false });
    const on = await patch(seed.evaluationId, { settings: { negativeMarking: true } });
    expect(on.statusCode).toBe(200);
    expect((await reload(db(), seed.evaluationId)).settings).toMatchObject({ negativeMarking: true });
  });

  it("is frozen once an attempt exists", async () => {
    const { seed } = await build({});
    const evaluation = await applyState(db(), await reload(db(), seed.evaluationId), "running", server.clock.now());
    await sit(evaluation, students[0]!.id, ["nope", [0], []]);
    await close(evaluation.id);
    const off = await patch(seed.evaluationId, { settings: { negativeMarking: false } });
    expect(off.statusCode).toBe(409);
    expect(evaluationService.negativeMarkingEnabled(await reload(db(), seed.evaluationId))).toBe(true);
  });

  it("is refused on a poll, and read as off there whatever the row says", async () => {
    const { seed } = await build({ negativeMarking: false });
    await db().update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, seed.evaluationId));
    const refused = await evaluationService
      .patchEvaluation(db(), await reload(db(), seed.evaluationId), { settings: { negativeMarking: true } }, {
        attemptCount: 0,
      })
      .then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(refused).toBe("negative_marking_not_allowed");

    await db()
      .update(evaluations)
      .set({ settings: { ...(await reload(db(), seed.evaluationId)).settings as object, negativeMarking: true } })
      .where(eq(evaluations.id, seed.evaluationId));
    const row = await reload(db(), seed.evaluationId);
    expect(evaluationService.negativeMarkingEnabled(row)).toBe(false);
    expect(evaluationService.gradeDefaults(row)).toEqual({
      mcq: { policy: row.mcqPolicy, negativeMarking: false },
    });
  });
});
