import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminActivity, CSRF_COOKIE, IDLE_HEADER } from "@quiz/contracts";

import { openSebSession } from "../../auth/testing.js";
import { createApiToken } from "../../auth/tokens.js";
import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import { presenceHours, presenceLastSeen, users } from "../../db/schema.js";
import { seedLive } from "../../test/live.js";
import { testServer, type TestServer } from "../../test/http.js";
import { createPresenceRecorder, purgePresence, type PresenceRecorder } from "./service.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;
let teacher: Actor;
let student: Actor;

beforeAll(async () => {
  server = await testServer();
  admin = await server.signIn("admin");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});

afterAll(async () => {
  await server.close();
});

const hoursOf = async (userId: string) =>
  (await server.app.db.select().from(presenceHours).where(eq(presenceHours.userId, userId))).map((r) =>
    r.hour.toISOString(),
  );

const lastSeenOf = async (userId: string) =>
  (
    await server.app.db.select().from(presenceLastSeen).where(eq(presenceLastSeen.userId, userId))
  )[0]?.at.toISOString() ?? null;

/** One request of `headers` to `url`, then every write it queued, written. */
async function request(headers: Record<string, string>, url = "/app/api/me") {
  const res = await server.app.inject({ method: "GET", url, headers });
  await server.app.sitePresence.settled();
  return res;
}

/** Runs `body` with `recorder` in the app's place: one that has seen nobody, or one that fails. */
async function withRecorder(recorder: PresenceRecorder, body: () => Promise<void>) {
  const kept = server.app.sitePresence;
  server.app.sitePresence = recorder;
  try {
    await body();
  } finally {
    server.app.sitePresence = kept;
  }
}

describe("recording the activity (ADR-107)", () => {
  it("records a person's own request once per hour, and their last request to five minutes", async () => {
    const who = await server.signIn("student");
    server.clock.set("2026-10-12T09:10:00Z");
    expect((await request(who.headers)).statusCode).toBe(200);
    expect(await hoursOf(who.id)).toEqual(["2026-10-12T09:00:00.000Z"]);
    expect(await lastSeenOf(who.id)).toBe("2026-10-12T09:10:00.000Z");

    // The same hour again: the process remembers it and writes nothing — a
    // row deleted behind its back is not re-created.
    await server.app.db.delete(presenceHours).where(eq(presenceHours.userId, who.id));
    server.clock.set("2026-10-12T09:13:00Z");
    await request(who.headers);
    expect(await hoursOf(who.id)).toEqual([]);
    // Three minutes on: the last activity has not moved.
    expect(await lastSeenOf(who.id)).toBe("2026-10-12T09:10:00.000Z");

    // Five minutes after the last write, and a new hour: both move.
    server.clock.set("2026-10-12T10:02:00Z");
    await request(who.headers);
    expect(await hoursOf(who.id)).toEqual(["2026-10-12T10:00:00.000Z"]);
    expect(await lastSeenOf(who.id)).toBe("2026-10-12T10:02:00.000Z");
  });

  it("writes everybody's rows together, keeps one hour row per process, and never moves the last activity back", async () => {
    const [a, b] = [await server.signIn("student"), await server.signIn("student")];
    const db = server.app.db;
    const first = createPresenceRecorder(db, server.app.log);
    first.touch(a.id, new Date("2026-10-12T11:20:00Z"));
    first.touch(b.id, new Date("2026-10-12T11:21:00Z"));
    await first.settled();
    // Another process, behind on the same hour and with an older instant.
    const other = createPresenceRecorder(db, server.app.log);
    other.touch(a.id, new Date("2026-10-12T11:05:00Z"));
    await other.settled();
    expect(await hoursOf(a.id)).toEqual(["2026-10-12T11:00:00.000Z"]);
    expect(await hoursOf(b.id)).toEqual(["2026-10-12T11:00:00.000Z"]);
    expect(await lastSeenOf(a.id)).toBe("2026-10-12T11:20:00.000Z");
  });

  it("answers the request whatever the recorder's database does, and retries at the next request", async () => {
    const who = await server.signIn("student");
    server.clock.set("2026-10-12T13:05:00Z");
    // A database that throws on the call, then one that rejects, then one that works.
    let mode: "throw" | "reject" | "ok" = "throw";
    const flaky = new Proxy(server.app.db, {
      get: (target, key) => {
        if (key !== "insert" || mode === "ok") return Reflect.get(target, key);
        if (mode === "throw") {
          return () => {
            throw new Error("database gone");
          };
        }
        const gone = () => Promise.reject(new Error("still gone"));
        return () => ({ values: () => ({ onConflictDoNothing: gone, onConflictDoUpdate: gone }) });
      },
    }) as Db;
    await withRecorder(createPresenceRecorder(flaky, server.app.log), async () => {
      expect((await request(who.headers)).statusCode).toBe(200);
      mode = "reject";
      server.clock.set("2026-10-12T13:40:00Z");
      expect((await request(who.headers)).statusCode).toBe(200);
      expect(await hoursOf(who.id)).toEqual([]);
      // The failed rows left the dedupe: the next request of the hour queues them again.
      mode = "ok";
      server.clock.set("2026-10-12T13:41:00Z");
      expect((await request(who.headers)).statusCode).toBe(200);
    });
    expect(await hoursOf(who.id)).toEqual(["2026-10-12T13:00:00.000Z"]);
    expect(await lastSeenOf(who.id)).toBe("2026-10-12T13:41:00.000Z");
  });

  it("counts a confined seb session as the student's own", async () => {
    const who = await server.signIn("student");
    server.clock.set("2026-10-12T14:05:00Z");
    const seed = await seedLive(server.app.db, {
      teacherId: teacher.id,
      studentIds: [who.id],
      mode: "exam",
      settings: { safeExamBrowser: true },
      questions: 0,
    });
    const seb = await openSebSession(server, seed.evaluationId, who.headers);
    await server.app.sitePresence.settled();
    await server.app.db.delete(presenceHours).where(eq(presenceHours.userId, who.id));
    await withRecorder(createPresenceRecorder(server.app.db, server.app.log), async () => {
      expect((await request(seb("/app/api/me"))).statusCode).toBe(200);
    });
    expect(await hoursOf(who.id)).toEqual(["2026-10-12T14:00:00.000Z"]);
  });

  it("never counts an impersonation, a bearer token, the event stream or an idle page", async () => {
    const who = await server.signIn("student");
    server.clock.set("2026-10-12T12:05:00Z");

    // ADR-034: an administrator acting as the student.
    const acting = await createSession(server.app.db, who.id, 12, {
      kind: "impersonation",
      actorUserId: admin.id,
      evaluationId: null,
      projectId: null,
    });
    const cookie = `${server.app.cookieName(SESSION_COOKIE)}=${acting.token}; ${server.app.cookieName(CSRF_COOKIE)}=${acting.csrf}`;
    expect((await request({ cookie })).statusCode).toBe(200);

    // ADR-022: a personal API token of the student's own.
    const token = await createApiToken(server.app.db, who.id, { name: "t", expiresInDays: 30, scope: "api" }, server.clock.now());
    expect((await request({ authorization: `Bearer ${token.token}` })).statusCode).toBe(200);

    // A request the SPA made while its person was idle (a poll).
    expect((await request({ ...who.headers, [IDLE_HEADER]: "1" })).statusCode).toBe(200);

    // The event stream: background traffic, by its route's own declaration.
    const res = await server.app.inject({
      method: "GET",
      url: "/app/api/events",
      headers: who.headers,
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    res.stream().destroy();
    await server.app.sitePresence.settled();

    expect(await hoursOf(who.id)).toEqual([]);
    expect(await lastSeenOf(who.id)).toBeNull();
    // Nor is the administrator behind the impersonation.
    expect(await hoursOf(admin.id)).toEqual([]);
  });
});

describe("purge (presence.purge, N-DATA-03)", () => {
  it("deletes the hours older than eight days, and only those", async () => {
    const who = await server.signIn("student");
    const now = new Date("2026-10-20T12:00:00Z");
    await server.app.db.insert(presenceHours).values([
      { userId: who.id, hour: new Date("2026-10-12T11:00:00Z") },
      { userId: who.id, hour: new Date("2026-10-12T13:00:00Z") },
    ]);
    expect(await purgePresence(server.app.db, now)).toBeGreaterThanOrEqual(1);
    expect(await hoursOf(who.id)).toEqual(["2026-10-12T13:00:00.000Z"]);
  });
});

describe("GET /app/api/admin/activity (F-ADMIN-09)", () => {
  const get = (headers?: Record<string, string>) =>
    server.app.inject({ method: "GET", url: "/app/api/admin/activity", ...(headers ? { headers } : {}) });

  it("is refused to anyone but an administrator, as the other admin routes are", async () => {
    expect((await get(teacher.headers)).statusCode).toBe(403);
    expect((await get(student.headers)).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(401);
  });

  it("counts distinct people per local hour across the end of summer time, and the off-hours share", async () => {
    const db = server.app.db;
    // Whatever earlier tests queued is written before the slate is cleaned.
    await server.app.sitePresence.settled();
    await db.delete(presenceHours);
    // The administrator's own reading is activity too: recorded first, so
    // the counts below are known (10:00 UTC, 11:00 local).
    server.clock.set("2026-10-26T10:00:00Z");
    await request(admin.headers, "/app/api/admin/activity");
    const [s1, s2, gone] = [await server.signIn("student"), await server.signIn("student"), await server.signIn("student")];
    const row = (who: Actor, hour: string) => ({ userId: who.id, hour: new Date(hour) });
    await db.insert(presenceHours).values([
      // Sunday 25 October 2026: 22:00 UTC the day before is 00:00 local (+02:00)…
      row(s1, "2026-10-24T22:00:00Z"),
      // …and 00:00 and 01:00 UTC are both 02:00 local, summer time then winter
      // time: one hour of the grid, s1 counted once in it.
      row(s1, "2026-10-25T00:00:00Z"),
      row(s1, "2026-10-25T01:00:00Z"),
      row(s2, "2026-10-25T01:00:00Z"),
      // Monday 26 October, 09:00 local (+01:00): a class hour.
      row(s1, "2026-10-26T08:00:00Z"),
      row(teacher, "2026-10-26T08:00:00Z"),
      // An anonymized account is counted nowhere.
      row(gone, "2026-10-26T08:00:00Z"),
      // Monday 19 October: kept, but before the grid's seven days.
      row(s2, "2026-10-19T12:00:00Z"),
    ]);
    await db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, gone.id));
    const now = server.clock.now().getTime();
    await db.delete(presenceLastSeen);
    await db.insert(presenceLastSeen).values([
      { userId: teacher.id, at: new Date(now - 5 * 60_000) },
      { userId: s1.id, at: new Date(now - 20 * 60_000) },
      { userId: gone.id, at: new Date(now - 60_000) },
    ]);

    const res = await get(admin.headers);
    expect(res.statusCode).toBe(200);
    const body = AdminActivity.parse(res.json());
    expect(body.days.map((d) => d.date)).toEqual([
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
      "2026-10-26",
    ]);
    const sunday = body.days[5]!.hours;
    expect(sunday[0]).toEqual({ students: 1, staff: 0 });
    expect(sunday[1]).toEqual({ students: 0, staff: 0 });
    expect(sunday[2]).toEqual({ students: 2, staff: 0 });
    expect(body.days[6]!.hours[9]).toEqual({ students: 1, staff: 1 });
    expect(body.days[6]!.hours[11]).toEqual({ students: 0, staff: 1 });
    // Saturday the 24th holds nothing: 22:00 UTC was already Sunday here.
    expect(body.days[4]!.hours.every((c) => c.students === 0 && c.staff === 0)).toBe(true);

    expect(body.last7d).toEqual({ students: 2, staff: 2 });
    expect(body.last24h).toEqual({ students: 1, staff: 2 });
    // The administrator's own last activity was cleared above: the teacher alone.
    expect(body.activeNow).toEqual({ students: 0, staff: 1 });
    // Four student person-hours in the grid, three on the Sunday.
    expect(body.offHoursStudentShare).toBeCloseTo(0.75);
    // The oldest kept hour's local date.
    expect(body.recordedSince).toBe("2026-10-19");
    // Aggregates only: nobody is named.
    expect(res.body).not.toContain(s1.id);
    expect(res.body).not.toContain(teacher.id);
  });

  it("answers an empty grid when nothing is recorded", async () => {
    await server.app.db.delete(presenceHours);
    const body = AdminActivity.parse((await get(admin.headers)).json());
    expect(body.last7d).toEqual({ students: 0, staff: 0 });
    expect(body.offHoursStudentShare).toBeNull();
    expect(body.recordedSince).toBeNull();
  });
});

describe("GET /app/api/admin/users", () => {
  it("carries each account's last activity, read from the presence module", async () => {
    await server.app.db.delete(presenceLastSeen).where(eq(presenceLastSeen.userId, student.id));
    await server.app.db.insert(presenceLastSeen).values({ userId: student.id, at: new Date("2026-10-12T08:00:00Z") });
    const res = await server.app.inject({ method: "GET", url: "/app/api/admin/users", headers: admin.headers });
    const rows = res.json() as { id: string; lastSeenAt: string | null }[];
    expect(rows.find((r) => r.id === student.id)?.lastSeenAt).toBe("2026-10-12T08:00:00.000Z");
    expect(rows.find((r) => r.id === teacher.id)).toHaveProperty("lastSeenAt");
  });
});
