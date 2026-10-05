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

import { attempts, auditLog, courseStaff, enrollments, launchTickets, sessions, users } from "../db/schema.js";
import { presence } from "../modules/realtime/presence.js";
import { fakeShort } from "../test/fakeType.js";
import { routesOf, testServer, type Method, type TestServer } from "../test/http.js";
import { seedLive, type Seeded } from "../test/live.js";
import { redactUrl } from "../redact.js";
import { IMPERSONATION_PATH } from "./paths.js";
import { issueLaunchTicket } from "./launch.js";
import { purgeExpiredSessions } from "./session.js";
import { issueImpersonation, openImpersonation } from "./testing.js";

type Who = { id: string; headers: Record<string, string> };
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
  // A link to act as a student takes Super Powers (ADR-054).
  const admin = await server.signInWithSuperPowers();
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
const issue = (w: World, who: Who = w.admin, entryId = w.entryId) =>
  issueImpersonation(w.server, who.headers, w.seed.classroomId, entryId);

/** Opens a link in a browser with no session; the session headers, or null. */
const open = (w: World, path: string) => openImpersonation(w.server, path);

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

    it("is refused to an admin without Super Powers, even on their own course (ADR-054)", async () => {
      const plain = await w.server.signIn("admin");
      await w.server.app.db.insert(courseStaff).values({ courseId: w.seed.courseId, userId: plain.id });
      const res = await call(w.server, "POST", linkUrl(w), plain.headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("super_powers_required");
    });

    it("opens nothing once its actor is no longer an admin", async () => {
      const other = await w.server.signInWithSuperPowers();
      const path = (await issue(w, other)) as string;
      await w.server.app.db.update(users).set({ role: "teacher" }).where(eq(users.id, other.id));
      expect(await open(w, path)).toBeNull();
    });

    it("stops working the moment its actor is no longer an admin", async () => {
      const other = await w.server.signInWithSuperPowers();
      const session = (await open(w, (await issue(w, other)) as string))!;
      expect((await call(w.server, "GET", "/app/api/me", session)).statusCode).toBe(200);
      await w.server.app.db.update(users).set({ role: "teacher" }).where(eq(users.id, other.id));
      expect((await call(w.server, "GET", "/app/api/me", session)).statusCode).toBe(401);
      const ended = await auditRows(w, "impersonation.ended");
      expect(ended.at(-1)).toMatchObject({
        actorUserId: null,
        actorType: "system",
        subjectId: w.student.id,
        payload: { reason: "revoked", actorUserId: other.id },
      });
    });
  });

  describe("the session", () => {
    it("is the student's, lives one hour, and was audited", async () => {
      const me = await call(w.server, "GET", "/app/api/me", as);
      expect(me.statusCode).toBe(200);
      expect(me.json().id).toBe(w.student.id);
      expect(me.json().session).toEqual({
        kind: "impersonation",
        evaluationId: null,
        readOnly: true,
        superPowersUntil: null,
        superPowersAvailable: false,
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
      const [mine, theirs] = await Promise.all([
        call(w.server, "GET", "/app/api/student/classrooms", as),
        call(w.server, "GET", "/app/api/student/classrooms", w.student.headers),
      ]);
      expect(mine.statusCode).toBe(200);
      expect(mine.json()).toEqual(theirs.json());
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
      // The attempt page, reloaded: a sign of life for the student, none for somebody acting as them.
      const entered = await call(w.server, "POST", `/app/api/evaluations/${w.seed.evaluationId}/attempt/start`, w.student.headers);
      const attemptId = entered.json().view.attempt.id as string;
      await w.server.app.db.update(attempts).set({ presentAt: null }).where(eq(attempts.id, attemptId));
      expect((await call(w.server, "GET", `/app/api/attempts/${attemptId}`, as)).statusCode).toBe(200);
      const [attempt] = await w.server.app.db.select().from(attempts).where(eq(attempts.id, attemptId));
      expect(attempt!.presentAt).toBeNull();
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
      const ended = (await auditRows(w, "impersonation.ended")).filter(
        (r) => (r.payload as { reason: string }).reason === "logout",
      );
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
      const expired = (await auditRows(w, "impersonation.ended")).filter(
        (r) => (r.payload as { reason: string }).reason === "expired",
      );
      expect(expired.length).toBeGreaterThan(0);
      for (const row of expired) {
        expect(row).toMatchObject({ actorUserId: null, actorType: "system", subjectId: w.student.id });
      }
      expect(expired.at(-1)!.payload).toEqual({ reason: "expired", actorUserId: w.admin.id });
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
    const entered = await call(w.server, "POST", `/app/api/evaluations/${evaluationId}/attempt/start`, as);
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
    // The retake of an exercise is such a write (F-EVAL-15).
    const exercise = await seedLive(w.server.app.db, {
      teacherId: w.teacher.id,
      studentIds: [w.student.id],
      mode: "exercise",
      questions: 1,
      durationS: null,
      settings: { timing: "manual", lobby: "skip", retakes: { enabled: true, keep: "best", maxAttempts: 2 } },
    });
    const id = exercise.evaluationId;
    expect(
      (await call(w.server, "POST", `/app/api/evaluations/${id}/start`, w.teacher.headers, { confirm: true })).statusCode,
    ).toBe(200);
    const first = await call(w.server, "POST", `/app/api/evaluations/${id}/attempt/start`, as);
    expect(first.statusCode, first.body).toBe(200);
    const firstId = first.json().view.attempt.id as string;
    expect((await call(w.server, "POST", `/app/api/attempts/${firstId}/submit`, as, { confirm: true })).statusCode).toBe(200);
    const retaken = await call(w.server, "POST", `/app/api/evaluations/${id}/retake`, as);
    expect(retaken.statusCode, retaken.body).toBe(200);
    const [trace] = await w.server.app.db.select().from(auditLog).where(eq(auditLog.action, "attempt.retake"));
    expect(trace).toMatchObject({ actorUserId: w.admin.id, actorType: "user" });
  });
});
