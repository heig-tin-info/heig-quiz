import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CourseDetail } from "@quiz/contracts";

import {
  auditLog,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  userEmails,
} from "../../db/schema.js";
import { type Payload, testServer, type TestServer } from "../../test/http.js";
import { studentJoined } from "../realtime/bus.js";
import { claimEnrollments } from "./roster.js";

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
    expect(rows[0]!.userId).toBe(student.id);
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

/** Opens the inherited SSE stream and collects what it receives. */
async function openStream(headers: Record<string, string>) {
  const res = await server.app.inject({
    method: "GET",
    url: "/app/api/events",
    headers,
    payloadAsStream: true,
  });
  expect(res.statusCode).toBe(200);
  let text = "";
  let ended = false;
  res.stream().on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  res.stream().on("end", () => (ended = true));
  return {
    get text() {
      return text;
    },
    /** The server ended the stream (the client would reconnect). */
    get ended() {
      return ended;
    },
    close: () => res.stream().destroy(),
  };
}

/** Lets the event loop deliver what the handler wrote. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * #198: the notice named the joiner on `classroom:<id>` and on the joiner's
 * own topic, so every classmate with a tab open — and the joiner — was told.
 * It reaches the course's staff only, as facts the web app translates.
 */
describe("the student_joined notice", () => {
  async function watchers() {
    const classmate = await server.signIn("student");
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId,
      nom: "Pair",
      prenom: "Classmate",
      email: `classmate-${randomUUID().slice(0, 8)}@heig.test`,
      userId: classmate.id,
      claimedAt: new Date(),
    });
    return {
      staff: await openStream(teacher.headers),
      classmate: await openStream(classmate.headers),
      outsider: await openStream(outsider.headers),
    };
  }

  function expectStaffOnly(
    streams: Awaited<ReturnType<typeof watchers>> & { joiner: { text: string } },
    name: string,
  ) {
    const notice = { kind: "student_joined", name, classroomName: "PRG1-A" };
    expect(streams.staff.text).toContain(JSON.stringify(notice));
    for (const who of ["classmate", "joiner", "outsider"] as const) {
      expect(streams[who].text).not.toContain("student_joined");
      expect(streams[who].text).not.toContain(name);
    }
    // The joiner still gets a bare refresh hint for their own screens.
    expect(streams.joiner.text).toContain('"kinds":["roster"]');
  }

  it("reaches the staff only when a student joins by code", async () => {
    const code = await enableJoinCode();
    const streams = await watchers();
    const student = await signInStudent(`joiner-${randomUUID().slice(0, 8)}@heig.test`);
    const joiner = await openStream(student.headers);
    await settle();

    const joined = await server.app.inject({
      method: "POST",
      url: `/app/api/join/${code}`,
      headers: student.headers,
    });
    expect(joined.statusCode).toBe(201);
    await settle();

    expectStaffOnly({ ...streams, joiner }, "Test student");
    for (const s of [...Object.values(streams), joiner]) s.close();
  });

  it("reaches the staff only when a roster line is claimed at login", async () => {
    const email = `grace-${randomUUID().slice(0, 8)}@heig.test`;
    await server.app.db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId, nom: "Hopper", prenom: "Grace", email });
    const streams = await watchers();
    const student = await signInStudent(email);
    const joiner = await openStream(student.headers);
    await settle();

    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(1);
    await settle();

    expectStaffOnly({ ...streams, joiner }, "Grace Hopper");
    for (const s of [...Object.values(streams), joiner]) s.close();
  });
});

/**
 * #198: a roster line flagged as a conflict (AU-21) is a decision for the
 * course's staff. Every claim pass that raises flags says so once per
 * classroom, with a count and no name — and never to whoever ran the pass.
 */
describe("the roster_conflict notice", () => {
  let colleague: Awaited<ReturnType<TestServer["signIn"]>>;
  const course = randomUUID();
  beforeAll(async () => {
    colleague = await server.signIn("teacher");
    await server.app.db
      .insert(courses)
      .values({ id: course, name: "Conflicts", code: `CONF-${course.slice(0, 6)}` });
    await server.app.db.insert(courseStaff).values([
      { courseId: course, userId: teacher.id },
      { courseId: course, userId: colleague.id },
    ]);
  });

  const tag = () => randomUUID().slice(0, 8);

  /** A fresh classroom of the course, with a claimed classmate in it. */
  async function room(name: string) {
    const id = randomUUID();
    await server.app.db.insert(classrooms).values({ id, courseId: course, name, period: "2026-A" });
    const classmate = await server.signIn("student");
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: id,
      nom: "Pair",
      prenom: "Classmate",
      email: `classmate-${tag()}@heig.test`,
      userId: classmate.id,
      claimedAt: new Date(),
    });
    return { id, classmate };
  }

  async function line(classroomId: string, email: string, userId: string | null = null) {
    const id = randomUUID();
    await server.app.db.insert(enrollments).values({
      id,
      classroomId,
      nom: "Doe",
      prenom: "Jane",
      email,
      userId,
      claimedAt: userId ? new Date() : null,
    });
    return id;
  }

  /** An account holding these verified addresses (GH-11). */
  async function account(...emails: string[]) {
    const student = await signInStudent(emails[0]!);
    for (const email of emails.slice(1)) {
      await server.app.db
        .insert(userEmails)
        .values({ userId: student.id, email, source: "swissEduIDLinkedAffiliationMail", verified: true });
    }
    return student;
  }

  const notices = (text: string) =>
    text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => (JSON.parse(l.slice(6)) as { notice?: { kind: string } | null }).notice)
      .filter((n) => n?.kind === "roster_conflict");

  const notice = (classroomId: string, classroomName: string, count: number) => ({
    kind: "roster_conflict",
    classroomId,
    classroomName,
    count,
  });

  it("from the login claim: one notice per classroom, ambiguous lines and a second seat alike", async () => {
    const a = await room("CONF-A");
    const b = await room("CONF-B");
    const priv = `jane-${tag()}@gmail.test`;
    const inst = `jane-${tag()}@heig.test`;
    const student = await account(priv, inst);
    // A: two lines of one classroom match the account.
    await line(a.id, priv);
    await line(a.id, inst);
    // B: the account already holds a seat; the second line hits UNIQUE.
    await line(b.id, `old-${tag()}@heig.test`, student.id);
    const second = await line(b.id, inst);
    const streams = {
      teacher: await openStream(teacher.headers),
      colleague: await openStream(colleague.headers),
      classmate: await openStream(a.classmate.headers),
      outsider: await openStream(outsider.headers),
      student: await openStream(student.headers),
    };
    await settle();

    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(0);
    await settle();

    for (const staff of [streams.teacher, streams.colleague]) {
      expect(notices(staff.text)).toEqual(
        expect.arrayContaining([notice(a.id, "CONF-A", 2), notice(b.id, "CONF-B", 1)]),
      );
      expect(notices(staff.text)).toHaveLength(2);
    }
    for (const who of ["classmate", "outsider", "student"] as const) {
      expect(notices(streams[who].text)).toEqual([]);
    }
    // The UNIQUE branch is audited like the others.
    const logged = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "roster.claim_conflict"), eq(auditLog.subjectId, second)));
    expect(logged).toHaveLength(1);

    // A line already flagged waits for a teacher: the next login says nothing.
    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(0);
    await settle();
    expect(notices(streams.colleague.text)).toHaveLength(2);
    for (const s of Object.values(streams)) s.close();
  });

  it("from an import: one notice with the count, to the staff but not the importer", async () => {
    const r = await room("CONF-C");
    const shared = `twin-${tag()}@heig.test`;
    await account(`twin-a-${tag()}@gmail.test`, shared);
    await account(`twin-b-${tag()}@gmail.test`, shared);
    const priv = `tom-${tag()}@gmail.test`;
    const inst = `tom-${tag()}@heig.test`;
    await account(priv, inst);
    const streams = {
      teacher: await openStream(teacher.headers),
      colleague: await openStream(colleague.headers),
      classmate: await openStream(r.classmate.headers),
    };
    await settle();

    const rows = [
      ["Nom", "Prénom", "E-mail"],
      ["Twin", "Ann", shared],
      ["Colau", "Tom", priv],
      ["Colau", "Tom", inst],
    ];
    const imported = await server.app.inject({
      method: "POST",
      url: `/app/api/classrooms/${r.id}/roster`,
      headers: teacher.headers,
      payload: { rows },
    });
    expect(imported.statusCode).toBe(200);
    await settle();

    expect(notices(streams.colleague.text)).toEqual([notice(r.id, "CONF-C", 3)]);
    expect(notices(streams.teacher.text)).toEqual([]);
    expect(notices(streams.classmate.text)).toEqual([]);
    expect(streams.colleague.text).not.toContain(shared);
    for (const s of Object.values(streams)) s.close();
  });

  it("from an e-mail edit: one notice, to the staff but not the editor", async () => {
    const r = await room("CONF-D");
    const shared = `pair-${tag()}@heig.test`;
    await account(`pair-a-${tag()}@gmail.test`, shared);
    await account(`pair-b-${tag()}@gmail.test`, shared);
    const entry = await line(r.id, `typo-${tag()}@heig.test`);
    const streams = {
      teacher: await openStream(teacher.headers),
      colleague: await openStream(colleague.headers),
    };
    await settle();

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${r.id}/roster/${entry}`,
      headers: teacher.headers,
      payload: { email: shared },
    });
    expect(patched.statusCode).toBe(200);
    await settle();

    expect(notices(streams.colleague.text)).toEqual([notice(r.id, "CONF-D", 1)]);
    expect(notices(streams.teacher.text)).toEqual([]);
    for (const s of Object.values(streams)) s.close();
  });
});

/**
 * #248: a stream's topics are computed once, at connection. Whoever loses a
 * seat or a roster line has their streams closed, so the reconnection holds
 * only what they may still reach.
 */
describe("losing access closes the streams", () => {
  it("ends a removed staff member's, a removed and an unclaimed student's streams, and only theirs", async () => {
    const course = randomUUID();
    const room = randomUUID();
    const entry = randomUUID();
    const colleague = await server.signIn("teacher");
    const student = await server.signIn("student");
    const detached = await server.signIn("student");
    const detachedEntry = randomUUID();
    await server.app.db.insert(courses).values({ id: course, name: "Réseaux", code: `RES-${course.slice(0, 6)}` });
    await server.app.db.insert(courseStaff).values([
      { courseId: course, userId: teacher.id },
      { courseId: course, userId: colleague.id },
    ]);
    await server.app.db.insert(classrooms).values({ id: room, courseId: course, name: "RES-A", period: "2026-A" });
    await server.app.db.insert(enrollments).values({
      id: entry,
      classroomId: room,
      nom: "Lovelace",
      prenom: "Ada",
      email: `ada-${entry.slice(0, 8)}@heig.test`,
      userId: student.id,
      claimedAt: new Date(),
    });
    await server.app.db.insert(enrollments).values({
      id: detachedEntry,
      classroomId: room,
      nom: "Hamilton",
      prenom: "Margaret",
      email: `margaret-${detachedEntry.slice(0, 8)}@heig.test`,
      userId: detached.id,
      claimedAt: new Date(),
    });
    const streams = {
      teacher: await openStream(teacher.headers),
      colleague: await openStream(colleague.headers),
      student: await openStream(student.headers),
      detached: await openStream(detached.headers),
    };
    await settle();

    const unseated = await server.app.inject({
      method: "DELETE",
      url: `/app/api/courses/${course}/staff/${colleague.id}`,
      headers: teacher.headers,
    });
    expect(unseated.statusCode).toBe(204);
    await settle();
    expect(streams.colleague.ended).toBe(true);
    expect(streams.teacher.ended).toBe(false);
    expect(streams.student.ended).toBe(false);

    // A notice on the course no longer reaches the removed colleague.
    studentJoined({ courseId: course, classroomName: "RES-A", userId: randomUUID(), name: "Late Joiner" });
    await settle();
    expect(streams.teacher.text).toContain("Late Joiner");
    expect(streams.colleague.text).not.toContain("Late Joiner");

    const removed = await server.app.inject({
      method: "DELETE",
      url: `/app/api/classrooms/${room}/roster/${entry}`,
      headers: teacher.headers,
    });
    expect(removed.statusCode).toBe(204);
    await settle();
    expect(streams.student.ended).toBe(true);
    expect(streams.detached.ended).toBe(false);

    // Unclaiming a line detaches its student from the classroom just the same.
    const unclaimed = await server.app.inject({
      method: "POST",
      url: `/app/api/classrooms/${room}/roster/${detachedEntry}/unclaim`,
      headers: teacher.headers,
    });
    expect(unclaimed.statusCode).toBe(200);
    await settle();
    expect(streams.detached.ended).toBe(true);
    expect(streams.teacher.ended).toBe(false);

    for (const s of Object.values(streams)) s.close();
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

describe("dated period (F-ORG-03, #156)", () => {
  // A course of its own: the other blocks count the classrooms of `courseId`.
  const courseId = randomUUID();
  beforeAll(async () => {
    await server.app.db.insert(courses).values({ id: courseId, name: "Périodes", code: "PER1" });
    await server.app.db.insert(courseStaff).values({ courseId, userId: teacher.id });
  });

  const create = (payload: Record<string, unknown>) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/courses/${courseId}/classrooms`,
      headers: teacher.headers,
      payload,
    });

  it("creates an undated classroom by default, and a dated one on request", async () => {
    const undated = await create({ name: "Sans dates" });
    expect(undated.statusCode).toBe(201);
    expect(undated.json()).toMatchObject({ periodStart: null, periodEnd: null });

    const dated = await create({
      name: "Automne",
      period: "Automne 2026",
      periodStart: "2026-09",
      periodEnd: "2027-01",
    });
    expect(dated.statusCode).toBe(201);
    const detail = await server.app.inject({
      method: "GET",
      url: `/app/api/classrooms/${dated.json().id}`,
      headers: teacher.headers,
    });
    expect(detail.json()).toMatchObject({
      period: "Automne 2026",
      periodStart: "2026-09",
      periodEnd: "2027-01",
    });
  });

  it("validates the months with the contract (its cases are tested there)", async () => {
    expect(
      (await create({ name: "x", periodStart: "2027-01", periodEnd: "2026-09" })).statusCode,
    ).toBe(400);
  });

  it("dates, then undates, a classroom by PATCH, and audits both periods", async () => {
    const id = (await create({ name: "Printemps" })).json().id as string;
    const patch = (payload: Payload) =>
      server.app.inject({
        method: "PATCH",
        url: `/app/api/classrooms/${id}`,
        headers: teacher.headers,
        payload,
      });
    const dated = await patch({ periodStart: "2027-02", periodEnd: "2027-07" });
    expect(dated.json()).toMatchObject({ periodStart: "2027-02", periodEnd: "2027-07" });
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "classroom.rename"), eq(auditLog.subjectId, id)));
    expect(entry!.payload).toMatchObject({
      periodFrom: { period: "", periodStart: null, periodEnd: null },
      periodTo: { period: "", periodStart: "2027-02", periodEnd: "2027-07" },
    });
    const cleared = await patch({ periodStart: null, periodEnd: null });
    expect(cleared.json()).toMatchObject({ periodStart: null, periodEnd: null });
  });

  it("is also enforced by the database check", async () => {
    const insert = (periodStart: string | null, periodEnd: string | null) =>
      server.app.db
        .insert(classrooms)
        .values({ id: randomUUID(), courseId, name: "raw", periodStart, periodEnd });
    await expect(insert("2026-09", null)).rejects.toThrow();
    await expect(insert("2027-01", "2026-09")).rejects.toThrow();
    await expect(insert("2026-13", "2027-01")).rejects.toThrow();
    await expect(insert("2026-09", "2026-09")).resolves.toBeDefined();
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

/**
 * The order of the refusals, which the org routes keep on `teacherRoute`
 * (audit B-02, B-12): session and role (preHandler) → params (404) → the
 * entity under `staffAccess` (404, invariant 6) → body (400), the
 * `details` of `invalid()`.
 */
describe("the order of the refusals, over HTTP", () => {
  it("refuses session, role, params, access, then body", async () => {
    const student = await server.signIn("student");
    const entryId = randomUUID();
    await server.app.db.insert(enrollments).values({
      id: entryId,
      classroomId,
      nom: "Liskov",
      prenom: "Barbara",
      email: `barbara-${entryId.slice(0, 8)}@heig.test`,
    });
    const patch = (url: string, headers: Record<string, string>, payload: Payload) =>
      server.app.inject({ method: "PATCH", url, headers, payload });

    for (const [url, badBody] of [
      [`/app/api/courses/${courseId}`, { name: 42 }],
      [`/app/api/classrooms/${classroomId}`, { name: 42 }],
      [`/app/api/classrooms/${classroomId}/roster/${entryId}`, { timeBonusPercent: 4000 }],
    ] as const) {
      const badParams = url.replace(/[0-9a-f-]{36}$/, "x");
      expect((await patch(url, {}, badBody)).statusCode).toBe(401);
      expect((await patch(url, student.headers, badBody)).statusCode).toBe(403);
      const malformedId = await patch(badParams, teacher.headers, badBody);
      expect(malformedId.statusCode).toBe(404);
      expect(malformedId.json()).toEqual({ error: "not_found" });
      // Out of reach: the 404 wins over the malformed body.
      const unreachable = await patch(url, outsider.headers, badBody);
      expect(unreachable.statusCode).toBe(404);
      expect(unreachable.json()).toEqual({ error: "not_found" });
      const malformed = await patch(url, teacher.headers, badBody);
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().error).toBe("validation");
      expect(Array.isArray(malformed.json().details)).toBe(true);
    }

    // A second parameter is checked with the first: a malformed staff id is
    // the same 404 as a course out of reach.
    const del = (url: string, headers: Record<string, string>) =>
      server.app.inject({ method: "DELETE", url, headers });
    expect((await del(`/app/api/courses/${courseId}/staff/x`, teacher.headers)).statusCode).toBe(
      404,
    );
    expect(
      (await del(`/app/api/courses/${courseId}/staff/${teacher.id}`, outsider.headers)).statusCode,
    ).toBe(404);
    // …and the last seat of the staff is never removed.
    const last = await del(`/app/api/courses/${courseId}/staff/${teacher.id}`, teacher.headers);
    expect(last.statusCode).toBe(409);
    expect(last.json().error).toBe("last_staff");
  });
});
