/**
 * The pool's "Tags" tab (`poolTagUsage`): per tag, the live questions that
 * wear it and the DISTINCT courses that use one of them — through an exam or
 * an exercise of a classroom, or through a template of the course. A poll,
 * a deleted question and a course using another tag do not count.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { EvaluationMode } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "../../db/client.js";
import {
  classrooms,
  coursePools,
  courses,
  evaluations,
  poolTags,
  questionTags,
  questions,
} from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { fakeShort } from "../../test/fakeType.js";
import { publishQuestion, seedLive } from "../../test/live.js";
import * as evaluationService from "../evaluation/service.js";
import { loadConfig, typeOf } from "./config.js";
import * as service from "./service.js";

let db: Db;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
});

afterAll(() => restore());

/** A course linked to `poolId`, with one classroom. */
async function course(poolId: string) {
  const courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Other", code: `C-${courseId.slice(0, 6)}` });
  await db.insert(coursePools).values({ courseId, poolId });
  const classroomId = randomUUID();
  await db.insert(classrooms).values({ id: classroomId, courseId, name: "B", period: "2026-B" });
  return { courseId, classroomId };
}

/** An evaluation (a classroom's) or a template (a course's) on `questionIds`. */
async function using(
  home: { classroomId: string } | { courseId: string },
  createdBy: string,
  questionIds: string[],
  mode: EvaluationMode = "exam",
) {
  const evaluation = await evaluationService.createEvaluation(db, {
    ...home,
    title: `On ${randomUUID().slice(0, 4)}`,
    mode: "exam",
    createdBy,
  });
  await evaluationService.addItems(
    db,
    evaluation,
    questionIds,
    (type, version) => typeOf(type).defaultPoints(loadConfig(type, version)),
    { attemptCount: 0 },
  );
  if (mode !== "exam") {
    await db.update(evaluations).set({ mode }).where(eq(evaluations.id, evaluation.id));
  }
}

async function tag(poolId: string, questionId: string, ...tags: string[]) {
  await db.insert(questionTags).values(tags.map((t) => ({ questionId, tag: t })));
  await db
    .insert(poolTags)
    .values(tags.map((t) => ({ poolId, tag: t })))
    .onConflictDoNothing();
}

describe("the tag usage of a pool", () => {
  it("counts questions and distinct courses, through evaluations and templates", async () => {
    const seed = await seedLive(db, { students: 0, questions: 0 });
    const [a, b, polled, gone] = await Promise.all(
      ["a", "b", "polled", "gone"].map((n) => publishQuestion(db, seed.poolId, seed.teacherId, n)),
    );
    await tag(seed.poolId, a!, "alpha", "beta");
    await tag(seed.poolId, b!, "alpha");
    await tag(seed.poolId, polled!, "gamma");
    await tag(seed.poolId, gone!, "alpha", "delta");
    await db
      .insert(poolTags)
      .values({ poolId: seed.poolId, tag: "unused", description: "Nobody wears it" });

    // Course A (the seed's): two exams of its classroom, on a and on b.
    await using({ classroomId: seed.classroomId }, seed.teacherId, [a!]);
    await using({ classroomId: seed.classroomId }, seed.teacherId, [b!], "exercise");
    // Course B: a template on a.
    const other = await course(seed.poolId);
    await using({ courseId: other.courseId }, seed.teacherId, [a!]);
    // Course C: a poll on `polled`, an exam on `gone` that is deleted later.
    const third = await course(seed.poolId);
    await using({ classroomId: third.classroomId }, seed.teacherId, [polled!], "poll");
    await using({ classroomId: third.classroomId }, seed.teacherId, [gone!]);
    await db.update(questions).set({ deletedAt: new Date() }).where(eq(questions.id, gone!));

    expect(await service.poolTagUsage(db, seed.poolId)).toEqual([
      { tag: "alpha", description: "", questions: 2, courses: 2 },
      { tag: "beta", description: "", questions: 1, courses: 2 },
      { tag: "delta", description: "", questions: 0, courses: 0 },
      { tag: "gamma", description: "", questions: 1, courses: 0 },
      { tag: "unused", description: "Nobody wears it", questions: 0, courses: 0 },
    ]);
  });

  it("counts a question once across its versions", async () => {
    const seed = await seedLive(db, { students: 0, questions: 1 });
    const questionId = seed.questionIds[0]!;
    await tag(seed.poolId, questionId, "solo");
    const [question] = await db.select().from(questions).where(eq(questions.id, questionId));
    await service.putDraft(db, question!, { config: { statement: "v2", answer: "v2" } });
    await service.publishQuestion(db, question!, { userId: seed.teacherId });
    await using({ classroomId: seed.classroomId }, seed.teacherId, [questionId]);

    expect(await service.poolTagUsage(db, seed.poolId)).toEqual([
      { tag: "solo", description: "", questions: 1, courses: 1 },
    ]);
  });

  it("answers an empty list for a pool without tags", async () => {
    const seed = await seedLive(db, { students: 0, questions: 1 });
    expect(await service.poolTagUsage(db, seed.poolId)).toEqual([]);
  });
});
