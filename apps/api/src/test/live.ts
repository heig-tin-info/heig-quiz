/**
 * The fixture of the WP5 tests: a course, a classroom, a roster, a pool with
 * published questions, and an evaluation whose items are frozen on them.
 *
 * Everything goes through the REAL paths (`pool/service.ts` publishes,
 * `evaluation/service.ts` adds the items), so a test never asserts against a
 * hand-built row that the production code would have written differently.
 * The question type is the fake of `./fakeType.ts`, registered through
 * `registerForTests`: the tests own its behaviour completely.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import type { EvaluationMode, EvaluationSettings } from "@quiz/contracts";

import type { Db } from "../db/client.js";
import {
  classrooms,
  coursePools,
  courseStaff,
  courses,
  enrollments,
  evaluations,
  pools,
  questions,
  users,
} from "../db/schema.js";
import * as evaluationService from "../modules/evaluation/service.js";
import { loadConfig, typeOf } from "../modules/pool/config.js";
import * as poolService from "../modules/pool/service.js";

interface SeedOptions {
  teacherId?: string;
  /** Existing user ids to enrol; otherwise `students` accounts are created. */
  studentIds?: string[];
  students?: number;
  questions?: number;
  mode?: EvaluationMode;
  settings?: Partial<EvaluationSettings>;
  durationS?: number | null;
  opensAt?: Date | null;
  closesAt?: Date | null;
  /** Accommodation of the FIRST student, in percent (F-ORG-07). */
  timeBonusPercent?: number;
}

export interface Seeded {
  courseId: string;
  classroomId: string;
  poolId: string;
  teacherId: string;
  studentIds: string[];
  evaluationId: string;
  questionIds: string[];
  itemIds: string[];
}

async function makeUser(db: Db, role: "teacher" | "student"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    oidcSub: `test-${id}`,
    email: `${role}-${id.slice(0, 8)}@heig.test`,
    givenName: "Test",
    familyName: role,
    role,
  });
  return id;
}

/** One published question of the fake `short` type, with a known answer. */
async function publishQuestion(
  db: Db,
  poolId: string,
  ownerId: string,
  name: string,
): Promise<string> {
  const id = await poolService.createQuestion(db, {
    poolId,
    type: "short",
    internalName: name,
    createdBy: ownerId,
  });
  const [question] = await db.select().from(questions).where(eq(questions.id, id));
  await poolService.putDraft(db, question!, {
    config: { statement: `Statement of ${name}`, answer: `answer-${name}` },
  });
  await poolService.publishQuestion(db, question!, { userId: ownerId });
  return id;
}

export async function seedLive(db: Db, options: SeedOptions = {}): Promise<Seeded> {
  const teacherId = options.teacherId ?? (await makeUser(db, "teacher"));
  const studentIds =
    options.studentIds ??
    (await Promise.all(
      Array.from({ length: options.students ?? 2 }, () => makeUser(db, "student")),
    ));

  const courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: `PRG-${courseId.slice(0, 6)}` });
  await db.insert(courseStaff).values({ courseId, userId: teacherId });

  const classroomId = randomUUID();
  await db.insert(classrooms).values({ id: classroomId, courseId, name: "A", period: "2026-A" });

  for (const [index, userId] of studentIds.entries()) {
    await db.insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom: `Nom${index}`,
      prenom: `Prenom${index}`,
      email: `student-${index}-${classroomId.slice(0, 6)}@heig.test`,
      status: "claimed",
      userId,
      claimedAt: new Date(),
      timeBonusPercent: index === 0 ? (options.timeBonusPercent ?? 0) : 0,
    });
  }

  const poolId = randomUUID();
  await db.insert(pools).values({ id: poolId, name: "Pool", ownerId: teacherId });
  await db.insert(coursePools).values({ courseId, poolId });

  const questionIds: string[] = [];
  for (let i = 0; i < (options.questions ?? 2); i++) {
    questionIds.push(await publishQuestion(db, poolId, teacherId, `q${i}`));
  }

  const evaluation = await evaluationService.createEvaluation(db, {
    classroomId,
    title: "Test évaluation",
    mode: options.mode ?? "exam",
    createdBy: teacherId,
  });
  await db
    .update(evaluations)
    .set({
      settings: { ...evaluationService.settingsOf(evaluation), ...(options.settings ?? {}) },
      durationS: options.durationS === undefined ? 1800 : options.durationS,
      opensAt: options.opensAt ?? null,
      closesAt: options.closesAt ?? null,
    })
    .where(eq(evaluations.id, evaluation.id));
  const stored = (await evaluationService.byId(db, evaluation.id))!;

  const items =
    questionIds.length === 0
      ? []
      : await evaluationService.addItems(
          db,
          stored,
          questionIds,
          (type, version) =>
            typeOf(type).defaultPoints(
              loadConfig(type, { config: version.config, configVersion: version.configVersion }),
            ),
          { attemptCount: 0 },
        );

  return {
    courseId,
    classroomId,
    poolId,
    teacherId,
    studentIds,
    evaluationId: evaluation.id,
    questionIds,
    itemIds: items.map((i) => i.id),
  };
}

/** Reloads the evaluation row; every service call takes the fresh one. */
export async function reload(db: Db, evaluationId: string) {
  return (await evaluationService.byId(db, evaluationId))!;
}
