/**
 * ADR-097 (audit H2): a student names a choice by the position it was shown
 * at, never by its canonical index — the index the teacher typed it at, which
 * the editor's default (the first choice ticked) makes the key's.
 *
 * One `mcq` and one `cloze` dropdown, each with its key at canonical index 0
 * — the editor's bias — under an attempt seed that shows neither key first.
 * Over HTTP, as the student: the load, the reload, an answer, a stale save,
 * a position the view does not have, the feedback with the key hidden and
 * with it shown. Every response names choices in the attempt's view; the
 * database holds the canonical answer; nothing a student receives pairs a
 * choice with its canonical index. Then the round trip of a partial retake's
 * carried-over answer, re-read under the new attempt's seed (ADR-091).
 *
 * The poll (forced unshuffled) is pinned in `poll.db.test.ts`, the drill's
 * answer and reveal in `drill.db.test.ts`, the preview's grading in
 * `preview.db.test.ts`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FeedbackPolicy, type EvaluationSettings } from "@quiz/contracts";
import { shuffle, streamSeed } from "@quiz/core/rng";

import { answers, attempts, evaluations } from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { enterStarted, publishQuestion, reload, seedLive } from "../../test/live.js";
import { addItems, byId, joinedItem, type EvaluationRecord } from "../evaluation/service.js";
import { loadConfig, typeOf } from "../pool/config.js";
import * as live from "./service.js";

const KEY = "Paris";
const LABELS = [KEY, "Lyon", "Marseille", "Nice"];
const MCQ = {
  configVersion: 2,
  prompt: "Which one is the capital of France?",
  choices: LABELS.map((text, index) => ({ text, correct: index === 0 })),
  mode: "single",
  policy: "inherit",
  shuffleChoices: true,
};
const CLOZE_TEXT = `The capital of France is {{=${LABELS.join("|")}}}.`;
const CLOZE = { configVersion: 2, text: CLOZE_TEXT, caseSensitive: false, shuffleOptions: true };

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let student: { id: string; headers: Record<string, string> };

const get = (url: string, headers: Record<string, string>) => server.app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload?: Payload) =>
  server.app.inject({ method: "POST", url, headers, ...(payload === undefined ? {} : { payload }) });
const put = (url: string, headers: Record<string, string>, payload: Payload) =>
  server.app.inject({ method: "PUT", url, headers, payload });

/**
 * The labels of the mcq and of the dropdown in the order `seed` shows them:
 * the streams of decision D19, recomputed here rather than asked of the code
 * under test.
 */
function shownOrder(seed: number, mcqItem: string, clozeItem: string) {
  const mcq = shuffle(LABELS, streamSeed(seed, mcqItem, "choices"));
  const cloze = shuffle(LABELS, streamSeed(seed, clozeItem, "options:0"));
  return { mcq, cloze };
}

/** A seed under which neither key is shown first, nor at the same place as under `avoid`. */
function seedHidingTheKey(mcqItem: string, clozeItem: string, avoid?: number): number {
  for (let seed = 1; ; seed++) {
    const { mcq, cloze } = shownOrder(seed, mcqItem, clozeItem);
    const before = avoid === undefined ? null : shownOrder(avoid, mcqItem, clozeItem);
    if (mcq[0] === KEY || cloze[0] === KEY) continue;
    if (before && (before.mcq.indexOf(KEY) === mcq.indexOf(KEY) || before.cloze.indexOf(KEY) === cloze.indexOf(KEY))) {
      continue;
    }
    return seed;
  }
}

/** An evaluation of the mcq and the cloze above; `settings` on top of the seed's. */
async function evaluationOf(settings: Partial<EvaluationSettings> | undefined, mode: "exam" | "exercise") {
  const db = server.app.db;
  const seed = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    questions: 0,
    mode,
    // A timed exam; an exercise on a manual clock (its settings say so).
    durationS: mode === "exam" ? 1800 : null,
    ...(settings ? { settings } : {}),
  });
  const mcqQuestion = await publishQuestion(db, seed.poolId, teacher.id, "mcq", { type: "mcq", config: MCQ });
  const clozeQuestion = await publishQuestion(db, seed.poolId, teacher.id, "cloze", { type: "cloze", config: CLOZE });
  const [mcq, cloze] = await addItems(
    db,
    (await byId(db, seed.evaluationId))!,
    [mcqQuestion, clozeQuestion],
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  return { seed, mcq: mcq!.id, cloze: cloze!.id };
}

type Choice = { id: number; text?: string; label?: string };
interface ItemView {
  id: string;
  student: { choices?: Choice[]; blanks?: { options?: Choice[] }[] };
  answer: unknown;
}

const choicesOf = (item: ItemView): Choice[] => item.student.choices ?? item.student.blanks?.[0]?.options ?? [];
const labelsOf = (item: ItemView) => choicesOf(item).map((c) => c.text ?? c.label);
const idsOf = (item: ItemView) => choicesOf(item).map((c) => c.id);
const keyPositionOf = (item: ItemView) => choicesOf(item).find((c) => (c.text ?? c.label) === KEY)!.id;

/**
 * What a response must never say: the canonical key index (0) as a choice
 * the student ticked or picked, or the key itself by name.
 */
function expectNoCanonicalKey(body: string): void {
  expect(body).not.toContain('"selected":[0]');
  expect(body).not.toContain('"blanks":["0"]');
  expect(body).not.toContain('"given":"0"');
  // As a key: `"verdict":"correct"` is the student's own verdict, no key.
  expect(body).not.toContain('"correct":');
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});
afterAll(async () => {
  await server.close();
});

describe("a student exchanges choices by displayed position (ADR-097)", () => {
  let built: Awaited<ReturnType<typeof evaluationOf>>;
  let attemptId: string;
  let order: ReturnType<typeof shownOrder>;
  const items = new Map<string, ItemView>();

  beforeAll(async () => {
    built = await evaluationOf(undefined, "exam");
    await post(`/app/api/evaluations/${built.seed.evaluationId}/start`, teacher.headers, { confirm: true });
    const entered = await post(`/app/api/evaluations/${built.seed.evaluationId}/attempt/start`, student.headers, {});
    expect(entered.statusCode).toBe(200);
    attemptId = entered.json().view.attempt.id as string;
    // A seed of our choosing, so the key is never shown first: the view is
    // derived from the seed alone on every read (D19).
    const seed = seedHidingTheKey(built.mcq, built.cloze);
    await server.app.db.update(attempts).set({ seed }).where(eq(attempts.id, attemptId));
    order = shownOrder(seed, built.mcq, built.cloze);
  });

  const viewItems = async () => {
    const res = await get(`/app/api/attempts/${attemptId}`, student.headers);
    expect(res.statusCode).toBe(200);
    const view = res.json().view as { items: ItemView[] };
    for (const item of view.items) items.set(item.id, item);
    return res.body;
  };

  it("serves each choice by its position, in the attempt's order", async () => {
    await viewItems();
    for (const [itemId, labels] of [
      [built.mcq, order.mcq],
      [built.cloze, order.cloze],
    ] as const) {
      const item = items.get(itemId)!;
      expect(labelsOf(item)).toEqual(labels);
      expect(idsOf(item)).toEqual([0, 1, 2, 3]);
      expect(keyPositionOf(item)).not.toBe(0);
    }
  });

  it("stores the canonical answer, and hands the position back on a reload", async () => {
    const mcqKey = keyPositionOf(items.get(built.mcq)!);
    const clozeKey = keyPositionOf(items.get(built.cloze)!);
    for (const [itemId, payload] of [
      [built.mcq, { selected: [mcqKey] }],
      [built.cloze, { blanks: [String(clozeKey)] }],
    ] as const) {
      const saved = await put(`/app/api/attempts/${attemptId}/answers/${itemId}`, student.headers, {
        payload,
        revision: 1,
        clientTs: server.clock.now().toISOString(),
        coordinates: "position",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().accepted).toBe(true);
    }
    const stored = await server.app.db.select().from(answers).where(eq(answers.attemptId, attemptId));
    const payloadOf = (itemId: string) => stored.find((a) => a.itemId === itemId)!.payload;
    expect(payloadOf(built.mcq)).toEqual({ selected: [0] });
    expect(payloadOf(built.cloze)).toEqual({ blanks: ["0"] });

    const body = await viewItems();
    expect(items.get(built.mcq)!.answer).toEqual({ selected: [mcqKey] });
    expect(items.get(built.cloze)!.answer).toEqual({ blanks: [String(clozeKey)] });
    expectNoCanonicalKey(body);
  });

  it("hands the stored answer back in the student's coordinates when a save is stale", async () => {
    const mcqKey = keyPositionOf(items.get(built.mcq)!);
    const stale = await put(`/app/api/attempts/${attemptId}/answers/${built.mcq}`, student.headers, {
      payload: { selected: [(mcqKey + 1) % 4] },
      revision: 1,
      clientTs: server.clock.now().toISOString(),
      coordinates: "position",
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json()).toMatchObject({ accepted: false, payload: { selected: [mcqKey] } });
    expectNoCanonicalKey(stale.body);
  });

  it("refuses a position the view does not have, and keeps the stored answer", async () => {
    for (const [itemId, payload] of [
      [built.mcq, { selected: [4] }],
      [built.cloze, { blanks: ["4"] }],
      [built.cloze, { blanks: ["Paris"] }],
    ] as const) {
      const refused = await put(`/app/api/attempts/${attemptId}/answers/${itemId}`, student.headers, {
        payload,
        revision: 2,
        clientTs: server.clock.now().toISOString(),
        coordinates: "position",
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error).toBe("answer_invalid");
    }
    const stored = await server.app.db.select().from(answers).where(eq(answers.attemptId, attemptId));
    expect(stored.find((a) => a.itemId === built.mcq)!.payload).toEqual({ selected: [0] });
  });

  /*
   * The marker of ADR-097: a client built before it named choices by
   * canonical index. On a shuffled view the two readings differ, so its write
   * is refused — "not saved" until the tab reloads, never a wrong tick.
   */
  it("refuses a write without the coordinates marker on a shuffled item", async () => {
    const refused = await put(`/app/api/attempts/${attemptId}/answers/${built.mcq}`, student.headers, {
      payload: { selected: [0] },
      revision: 3,
      clientTs: server.clock.now().toISOString(),
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "answer_invalid", details: [{ message: "answer.coordinates_missing" }] });
    const stored = await server.app.db.select().from(answers).where(eq(answers.attemptId, attemptId));
    expect(stored.find((a) => a.itemId === built.mcq)!.revision).toBe(1);
  });

  it("keeps the feedback in the attempt's coordinates while the key is hidden", async () => {
    await post(`/app/api/evaluations/${built.seed.evaluationId}/close`, teacher.headers);
    await post(`/app/api/evaluations/${built.seed.evaluationId}/release`, teacher.headers, { confirm: true });
    await server.app.db
      .update(evaluations)
      .set({ feedbackPolicy: FeedbackPolicy.parse({ showKey: false, showAnswer: true }) })
      .where(eq(evaluations.id, built.seed.evaluationId));
    const res = await get(`/app/api/attempts/${attemptId}/feedback`, student.headers);
    expect(res.statusCode).toBe(200);
    const feedback = res.json() as {
      items: (ItemView & { itemId: string; verdict: string; details: Record<string, unknown> })[];
    };
    const mcq = feedback.items.find((i) => i.itemId === built.mcq)!;
    const cloze = feedback.items.find((i) => i.itemId === built.cloze)!;
    expect(labelsOf(mcq)).toEqual(order.mcq);
    expect(labelsOf(cloze)).toEqual(order.cloze);
    expect(mcq.verdict).toBe("correct");
    expect(mcq.answer).toEqual({ selected: [keyPositionOf(mcq)] });
    expect(cloze.answer).toEqual({ blanks: [String(keyPositionOf(cloze))] });
    expectNoCanonicalKey(res.body);
  });

  it("shows the teacher's order once the key is published, where position and index are one", async () => {
    await server.app.db
      .update(evaluations)
      .set({ feedbackPolicy: FeedbackPolicy.parse({ showKey: true, showAnswer: true }) })
      .where(eq(evaluations.id, built.seed.evaluationId));
    const res = await get(`/app/api/attempts/${attemptId}/feedback`, student.headers);
    const feedback = res.json() as { items: (ItemView & { itemId: string; solution: unknown })[] };
    const mcq = feedback.items.find((i) => i.itemId === built.mcq)!;
    expect(labelsOf(mcq)).toEqual(LABELS);
    expect(mcq.answer).toEqual({ selected: [0] });
    expect(mcq.solution).toEqual({ correct: [0] });
  });
});

describe("a partial retake's carried-over answer (ADR-091, ADR-097)", () => {
  it("is re-read in the new attempt's view", async () => {
    const db = server.app.db;
    const built = await evaluationOf(
      {
        timing: "manual",
        lobby: "skip",
        retakes: { enabled: true, keep: "best", maxAttempts: null, scope: "to_review" },
      },
      "exercise",
    );
    let evaluation: EvaluationRecord = await live.startEvaluation(
      db,
      await reload(db, built.seed.evaluationId),
      server.clock.now(),
    );
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    const { attempt: first } = await enterStarted(db, { evaluation, participant, now: server.clock.now() });
    const firstSeed = seedHidingTheKey(built.mcq, built.cloze);
    await db.update(attempts).set({ seed: firstSeed }).where(eq(attempts.id, first.id));
    const firstAttempt = (await live.attemptById(db, first.id))!;

    // The key of the mcq (acquired), a wrong option of the cloze (to review),
    // each sent as the position the first attempt shows it at.
    const shownFirst = shownOrder(firstSeed, built.mcq, built.cloze);
    for (const [itemId, payload] of [
      [built.mcq, { selected: [shownFirst.mcq.indexOf(KEY)] }],
      [built.cloze, { blanks: [String(shownFirst.cloze.indexOf("Nice"))] }],
    ] as const) {
      await live.saveAnswer(db, {
        evaluation,
        attempt: firstAttempt,
        itemId,
        payload,
        revision: 1,
        coordinates: "position",
        now: server.clock.now(),
      });
    }
    const submitted = await live.submitAttempt(db, evaluation, firstAttempt, server.clock.now());
    await live.gradeAtHandIn(server.app, evaluation, [submitted.id]);
    server.clock.advance(1000);

    evaluation = await reload(db, built.seed.evaluationId);
    const second = await live.retakeAttempt(db, { evaluation, participant, scope: "to_review", now: server.clock.now() });
    expect(second.acquiredItemIds).toEqual([built.mcq]);
    const secondSeed = seedHidingTheKey(built.mcq, built.cloze, firstSeed);
    await db.update(attempts).set({ seed: secondSeed }).where(eq(attempts.id, second.id));

    // Copied canonical, read back in the NEW order.
    const [copied] = await db
      .select()
      .from(answers)
      .where(and(eq(answers.attemptId, second.id), eq(answers.itemId, built.mcq)));
    expect(copied!.payload).toEqual({ selected: [0] });
    const view = await live.attemptView(db, evaluation, (await live.attemptById(db, second.id))!, server.clock.now());
    const mcq = view.items.find((i) => i.id === built.mcq)! as unknown as ItemView & { acquired: boolean };
    expect(mcq.acquired).toBe(true);
    expect(labelsOf(mcq)).toEqual(shownOrder(secondSeed, built.mcq, built.cloze).mcq);
    expect(mcq.answer).toEqual({ selected: [keyPositionOf(mcq)] });
    expect(keyPositionOf(mcq)).not.toBe(shownFirst.mcq.indexOf(KEY));
  });
});

describe("an mcq capped by maxSelections (ADR-097)", () => {
  /*
   * The grader keeps the LOWEST canonical indices of an answer too long — the
   * teacher's first-typed choices, the key under the editor's default. With
   * position ids, ticking every position would let it pick the key: refused.
   */
  it("refuses an answer ticking every position", async () => {
    const db = server.app.db;
    const seed = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const questionId = await publishQuestion(db, seed.poolId, teacher.id, "capped", {
      type: "mcq",
      config: { ...MCQ, mode: "multiple", maxSelections: 1 },
    });
    const [item] = await addItems(db, (await byId(db, seed.evaluationId))!, [questionId], () => 1, { attemptCount: 0 });
    const evaluation = await live.startEvaluation(db, await reload(db, seed.evaluationId), server.clock.now());
    const participant = (await live.participantOf(db, evaluation, student.id))!;
    const { attempt } = await enterStarted(db, { evaluation, participant, now: server.clock.now() });
    const write = (selected: number[], revision: number) =>
      live.saveAnswer(db, {
        evaluation,
        attempt,
        itemId: item!.id,
        payload: { selected },
        revision,
        coordinates: "position",
        now: server.clock.now(),
      });
    await expect(write([0, 1, 2, 3], 1)).rejects.toBeInstanceOf(live.AnswerInvalid);
    await expect(write([3], 2)).resolves.toMatchObject({ accepted: true });
  });
});

describe("the one view of an item (ADR-097)", () => {
  it("never shuffles a poll, whatever its settings say, and reads the frozen config", async () => {
    const db = server.app.db;
    const built = await evaluationOf({ shuffleChoices: true }, "exam");
    const entry = (await joinedItem(db, built.seed.evaluationId, built.mcq))!;
    const exam = (await byId(db, built.seed.evaluationId))!;
    const attempt = { seed: 7, instances: {} };
    expect(live.attemptItemView(exam, entry, attempt).view.shuffle).toBe(true);
    expect(live.attemptItemView({ ...exam, mode: "poll" }, entry, attempt).view.shuffle).toBe(false);
    const off = { ...exam, settings: { ...(exam.settings as object), shuffleChoices: false } };
    expect(live.attemptItemView(off, entry, attempt).view.shuffle).toBe(false);
    // The live column a teacher may patch is not read on the student path.
    expect(live.attemptItemView(exam, { ...entry, question: { ...entry.question, shuffleable: false } }, attempt).view.shuffle).toBe(
      true,
    );
  });
});
