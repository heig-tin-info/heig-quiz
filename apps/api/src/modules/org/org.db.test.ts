import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CourseDetail } from "@quiz/contracts";

import { classrooms, courseStaff, courses, enrollments, userEmails } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
let teacher: Awaited<ReturnType<TestServer["signIn"]>>;
let outsider: Awaited<ReturnType<TestServer["signIn"]>>;
let courseId: string;
let classroomId: string;

/** The address set is what a roster line is matched against (GH-11). */
async function signInStudent(email: string) {
  const student = await server.signIn("student", email);
  await server.app.db
    .insert(userEmails)
    .values({ userId: student.id, email, source: "login", verified: true });
  return student;
}

async function enableJoinCode(): Promise<string> {
  const patched = await server.app.inject({
    method: "PATCH",
    url: `/app/api/classrooms/${classroomId}`,
    headers: teacher.headers,
    payload: { joinCodeEnabled: true },
  });
  expect(patched.statusCode).toBe(200);
  // The code rides on the course detail; there is no route of its own.
  const detail = await server.app.inject({
    method: "GET",
    url: `/app/api/courses/${courseId}`,
    headers: teacher.headers,
  });
  const room = (detail.json() as CourseDetail).classrooms.find((c) => c.id === classroomId);
  expect(room?.joinCodeEnabled).toBe(true);
  return room!.joinCode as string;
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  outsider = await server.signIn("teacher");
  courseId = randomUUID();
  classroomId = randomUUID();
  await server.app.db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  await server.app.db.insert(courseStaff).values({ courseId, userId: teacher.id });
  await server.app.db
    .insert(classrooms)
    .values({ id: classroomId, courseId, name: "PRG1-A", period: "2026-A" });
});

afterAll(async () => {
  await server.close();
});

describe("join code (F-ORG-06)", () => {
  it("mints a readable code when self-enrolment is switched on, and keeps it", async () => {
    const code = await enableJoinCode();
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/);
    // Switching off and on again hands back the SAME code: the handout the
    // teacher printed still works.
    await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}`,
      headers: teacher.headers,
      payload: { joinCodeEnabled: false },
    });
    expect(await enableJoinCode()).toBe(code);
  });

  it("lets a student join, once, and puts them on the roster", async () => {
    const code = await enableJoinCode();
    const student = await signInStudent("new.student@heig.test");
    const joined = await server.app.inject({
      method: "POST",
      url: `/app/api/join/${code}`,
      headers: student.headers,
    });
    expect(joined.statusCode).toBe(201);
    expect(joined.json()).toMatchObject({ classroomId, courseCode: "PRG1", status: "joined" });

    const again = await server.app.inject({
      method: "POST",
      url: `/app/api/join/${code}`,
      headers: student.headers,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("already");

    const rows = await server.app.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.userId, student.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("claimed");
  });

  it("claims the roster line the teacher had already imported, never a second one", async () => {
    const code = await enableJoinCode();
    const email = "imported@heig.test";
    const enrollmentId = randomUUID();
    await server.app.db
      .insert(enrollments)
      .values({ id: enrollmentId, classroomId, nom: "Turing", prenom: "Alan", email });
    const student = await signInStudent(email);

    const joined = await server.app.inject({
      method: "POST",
      url: `/app/api/join/${code}`,
      headers: student.headers,
    });
    expect(joined.json().status).toBe("joined");
    const rows = await server.app.db
      .select()
      .from(enrollments)
      .where(eq(enrollments.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(enrollmentId);
    expect(rows[0]!.userId).toBe(student.id);
    // The imported name is kept: the roster is the teacher's document.
    expect(rows[0]!.nom).toBe("Turing");
  });

  it("refuses a wrong code, and a disabled one, with the same 404", async () => {
    const code = await enableJoinCode();
    const student = await signInStudent("late@heig.test");
    expect(
      (await server.app.inject({
        method: "POST",
        url: "/app/api/join/ZZZZZZZZ",
        headers: student.headers,
      })).statusCode,
    ).toBe(404);

    await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}`,
      headers: teacher.headers,
      payload: { joinCodeEnabled: false },
    });
    const refused = await server.app.inject({
      method: "POST",
      url: `/app/api/join/${code}`,
      headers: student.headers,
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: "not_found" });
  });

  it("is closed to a teacher who is not on the course staff", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/classrooms/${classroomId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("roster accommodations (F-ORG-07)", () => {
  it("updates the time bonus and the private note of one entry", async () => {
    const id = randomUUID();
    await server.app.db.insert(enrollments).values({
      id,
      classroomId,
      nom: "Hopper",
      prenom: "Grace",
      email: `grace-${id.slice(0, 8)}@heig.test`,
    });
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/roster/${id}`,
      headers: teacher.headers,
      payload: { timeBonusPercent: 33, note: "third of extra time" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ timeBonusPercent: 33, note: "third of extra time" });

    const [row] = await server.app.db.select().from(enrollments).where(eq(enrollments.id, id));
    expect(row!.timeBonusPercent).toBe(33);

    // Out of range is refused by the contracts schema, not by the database.
    const refused = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}/roster/${id}`,
      headers: teacher.headers,
      payload: { timeBonusPercent: 4000 },
    });
    expect(refused.statusCode).toBe(400);
  });

  it("answers 404 to a teacher who is not staff of the classroom", async () => {
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/classrooms/${classroomId}`,
      headers: outsider.headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /courses/:id", () => {
  it("returns the course, its staff, its classrooms and its pools", async () => {
    const pool = await server.app.inject({
      method: "POST",
      url: "/app/api/pools",
      headers: teacher.headers,
      payload: { name: "PRG1 questions" },
    });
    await server.app.inject({
      method: "PUT",
      url: `/app/api/courses/${courseId}/pools`,
      headers: teacher.headers,
      payload: { poolIds: [pool.json().id] },
    });
    const res = await server.app.inject({
      method: "GET",
      url: `/app/api/courses/${courseId}`,
      headers: teacher.headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.course).toMatchObject({ code: "PRG1" });
    expect(body.staff.map((s: { userId: string }) => s.userId)).toEqual([teacher.id]);
    expect(body.classrooms.map((c: { id: string }) => c.id)).toEqual([classroomId]);
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0].questionCount).toBe(0);
  });
});
