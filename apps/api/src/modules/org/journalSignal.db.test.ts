/**
 * The journal's line on a classroom row (#805): `GET /courses` names, per
 * classroom, the page that most recently became visible to students and the
 * next one a `visible_from` will show — by the student view's own rule (not
 * a draft, `visible_from` passed on the database's clock), the same in both
 * modes (ADR-057). A teacher's route: a student never receives it.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ClassroomSummary, CourseSummary } from "@quiz/contracts";

import { classroomJournals, classrooms, courseStaff, courses, enrollments, journalPages } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

const DAY = 86_400_000;

let server: TestServer;
let teacher: Caller;
let student: Caller;
const courseId = randomUUID();
const quizRoom = randomUUID();
const githubRoom = randomUUID();
const emptyRoom = randomUUID();
const bareRoom = randomUUID();

function page(classroomId: string, path: string, extra: Partial<typeof journalPages.$inferInsert> = {}) {
  return {
    id: randomUUID(),
    classroomId,
    path,
    parentPath: "",
    sortKey: path,
    blobSha: "a".repeat(40),
    markdown: `# ${path}\n`,
    htmlStaff: "",
    htmlStudent: "",
    ...extra,
  };
}

async function rooms(caller: Caller): Promise<ClassroomSummary[]> {
  const res = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: caller.headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as CourseSummary[]).find((c) => c.id === courseId)!.classrooms;
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  const db = server.app.db;
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  await db.insert(courseStaff).values({ courseId, userId: teacher.id });
  await db.insert(classrooms).values(
    [quizRoom, githubRoom, emptyRoom, bareRoom].map((id, i) => ({
      id,
      courseId,
      name: `PRG1-${i}`,
      period: "2026-A",
      createdAt: new Date(Date.now() - (10 - i) * 1000),
    })),
  );
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: quizRoom,
    nom: "Student",
    prenom: "Some",
    email: "some.student@heig.test",
    userId: student.id,
    claimedAt: new Date(),
  });
  await db.insert(classroomJournals).values([
    { classroomId: quizRoom, mode: "quiz", createdBy: teacher.id },
    { classroomId: githubRoom, mode: "github", githubRepoId: 7, fullName: "o/journal", ref: "main", createdBy: teacher.id },
    { classroomId: emptyRoom, mode: "quiz", createdBy: teacher.id },
  ]);
  const now = Date.now();
  const at = (days: number) => new Date(now + days * DAY);
  await db.insert(journalPages).values([
    // Visible: undated, created five days ago.
    page(quizRoom, "index.md", { title: "Intro", createdAt: at(-5) }),
    // Visible: its `visible_from` passed two days ago — the last one shown.
    page(quizRoom, "week-2.md", { title: "Week 2", createdAt: at(-6), visibleFrom: at(-2) }),
    // A draft, created just now: never visible, never "last".
    page(quizRoom, "draft.md", { title: "Draft", draft: true }),
    // A dated draft: never "next", even before the dated page.
    page(quizRoom, "draft-soon.md", { title: "Draft soon", draft: true, visibleFrom: at(1) }),
    // The next one: not a draft, the soonest `visible_from` ahead.
    page(quizRoom, "week-3.md", { title: "Week 3", createdAt: at(-1), visibleFrom: at(3) }),
    page(quizRoom, "week-4.md", { title: "Week 4", createdAt: at(-1), visibleFrom: at(7) }),
    // GitHub mode, same rule; a page without a title is named by its path.
    page(githubRoom, "notes/cours-1.md", { createdAt: at(-3) }),
    page(githubRoom, "cours-2.md", { title: "Cours 2", visibleFrom: at(2) }),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("the journal field of a classroom row (#805)", () => {
  it("names the last page students see and the next scheduled one, never a draft nor a future page", async () => {
    const quiz = (await rooms(teacher)).find((r) => r.id === quizRoom)!;
    expect(quiz.journal?.lastPage?.title).toBe("Week 2");
    expect(quiz.journal?.nextPage?.title).toBe("Week 3");
    expect(Date.parse(quiz.journal!.lastPage!.at)).toBeLessThan(Date.now());
    expect(Date.parse(quiz.journal!.nextPage!.at)).toBeGreaterThan(Date.now() + 2 * DAY);
    expect(quiz.journal!.nextPage!.at).toMatch(/Z$/);
  });

  it("reads a GitHub-mode journal by the same rule", async () => {
    const github = (await rooms(teacher)).find((r) => r.id === githubRoom)!;
    expect(github.journal?.lastPage?.title).toBe("notes/cours-1.md");
    expect(github.journal?.nextPage?.title).toBe("Cours 2");
  });

  it("is empty for a journal without pages, and null for a classroom without one", async () => {
    const list = await rooms(teacher);
    expect(list.find((r) => r.id === emptyRoom)!.journal).toEqual({ lastPage: null, nextPage: null });
    expect(list.find((r) => r.id === bareRoom)!.journal).toBeNull();
  });

  it("only shows a dated page once its `visible_from` passed on the database's clock", async () => {
    await server.app.db.insert(journalPages).values(
      page(emptyRoom, "later.md", { title: "Later", visibleFrom: new Date(Date.now() + DAY) }),
    );
    const empty = (await rooms(teacher)).find((r) => r.id === emptyRoom)!;
    expect(empty.journal).toEqual({ lastPage: null, nextPage: { title: "Later", at: expect.any(String) } });
  });

  it("never reaches a student: the course list is a teacher's route", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: student.headers });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("Week");
    expect(res.body).not.toContain("journal");
  });
});
