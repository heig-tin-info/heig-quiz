/**
 * `GET /app/api/activities` (issue #190): who sees what. The scope is the
 * access predicate of the evaluations the caller manages — a staff seat on
 * the classroom's course, or the ownership of an anonymous poll — loaded,
 * never filtered afterwards (invariant 6). An admin sees their own, like
 * any teacher: the admin override does not apply to this page.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ActivityList } from "@quiz/contracts";

import { classrooms, courseStaff, courses, evaluations } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

type Signed = { id: string; headers: Record<string, string> };

let server: TestServer;
let alice: Signed;
let bob: Signed;
let admin: Signed;
let student: Signed;
const ids: Record<string, string> = {};

async function course(code: string, staff: string[]): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(courses).values({ id, name: code, code });
  for (const userId of staff) await server.app.db.insert(courseStaff).values({ courseId: id, userId });
  return id;
}

async function classroom(courseId: string, name: string, archived = false): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(classrooms).values({
    id,
    courseId,
    name,
    period: "2026-A",
    archivedAt: archived ? new Date() : null,
  });
  return id;
}

async function evaluation(
  title: string,
  home: { classroomId?: string; courseId?: string; owner?: string },
  over: Partial<typeof evaluations.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  await server.app.db.insert(evaluations).values({
    id,
    classroomId: home.classroomId ?? null,
    courseId: home.courseId ?? null,
    revision: home.courseId ? 1 : null,
    createdBy: home.owner ?? null,
    title,
    mode: "exam",
    state: "draft",
    settings: {},
    gradingScale: {},
    feedbackPolicy: {},
    ...over,
  });
  ids[title] = id;
  return id;
}

beforeAll(async () => {
  server = await testServer();
  alice = await server.signIn("teacher");
  bob = await server.signIn("teacher");
  admin = await server.signIn("admin");
  student = await server.signIn("student");

  const aliceCourse = await course("PRG1", [alice.id]);
  const shared = await course("EMB", [alice.id, bob.id]);
  const bobCourse = await course("ALG", [bob.id]);
  const a1 = await classroom(aliceCourse, "PRG1-2026");
  const archived = await classroom(aliceCourse, "PRG1-2024", true);
  const s1 = await classroom(shared, "EMB-2026");
  const b1 = await classroom(bobCourse, "ALG-2026");

  await evaluation("alice exam", { classroomId: a1 }, { state: "running", startedAt: new Date() });
  await evaluation(
    "alice series",
    { classroomId: a1 },
    { mode: "exercise", state: "scheduled", settings: { lobby: "skip" }, opensAt: new Date() },
  );
  await evaluation("archived exam", { classroomId: archived }, { state: "released" });
  await evaluation("shared exam", { classroomId: s1, owner: bob.id }, { state: "closed" });
  await evaluation("bob exam", { classroomId: b1, owner: bob.id });
  await evaluation("alice template", { courseId: aliceCourse, owner: alice.id });
  await evaluation("alice poll", { owner: alice.id }, { mode: "poll", state: "running" });
  await evaluation("bob poll", { owner: bob.id }, { mode: "poll", state: "running" });
  // Bounded (#190 review): an anonymous poll ended 121 days ago is out, one
  // ended 119 days ago stays, and so does an old ended CLASSROOM poll.
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(server.clock.now().getTime() - days * DAY);
  await evaluation("old poll", { owner: alice.id }, { mode: "poll", state: "closed", closedAt: ago(121), createdAt: ago(121) });
  await evaluation("recent poll", { owner: alice.id }, { mode: "poll", state: "closed", closedAt: ago(119), createdAt: ago(119) });
  await evaluation("old class poll", { classroomId: a1, owner: alice.id }, { mode: "poll", state: "closed", closedAt: ago(200) });
});

afterAll(async () => {
  await server.close();
});

async function activitiesOf(user: Signed): Promise<ActivityList> {
  const response = await server.app.inject({
    method: "GET",
    url: "/app/api/activities",
    headers: user.headers,
  });
  expect(response.statusCode).toBe(200);
  // The route's answer is the contract's shape, whole.
  return ActivityList.parse(response.json());
}

const titles = (list: ActivityList) => list.map((a) => a.title).sort();

describe("GET /app/api/activities", () => {
  it("lists what the teacher reaches through a staff seat, and their own polls", async () => {
    expect(titles(await activitiesOf(alice))).toEqual([
      "alice exam",
      "alice poll",
      "alice series",
      "old class poll",
      "recent poll",
      "shared exam",
    ]);
  });

  it("never lists another teacher's classroom, nor their classroom-less poll", async () => {
    const list = await activitiesOf(alice);
    expect(list.map((a) => a.id)).not.toContain(ids["bob exam"]);
    expect(list.map((a) => a.id)).not.toContain(ids["bob poll"]);
    expect(titles(await activitiesOf(bob))).toEqual(["bob exam", "bob poll", "shared exam"]);
  });

  it("leaves out templates and the evaluations of an archived classroom", async () => {
    const list = titles(await activitiesOf(alice));
    expect(list).not.toContain("alice template");
    expect(list).not.toContain("archived exam");
  });

  it("leaves out an anonymous poll that ended more than 120 days ago, and only that", async () => {
    const list = titles(await activitiesOf(alice));
    expect(list).not.toContain("old poll");
    expect(list).toContain("recent poll");
    expect(list).toContain("old class poll");
  });

  it("gives an admin their own activities only, like any teacher", async () => {
    // The admin sits on no staff and owns no poll: nothing, not everything.
    expect(await activitiesOf(admin)).toEqual([]);
    const course = randomUUID();
    await server.app.db.insert(courses).values({ id: course, name: "ADM", code: "ADM" });
    await server.app.db.insert(courseStaff).values({ courseId: course, userId: admin.id });
    const room = await classroom(course, "ADM-2026");
    await evaluation("admin exam", { classroomId: room });
    await evaluation("admin poll", { owner: admin.id }, { mode: "poll", state: "running" });
    expect(titles(await activitiesOf(admin))).toEqual(["admin exam", "admin poll"]);
  });

  it("names the classroom, or none for an anonymous poll, and flags a take-home series", async () => {
    const list = await activitiesOf(alice);
    const byTitle = new Map(list.filter((a) => a.kind === "evaluation").map((a) => [a.title, a]));
    expect(byTitle.get("alice exam")!.classroom).toMatchObject({
      name: "PRG1-2026",
      courseCode: "PRG1",
    });
    expect(byTitle.get("alice poll")!.classroom).toBeNull();
    expect(byTitle.get("alice series")!.takeHome).toBe(true);
    expect(byTitle.get("alice exam")!.takeHome).toBe(false);
  });

  it("is a teacher route", async () => {
    const response = await server.app.inject({
      method: "GET",
      url: "/app/api/activities",
      headers: student.headers,
    });
    expect(response.statusCode).toBe(403);
  });
});
