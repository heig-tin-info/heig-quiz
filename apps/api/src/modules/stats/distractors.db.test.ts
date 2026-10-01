/**
 * The distractor analysis of a multiple-choice question (ADR-043): the
 * success rate's counted answers, narrowed to the versions that carry the
 * latest version's options, as whole-percent shares from ten answers on.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ParametersDraft } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import { answers, attempts, enrollments, evaluations, questions } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { seedLive, type Seeded } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { writeGrading } from "../grading/service.js";
import { typeOf } from "../pool/config.js";
import * as poolService from "../pool/service.js";
import { poolQuestionStats } from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});

afterAll(() => restore());

const BEFORE = new Date("2026-09-01T08:00:00.000Z");

type Choice = { text: string; correct: boolean };

const SINGLE: Choice[] = [
  { text: "`p + 1`", correct: true },
  { text: "`*p + 1`", correct: false },
  { text: "`&p + 1`", correct: false },
];

function mcq(choices: Choice[], o: { mode?: "single" | "multiple"; prompt?: string } = {}) {
  return {
    configVersion: 2,
    prompt: o.prompt ?? "Which expression points to the next element?",
    choices,
    mode: o.mode ?? "single",
    policy: "inherit",
    shuffleChoices: true,
  };
}

/** Publishes a new version of the question with this config (and these variables). */
async function publish(seed: Seeded, questionId: string, config: unknown, variables?: ParametersDraft) {
  const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
  const saved = await poolService.putDraft(db, question!, { config, ...(variables ? { variables } : {}) });
  expect(saved.issues).toEqual([]);
  await poolService.publishQuestion(db, question!, { userId: seed.teacherId });
}

/** An mcq question of the seed's pool, published with `config`. */
async function mcqQuestion(seed: Seeded, config: unknown, variables?: ParametersDraft) {
  const { id } = await poolService.createQuestion(db, {
    poolId: seed.poolId,
    type: "mcq",
    internalName: `mcq-${randomUUID().slice(0, 6)}`,
    createdBy: seed.teacherId,
  });
  await publish(seed, id, config, variables);
  return id;
}

/** An evaluation of the seed's classroom holding the question at its latest version. */
async function evaluationOf(seed: Seeded, questionId: string, mode: "exam" | "exercise" | "poll" = "exam") {
  const evaluation = await evaluationService.createEvaluation(db, {
    classroomId: seed.classroomId,
    title: `Eval ${randomUUID().slice(0, 4)}`,
    mode: mode === "poll" ? "exam" : mode,
    createdBy: seed.teacherId,
  });
  // A poll is not created this way; the statistics only read its mode.
  if (mode === "poll") await db.update(evaluations).set({ mode }).where(eq(evaluations.id, evaluation.id));
  const [item] = await evaluationService.addItems(
    db,
    evaluation,
    [questionId],
    // The example instance's: a parameterized question's template is no config.
    (type, version) => typeOf(type).defaultPoints(poolService.exampleConfig(type, version)),
    { attemptCount: 0 },
  );
  return { evaluationId: evaluation.id, itemId: item!.id };
}

/**
 * One finished attempt per `picks` entry, each by a student of `users`: the
 * picked choices stored as the answer, on screen (`null`: no answer row at
 * all, which only an attempt of before ADR-039 counts; `"skip"`: skipped
 * with a choice left in it; `{ raw }`: a payload stored as is), graded and
 * validated.
 */
async function sit(
  target: { evaluationId: string; itemId: string },
  users: readonly string[],
  picks: readonly (number[] | null | "skip" | { raw: unknown })[],
  o: { startedAt?: Date } = {},
) {
  for (const [i, pick] of picks.entries()) {
    const attemptId = randomUUID();
    await db.insert(attempts).values({
      id: attemptId,
      evaluationId: target.evaluationId,
      userId: users[i]!,
      seed: 1,
      state: "submitted",
      attemptNumber: 1,
      startedAt: o.startedAt ?? BEFORE,
      displayTracked: pick !== null,
    });
    if (pick !== null) {
      await db.insert(answers).values({
        id: randomUUID(),
        attemptId,
        itemId: target.itemId,
        payload: pick === "skip" ? { selected: [0] } : Array.isArray(pick) ? { selected: pick } : pick.raw,
        skipped: pick === "skip",
        firstShownAt: BEFORE,
      });
    }
    await writeGrading(db, {
      attemptId,
      itemId: target.itemId,
      answerId: null,
      points: 0,
      maxPoints: 1,
      source: "manual",
      state: "validated",
      now: BEFORE,
    });
  }
}

async function distractorsOf(seed: Seeded, questionId: string) {
  const { items } = await poolQuestionStats(db, seed.poolId);
  return items.find((i) => i.questionId === questionId)?.distractors;
}

/** Ten picks: A seven times, B twice, C once. */
const SEVEN_TWO_ONE = [[0], [0], [0], [0], [0], [0], [0], [1], [1], [2]];

describe("the distractor analysis (ADR-043)", () => {
  it("gives each option's share, the key marked, in the options' order", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);

    expect(await distractorsOf(seed, q)).toEqual({
      n: 10,
      multiple: false,
      options: [
        { text: "`p + 1`", correct: true, share: 70 },
        { text: "`*p + 1`", correct: false, share: 20 },
        { text: "`&p + 1`", correct: false, share: 10 },
      ],
      none: 0,
    });
  });

  it("is absent for another type, and null below ten matching answers", async () => {
    const seed = await seedLive(db, { students: 10, questions: 1 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    const shortItem = { evaluationId: seed.evaluationId, itemId: seed.itemIds[0]! };
    await sit(shortItem, seed.studentIds, Array.from({ length: 10 }, () => null));
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);

    const { items } = await poolQuestionStats(db, seed.poolId);
    expect(items.find((i) => i.questionId === seed.questionIds[0])).not.toHaveProperty("distractors");
    expect(items.find((i) => i.questionId === q)?.distractors).not.toBeNull();

    // The options change: the question keeps its ten answers, the analysis has none left.
    await publish(seed, q, mcq([...SINGLE, { text: "`p++`", correct: false }]));
    const after = (await poolQuestionStats(db, seed.poolId)).items.find((i) => i.questionId === q);
    expect(after).toMatchObject({ n: 10, distractors: null });
  });

  it("counts blanks, skips and answers never stored as 'no answer'", async () => {
    const seed = await seedLive(db, { students: 11, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    await sit(await evaluationOf(seed, q), seed.studentIds, [[0], [0], [0], [0], [0], [0], [1], [1], [], "skip", null]);

    const shares = await distractorsOf(seed, q);
    expect(shares?.n).toBe(11);
    expect(shares?.options.map((o) => o.share)).toEqual([55, 18, 0]);
    expect(shares?.none).toBe(27);
  });

  it("puts a payload of an older schema in one bucket at most, as the class debrief does", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    await sit(await evaluationOf(seed, q), seed.studentIds, [
      [0], [0], [0], [0], [0], [0], [0],
      // Not the current schema, yet it holds something: answered, so never "no answer" —
      // counted under the option the type recognises in it, or under none at all.
      { raw: { selected: [0, "x"] } },
      { raw: { choice: 1 } },
      [],
    ]);

    expect(await distractorsOf(seed, q)).toMatchObject({
      n: 10,
      options: [{ share: 80 }, { share: 0 }, { share: 0 }],
      none: 10,
    });
  });

  it("lets a multiple-choice question's shares add up past 100", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const choices = [
      { text: "int", correct: true },
      { text: "char", correct: true },
      { text: "string", correct: false },
    ];
    const q = await mcqQuestion(seed, mcq(choices, { mode: "multiple" }));
    await sit(await evaluationOf(seed, q), seed.studentIds, [
      [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1], [0, 1, 2], [0], [2, 2],
    ]);

    const shares = await distractorsOf(seed, q);
    expect(shares?.multiple).toBe(true);
    // A choice ticked twice in one answer counts once.
    expect(shares?.options.map((o) => o.share)).toEqual([90, 80, 20]);
  });

  it("says several choices may be ticked when any counted version allowed it", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE, { mode: "multiple" }));
    await sit(await evaluationOf(seed, q), seed.studentIds, [[0, 1], [0], [0], [0], [0], [0], [0], [0], [1], [2]]);
    // v2 is single-choice with the same options: v1's answers still count, and may hold two.
    await publish(seed, q, mcq(SINGLE));

    expect(await distractorsOf(seed, q)).toMatchObject({ n: 10, multiple: true, options: [{ share: 80 }, { share: 20 }, { share: 10 }] });
  });

  it("reads only the versions whose options are the latest's", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    // v1: everybody picks C.
    await sit(await evaluationOf(seed, q), seed.studentIds, Array.from({ length: 10 }, () => [2]));
    // v2 moves the key: other options, whatever the texts.
    const moved = SINGLE.map((c, i) => ({ ...c, correct: i === 2 }));
    await publish(seed, q, mcq(moved));
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);
    // v3 rewrites the prompt only: the same options, counted together.
    await publish(seed, q, mcq(moved, { prompt: "Rewritten prompt" }));
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);

    const shares = await distractorsOf(seed, q);
    expect(shares).toMatchObject({ n: 20 });
    expect(shares?.options.map((o) => [o.share, o.correct])).toEqual([[70, false], [20, false], [10, true]]);
  });

  it("brings the older answers back when the options are put back after a change", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);
    const edited = SINGLE.map((c) => ({ ...c, text: `${c.text} ` }));
    await publish(seed, q, mcq(edited));
    await sit(await evaluationOf(seed, q), seed.studentIds, Array.from({ length: 10 }, () => [2]));

    // v2's options differ: v1's ten answers are left out, v2's ten counted.
    expect(await distractorsOf(seed, q)).toMatchObject({ n: 10, options: [{ share: 0 }, { share: 0 }, { share: 100 }] });

    // v3 puts v1's options back: v1's answers count again, v2's no longer.
    await publish(seed, q, mcq(SINGLE));
    expect(await distractorsOf(seed, q)).toMatchObject({ n: 10, options: [{ share: 70 }, { share: 20 }, { share: 10 }] });
  });

  it("counts what the success rate counts: exams, not exercises, polls nor staff seats, since the reset", async () => {
    const seed = await seedLive(db, { students: 12, questions: 0 });
    const q = await mcqQuestion(seed, mcq(SINGLE));
    const students = seed.studentIds;
    // An exercise alone is never counted, whatever its number of answers.
    await sit(await evaluationOf(seed, q, "exercise"), students, Array.from({ length: 10 }, () => [2]));
    expect(await distractorsOf(seed, q)).toBeUndefined();
    const exam = await evaluationOf(seed, q);
    await sit(exam, students, SEVEN_TWO_ONE);
    // A poll on the question, and the teacher's own walk from a staff seat.
    await sit(await evaluationOf(seed, q, "poll"), students, Array.from({ length: 10 }, () => [2]));
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: seed.classroomId,
      nom: "Staff",
      prenom: "Teacher",
      email: `staff-${seed.classroomId.slice(0, 6)}@heig.test`,
      userId: seed.teacherId,
      staff: true,
    });
    await sit(exam, [seed.teacherId], [[2]]);

    expect(await distractorsOf(seed, q)).toMatchObject({ n: 10, options: [{ share: 70 }, { share: 20 }, { share: 10 }] });

    // After a reset, only attempts started since count: the ten above are gone.
    await poolService.resetQuestionStats(db, q, new Date("2026-09-05T08:00:00.000Z"));
    const later = new Date("2026-09-06T08:00:00.000Z");
    await sit(await evaluationOf(seed, q), students.slice(0, 10), Array.from({ length: 10 }, () => [1]), { startedAt: later });
    expect(await distractorsOf(seed, q)).toMatchObject({ n: 10, options: [{ share: 0 }, { share: 100 }, { share: 0 }] });
  });
  it("groups a parameterized mcq's options by their template, and says which show a value drawn for them alone", async () => {
    const seed = await seedLive(db, { students: 10, questions: 0 });
    const choices = [
      { text: "[[t]] s", correct: true },
      // A formula of the statement's values: one mistake for every student.
      { text: "[[sqrt(h/g)]] s", correct: false },
      // A number drawn for this option alone: noise, a different one each time.
      { text: "[[d]] s", correct: false },
    ];
    const variables: ParametersDraft = {
      rows: [
        { name: "h", expr: "randint(10, 100)", format: "int" },
        { name: "g", expr: "choice([3.71, 9.81, 24.79])", format: ".2" },
        { name: "t", expr: "sqrt(2*h/g)", format: ".2" },
        { name: "d", expr: "uniform(20, 30)", format: ".1" },
      ],
    };
    const q = await mcqQuestion(seed, mcq(choices, { prompt: "Dropped from [[h]] m where g = [[g]]: how long?" }), variables);
    await sit(await evaluationOf(seed, q), seed.studentIds, SEVEN_TWO_ONE);

    expect(await distractorsOf(seed, q)).toEqual({
      n: 10,
      multiple: false,
      options: [
        { text: "[[t]] s", correct: true, share: 70 },
        { text: "[[sqrt(h/g)]] s", correct: false, share: 20 },
        { text: "[[d]] s", correct: false, share: 10, drawn: true },
      ],
      none: 0,
    });
  });
});
