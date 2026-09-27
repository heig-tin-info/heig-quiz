/**
 * Hiding a course from one's own navigation (#155, ADR-032): per user, under
 * `staffAccess`, and out of the navigation only — `GET /courses` still lists
 * the course, flagged, for the pickers and the MCP `list_courses`. And the
 * course detail lists the archived classrooms the course list leaves out.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiTokenCreated, CourseDetail, CourseSummary } from "@quiz/contracts";

import { classrooms, courseStaff, courses } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let teacherA: Caller;
let teacherB: Caller;
let outsider: Caller;
let admin: Caller;
let courseId: string;
let liveRoomId: string;
let archivedRoomId: string;

async function post(caller: Caller, path: "hide" | "unhide", id = courseId) {
  return server.app.inject({
    method: "POST",
    url: `/app/api/courses/${id}/${path}`,
    headers: caller.headers,
  });
}

async function listOf(caller: Caller): Promise<CourseSummary[]> {
  const res = await server.app.inject({ method: "GET", url: "/app/api/courses", headers: caller.headers });
  expect(res.statusCode).toBe(200);
  return res.json() as CourseSummary[];
}

async function hiddenFor(caller: Caller): Promise<boolean | undefined> {
  return (await listOf(caller)).find((c) => c.id === courseId)?.hidden;
}

beforeAll(async () => {
  server = await testServer();
  teacherA = await server.signIn("teacher");
  teacherB = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  admin = await server.signIn("admin");
  courseId = randomUUID();
  liveRoomId = randomUUID();
  archivedRoomId = randomUUID();
  await server.app.db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  await server.app.db.insert(courseStaff).values([
    { courseId, userId: teacherA.id },
    { courseId, userId: teacherB.id },
  ]);
  await server.app.db.insert(classrooms).values([
    { id: liveRoomId, courseId, name: "PRG1-2026", period: "2026-A" },
    { id: archivedRoomId, courseId, name: "PRG1-2024", period: "2024-A", archivedAt: new Date() },
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("hiding a course (#155)", () => {
  it("hides and unhides for the caller, and a second hide is a no-op", async () => {
    expect(await hiddenFor(teacherA)).toBe(false);
    expect((await post(teacherA, "hide")).statusCode).toBe(204);
    expect((await post(teacherA, "hide")).statusCode).toBe(204);
    expect(await hiddenFor(teacherA)).toBe(true);
    expect((await post(teacherA, "unhide")).statusCode).toBe(204);
    expect(await hiddenFor(teacherA)).toBe(false);
  });

  it("does not hide the course for a colleague on the same staff", async () => {
    await post(teacherA, "hide");
    expect(await hiddenFor(teacherA)).toBe(true);
    expect(await hiddenFor(teacherB)).toBe(false);
    await post(teacherA, "unhide");
  });

  it("answers 404 to a teacher off the staff, and to an unknown course", async () => {
    expect((await post(outsider, "hide")).statusCode).toBe(404);
    expect((await post(outsider, "unhide")).statusCode).toBe(404);
    expect((await post(teacherA, "hide", randomUUID())).statusCode).toBe(404);
    expect(await listOf(outsider)).toEqual([]);
  });

  it("lets an admin, who holds no staff seat, hide a course for themselves", async () => {
    expect((await post(admin, "hide")).statusCode).toBe(204);
    expect(await hiddenFor(admin)).toBe(true);
    expect(await hiddenFor(teacherA)).toBe(false);
  });

  it("keeps a hidden course in the list, flagged, with its classrooms", async () => {
    await post(teacherA, "hide");
    const course = (await listOf(teacherA)).find((c) => c.id === courseId);
    // The navigation leaves it out on `hidden`; the pickers read the same
    // list and still offer it, and so does the MCP below.
    expect(course).toMatchObject({ hidden: true, code: "PRG1" });
    expect(course!.classrooms.map((r) => r.id)).toEqual([liveRoomId]);
    await post(teacherA, "unhide");
  });

  it("still lists a hidden course through the MCP list_courses", async () => {
    await post(teacherA, "hide");
    const created = await server.app.inject({
      method: "POST",
      url: "/app/api/me/tokens",
      headers: teacherA.headers,
      payload: { name: "hide test" },
    });
    const token = (created.json() as ApiTokenCreated).token;
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/mcp",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_courses", arguments: {} },
      },
    });
    const listed = JSON.parse(res.json().result.content[0].text) as CourseSummary[];
    expect(listed.map((c) => c.id)).toContain(courseId);
    await post(teacherA, "unhide");
  });
});

describe("archived classrooms of a course (#155)", () => {
  it("are out of the course list and in the course detail, flagged", async () => {
    const course = (await listOf(teacherA)).find((c) => c.id === courseId)!;
    expect(course.classrooms.map((r) => r.id)).not.toContain(archivedRoomId);
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/courses/${courseId}`,
      headers: teacherA.headers,
    });
    const detail = res.json() as CourseDetail;
    const archived = detail.classrooms.filter((r) => r.archivedAt !== null).map((r) => r.id);
    expect(archived).toEqual([archivedRoomId]);
  });
});
