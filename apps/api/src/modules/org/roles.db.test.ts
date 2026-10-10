/**
 * Course staff roles (ADR-068): what only an owner of a course may do, the
 * order of the refusals (404 for anyone off the staff, then 403
 * `owner_required` for an assistant, before the body), the last-owner rule,
 * leaving a course, and the role each payload reports.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CourseDetail, CourseSummary, EvaluationDetail } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, classrooms, courseStaff, courses, evaluations, userEmails } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { reload, seedLive } from "../../test/live.js";
import { applyState } from "../evaluation/service.js";

type Caller = Awaited<ReturnType<TestServer["signIn"]>>;

let server: TestServer;
let restore: () => void;
let owner: Caller & { email: string };
let assistant: Caller & { email: string };
let outsider: Caller;
let courseId: string;
let classroomId: string;

const send = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, caller: Caller, payload?: Payload) =>
  server.app.inject({ method, url, headers: caller.headers, ...(payload === undefined ? {} : { payload }) });

/** A teacher whose address is verified, so the Add-staff form can name them. */
async function teacherWithAddress(): Promise<Caller & { email: string }> {
  const email = `t-${randomUUID().slice(0, 8)}@heig.test`;
  const caller = await server.signIn("teacher", email);
  await server.app.db.insert(userEmails).values({ userId: caller.id, email, source: "login", verified: true });
  return { ...caller, email };
}

async function roleOf(userId: string, course = courseId) {
  const [seat] = await server.app.db
    .select({ role: courseStaff.role })
    .from(courseStaff)
    .where(and(eq(courseStaff.courseId, course), eq(courseStaff.userId, userId)));
  return seat?.role ?? null;
}

async function lastAudit(action: string) {
  const [row] = await server.app.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  outsider = await server.signIn("teacher");
});

afterAll(async () => {
  await server.close();
  restore();
});

/** A fresh course for every test: one owner, one assistant, one classroom. */
beforeEach(async () => {
  owner = await teacherWithAddress();
  assistant = await teacherWithAddress();
  courseId = randomUUID();
  classroomId = randomUUID();
  await server.app.db
    .insert(courses)
    .values({ id: courseId, name: "Programmation C", code: `PRG-${courseId.slice(0, 6)}` });
  await server.app.db.insert(courseStaff).values([
    { courseId, userId: owner.id, role: "owner" },
    { courseId, userId: assistant.id, role: "assistant" },
  ]);
  await server.app.db.insert(classrooms).values({ id: classroomId, courseId, name: "PRG1-A" });
});

describe("the migration", () => {
  it("makes an owner of a seat written without a role", async () => {
    const someone = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId, userId: someone.id });
    expect(await roleOf(someone.id)).toBe("owner");
  });
});

describe("owner-only course routes", () => {
  /** Each route with a body an owner would send successfully, and a malformed one. */
  const routes = (): {
    method: "POST" | "PATCH" | "PUT" | "DELETE";
    url: string;
    body?: Payload;
    bad?: Payload;
    ok: number;
  }[] => [
    { method: "PATCH", url: `/app/api/courses/${courseId}`, body: { name: "Renamed" }, bad: { name: 42 }, ok: 200 },
    { method: "PUT", url: `/app/api/courses/${courseId}/pools`, body: { pools: [] }, bad: { pools: "x" }, ok: 200 },
    {
      method: "POST",
      url: `/app/api/courses/${courseId}/classrooms`,
      body: { name: "PRG1-B" },
      bad: { name: 42 },
      ok: 201,
    },
    { method: "DELETE", url: `/app/api/classrooms/${classroomId}`, ok: 204 },
    { method: "DELETE", url: `/app/api/courses/${courseId}`, ok: 204 },
  ];

  it("answers 404 off the staff, 403 owner_required to an assistant (body or not), 2xx to an owner", async () => {
    for (const route of routes()) {
      const off = await send(route.method, route.url, outsider, route.bad ?? route.body);
      expect(off.statusCode, `${route.method} ${route.url}`).toBe(404);
      for (const payload of [route.body, route.bad]) {
        const refused = await send(route.method, route.url, assistant, payload);
        expect(refused.statusCode, `${route.method} ${route.url}`).toBe(403);
        expect(refused.json().error).toBe("owner_required");
      }
    }
    // The course goes last: it takes everything with it.
    for (const route of routes()) {
      const done = await send(route.method, route.url, owner, route.body);
      expect(done.statusCode, `${route.method} ${route.url}`).toBe(route.ok);
    }
  });

  it("leaves what every member may do open to an assistant", async () => {
    expect((await send("POST", `/app/api/courses/${courseId}/hide`, assistant)).statusCode).toBe(204);
    expect((await send("POST", `/app/api/courses/${courseId}/unhide`, assistant)).statusCode).toBe(204);
    expect((await send("PATCH", `/app/api/classrooms/${classroomId}`, assistant, { name: "PRG1-A2" })).statusCode).toBe(200);
    expect((await send("POST", `/app/api/classrooms/${classroomId}/archive`, assistant)).statusCode).toBe(204);
    expect((await send("GET", `/app/api/courses/${courseId}`, assistant)).statusCode).toBe(200);
  });

  it("lets an admin with Super Powers act as an owner, and one without act as their seat", async () => {
    const powered = await server.signInWithSuperPowers();
    expect((await send("PATCH", `/app/api/courses/${courseId}`, powered, { name: "By admin" })).statusCode).toBe(200);
    const plain = await server.signIn("admin");
    expect((await send("PATCH", `/app/api/courses/${courseId}`, plain, { name: "x" })).statusCode).toBe(404);
    await server.app.db.insert(courseStaff).values({ courseId, userId: plain.id, role: "assistant" });
    const seated = await send("PATCH", `/app/api/courses/${courseId}`, plain, { name: "x" });
    expect(seated.statusCode).toBe(403);
    expect(seated.json().error).toBe("owner_required");
  });
});

describe("the staff", () => {
  it("adds an assistant by default, audits the role, and refuses a second seat", async () => {
    const colleague = await teacherWithAddress();
    const url = `/app/api/courses/${courseId}/staff`;
    const refused = await send("POST", url, assistant, { email: colleague.email });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_required");
    expect((await send("POST", url, outsider, { email: colleague.email })).statusCode).toBe(404);

    const added = await send("POST", url, owner, { email: colleague.email });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ userId: colleague.id, role: "assistant" });
    expect(await roleOf(colleague.id)).toBe("assistant");
    expect((await lastAudit("course.staff_add"))?.payload).toMatchObject({ userId: colleague.id, role: "assistant" });

    const again = await send("POST", url, owner, { email: colleague.email, role: "owner" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_staff");
    expect(await roleOf(colleague.id)).toBe("assistant");

    const other = await teacherWithAddress();
    expect((await send("POST", url, owner, { email: other.email, role: "owner" })).statusCode).toBe(201);
    expect(await roleOf(other.id)).toBe("owner");
  });

  it("offers the teachers off the staff to an owner, by name or address, and nobody else", async () => {
    const colleague = await teacherWithAddress();
    const studentEmail = `s-${randomUUID().slice(0, 8)}@heig.test`;
    const student = await server.signIn("student", studentEmail);
    const url = (q: string) => `/app/api/courses/${courseId}/staff/candidates?q=${encodeURIComponent(q)}`;

    const refused = await send("GET", url(""), assistant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_required");
    expect((await send("GET", url(""), outsider)).statusCode).toBe(404);

    const ids = async (q: string) =>
      ((await send("GET", url(q), owner)).json() as { userId: string }[]).map((c) => c.userId);
    // Matched on the address, the current staff and the students left out.
    expect(await ids(colleague.email.slice(0, 8))).toEqual([colleague.id]);
    for (const seated of [owner, assistant]) expect(await ids(seated.email)).toEqual([]);
    expect(await ids(studentEmail)).toEqual([]);
    // `signIn` names a student "Test student": no name finds one either.
    expect(await ids("student")).not.toContain(student.id);
    // A typed `%` is a character, not a wildcard.
    expect(await ids("%")).toEqual([]);
    // Ten at most: a picker is searched, not browsed.
    expect((await ids("")).length).toBeLessThanOrEqual(10);
  });

  it("adds the account picked (by id), audits its address, and refuses a pick that is not a teacher", async () => {
    const colleague = await teacherWithAddress();
    const url = `/app/api/courses/${courseId}/staff`;
    const added = await send("POST", url, owner, { userId: colleague.id, role: "owner" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toEqual({ userId: colleague.id, role: "owner" });
    expect(await roleOf(colleague.id)).toBe("owner");
    expect((await lastAudit("course.staff_add"))?.payload).toMatchObject({
      userId: colleague.id,
      email: colleague.email,
      role: "owner",
    });
    const again = await send("POST", url, owner, { userId: colleague.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_staff");

    const student = await server.signIn("student", `s-${randomUUID().slice(0, 8)}@heig.test`);
    for (const userId of [student.id, randomUUID()]) {
      const unknown = await send("POST", url, owner, { userId });
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error).toBe("unknown_account");
    }
    expect(await roleOf(student.id)).toBeNull();

    // One of the two, never both, never neither.
    expect((await send("POST", url, owner, { userId: colleague.id, email: colleague.email })).statusCode).toBe(400);
    expect((await send("POST", url, owner, { role: "assistant" })).statusCode).toBe(400);
  });

  it("changes a role (owners only), audits it, and keeps the last owner", async () => {
    const url = (uid: string) => `/app/api/courses/${courseId}/staff/${uid}`;
    const refused = await send("PATCH", url(assistant.id), assistant, { role: "owner" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_required");
    // Before the body, as everywhere else.
    expect((await send("PATCH", url(assistant.id), assistant, { role: "boss" })).statusCode).toBe(403);
    expect((await send("PATCH", url(assistant.id), outsider, { role: "owner" })).statusCode).toBe(404);
    expect((await send("PATCH", url(outsider.id), owner, { role: "owner" })).statusCode).toBe(404);
    expect((await send("PATCH", url(assistant.id), owner, { role: "boss" })).statusCode).toBe(400);

    const lone = await send("PATCH", url(owner.id), owner, { role: "assistant" });
    expect(lone.statusCode).toBe(409);
    expect(lone.json().error).toBe("last_owner");

    const promoted = await send("PATCH", url(assistant.id), owner, { role: "owner" });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toEqual({ userId: assistant.id, role: "owner" });
    expect((await lastAudit("course.staff_role_change"))?.payload).toEqual({
      userId: assistant.id,
      from: "assistant",
      to: "owner",
    });

    // With another owner, an owner may step down themselves.
    expect((await send("PATCH", url(owner.id), owner, { role: "assistant" })).statusCode).toBe(200);
    expect(await roleOf(owner.id)).toBe("assistant");
    expect((await send("PATCH", url(assistant.id), assistant, { role: "assistant" })).json().error).toBe(
      "last_owner",
    );
  });

  it("lets an assistant leave, never remove another, and keeps the last owner", async () => {
    const url = (uid: string) => `/app/api/courses/${courseId}/staff/${uid}`;
    const colleague = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId, userId: colleague.id, role: "assistant" });

    const refused = await send("DELETE", url(colleague.id), assistant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_required");
    expect((await send("DELETE", url(owner.id), assistant)).statusCode).toBe(403);

    expect((await send("DELETE", url(assistant.id), assistant)).statusCode).toBe(204);
    expect(await roleOf(assistant.id)).toBeNull();
    // Off the staff now (and off the teacher role, their only seat gone).
    expect((await send("GET", `/app/api/courses/${courseId}`, assistant)).statusCode).not.toBe(200);

    const last = await send("DELETE", url(owner.id), owner);
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe("last_owner");
    expect((await send("DELETE", url(colleague.id), owner)).statusCode).toBe(204);
    expect((await lastAudit("course.staff_remove"))?.payload).toEqual({ userId: colleague.id, role: "assistant" });
    expect((await send("DELETE", url(colleague.id), owner)).statusCode).toBe(404);
  });

  it("never lets two owners demote each other down to none", async () => {
    await server.app.db
      .update(courseStaff)
      .set({ role: "owner" })
      .where(and(eq(courseStaff.courseId, courseId), eq(courseStaff.userId, assistant.id)));
    const [a, b] = await Promise.all([
      send("PATCH", `/app/api/courses/${courseId}/staff/${owner.id}`, assistant, { role: "assistant" }),
      send("PATCH", `/app/api/courses/${courseId}/staff/${assistant.id}`, owner, { role: "assistant" }),
    ]);
    // Whichever comes second is refused: by the last-owner count, or — its
    // author demoted already — by the role step.
    expect([a.statusCode, b.statusCode].filter((c) => c === 200)).toHaveLength(1);
    const owners = await server.app.db
      .select()
      .from(courseStaff)
      .where(and(eq(courseStaff.courseId, courseId), eq(courseStaff.role, "owner")));
    expect(owners).toHaveLength(1);
  });

  it("makes the creator of a course its owner", async () => {
    const res = await send("POST", "/app/api/courses", owner, { name: "New", code: `N-${randomUUID().slice(0, 6)}` });
    expect(res.statusCode).toBe(201);
    expect(await roleOf(owner.id, res.json().id)).toBe("owner");
  });
});

describe("the role each payload reports", () => {
  it("lists the staff's roles, and the caller's own on every course they reach, hidden ones included", async () => {
    const detail = (await send("GET", `/app/api/courses/${courseId}`, assistant)).json() as CourseDetail;
    expect(Object.fromEntries(detail.staff.map((s) => [s.userId, s.role]))).toEqual({
      [owner.id]: "owner",
      [assistant.id]: "assistant",
    });
    const mine = async (caller: Caller) =>
      ((await send("GET", "/app/api/courses", caller)).json() as CourseSummary[]).find((c) => c.id === courseId);
    expect((await mine(owner))?.myRole).toBe("owner");
    expect((await mine(assistant))?.myRole).toBe("assistant");
    expect((await mine(assistant))?.staff.find((s) => s.userId === owner.id)?.role).toBe("owner");
    expect((await mine(await server.signInWithSuperPowers()))?.myRole).toBe("owner");

    // The screens read the role from this list alone: a hidden course stays in it.
    expect((await send("POST", `/app/api/courses/${courseId}/hide`, assistant)).statusCode).toBe(204);
    expect(await mine(assistant)).toMatchObject({ hidden: true, myRole: "assistant" });
  });
});

describe("what reaches the students", () => {
  /** A closed exam and a running exercise of the owner's course, the assistant seated on it. */
  async function seeded(mode: "exam" | "exercise") {
    const seed = await seedLive(server.app.db, {
      teacherId: owner.id,
      questions: 1,
      mode,
      ...(mode === "exercise" ? { durationS: null, settings: { timing: "manual", lobby: "skip" } } : {}),
    });
    await server.app.db.insert(courseStaff).values({ courseId: seed.courseId, userId: assistant.id, role: "assistant" });
    if (mode === "exam") {
      await server.app.db.update(evaluations).set({ state: "closed" }).where(eq(evaluations.id, seed.evaluationId));
    } else {
      await applyState(server.app.db, await reload(server.app.db, seed.evaluationId), "running", server.clock.now());
    }
    return seed.evaluationId;
  }

  it("keeps release and unrelease to an owner", async () => {
    const id = await seeded("exam");
    const release = (caller: Caller, payload?: Payload) =>
      send("POST", `/app/api/evaluations/${id}/release`, caller, payload ?? { confirm: true });
    const unrelease = (caller: Caller) => send("POST", `/app/api/evaluations/${id}/unrelease`, caller);
    expect((await release(outsider)).statusCode).toBe(404);
    expect((await release(assistant)).json().error).toBe("owner_required");
    expect((await release(assistant, { confirm: "nope" })).statusCode).toBe(403);
    expect((await release(owner)).statusCode).toBe(200);
    expect((await unrelease(outsider)).statusCode).toBe(404);
    expect((await unrelease(assistant)).statusCode).toBe(403);
    expect((await unrelease(owner)).statusCode).toBe(200);

    // The course the screens look the reader's role up by.
    const detail = (await send("GET", `/app/api/evaluations/${id}`, assistant)).json() as EvaluationDetail;
    const [room] = await server.app.db.select().from(classrooms).where(eq(classrooms.id, detail.evaluation.classroomId));
    expect(detail.courseId).toBe(room!.courseId);
  });

  it("keeps the publication of a correction to an owner", async () => {
    const id = await seeded("exercise");
    const publish = (caller: Caller) =>
      send("POST", `/app/api/evaluations/${id}/publish-correction`, caller, { confirm: true });
    expect((await publish(outsider)).statusCode).toBe(404);
    const refused = await publish(assistant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("owner_required");
    expect((await publish(owner)).statusCode).toBe(200);
  });
});
