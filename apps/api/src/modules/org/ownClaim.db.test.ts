/**
 * Audit L4 (ADR-053, addendum of 2026-10-11): a roster line is attached to an
 * account only when the PERSON acts — at their sign-in, or at their next own
 * request on their own portal session — never by a teacher's import or
 * e-mail edit. Until then the staff's roster shows nothing of the account,
 * not even that it exists.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CSRF_COOKIE } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { issueImpersonation, openImpersonation, openSebSession } from "../../auth/testing.js";
import { createApiToken } from "../../auth/tokens.js";
import {
  avatars,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  notifications,
  userEmails,
  users,
} from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

type Who = { id: string; headers: Record<string, string> };

let server: TestServer;
let restore: () => void;
let teacher: Who;
let courseId: string;

const tag = () => randomUUID().slice(0, 8);

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  teacher = await server.signIn("teacher");
  courseId = randomUUID();
  await server.app.db.insert(courses).values({ id: courseId, name: "Programmation C", code: `OWN-${tag()}` });
  await server.app.db.insert(courseStaff).values({ courseId, userId: teacher.id });
});

afterAll(async () => {
  await server.close();
  restore();
});

/** A classroom of the course, connected to GitHub when asked. */
async function room(name: string, connected = false) {
  const id = randomUUID();
  await server.app.db.insert(classrooms).values({ id, courseId, name });
  if (connected) {
    const orgId = randomUUID();
    await server.app.db.insert(githubOrganizations).values({ id: orgId, login: `org-${tag()}` });
    await server.app.db.insert(githubClassroomLinks).values({ classroomId: id, orgId, linkedBy: teacher.id });
  }
  return id;
}

/** An account holding these verified addresses (GH-11), with a portal session that made no request yet. */
async function account(...emails: string[]): Promise<Who> {
  const who = await server.signIn("student", emails[0]);
  await server.app.db
    .insert(userEmails)
    .values(emails.map((email) => ({ userId: who.id, email, source: "login", verified: true })));
  return who;
}

/** Another portal session of the same account, as a second sign-in opens it. */
async function portalSession(userId: string): Promise<Record<string, string>> {
  const session = await createSession(server.app.db, userId, 12);
  return {
    cookie: `${server.app.cookieName(SESSION_COOKIE)}=${session.token}; ${server.app.cookieName(CSRF_COOKIE)}=${session.csrf}`,
    "x-csrf-token": session.csrf,
  };
}

const importRows = (classroomId: string, ...lines: [string, string, string][]) =>
  server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${classroomId}/roster`,
    headers: teacher.headers,
    payload: { rows: [["Nom", "Prénom", "E-mail"], ...lines] },
  });

interface RosterRow {
  id: string;
  email: string;
  status: "pending" | "claimed";
  conflictFlag: boolean;
  userId: string | null;
  lastLoginAt: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
}

/** The staff's roster of a classroom, as the teacher's page reads it. */
async function roster(classroomId: string): Promise<RosterRow[]> {
  const res = await server.app.inject({ method: "GET", url: `/app/api/classrooms/${classroomId}`, headers: teacher.headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { roster: RosterRow[] }).roster;
}

const lineOf = async (classroomId: string, email: string) =>
  (await roster(classroomId)).find((r) => r.email === email)!;

/** The classrooms a student holds a seat in, as their home reads them. */
async function myClassrooms(headers: Record<string, string>): Promise<string[]> {
  const res = await server.app.inject({ method: "GET", url: "/app/api/student/classrooms", headers });
  expect(res.statusCode).toBe(200);
  return (res.json() as { id: string }[]).map((c) => c.id);
}

/** A pending line written straight into the table: no roster write, so no reason for a session to look again. */
async function quietLine(classroomId: string, email: string) {
  const id = randomUUID();
  await server.app.db.insert(enrollments).values({ id, classroomId, nom: "Quiet", prenom: "Line", email });
  return id;
}

const holder = async (entryId: string) =>
  (await server.app.db.select({ userId: enrollments.userId }).from(enrollments).where(eq(enrollments.id, entryId)))[0]!
    .userId;

/** Opens the SSE stream and collects what it receives. */
async function openStream(headers: Record<string, string>) {
  const res = await server.app.inject({ method: "GET", url: "/app/api/events", headers, payloadAsStream: true });
  expect(res.statusCode).toBe(200);
  let text = "";
  res.stream().on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
  return {
    get text() {
      return text;
    },
    close: () => res.stream().destroy(),
  };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

const told = async (userId: string, kind: string, classroomId: string) =>
  (await server.app.db.select().from(notifications).where(eq(notifications.userId, userId)))
    .map((n) => n.payload as { kind: string; classroomId: string; count: number })
    .filter((p) => p.kind === kind && p.classroomId === classroomId);

const UNATTACHED = { status: "pending", conflictFlag: false, userId: null, lastLoginAt: null, githubLogin: null, avatarUrl: null };

describe("a staff write attaches nobody (audit L4)", () => {
  it("shows nothing of an existing account after an import or an e-mail edit; the person's own request claims", async () => {
    // Someone who used Quiz before: a sign-in, an uploaded avatar, a linked
    // GitHub account, and an address a second account also holds.
    const own = `ada-${tag()}@heig.test`;
    const shared = `shared-${tag()}@heig.test`;
    const ada = await account(own, shared);
    const twin = await account(`twin-${tag()}@gmail.test`, shared);
    await server.app.db.update(users).set({ lastLoginAt: new Date("2026-09-01T08:00:00Z") }).where(eq(users.id, ada.id));
    await server.app.db.insert(avatars).values({ userId: ada.id, data: Buffer.from("png"), contentType: "image/png" });
    await server.app.db
      .insert(githubAccounts)
      .values({ userId: ada.id, githubUserId: 8_000_000 + Math.floor(Math.random() * 1e6), login: `ada-${tag()}` });

    const imported = await room("L4-import", true);
    const edited = await room("L4-edit", true);
    const flagged = await room("L4-shared", true);

    expect((await importRows(imported, ["Lovelace", "Ada", own])).statusCode).toBe(200);
    expect((await importRows(edited, ["Lovelace", "Ada", `typo-${tag()}@heig.test`])).statusCode).toBe(200);
    const typo = (await roster(edited))[0]!;
    const patched = await server.app.inject({
      method: "PATCH",
      url: `/app/api/classrooms/${edited}/roster/${typo.id}`,
      headers: teacher.headers,
      payload: { email: own },
    });
    expect(patched.statusCode).toBe(200);
    expect((await importRows(flagged, ["Twin", "Ann", shared])).statusCode).toBe(200);

    expect(await lineOf(imported, own)).toMatchObject(UNATTACHED);
    expect(await lineOf(edited, own)).toMatchObject(UNATTACHED);
    // Two accounts hold this address: no pass ran, so nothing is flagged yet.
    expect(await lineOf(flagged, shared)).toMatchObject(UNATTACHED);
    expect(await told(teacher.id, "roster_conflict", flagged)).toEqual([]);

    const staff = await openStream(teacher.headers);
    await settle();
    const before = staff.text.length;

    // Ada's own request: her seats are hers, in this very response.
    const mine = await myClassrooms(ada.headers);
    expect(mine).toEqual(expect.arrayContaining([imported, edited]));
    expect(mine).not.toContain(flagged);
    await settle();

    for (const classroomId of [imported, edited]) {
      expect(await lineOf(classroomId, own)).toMatchObject({ status: "claimed", userId: ada.id, conflictFlag: false });
      expect(await told(teacher.id, "student_joined", classroomId)).toEqual([
        expect.objectContaining({ kind: "student_joined", classroomId, count: 1 }),
      ]);
    }
    expect(await lineOf(imported, own)).toMatchObject({ lastLoginAt: expect.any(String), githubLogin: expect.any(String), avatarUrl: expect.any(String) });
    // The shared address is decided at claim time, as at a sign-in (AU-21):
    // flagged, and the importer is told this time, the pass being Ada's.
    expect(await lineOf(flagged, shared)).toMatchObject({ status: "pending", conflictFlag: true, userId: null });
    expect(await told(teacher.id, "roster_conflict", flagged)).toEqual([
      expect.objectContaining({ kind: "roster_conflict", classroomId: flagged, count: 1 }),
    ]);
    // The staff's roster screens refresh.
    expect(staff.text.slice(before)).toContain('"kinds":["roster"]');
    expect(staff.text.slice(before)).not.toContain(own);
    staff.close();
    expect(await myClassrooms(twin.headers)).not.toContain(flagged);
  });
});

describe("who claims on a request", () => {
  it("never an impersonation, a seb session nor a bearer token; the own portal session once until a roster write", async () => {
    const admin = await server.signInWithSuperPowers();
    const email = `grace-${tag()}@heig.test`;
    const grace = await account(email);
    const seed = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [grace.id],
      mode: "exam",
      settings: { safeExamBrowser: true },
    });
    const started = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${seed.evaluationId}/start`,
      headers: teacher.headers,
      payload: { confirm: true },
    });
    expect(started.statusCode, started.body).toBe(200);
    const [seat] = await server.app.db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, seed.classroomId), eq(enrollments.userId, grace.id)));

    // Her own session ran its claim pass on its first request; the sessions
    // acting through her account are opened before her new line exists.
    expect(await myClassrooms(grace.headers)).toEqual([seed.classroomId]);
    const sitting = await openSebSession(server, seed.evaluationId, grace.headers);
    const link = await issueImpersonation(server, admin.headers, seed.classroomId, seat!.id);
    expect(typeof link).toBe("string");
    const impersonation = (await openImpersonation(server, link as string))!;
    const { token } = await createApiToken(server.app.db, grace.id, { name: "cli", expiresInDays: 1 });

    const later = await room("L4-who");
    const entry = await quietLine(later, email);

    const me = (headers: Record<string, string>) => server.app.inject({ method: "GET", url: "/app/api/me", headers });
    expect((await me(impersonation)).statusCode).toBe(200);
    expect((await me(sitting("/app/api/me"))).statusCode).toBe(200);
    expect((await me({ authorization: `Bearer ${token}` })).statusCode).toBe(200);
    expect(await holder(entry)).toBeNull();

    // Her own session already looked, and no roster write came since: it
    // does not look again.
    expect(await myClassrooms(grace.headers)).toEqual([seed.classroomId]);
    expect(await holder(entry)).toBeNull();

    // A new session of hers looks once, and claims.
    expect(await myClassrooms(await portalSession(grace.id))).toEqual(expect.arrayContaining([seed.classroomId, later]));
    expect(await holder(entry)).toBe(grace.id);
  });

  it("exam day: a line added in the lobby is the student's at their next request", async () => {
    const email = `late-${tag()}@heig.test`;
    const late = await account(email);
    const lobby = await room("L4-lobby");
    // Signed in, and not on the list: the classroom is not theirs.
    expect(await myClassrooms(late.headers)).not.toContain(lobby);

    // The teacher adds the missing line from the lobby (the roster import, one row).
    expect((await importRows(lobby, ["Late", "Student", email])).statusCode).toBe(200);
    expect(await lineOf(lobby, email)).toMatchObject(UNATTACHED);

    // The student refreshes: the same session, now claimed.
    expect(await myClassrooms(late.headers)).toContain(lobby);
    expect(await lineOf(lobby, email)).toMatchObject({ status: "claimed", userId: late.id });
  });
});
