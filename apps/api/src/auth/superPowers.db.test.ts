/**
 * Super Powers over the REAL application (ADR-054): an admin reaches a
 * colleague's course and pool only while they run, by the server's clock;
 * a Bearer token never has them; every switch, and every end, is audited.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CSRF_COOKIE } from "@quiz/contracts";

import { auditLog, sessions } from "../db/schema.js";
import { subscribe, type BusMessage } from "../events.js";
import { testServer, type TestServer } from "../test/http.js";
import { seedLive, type Seeded } from "../test/live.js";
import type { AppConfig } from "../config.js";
import { TICK_TASKS } from "../ticker.js";
import { createApiToken } from "./tokens.js";

type Who = { id: string; headers: Record<string, string> };

let server: TestServer;
let teacher: Who;
let seed: Seeded;

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  seed = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [],
    questions: 0,
  });
});
afterAll(() => server.close());

const HOUR = 3_600_000;
const PATH = "/app/api/me/super-powers";

const call = (method: "GET" | "POST" | "DELETE", url: string, headers: Record<string, string>) =>
  server.app.inject({ method, url, headers });

/** What `who` gets on the teacher's course and pool: the two status codes. */
async function reach(headers: Record<string, string>) {
  const [course, pool] = await Promise.all([
    call("GET", `/app/api/courses/${seed.courseId}`, headers),
    call("GET", `/app/api/pools/${seed.poolId}`, headers),
  ]);
  return [course.statusCode, pool.statusCode];
}

const untilOf = async (who: Who) =>
  (await call("GET", "/app/api/me", who.headers)).json().session.superPowersUntil as string | null;

async function audits(userId: string, action: "superpowers.enabled" | "superpowers.disabled") {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, userId)));
}

describe("switching them on and off", () => {
  let admin: Who;
  beforeEach(async () => {
    admin = await server.signIn("admin");
  });

  it("leaves an admin without them where a teacher stands: the 404 of a missing entity", async () => {
    expect(await reach(admin.headers)).toEqual([404, 404]);
    expect(await untilOf(admin)).toBeNull();
  });

  it("opens everything for one hour of the server's clock, audited", async () => {
    const on = await call("POST", PATH, admin.headers);
    expect(on.statusCode).toBe(200);
    const until = new Date(server.clock.now().getTime() + HOUR).toISOString();
    expect(on.json()).toEqual({ superPowersUntil: until });
    expect(await untilOf(admin)).toBe(until);
    expect(await reach(admin.headers)).toEqual([200, 200]);
    // The pool role that comes with them: owner, like the pool's owner.
    expect((await call("GET", `/app/api/pools/${seed.poolId}`, admin.headers)).json().role).toBe(
      "owner",
    );
    const [enabled] = await audits(admin.id, "superpowers.enabled");
    expect(enabled).toMatchObject({
      actorUserId: admin.id,
      actorType: "user",
      payload: { until },
    });
  });

  it("is never extended: a second enable while they run is refused", async () => {
    expect((await call("POST", PATH, admin.headers)).statusCode).toBe(200);
    const before = await untilOf(admin);
    server.clock.advance(10 * 60_000);
    const again = await call("POST", PATH, admin.headers);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("super_powers_active");
    expect(await untilOf(admin)).toBe(before);
  });

  it("goes off on request, audited once, and closes the admin's streams", async () => {
    expect((await call("POST", PATH, admin.headers)).statusCode).toBe(200);
    const closed: string[] = [];
    const unsubscribe = subscribe((m: BusMessage) => {
      if (m.kind === "close") closed.push(...m.topics);
    });
    try {
      const off = await call("DELETE", PATH, admin.headers);
      expect(off.statusCode).toBe(200);
      expect(off.json()).toEqual({ superPowersUntil: null });
      // Idempotent: off again writes nothing.
      expect((await call("DELETE", PATH, admin.headers)).statusCode).toBe(200);
    } finally {
      unsubscribe();
    }
    expect(closed).toEqual([`user:${admin.id}`]);
    expect(await reach(admin.headers)).toEqual([404, 404]);
    const ended = await audits(admin.id, "superpowers.disabled");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actorUserId: admin.id,
      actorType: "user",
      payload: { reason: "manual" },
    });
  });

  it("belongs to the one session that switched them on", async () => {
    const other = { id: admin.id, headers: await secondSession(admin.id) };
    expect((await call("POST", PATH, admin.headers)).statusCode).toBe(200);
    expect(await reach(other.headers)).toEqual([404, 404]);
    expect(await untilOf(other)).toBeNull();
  });

  it("ends with the session: signing out audits `logout`", async () => {
    expect((await call("POST", PATH, admin.headers)).statusCode).toBe(200);
    expect((await call("POST", "/app/auth/logout", admin.headers)).statusCode).toBe(204);
    const ended = await audits(admin.id, "superpowers.disabled");
    expect(ended.map((r) => r.payload)).toEqual([{ reason: "logout" }]);
  });
});

/** A second portal session of the same account, as another browser would hold. */
async function secondSession(userId: string) {
  const { createSession, SESSION_COOKIE } = await import("./session.js");
  const session = await createSession(server.app.db, userId, 12);
  return {
    cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${session.csrf}`,
    "x-csrf-token": session.csrf,
  };
}

describe("expiry, by the server's clock (invariant 5)", () => {
  it("ends at the hour on the next request, audited `expired` once", async () => {
    const admin = await server.signInWithSuperPowers();
    server.clock.advance(HOUR - 1000);
    expect(await reach(admin.headers)).toEqual([200, 200]);
    server.clock.advance(1000);
    expect(await reach(admin.headers)).toEqual([404, 404]);
    expect(await untilOf(admin)).toBeNull();
    const ended = await audits(admin.id, "superpowers.disabled");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      actorUserId: null,
      actorType: "system",
      payload: { reason: "expired" },
    });
    const rows = await server.app.db.select().from(sessions).where(eq(sessions.userId, admin.id));
    expect(rows.map((r) => r.superPowersUntil)).toEqual([null]);
  });

  it("ends at the hour in the ticker's task when no request comes, closing the open stream", async () => {
    const admin = await server.signInWithSuperPowers();
    // A stream opened with Super Powers holds the topics of every course.
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/events",
      headers: admin.headers,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    let closed = false;
    const stream = res.stream();
    stream.on("data", () => {});
    stream.on("end", () => (closed = true));
    stream.on("close", () => (closed = true));
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false);

    server.clock.advance(HOUR);
    const task = TICK_TASKS.find((t) => t.name === "superpowers.expire")!;
    expect(task.everyMs).toBe(60_000);
    await task.run(server.app, {} as AppConfig);
    for (let i = 0; i < 10 && !closed; i++) await new Promise((r) => setImmediate(r));
    expect(closed).toBe(true);

    const ended = await audits(admin.id, "superpowers.disabled");
    expect(ended.map((r) => r.payload)).toEqual([{ reason: "expired" }]);
    // The request that comes later finds nothing more to write.
    expect(await reach(admin.headers)).toEqual([404, 404]);
    expect(await audits(admin.id, "superpowers.disabled")).toHaveLength(1);
  });
});

describe("who may hold them", () => {
  it("is an admin's: a teacher and a student are refused", async () => {
    const student = await server.signIn("student");
    expect((await call("POST", PATH, teacher.headers)).statusCode).toBe(403);
    expect((await call("POST", PATH, student.headers)).statusCode).toBe(403);
  });

  it("is never a Bearer token's, not even while the admin's session holds them", async () => {
    const admin = await server.signInWithSuperPowers();
    const { token } = await createApiToken(
      server.app.db,
      admin.id,
      { name: "MCP", expiresInDays: 7 },
      server.clock.now(),
    );
    const bearer = { authorization: `Bearer ${token}` };
    expect(await reach(admin.headers)).toEqual([200, 200]);
    expect(await reach(bearer)).toEqual([404, 404]);
    const refused = await call("POST", PATH, bearer);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("session_required");
  });
});
