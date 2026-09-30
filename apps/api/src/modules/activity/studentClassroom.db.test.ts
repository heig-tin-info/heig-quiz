/**
 * The student's classrooms over the real application (F-ORG-14, F-ORG-15,
 * merge task M5-01): the Courses list and the classroom page. What they must
 * never carry — a draft, another student's data, another classroom's — and
 * who reads the page: the route's 404 (the loader's matrix is in
 * `readableClassroom.db.test.ts`), the staff, an impersonation session and a
 * `seb` session.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudentClassroom, StudentClassroomPage, type SessionKind } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import {
  attempts,
  classroomJournals,
  classrooms,
  courseStaff,
  enrollments,
  evaluations,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { createEvaluation } from "../evaluation/service.js";

type Signed = { id: string; headers: Record<string, string> };

let server: TestServer;
let teacher: Signed;
/** On the staff, with a staff seat of their own (the self-enrolment, ADR-018). */
let seatedTeacher: Signed;
let outsider: Signed;
let admin: Signed;
let student: Signed;
let classmate: Signed;
let unclaimed: Signed;
let mine: Seeded;
let other: Seeded;
let archivedId: string;
let classmateAttempt: string;
const ids: Record<string, string> = {};

async function evaluation(
  classroomId: string,
  title: string,
  over: Partial<typeof evaluations.$inferInsert>,
): Promise<string> {
  const created = await createEvaluation(server.app.db, {
    classroomId,
    title,
    mode: "exam", // a poll is created by its own module; `over` makes it one
    createdBy: teacher.id,
  });
  await server.app.db.update(evaluations).set(over).where(eq(evaluations.id, created.id));
  ids[title] = created.id;
  return created.id;
}

/** A session of `kind` for `userId`, as the cookies a browser would send. */
async function sessionOf(userId: string, auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string }) {
  const session = await createSession(server.app.db, userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
  });
  return {
    cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`,
    "x-csrf-token": session.csrf,
  };
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  seatedTeacher = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  admin = await server.signIn("admin");
  student = await server.signIn("student");
  classmate = await server.signIn("student");
  unclaimed = await server.signIn("student", "unclaimed@heig.test");
  const db = server.app.db;

  mine = await seedLive(db, {
    teacherId: teacher.id,
    studentIds: [student.id, classmate.id],
    questions: 0,
    timeBonusPercent: 25,
  });
  // `seedLive`'s own evaluation stays a draft.
  await db.update(evaluations).set({ title: "draft exam" }).where(eq(evaluations.id, mine.evaluationId));
  ids["draft exam"] = mine.evaluationId;
  await db.insert(courseStaff).values({ courseId: mine.courseId, userId: seatedTeacher.id });
  await db.insert(enrollments).values([
    {
      id: randomUUID(),
      classroomId: mine.classroomId,
      nom: "Teacher",
      prenom: "Seated",
      email: "seated@heig.test",
      userId: seatedTeacher.id,
      claimedAt: new Date(),
      staff: true,
    },
    // The roster names this address; nobody claimed the line.
    { id: randomUUID(), classroomId: mine.classroomId, nom: "Un", prenom: "Claimed", email: "unclaimed@heig.test" },
  ]);
  await db.insert(classroomJournals).values({
    classroomId: mine.classroomId,
    githubRepoId: 1,
    fullName: "heig/journal",
    ref: "main",
    createdBy: teacher.id,
  });

  const now = server.clock.now();
  const running = await evaluation(mine.classroomId, "running exam", { state: "running", startedAt: now });
  await evaluation(mine.classroomId, "scheduled exam", { state: "scheduled", opensAt: new Date(now.getTime() + 86_400_000) });
  await evaluation(mine.classroomId, "closed exam", { state: "closed", closedAt: now });
  await evaluation(mine.classroomId, "class poll", { mode: "poll", state: "running", accessCode: "POLL42" });
  classmateAttempt = randomUUID();
  await db.insert(attempts).values({
    id: classmateAttempt,
    evaluationId: running,
    userId: classmate.id,
    state: "in_progress",
    seed: 7,
    startedAt: now,
  });

  // Another course, where only the classmate sits.
  other = await seedLive(db, { teacherId: outsider.id, studentIds: [classmate.id], questions: 0 });
  await evaluation(other.classroomId, "other exam", { state: "running", startedAt: now });

  // An archived classroom of the same course, where the student sits too.
  archivedId = randomUUID();
  await db.insert(classrooms).values({
    id: archivedId,
    courseId: mine.courseId,
    name: "Z-archived",
    period: "2024-A",
    archivedAt: now,
  });
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: archivedId,
    nom: "Nom",
    prenom: "Prenom",
    email: "archived@heig.test",
    userId: student.id,
    claimedAt: now,
  });
});

afterAll(async () => {
  await server.close();
});

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });

const pageUrl = (id: string) => `/app/api/student/classrooms/${id}`;

async function page(headers: Record<string, string>, id = mine.classroomId) {
  const res = await get(pageUrl(id), headers);
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, page: StudentClassroomPage.parse(res.json()) };
}

const titles = (p: StudentClassroomPage) => ({
  open: p.activities.open.map((c) => c.title),
  upcoming: p.activities.upcoming.map((c) => c.title),
  past: p.activities.past.map((c) => c.title),
});

describe("GET /app/api/student/classrooms", () => {
  it("lists the claimed seats, archived classrooms excepted, in the contract's shape", async () => {
    const res = await get("/app/api/student/classrooms", student.headers);
    expect(res.statusCode).toBe(200);
    const list = StudentClassroom.array().parse(res.json());
    expect(list.map((c) => c.id)).toEqual([mine.classroomId]);
    expect(list[0]).toMatchObject({ timeBonusPercent: 25, courseCode: expect.stringMatching(/^PRG-/) });
    expect(list[0]!.teachers).toHaveLength(2);
  });

  it("lists nothing for an unclaimed roster line", async () => {
    const res = await get("/app/api/student/classrooms", unclaimed.headers);
    expect(res.json()).toEqual([]);
  });
});

describe("GET /app/api/student/classrooms/:id", () => {
  it("gives the student the header, the three groups, the journal tab", async () => {
    const { page: p } = await page(student.headers);
    expect(p.classroom).toMatchObject({
      id: mine.classroomId,
      name: "A",
      period: "2026-A",
      courseName: "Programmation C",
      timeBonusPercent: 25,
      archived: false,
    });
    expect(p.hasJournal).toBe(true);
    expect(p.hasProjects).toBe(false);
    expect(titles(p)).toEqual({ open: ["running exam"], upcoming: ["scheduled exam"], past: ["closed exam"] });
    expect(p.activities.open.every((c) => c.kind === "evaluation")).toBe(true);
    expect(p.activities.polls.map((c) => c.code)).toEqual(["POLL42"]);
  });

  it("leaks no draft, nothing of another student, nothing of another classroom", async () => {
    const { body, page: p } = await page(student.headers);
    for (const secret of [
      ids["draft exam"]!,
      "draft exam",
      classmateAttempt,
      classmate.id,
      other.classroomId,
      ids["other exam"]!,
      "other exam",
      archivedId,
      "unclaimed@heig.test",
    ]) {
      expect(body, secret).not.toContain(secret);
    }
    expect(p.activities.open[0]!.attemptId).toBeNull();
  });

  it("gives the classmate their own attempt, and never the student's bonus", async () => {
    const { page: p } = await page(classmate.headers);
    expect(p.activities.open[0]!.attemptId).toBe(classmateAttempt);
    expect(p.classroom.timeBonusPercent).toBe(0);
  });

  it("reaches an archived classroom by its address, as it is", async () => {
    const { page: p } = await page(student.headers, archivedId);
    expect(p.classroom).toMatchObject({ archived: true, name: "Z-archived" });
    expect(p.hasJournal).toBe(false);
  });

  it.each([
    ["an unknown id", (): string => randomUUID()],
    ["a malformed id", (): string => "not-a-uuid"],
    ["a classroom of another course", (): string => other.classroomId],
  ] as const)("answers the 404 of a missing classroom for %s", async (_name, id) => {
    const res = await get(pageUrl(id()), student.headers);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
  });

  describe("the staff read the student payload", () => {
    it("a teacher without a seat: the header, no cards", async () => {
      const { body, page: p } = await page(teacher.headers);
      expect(p.classroom).toMatchObject({ id: mine.classroomId, timeBonusPercent: 0 });
      expect(titles(p)).toEqual({ open: [], upcoming: [], past: [] });
      expect(body).not.toContain("draft exam");
    });

    it("a teacher on their staff seat sees what a student sees, never a draft", async () => {
      const { body, page: p } = await page(seatedTeacher.headers);
      expect(titles(p)).toEqual(titles((await page(student.headers)).page));
      expect(body).not.toContain("draft exam");
      expect(body).not.toContain(classmateAttempt);
    });
  });

  describe("sessions that are not the student's own portal", () => {
    it("an impersonation session reads exactly what the student reads", async () => {
      const as = await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id });
      const [theirs, ours] = await Promise.all([page(student.headers), page(as)]);
      expect(ours.body.replace(/"serverNow":"[^"]+"/, "")).toBe(theirs.body.replace(/"serverNow":"[^"]+"/, ""));
    });

    it("a seb session is nobody on this route (ADR-027)", async () => {
      const seb = await sessionOf(student.id, { kind: "seb", evaluationId: ids["running exam"]! });
      expect((await get(pageUrl(mine.classroomId), seb)).statusCode).toBe(401);
      expect((await get("/app/api/student/classrooms", seb)).statusCode).toBe(401);
    });

    it("an anonymous caller is asked to sign in", async () => {
      expect((await get(pageUrl(mine.classroomId), {})).statusCode).toBe(401);
    });
  });
});
