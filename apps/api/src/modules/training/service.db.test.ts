/**
 * The training course's services (ADR-105): the install of the content into
 * the one public pool (§2) and the provisioning of a teacher's course (§1),
 * both idempotent, through the ordinary services.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import {
  auditLog,
  categories,
  classrooms,
  coursePools,
  courseStaff,
  courses,
  evaluationItems,
  evaluations,
  pools,
  questionVersions,
  questions,
  users,
} from "../../db/schema.js";
import { TRAINING_MCQ, TRAINING_SHORT, trainingFixture } from "../../test/training.js";
import { testApp } from "../../test/db.js";
import { deleteEvaluation, feedbackOf, patchEvaluation, settingsOf } from "../evaluation/service.js";
import { install, provision, status, TrainingNotInstalled } from "./service.js";

const ADMIN_EMAIL = "admin@heig.test";
const NOW = new Date("2026-10-11T10:00:00.000Z");
const config = { SUPER_ADMIN_EMAIL: ADMIN_EMAIL };

let db: Db;
let adminId: string;

async function makeUser(role: "admin" | "teacher", email = `${role}-${randomUUID().slice(0, 8)}@heig.test`): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `test-${id}`, email, givenName: "Test", familyName: role, role });
  return id;
}

const actorOf = (userId: string) => ({ actorUserId: userId, actorType: "user" as const });

async function publishedVersions(internalName: string): Promise<number> {
  const [q] = await db.select({ id: questions.id }).from(questions).where(eq(questions.internalName, internalName));
  const rows = await db
    .select({ id: questionVersions.id })
    .from(questionVersions)
    .where(and(eq(questionVersions.questionId, q!.id), isNotNull(questionVersions.number)));
  return rows.length;
}

const auditRows = (action: "training.install" | "training.provision") =>
  db.select().from(auditLog).where(eq(auditLog.action, action));

beforeAll(async () => {
  const app = await testApp();
  db = app.db;
  adminId = await makeUser("admin", ADMIN_EMAIL);
});

describe("provision before the install (§1)", () => {
  it("refuses with training_not_installed", async () => {
    const teacherId = await makeUser("teacher");
    await expect(provision(db, { userId: teacherId, lang: "fr", now: NOW, actor: actorOf(teacherId) })).rejects.toBeInstanceOf(
      TrainingNotInstalled,
    );
    expect(await status(db, { userId: teacherId, llmEnabled: false })).toEqual({
      installed: false,
      course: null,
      missions: [
        { key: "student", state: "todo" },
        { key: "run", state: "todo" },
        { key: "own", state: "todo" },
        { key: "tools", state: "todo" },
      ],
    });
  });

  it("the install needs the super admin's account", async () => {
    await expect(install(db, { SUPER_ADMIN_EMAIL: "nobody@heig.test" }, NOW, trainingFixture())).rejects.toThrow(/SUPER_ADMIN_EMAIL/);
    expect(await db.select().from(pools).where(eq(pools.isTraining, true))).toEqual([]);
  });
});

describe("training.install (§2)", () => {
  it("creates the public pool of the super admin and publishes every question", async () => {
    const result = await install(db, config, NOW, trainingFixture());
    expect(result.questions).toEqual({ created: 2, updated: 0, unchanged: 0 });

    const [pool] = await db.select().from(pools).where(eq(pools.id, result.poolId));
    expect(pool).toMatchObject({ isTraining: true, isPublic: true, ownerId: adminId, name: "Prise en main (test)", icon: "graduation-cap" });
    expect(pool!.description).toBe("Le contenu d'initiation des tests.");
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await publishedVersions(TRAINING_SHORT.internalName)).toBe(1);
    const folders = await db.select({ name: categories.name }).from(categories).where(eq(categories.poolId, pool!.id));
    expect(folders.map((f) => f.name).sort()).toEqual(["Le cours", "Le quiz"]);
    const [mcq] = await db.select().from(questions).where(eq(questions.internalName, TRAINING_MCQ.internalName));
    expect(mcq).toMatchObject({ poolId: pool!.id, type: "mcq", difficulty: 1, createdBy: adminId });
    expect(await auditRows("training.install")).toHaveLength(1);
  });

  it("a second run leaves everything alone", async () => {
    const result = await install(db, config, NOW, trainingFixture());
    expect(result.questions).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await db.select().from(pools).where(eq(pools.isTraining, true))).toHaveLength(1);
    // Nothing changed: nothing traced.
    expect(await auditRows("training.install")).toHaveLength(1);
  });

  it("a changed config publishes a new version of that question only", async () => {
    const changed = { ...TRAINING_SHORT, config: { ...(TRAINING_SHORT.config as object), placeholder: "quatre lettres" } };
    const result = await install(db, config, NOW, trainingFixture([TRAINING_MCQ, changed]));
    expect(result.questions).toEqual({ created: 0, updated: 1, unchanged: 1 });
    expect(await publishedVersions(TRAINING_SHORT.internalName)).toBe(2);
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await auditRows("training.install")).toHaveLength(2);
  });

  it("a changed explanation publishes a new version too", async () => {
    const changed = { ...TRAINING_MCQ, explanation: "Autre explication." };
    const result = await install(db, config, NOW, trainingFixture([changed, TRAINING_SHORT]));
    // The short question is back to the fixture's config: a new version of it as well.
    expect(result.questions).toEqual({ created: 0, updated: 2, unchanged: 0 });
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(2);
    // Back to the fixture: unchanged from now on.
    await install(db, config, NOW, trainingFixture());
    expect((await install(db, config, NOW, trainingFixture())).questions).toEqual({ created: 0, updated: 0, unchanged: 2 });
  });

  it("a config the type refuses names the question", async () => {
    const broken = { ...TRAINING_MCQ, internalName: "init-broken", config: { configVersion: 2, prompt: "", choices: [] } };
    await expect(install(db, config, NOW, trainingFixture([broken]))).rejects.toThrow(/init-broken/);
  });
});

describe("provision (§1)", () => {
  let teacherId: string;

  beforeAll(async () => {
    teacherId = await makeUser("teacher");
  });

  it("creates the course, its classroom, the read link and the two evaluations — nothing else", async () => {
    const result = await provision(db, { userId: teacherId, lang: "fr", now: NOW, actor: actorOf(teacherId), content: trainingFixture() });
    expect(result.created).toBe(true);

    const [course] = await db.select().from(courses).where(eq(courses.id, result.courseId));
    expect(course).toMatchObject({ name: "Prise en main de Quiz", code: "INIT-1", trainingFor: teacherId });
    expect(await db.select().from(courseStaff).where(eq(courseStaff.courseId, course!.id))).toMatchObject([{ userId: teacherId, role: "owner" }]);

    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, result.classroomId));
    expect(room).toMatchObject({ courseId: course!.id, name: "Initiation", period: "Automne 2026", periodStart: "2026-09", periodEnd: "2027-01" });
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id))).toHaveLength(1);

    const [pool] = await db.select().from(pools).where(eq(pools.isTraining, true));
    expect(await db.select().from(coursePools).where(eq(coursePools.courseId, course!.id))).toMatchObject([{ poolId: pool!.id, mode: "read" }]);

    const rows = await db.select().from(evaluations).where(eq(evaluations.classroomId, room!.id));
    const welcome = rows.find((r) => r.title === "Le quiz d'accueil")!;
    const liveQuiz = rows.find((r) => r.title === "Le quiz en direct")!;
    expect(rows).toHaveLength(2);
    // The welcome quiz: an exercise, Scheduled (ADR-086), open now, closed by the ticker at the period's end, retakes allowed.
    expect(welcome).toMatchObject({ mode: "exercise", state: "running", createdBy: teacherId });
    expect(welcome.opensAt?.toISOString()).toBe(NOW.toISOString());
    expect(welcome.closesAt?.toISOString()).toBe("2027-01-31T23:59:59.000Z");
    expect(settingsOf(welcome)).toMatchObject({ timing: "deadline", lobby: "skip", navigation: "free", retakes: { enabled: true, keep: "best", maxAttempts: null } });
    expect(settingsOf(welcome).allowDrill).toBeUndefined();
    expect(feedbackOf(welcome)).toMatchObject({ when: "immediate", showKey: true, showExplanation: true });
    expect(await db.select().from(evaluationItems).where(eq(evaluationItems.evaluationId, welcome.id))).toHaveLength(2);
    // The live quiz: a draft, Live mode (the exam preset's clock).
    expect(liveQuiz).toMatchObject({ mode: "exam", state: "draft" });
    expect(settingsOf(liveQuiz)).toMatchObject({ timing: "duration", lobby: "manual" });
    expect(await db.select().from(evaluationItems).where(eq(evaluationItems.evaluationId, liveQuiz.id))).toHaveLength(2);

    expect(await auditRows("training.provision")).toMatchObject([{ actorUserId: teacherId, subjectId: course!.id }]);
    // The status names the live quiz by its clock mode (ADR-086), never by its title.
    expect(await status(db, { userId: teacherId, llmEnabled: false })).toMatchObject({
      installed: true,
      course: { id: course!.id, classroomId: room!.id, liveEvaluationId: liveQuiz.id },
    });
  });

  it("names no live quiz once the teacher deleted it, and names it whatever its title", async () => {
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, teacherId));
    const [room] = await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id));
    const liveQuiz = (await db.select().from(evaluations).where(and(eq(evaluations.classroomId, room!.id), eq(evaluations.mode, "exam"))))[0]!;
    await patchEvaluation(db, liveQuiz, { title: "Mon examen" }, { attemptCount: 0, now: NOW });
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course?.liveEvaluationId).toBe(liveQuiz.id);
    await deleteEvaluation(db, liveQuiz, "owner");
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toEqual({
      id: course!.id,
      classroomId: room!.id,
      liveEvaluationId: null,
    });
  });

  it("answers the existing course on a second call, and writes nothing", async () => {
    const first = await provision(db, { userId: teacherId, lang: "fr", now: NOW, actor: actorOf(teacherId), content: trainingFixture() });
    expect(first).toMatchObject({ created: false });
    expect(await db.select().from(courses).where(eq(courses.trainingFor, teacherId))).toHaveLength(1);
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, first.courseId))).toHaveLength(1);
    expect(await auditRows("training.provision")).toHaveLength(1);
  });

  it("concurrent calls of one teacher yield one course, one classroom", async () => {
    const other = await makeUser("teacher");
    const input = { userId: other, lang: "en" as const, now: NOW, actor: actorOf(other), content: trainingFixture() };
    const results = await Promise.all([provision(db, input), provision(db, input), provision(db, input)]);
    expect(new Set(results.map((r) => r.courseId)).size).toBe(1);
    expect(new Set(results.map((r) => r.classroomId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await db.select().from(courses).where(eq(courses.trainingFor, other))).toHaveLength(1);
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, results[0]!.courseId))).toHaveLength(1);
    // Named in the caller's language, the next free code.
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, other));
    expect(course).toMatchObject({ name: "Getting started with Quiz", code: "INIT-2" });
    const [room] = await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id));
    expect(room!.period).toBe("Autumn 2026");
  });

  it("takes the smallest free INIT code, a renamed one included", async () => {
    await db.update(courses).set({ code: "INIT-7" }).where(eq(courses.trainingFor, teacherId));
    const third = await makeUser("teacher");
    await provision(db, { userId: third, lang: "fr", now: NOW, actor: actorOf(third), content: trainingFixture() });
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, third));
    expect(course!.code).toBe("INIT-1");
  });
});
