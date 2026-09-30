import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NotificationPayload } from "@quiz/contracts";

import {
  auditLog,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  notifications,
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

describe("classroom access", () => {
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

/** The notifications of `kind` an account holds, as their payloads. */
async function notificationsOf(userId: string, kind: string) {
  const rows = await server.app.db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(notifications.createdAt);
  return rows
    .map((r) => ({ payload: r.payload as NotificationPayload, read: r.readAt !== null }))
    .filter((r) => r.payload.kind === kind);
}

/**
 * #198: a student joining is told to the course's staff seats as a
 * `student_joined` notification (ADR-030 addendum): a count per classroom,
 * never a name, never on a stream a classmate holds, never to an admin who
 * holds no seat.
 */
describe("the student_joined notification", () => {
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
    const admin = await server.signIn("admin");
    return {
      ids: { classmate: classmate.id, admin: admin.id, outsider: outsider.id },
      streams: {
        staff: await openStream(teacher.headers),
        classmate: await openStream(classmate.headers),
        outsider: await openStream(outsider.headers),
        admin: await openStream(admin.headers),
      },
    };
  }

  async function expectStaffOnly(
    watched: Awaited<ReturnType<typeof watchers>>,
    joiner: { id: string; stream: { text: string } },
    name: string,
  ) {
    const told = await notificationsOf(teacher.id, "student_joined");
    expect(told.at(-1)!.payload).toEqual({
      kind: "student_joined",
      classroomId,
      classroomName: "PRG1-A",
      count: expect.any(Number),
    });
    for (const id of [...Object.values(watched.ids), joiner.id]) {
      expect(await notificationsOf(id, "student_joined")).toEqual([]);
    }
    // The staff's stream only hears "re-read your inbox"; nothing names the joiner.
    expect(watched.streams.staff.text).toContain('"kinds":["notifications"]');
    for (const stream of [...Object.values(watched.streams), joiner.stream]) {
      expect(stream.text).not.toContain(name);
      expect(stream.text).not.toContain("student_joined");
    }
    // The joiner still gets a bare refresh hint for their own screens.
    expect(joiner.stream.text).toContain('"kinds":["roster"]');
  }

  it("reaches the staff seats only when a roster line is claimed at login, folded per classroom", async () => {
    // A first claim leaves the classroom an unread entry for the second to fold into.
    const first = `ada-${randomUUID().slice(0, 8)}@heig.test`;
    await server.app.db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId, nom: "Lovelace", prenom: "Ada", email: first });
    expect(await claimEnrollments(server.app.db, { id: (await signInStudent(first)).id })).toBe(1);
    await settle();

    const before = await notificationsOf(teacher.id, "student_joined");
    expect(before.some((n) => !n.read)).toBe(true);
    const unread = before.find((n) => !n.read);
    const email = `grace-${randomUUID().slice(0, 8)}@heig.test`;
    await server.app.db
      .insert(enrollments)
      .values({ id: randomUUID(), classroomId, nom: "Hopper", prenom: "Grace", email });
    const watched = await watchers();
    const student = await signInStudent(email);
    const joiner = { id: student.id, stream: await openStream(student.headers) };
    await settle();

    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(1);
    await settle();

    await expectStaffOnly(watched, joiner, "Grace Hopper");
    // The unread entry of the classroom counts one more; no second row.
    const after = await notificationsOf(teacher.id, "student_joined");
    expect(after).toHaveLength(before.length);
    const count = (unread?.payload as { count?: number } | undefined)?.count ?? 0;
    expect((after.find((n) => !n.read)!.payload as { count: number }).count).toBe(count + 1);
    for (const s of [...Object.values(watched.streams), joiner.stream]) s.close();
  });
});

/**
 * #198: a roster line flagged as a conflict (AU-21) is a decision for the
 * course's staff. Every claim pass that raises flags tells them once per
 * classroom, with a count and no name — and never whoever ran the pass.
 */
describe("the roster_conflict notification", () => {
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

  /** The roster_conflict entries of `userId` about these classrooms. */
  const told = async (userId: string, ...rooms: string[]) =>
    (await notificationsOf(userId, "roster_conflict"))
      .map((n) => n.payload as { classroomId: string })
      .filter((p) => rooms.includes(p.classroomId));

  const expected = (classroomId: string, classroomName: string, count: number) => ({
    kind: "roster_conflict",
    classroomId,
    classroomName,
    count,
  });

  it("from the login claim: one entry per classroom, ambiguous lines and a second seat alike", async () => {
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

    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(0);

    for (const staff of [teacher.id, colleague.id]) {
      const entries = await told(staff, a.id, b.id);
      expect(entries).toEqual(
        expect.arrayContaining([expected(a.id, "CONF-A", 2), expected(b.id, "CONF-B", 1)]),
      );
      expect(entries).toHaveLength(2);
    }
    for (const who of [a.classmate.id, outsider.id, student.id]) {
      expect(await told(who, a.id, b.id)).toEqual([]);
    }
    // The UNIQUE branch is audited like the others.
    const logged = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "roster.claim_conflict"), eq(auditLog.subjectId, second)));
    expect(logged).toHaveLength(1);

    // A line already flagged waits for a teacher: the next login says nothing.
    expect(await claimEnrollments(server.app.db, { id: student.id })).toBe(0);
    expect(await told(colleague.id, a.id, b.id)).toEqual(
      expect.arrayContaining([expected(a.id, "CONF-A", 2), expected(b.id, "CONF-B", 1)]),
    );
  });

  it("from an import: one entry with the count, to the staff but not the importer", async () => {
    const r = await room("CONF-C");
    const shared = `twin-${tag()}@heig.test`;
    await account(`twin-a-${tag()}@gmail.test`, shared);
    await account(`twin-b-${tag()}@gmail.test`, shared);
    const priv = `tom-${tag()}@gmail.test`;
    const inst = `tom-${tag()}@heig.test`;
    await account(priv, inst);

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

    expect(await told(colleague.id, r.id)).toEqual([expected(r.id, "CONF-C", 3)]);
    expect(await told(teacher.id, r.id)).toEqual([]);
    expect(await told(r.classmate.id, r.id)).toEqual([]);
    expect(JSON.stringify(await told(colleague.id, r.id))).not.toContain(shared);
  });

  it("from an e-mail edit: one entry, to the staff but not the editor", async () => {
    const r = await room("CONF-D");
    const shared = `pair-${tag()}@heig.test`;
    await account(`pair-a-${tag()}@gmail.test`, shared);
    await account(`pair-b-${tag()}@gmail.test`, shared);
    const entry = await line(r.id, `typo-${tag()}@heig.test`);

    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${r.id}/roster/${entry}`,
      headers: teacher.headers,
      payload: { email: shared },
    });
    expect(patched.statusCode).toBe(200);

    expect(await told(colleague.id, r.id)).toEqual([expected(r.id, "CONF-D", 1)]);
    expect(await told(teacher.id, r.id)).toEqual([]);
  });

  it("refreshes the staff's rosters, except the stream of whoever raised it", async () => {
    const r = await room("CONF-E");
    const shared = `hint-${tag()}@heig.test`;
    await account(`hint-a-${tag()}@gmail.test`, shared);
    await account(`hint-b-${tag()}@gmail.test`, shared);
    const entry = await line(r.id, `typo-${tag()}@heig.test`);
    const streams = {
      teacher: await openStream(teacher.headers),
      colleague: await openStream(colleague.headers),
    };
    await settle();
    await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${r.id}/roster/${entry}`,
      headers: teacher.headers,
      payload: { email: shared },
    });
    await settle();
    expect(streams.colleague.text).toContain('"kinds":["roster"]');
    expect(streams.colleague.text).toContain('"kinds":["notifications"]');
    expect(streams.colleague.text).not.toContain(shared);
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

    // A hint on the course no longer reaches the removed colleague.
    const [teacherBefore, colleagueBefore] = [streams.teacher.text, streams.colleague.text];
    studentJoined({ courseId: course, userId: randomUUID() });
    await settle();
    expect(streams.teacher.text.slice(teacherBefore.length)).toContain('"kinds":["roster"]');
    expect(streams.colleague.text).toBe(colleagueBefore);

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

describe("PATCH /courses/:id (#294)", () => {
  const course = async (code: string) => {
    const id = randomUUID();
    await server.app.db.insert(courses).values({ id, name: "Old name", code });
    await server.app.db.insert(courseStaff).values({ courseId: id, userId: teacher.id });
    return id;
  };
  const patch = (id: string, payload: Payload) =>
    server.app.inject({
      method: "PATCH",
      url: `/app/api/courses/${id}`,
      headers: teacher.headers,
      payload,
    });

  it("renames the course, trimmed, and audits it", async () => {
    const id = await course("RENAME1");
    const res = await patch(id, { name: "  New name " });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "New name" });
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "course.update"), eq(auditLog.subjectId, id)));
    expect(entry).toBeDefined();
  });

  it("refuses a blank name with a 400, and keeps the old one", async () => {
    const id = await course("RENAME2");
    expect((await patch(id, { name: "   " })).statusCode).toBe(400);
    const [row] = await server.app.db.select().from(courses).where(eq(courses.id, id));
    expect(row!.name).toBe("Old name");
  });
});

describe("a blank classroom name", () => {
  it("is refused with a 400 at creation and on PATCH", async () => {
    const created = await server.app.inject({
      method: "POST",
      url: `/app/api/courses/${courseId}/classrooms`,
      headers: teacher.headers,
      payload: { name: "   " },
    });
    expect(created.statusCode).toBe(400);
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${classroomId}`,
      headers: teacher.headers,
      payload: { name: "  " },
    });
    expect(patched.statusCode).toBe(400);
    const [row] = await server.app.db.select().from(classrooms).where(eq(classrooms.id, classroomId));
    expect(row!.name).toBe("PRG1-A");
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
