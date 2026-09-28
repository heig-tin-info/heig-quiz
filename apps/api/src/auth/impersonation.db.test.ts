/**
 * ADR-034 over the real application: an admin's one-time link, the
 * `impersonation` session it opens, and above all what that session may do —
 * read everything, write nothing in production (every route, from Fastify's
 * own tree), everything in development — and what it leaves in the audit log
 * and on the live dashboard.
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";

import { auditLog, enrollments, launchTickets, sessions, users } from "../db/schema.js";
import { presence } from "../modules/realtime/presence.js";
import { fakeShort } from "../test/fakeType.js";
import { testServer, type TestServer } from "../test/http.js";
import { seedLive, type Seeded } from "../test/live.js";
import { redactUrl } from "../redact.js";
import { IMPERSONATION_PATH } from "./impersonation.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";
import { CSRF_COOKIE, SESSION_COOKIE, purgeExpiredSessions } from "./session.js";

type Who = { id: string; headers: Record<string, string> };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Every (method, path) of `printRoutes`' tree, HEAD aside (as in `seb.db.test.ts`). */
function routesOf(tree: string): { method: Method; path: string }[] {
  const stack: string[] = [];
  return tree.split("\n").flatMap((line) => {
    const match = /^(.*?)[├└]── (\S+) \(([^)]+)\)/.exec(line);
    if (!match) return [];
    const depth = match[1]!.length / 4;
    stack.length = depth;
    stack.push(match[2]!);
    const path = stack.join("");
    return match[3]!
      .split(", ")
      .filter((m) => m !== "HEAD")
      .map((method) => ({ method: method as Method, path }));
  });
}

/** A classroom with one student, taught by `teacher`, watched over by `admin`. */
interface World {
  server: TestServer;
  admin: Who;
  teacher: Who;
  student: Who;
  seed: Seeded;
  entryId: string;
}

async function world(env: Record<string, string> = {}): Promise<World> {
  const server = await testServer(env);
  server.clock.set("2026-09-21T08:00:00.000Z");
  const admin = await server.signIn("admin");
  const teacher = await server.signIn("teacher");
  const student = await server.signIn("student");
  const seed = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id] });
  const [entry] = await server.app.db
    .select({ id: enrollments.id })
    .from(enrollments)
    .where(eq(enrollments.userId, student.id));
  return { server, admin, teacher, student, seed, entryId: entry!.id };
}

const call = (server: TestServer, method: Method, url: string, headers: Record<string, string>, payload: object = {}) =>
  server.app.inject({ method, url, headers, ...(method === "GET" ? {} : { payload }) });

const linkUrl = (w: World, entryId = w.entryId) =>
  `/app/api/classrooms/${w.seed.classroomId}/roster/${entryId}/impersonation`;

/** Asks for a link as `who`; the path of the link, or the status code. */
async function issue(w: World, who: Who = w.admin, entryId = w.entryId) {
  const res = await call(w.server, "POST", linkUrl(w, entryId), who.headers);
  return res.statusCode === 200 ? new URL(res.json().url as string).pathname : res.statusCode;
}

/** Opens a link in a browser with no session; the session headers, or null. */
async function open(w: World, path: string): Promise<Record<string, string> | null> {
  const res = await w.server.app.inject({ method: "GET", url: path });
  expect(res.statusCode).toBe(303);
  if (res.headers.location !== "/") {
    expect(res.headers.location).toBe("/?impersonation=invalid");
    return null;
  }
  const jar = Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
  return {
    cookie: `${SESSION_COOKIE}=${jar[SESSION_COOKIE]}; ${CSRF_COOKIE}=${jar[CSRF_COOKIE]}`,
    "x-csrf-token": jar[CSRF_COOKIE]!,
  };
}

async function auditRows(w: World, action: "impersonation.started" | "impersonation.ended") {
  return w.server.app.db.select().from(auditLog).where(eq(auditLog.action, action));
}

let restore: () => void;
beforeAll(() => {
  restore = registerForTests(fakeShort);
});
afterAll(() => restore());
afterEach(() => presence.reset());

describe("in production (no development login)", () => {
  let w: World;
  let as: Record<string, string>;

  beforeAll(async () => {
    w = await world();
    const path = await issue(w);
    as = (await open(w, path as string))!;
  });
  afterAll(() => w.server.close());

  describe("the link", () => {
    it("is issued to an admin, stored as a hash, and masked in the request log", async () => {
      const path = (await issue(w)) as string;
      expect(path.startsWith(IMPERSONATION_PATH)).toBe(true);
      const secret = path.slice(IMPERSONATION_PATH.length);
      const rows = await w.server.app.db.select().from(launchTickets).where(eq(launchTickets.userId, w.student.id));
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect(redactUrl(path)).toBe(`${IMPERSONATION_PATH}…`);
    });

    it("is used once, and a new one revokes the one before", async () => {
      const first = (await issue(w)) as string;
      const second = (await issue(w)) as string;
      expect(await open(w, first)).toBeNull();
      expect(await open(w, second)).not.toBeNull();
      expect(await open(w, second)).toBeNull();
    });

    it("is consumed exactly once, even by two requests at the same instant", async () => {
      const now = w.server.clock.now();
      const ticket = { kind: "impersonation", userId: w.student.id, actorUserId: w.admin.id, evaluationId: null } as const;
      const secret = await issueLaunchTicket(w.server.app.db, ticket, now);
      const both = await Promise.all([
        consumeLaunchTicket(w.server.app.db, "impersonation", secret, now),
        consumeLaunchTicket(w.server.app.db, "impersonation", secret, now),
      ]);
      expect(both.filter(Boolean)).toHaveLength(1);
    });

    it("is not opened by the secret of another kind of ticket", async () => {
      const secret = await issueLaunchTicket(
        w.server.app.db,
        { kind: "seb", userId: w.student.id, actorUserId: null, evaluationId: w.seed.evaluationId },
        w.server.clock.now(),
      );
      expect(await open(w, `${IMPERSONATION_PATH}${secret}`)).toBeNull();
    });

    it("is refused to anyone but an admin, with the 404 of a missing entry", async () => {
      // The teacher of the course, who reaches the roster entry itself.
      expect(await issue(w, w.teacher)).toBe(404);
      expect(await issue(w, w.student)).toBe(404);
      expect(await issue(w, w.admin, randomUUID())).toBe(404);
    });

    it("is refused for a staff seat, an admin's or teacher's account, and an unclaimed seat", async () => {
      const db = w.server.app.db;
      const seat = async (userId: string | null, staff = false) => {
        const id = randomUUID();
        await db.insert(enrollments).values({
          id,
          classroomId: w.seed.classroomId,
          nom: "N",
          prenom: "P",
          email: `${id}@heig.test`,
          userId,
          claimedAt: userId ? new Date() : null,
          staff,
        });
        return id;
      };
      expect(await issue(w, w.admin, await seat(w.teacher.id, true))).toBe(404);
      expect(await issue(w, w.admin, await seat((await w.server.signIn("admin")).id))).toBe(404);
      expect(await issue(w, w.admin, await seat((await w.server.signIn("teacher")).id))).toBe(404);
      expect(await issue(w, w.admin, await seat(null))).toBe(404);
    });

    it("opens nothing once its actor is no longer an admin", async () => {
      const other = await w.server.signIn("admin");
      const path = (await issue(w, other)) as string;
      await w.server.app.db.update(users).set({ role: "teacher" }).where(eq(users.id, other.id));
      expect(await open(w, path)).toBeNull();
    });
  });

  describe("the session", () => {
    it("is the student's, says who acts, lives one hour, and was audited", async () => {
      const me = await call(w.server, "GET", "/app/api/me", as);
      expect(me.statusCode).toBe(200);
      expect(me.json().id).toBe(w.student.id);
      expect(me.json().session).toEqual({
        kind: "impersonation",
        evaluationId: null,
        actorUserId: w.admin.id,
        readOnly: true,
      });
      const [row] = await w.server.app.db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, w.student.id), eq(sessions.kind, "impersonation")));
      expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeLessThanOrEqual(3_600_000 + 1000);
      const started = await auditRows(w, "impersonation.started");
      expect(started[0]).toMatchObject({ actorUserId: w.admin.id, subjectType: "user", subjectId: w.student.id });
    });

    it("reads what the student reads", async () => {
      expect((await call(w.server, "GET", "/app/api/student/classrooms", as)).statusCode).toBe(
        (await call(w.server, "GET", "/app/api/student/classrooms", w.student.headers)).statusCode,
      );
    });

    it("writes nothing, on every route of the application but sign-out", async () => {
      for (const { method, path } of routesOf(w.server.app.printRoutes({ commonPrefix: false }))) {
        if (method === "GET" || path === "/app/auth/logout") continue;
        const url = path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000").replace("*", "x");
        const res = await call(w.server, method, url, as);
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json().error, `${method} ${path}`).toBe("impersonation_read_only");
      }
    });

    it("is never a body in the room", async () => {
      const started = await call(w.server, "POST", `/app/api/evaluations/${w.seed.evaluationId}/start`, w.teacher.headers, {
        confirm: true,
      });
      expect(started.statusCode, started.body).toBe(200);
      const res = await w.server.app.inject({
        method: "GET",
        url: `/app/api/events?watch=${encodeURIComponent(`lobby:${w.seed.evaluationId}`)}`,
        headers: as,
        payloadAsStream: true,
      });
      for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
      expect(res.statusCode).toBe(200);
      expect(presence.count(w.seed.evaluationId)).toBe(0);
      res.stream().destroy();
    });

    it("cannot reach a Safe Exam Browser exam: no `.seb` is minted for it", async () => {
      const exam = await seedLive(w.server.app.db, {
        teacherId: w.teacher.id,
        studentIds: [w.student.id],
        mode: "exam",
        settings: { safeExamBrowser: true },
      });
      await call(w.server, "POST", `/app/api/evaluations/${exam.evaluationId}/start`, w.teacher.headers, { confirm: true });
      const seb = `/app/api/evaluations/${exam.evaluationId}/seb`;
      expect((await call(w.server, "GET", seb, w.student.headers)).statusCode).toBe(200);
      expect((await call(w.server, "GET", seb, as)).statusCode).toBe(404);
    });

    it("ends on sign-out, or on expiry, and says so in the audit log", async () => {
      const out = await call(w.server, "POST", "/app/auth/logout", as);
      expect(out.statusCode).toBe(204);
      expect((await call(w.server, "GET", "/app/api/me", as)).statusCode).toBe(401);
      const ended = await auditRows(w, "impersonation.ended");
      expect(ended).toHaveLength(1);
      expect(ended[0]).toMatchObject({
        actorUserId: w.admin.id,
        actorType: "user",
        subjectId: w.student.id,
        payload: { reason: "logout" },
      });
      // The student did not sign out of anything.
      const logouts = await w.server.app.db.select().from(auditLog).where(eq(auditLog.action, "auth.logout"));
      expect(logouts).toHaveLength(0);

      // Every other impersonation session of this file expires with it.
      await open(w, (await issue(w)) as string);
      await w.server.app.db
        .update(sessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(sessions.kind, "impersonation"));
      await purgeExpiredSessions(w.server.app.db);
      const after = await auditRows(w, "impersonation.ended");
      expect(after.length).toBeGreaterThan(1);
      for (const row of after.slice(1)) {
        expect(row).toMatchObject({ actorType: "system", payload: { reason: "expired" } });
      }
      expect(after.at(-1)).toMatchObject({ actorUserId: w.admin.id, subjectId: w.student.id });
    });
  });
});

describe("in development (AUTH_DEV_LOGIN)", () => {
  let w: World;
  let as: Record<string, string>;

  beforeAll(async () => {
    w = await world({ AUTH_DEV_LOGIN: "1" });
    as = (await open(w, (await issue(w)) as string))!;
  });
  afterAll(() => w.server.close());

  it("answers and submits as the student, and the audit names the admin", async () => {
    expect((await call(w.server, "GET", "/app/api/me", as)).json().session.readOnly).toBe(false);
    const { evaluationId, itemIds } = w.seed;
    expect(
      (await call(w.server, "POST", `/app/api/evaluations/${evaluationId}/start`, w.teacher.headers, { confirm: true }))
        .statusCode,
    ).toBe(200);
    const entered = await call(w.server, "POST", `/app/api/evaluations/${evaluationId}/attempt`, as);
    expect(entered.statusCode, entered.body).toBe(200);
    const attemptId = entered.json().view.attempt.id as string;
    const saved = await call(w.server, "PUT", `/app/api/attempts/${attemptId}/answers/${itemIds[0]}`, as, {
      payload: "answer-q0",
      revision: 1,
      clientTs: w.server.clock.now().toISOString(),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const submitted = await call(w.server, "POST", `/app/api/attempts/${attemptId}/submit`, as, { confirm: true });
    expect(submitted.statusCode, submitted.body).toBe(200);

    // A traced write made through the session is the admin's, on the student's behalf.
    const other = await seedLive(w.server.app.db, { teacherId: w.teacher.id, studentIds: [] });
    const code = (
      await call(w.server, "PATCH", `/app/api/classrooms/${other.classroomId}`, w.teacher.headers, {
        joinCodeEnabled: true,
      })
    ).json().joinCode as string;
    const joined = await call(w.server, "POST", `/app/api/join/${code}`, as);
    expect(joined.statusCode, joined.body).toBe(201);
    const [trace] = await w.server.app.db.select().from(auditLog).where(eq(auditLog.action, "roster.join"));
    expect(trace).toMatchObject({ actorUserId: w.admin.id, actorType: "user" });
  });
});
