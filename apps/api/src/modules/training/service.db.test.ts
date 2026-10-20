/**
 * The training course's services (ADR-105): the install of the content into
 * the one public pool (§2) and the provisioning of a teacher's course (§1),
 * both idempotent, through the ordinary services. The status over HTTP, the
 * refusals and the missions are `routes.db.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { TrainingInstallResult } from "@quiz/contracts";

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
  userEmails,
  users,
} from "../../db/schema.js";
import { TRAINING_MCQ, TRAINING_SHORT, trainingFixture } from "../../test/training.js";
import { testApp } from "../../test/db.js";
import type { TrainingContent } from "./content-types.js";
import { deleteEvaluation, feedbackOf, patchEvaluation, settingsOf } from "../evaluation/service.js";
import * as orgService from "../org/service.js";
import * as poolService from "../pool/service.js";
import { install, provision, status, TrainingNotInstalled } from "./service.js";

const ADMIN_EMAIL = "admin@heig.test";
const NOW = new Date("2026-10-11T10:00:00.000Z");
const config = { SUPER_ADMIN_EMAIL: ADMIN_EMAIL };

let db: Db;
let log: { error: (...args: unknown[]) => void };
let adminId: string;

async function makeUser(role: "admin" | "teacher", email = `${role}-${randomUUID().slice(0, 8)}@heig.test`): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `test-${id}`, email, givenName: "Test", familyName: role, role });
  // The install resolves the super admin through verified addresses (`ownersOf`), as a sign-in records them.
  await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  return id;
}

const actorOf = (userId: string) => ({ actorUserId: userId, actorType: "user" as const });

/** An install that must install: the result, never a skip. */
async function installed(content: TrainingContent = trainingFixture(), email = ADMIN_EMAIL): Promise<TrainingInstallResult> {
  const outcome = await install(db, { SUPER_ADMIN_EMAIL: email }, NOW, content);
  if ("skipped" in outcome) throw new Error(`skipped: ${outcome.skipped}`);
  return outcome;
}

const provisionFor = (userId: string, lang: "fr" | "en" = "fr", content = trainingFixture()) =>
  provision(db, { userId, lang, now: NOW, actor: actorOf(userId), log, content });

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

const trainingPoolRow = async () => (await db.select().from(pools).where(eq(pools.isTraining, true)))[0] ?? null;

beforeAll(async () => {
  const app = await testApp();
  db = app.db;
  log = app.log;
  adminId = await makeUser("admin", ADMIN_EMAIL);
});

describe("before the install (§1, §2)", () => {
  it("provisioning is refused and the status says not installed", async () => {
    const teacherId = await makeUser("teacher");
    await expect(provisionFor(teacherId)).rejects.toBeInstanceOf(TrainingNotInstalled);
    expect((await status(db, { userId: teacherId, llmEnabled: false })).installed).toBe(false);
  });

  it("a content without a question, or no super admin account, is a skipped run that creates no pool", async () => {
    expect(await install(db, config, NOW, trainingFixture([]))).toEqual({ skipped: expect.stringContaining("no question") });
    expect(await install(db, { SUPER_ADMIN_EMAIL: "nobody@heig.test" }, NOW, trainingFixture())).toEqual({
      skipped: expect.stringContaining("no account"),
    });
    expect(await trainingPoolRow()).toBeNull();
  });

  it("two accounts behind the super admin's address are a failure, not a guess", async () => {
    const shared = "shared@heig.test";
    const [a, b] = [await makeUser("teacher"), await makeUser("teacher")];
    await db.insert(userEmails).values([
      { userId: a, email: shared, source: "login", verified: true },
      { userId: b, email: shared, source: "login", verified: true },
    ]);
    await expect(install(db, { SUPER_ADMIN_EMAIL: shared }, NOW, trainingFixture())).rejects.toThrow(/2 accounts/);
  });
});

describe("training.install (§2)", () => {
  it("creates the public pool of the super admin and publishes every question", async () => {
    const result = await installed();
    expect(result.questions).toEqual({ created: 2, updated: 0, unchanged: 0 });

    const pool = (await trainingPoolRow())!;
    expect(pool).toMatchObject({ id: result.poolId, isPublic: true, ownerId: adminId, name: "Prise en main (test)", icon: "graduation-cap" });
    expect(pool.description).toBe("Le contenu d'initiation des tests.");
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await publishedVersions(TRAINING_SHORT.internalName)).toBe(1);
    const folders = await db.select({ name: categories.name }).from(categories).where(eq(categories.poolId, pool.id));
    expect(folders.map((f) => f.name).sort()).toEqual(["Le cours", "Le quiz"]);
    const [mcq] = await db.select().from(questions).where(eq(questions.internalName, TRAINING_MCQ.internalName));
    expect(mcq).toMatchObject({ poolId: pool.id, type: "mcq", difficulty: 1, createdBy: adminId });
    expect(await auditRows("training.install")).toHaveLength(1);
  });

  it("a second run leaves everything alone, and traces nothing", async () => {
    expect((await installed()).questions).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await db.select().from(pools).where(eq(pools.isTraining, true))).toHaveLength(1);
    expect(await auditRows("training.install")).toHaveLength(1);
  });

  it("a changed config publishes a new version of that question only", async () => {
    const changed = { ...TRAINING_SHORT, config: { ...(TRAINING_SHORT.config as object), placeholder: "quatre lettres" } };
    expect((await installed(trainingFixture([TRAINING_MCQ, changed]))).questions).toEqual({ created: 0, updated: 1, unchanged: 1 });
    expect(await publishedVersions(TRAINING_SHORT.internalName)).toBe(2);
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(1);
    expect(await auditRows("training.install")).toHaveLength(2);
  });

  it("a changed explanation publishes a new version too", async () => {
    const changed = { ...TRAINING_MCQ, explanation: "Autre explication." };
    // The short question is back to the fixture's config: a new version of it as well.
    expect((await installed(trainingFixture([changed, TRAINING_SHORT]))).questions).toEqual({ created: 0, updated: 2, unchanged: 0 });
    expect(await publishedVersions(TRAINING_MCQ.internalName)).toBe(2);
    // Back to the fixture: unchanged from now on.
    await installed();
    expect((await installed()).questions).toEqual({ created: 0, updated: 0, unchanged: 2 });
  });

  it("a config the type refuses names the question", async () => {
    const broken = { ...TRAINING_MCQ, internalName: "init-broken", config: { configVersion: 2, prompt: "", choices: [] } };
    await expect(install(db, config, NOW, trainingFixture([broken]))).rejects.toThrow(/init-broken/);
  });

  it("an unpublished pool stays private through a run: not installed, provisioning refused (ADR-095 §5)", async () => {
    const pool = (await trainingPoolRow())!;
    await poolService.updatePool(db, pool.id, { isPublic: false });
    expect((await installed()).questions).toEqual({ created: 0, updated: 0, unchanged: 2 });
    expect((await trainingPoolRow())!.isPublic).toBe(false);
    const teacherId = await makeUser("teacher");
    expect((await status(db, { userId: teacherId, llmEnabled: false })).installed).toBe(false);
    await expect(provisionFor(teacherId)).rejects.toBeInstanceOf(TrainingNotInstalled);
    await poolService.updatePool(db, pool.id, { isPublic: true });
  });
});

describe("provision (§1)", () => {
  let teacherId: string;

  beforeAll(async () => {
    teacherId = await makeUser("teacher");
  });

  it("creates the course, its classroom, the read link and the two evaluations — nothing else", async () => {
    const result = await provisionFor(teacherId);
    expect(result.created).toBe(true);

    const [course] = await db.select().from(courses).where(eq(courses.id, result.courseId));
    expect(course).toMatchObject({ name: "Prise en main de Quiz", code: "INIT-1", trainingFor: teacherId });
    expect(await db.select().from(courseStaff).where(eq(courseStaff.courseId, course!.id))).toMatchObject([{ userId: teacherId, role: "owner" }]);

    const [room] = await db.select().from(classrooms).where(eq(classrooms.id, result.classroomId));
    expect(room).toMatchObject({ courseId: course!.id, name: "Initiation", period: "Automne 2026", periodStart: "2026-09", periodEnd: "2027-01" });
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id))).toHaveLength(1);

    const pool = (await trainingPoolRow())!;
    expect(await db.select().from(coursePools).where(eq(coursePools.courseId, course!.id))).toMatchObject([{ poolId: pool.id, mode: "read" }]);

    const rows = await db.select().from(evaluations).where(eq(evaluations.classroomId, room!.id));
    const welcome = rows.find((r) => r.title === "L'exercice d'accueil")!;
    const liveQuiz = rows.find((r) => r.title === "L'examen en direct")!;
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

    expect(await auditRows("training.provision")).toMatchObject([{ actorUserId: teacherId, subjectId: course!.id, payload: { code: "INIT-1" } }]);
    // The status names the live quiz by its clock mode (ADR-086), never by its title.
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toEqual({
      id: course!.id,
      classroomId: room!.id,
      liveEvaluationId: liveQuiz.id,
    });
  });

  it("answers the existing course on a second call, and writes nothing", async () => {
    const first = await provisionFor(teacherId);
    expect(first).toMatchObject({ created: false });
    expect(await db.select().from(courses).where(eq(courses.trainingFor, teacherId))).toHaveLength(1);
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, first.courseId))).toHaveLength(1);
    expect(await auditRows("training.provision")).toHaveLength(1);
  });

  it("names no live quiz once the teacher deleted it, and names it whatever its title", async () => {
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, teacherId));
    const [room] = await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id));
    const liveQuiz = (await db.select().from(evaluations).where(and(eq(evaluations.classroomId, room!.id), eq(evaluations.mode, "exam"))))[0]!;
    await patchEvaluation(db, liveQuiz, { title: "Mon examen" }, { attemptCount: 0, now: NOW });
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course?.liveEvaluationId).toBe(liveQuiz.id);
    await deleteEvaluation(db, liveQuiz, "owner");
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toEqual({ id: course!.id, classroomId: room!.id, liveEvaluationId: null });
  });

  it("repeated calls at once of one teacher yield one course: the mark is the last write, the losers delete their own", async () => {
    // The three calls start before any claim: each builds a course of its own, the first claim wins,
    // the two losers delete theirs and answer the winner's (PGlite serialises statements, not calls).
    const other = await makeUser("teacher");
    const results = await Promise.all([provisionFor(other, "en"), provisionFor(other, "en"), provisionFor(other, "en")]);
    expect(new Set(results.map((r) => r.courseId)).size).toBe(1);
    expect(new Set(results.map((r) => r.classroomId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const theirs = await db.select().from(courses).where(eq(courses.trainingFor, other));
    expect(theirs).toHaveLength(1);
    expect(await db.select().from(classrooms).where(eq(classrooms.courseId, theirs[0]!.id))).toHaveLength(1);
    // No other course of theirs is left behind.
    expect(await db.select().from(courseStaff).where(eq(courseStaff.userId, other))).toHaveLength(1);
    // Named in the caller's language, the next free code.
    expect(theirs[0]).toMatchObject({ name: "Getting started with Quiz", code: "INIT-2" });
    const [room] = await db.select().from(classrooms).where(eq(classrooms.courseId, theirs[0]!.id));
    expect(room!.period).toBe("Autumn 2026");
  });

  it("a failure on the way leaves no course behind", async () => {
    const unlucky = await makeUser("teacher");
    const broken: TrainingContent = { ...trainingFixture(), evaluations: [{ key: "live", title: "Poll", mode: "poll" as "exam", target: "draft", questions: [] }] };
    await expect(provisionFor(unlucky, "fr", broken)).rejects.toThrow();
    expect(await db.select().from(courseStaff).where(eq(courseStaff.userId, unlucky))).toHaveLength(0);
    expect((await status(db, { userId: unlucky, llmEnabled: false })).course).toBeNull();
  });

  it("takes the smallest free INIT code, a renamed one included", async () => {
    await db.update(courses).set({ code: "INIT-7" }).where(eq(courses.trainingFor, teacherId));
    const third = await makeUser("teacher");
    await provisionFor(third);
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, third));
    expect(course!.code).toBe("INIT-1");
  });

  it("rebuilds a deleted classroom with the teacher's own links kept, and traces the rebuild", async () => {
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, teacherId));
    const mine = await poolService.createPool(db, { name: "Ma banque", ownerId: teacherId });
    const training = (await trainingPoolRow())!;
    await poolService.setCoursePools(
      db,
      course!.id,
      [
        { poolId: training.id, mode: "read" },
        { poolId: mine.id, mode: "edit" },
      ],
      undefined,
      { id: teacherId, role: "teacher", reach: "seats" },
    );
    const [room] = await db.select().from(classrooms).where(eq(classrooms.courseId, course!.id));
    await orgService.deleteClassroom(db, room!.id);
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toBeNull();

    const result = await provisionFor(teacherId);
    expect(result).toMatchObject({ courseId: course!.id, created: false });
    expect(result.classroomId).not.toBe(room!.id);
    const links = await db.select().from(coursePools).where(eq(coursePools.courseId, course!.id));
    expect(links.map((l) => [l.poolId, l.mode]).sort()).toEqual([[mine.id, "edit"], [training.id, "read"]].sort());
    expect(await db.select().from(evaluations).where(eq(evaluations.classroomId, result.classroomId))).toHaveLength(2);
    expect(await auditRows("training.provision")).toMatchObject([
      { subjectId: course!.id, payload: { code: "INIT-1" } },
      { subjectId: expect.any(String) },
      { subjectId: expect.any(String) },
      { subjectId: course!.id, payload: { classroomId: result.classroomId, rebuilt: true } },
    ]);
  });

  it("the course follows the seat: removed from the staff, the teacher provisions a new one (invariant 6)", async () => {
    const [course] = await db.select().from(courses).where(eq(courses.trainingFor, teacherId));
    const colleague = await makeUser("teacher");
    await orgService.addStaff(db, course!.id, colleague, "owner");
    const outcome = await orgService.changeStaffSeat(db, course!.id, teacherId, "remove");
    expect(outcome).toMatchObject({ refused: null });
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toBeNull();
    // The old course lives on, unmarked, as its remaining owner's ordinary course.
    expect((await db.select().from(courses).where(eq(courses.id, course!.id)))[0]).toMatchObject({ trainingFor: null });
    expect(await db.select().from(courseStaff).where(eq(courseStaff.courseId, course!.id))).toMatchObject([{ userId: colleague }]);

    const again = await provisionFor(teacherId);
    expect(again.created).toBe(true);
    expect(again.courseId).not.toBe(course!.id);
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course?.id).toBe(again.courseId);
  });

  it("restart: the course deleted, provisioning makes a new one (F-ORG-09)", async () => {
    const before = (await status(db, { userId: teacherId, llmEnabled: false })).course!;
    await orgService.deleteCourse(db, before.id);
    expect((await status(db, { userId: teacherId, llmEnabled: false })).course).toBeNull();
    const again = await provisionFor(teacherId);
    expect(again.created).toBe(true);
    expect(again.courseId).not.toBe(before.id);
  });
});
