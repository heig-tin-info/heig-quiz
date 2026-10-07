/**
 * ADR-051 §3 before proof B: `SEB_CONFIG_KEY_ENFORCE` off (the default), a
 * `seb` session whose request does not carry its Config Key header is served
 * all the same, and the mismatch is audited once per session and route.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { and, eq } from "drizzle-orm";
import { registerForTests } from "@quiz/registry/server";
import { CONFIG_KEY_HEADER, absoluteRequestUrl, expectedHash } from "@quiz/seb";

import { auditLog, kioskDevices, sessions } from "../db/schema.js";
import { subscribe, type BusMessage } from "../events.js";
import { fakeShort } from "../test/fakeType.js";
import { testServer, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";
import { CSRF_COOKIE, SESSION_COOKIE, createSession, deleteSession } from "./session.js";

/** A Config Key as a launch stores it. */
const KEY = "9d98ce221dd52eccf27cad6a01bcd49b14d3d718a9eeeb3be94f0e231a5787ae";

let server: TestServer;
let restore: () => void;
let studentId: string;
let evaluationId: string;
let cookies: Record<string, string>;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer();
  const teacher = await server.signIn("teacher");
  const student = await server.signIn("student");
  studentId = student.id;
  ({ evaluationId } = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    mode: "exam",
    settings: { safeExamBrowser: true },
  }));
  const started = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${evaluationId}/start`,
    headers: teacher.headers,
    payload: { confirm: true },
  });
  expect(started.statusCode, started.body).toBe(200);
  const s = await createSession(server.app.db, student.id, 12, {
    kind: "seb",
    actorUserId: null,
    evaluationId,
    sebConfigKey: KEY,
  });
  cookies = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
});
afterAll(async () => {
  await server.close();
  restore();
});

const mismatches = () =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, "auth.seb_config_key_mismatch"), eq(auditLog.actorUserId, studentId)))
    .orderBy(auditLog.id);

const get = (url: string, headers: Record<string, string>) =>
  server.app.inject({ method: "GET", url, headers });

describe("the Config Key of every request, audit-only (ADR-051 §3)", () => {
  it("serves a matching request and writes nothing", async () => {
    const url = "/app/api/me";
    const header = expectedHash(absoluteRequestUrl("http://localhost:3000", url), KEY);
    expect((await get(url, { ...cookies, [CONFIG_KEY_HEADER]: header })).statusCode).toBe(200);
    expect(await mismatches()).toHaveLength(0);
  });

  it("serves a mismatch, and audits it once per session and route template", async () => {
    const entered = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/attempt`,
      headers: cookies,
      payload: {},
    });
    expect(entered.statusCode, entered.body).toBe(200);
    const attemptId = entered.json().view.attempt.id as string;
    const url = `/app/api/attempts/${attemptId}`;
    expect((await get(url, cookies)).statusCode).toBe(200);
    expect((await get(url, { ...cookies, [CONFIG_KEY_HEADER]: "0".repeat(64) })).statusCode).toBe(200);

    const rows = await mismatches();
    expect(rows.map((r) => r.payload)).toEqual([
      { route: "/app/api/evaluations/:id/attempt" },
      { route: "/app/api/attempts/:id" },
    ]);
    expect(rows[1]).toMatchObject({ subjectType: "evaluation", subjectId: evaluationId });
    // Neither the header nor the key is ever written.
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(JSON.stringify(rows)).not.toContain("0".repeat(64));
  });
});

describe("a new kiosk session supersedes by station too (ADR-051 §4)", () => {
  it("deletes every session holding its device, expired ones included, and nothing else", async () => {
    const deviceId = randomUUID();
    await server.app.db
      .insert(kioskDevices)
      .values({ id: deviceId, googleDeviceId: `mock-${deviceId}`, status: "active", label: "Poste n° 7" });
    const other = await server.signIn("student");
    const kiosk = { kind: "kiosk", actorUserId: null, evaluationId, deviceId } as const;
    await createSession(server.app.db, other.id, 12, kiosk);
    await server.app.db.update(sessions).set({ expiresAt: new Date(0) }).where(eq(sessions.deviceId, deviceId));
    const heard: BusMessage[] = [];
    const unsubscribe = subscribe((message) => heard.push(message));
    await createSession(server.app.db, studentId, 12, kiosk);
    unsubscribe();
    const held = await server.app.db.select().from(sessions).where(eq(sessions.deviceId, deviceId));
    expect(held.map((s) => s.userId)).toEqual([studentId]);
    // The other student's portal is untouched.
    expect((await get("/app/api/me", other.headers)).statusCode).toBe(200);
    // This student's kiosk session superseded their seb one on the same evaluation.
    expect((await get("/app/api/me", cookies)).statusCode).toBe(401);

    // One entry and one alert per removed (user, evaluation), each naming its own student.
    const rows = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "auth.session_superseded"), eq(auditLog.actorUserId, studentId)));
    expect(rows.map((r) => r.payload)).toEqual(
      expect.arrayContaining([
        { userId: other.id, kinds: ["kiosk"], by: "kiosk", device: "Poste n° 7" },
        { userId: studentId, kinds: ["seb"], by: "kiosk", device: "Poste n° 7" },
      ]),
    );
    expect(rows).toHaveLength(2);
    const alerts = heard.flatMap((m) => (m.kind === "data" && m.event.type === "dashboard.alert" ? [m] : []));
    expect(alerts.map((m) => m.audience)).toEqual(["staff", "staff"]);
    expect(alerts.map((m) => (m.event as { userId: string }).userId).sort()).toEqual([other.id, studentId].sort());
    expect(heard.filter((m) => m.kind === "end")).toEqual([{ kind: "end", sessions: expect.any(Array) }]);
  });
});

describe("the end of a session ends its event streams, and only its own", () => {
  it("closes the stream of a signed-out session, never another session's", async () => {
    const auth = { kind: "seb", actorUserId: null, evaluationId, sebConfigKey: KEY } as const;
    const open = async (token: string, url = `/app/api/events?watch=lobby:${evaluationId}`) => {
      const hangUp = new AbortController();
      const res = await server.app.inject({
        method: "GET",
        url,
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
        payloadAsStream: true,
        signal: hangUp.signal,
      });
      expect(res.statusCode).toBe(200);
      let ended = false;
      res.stream().on("end", () => (ended = true)).resume();
      return { ended: () => ended, stop: () => (res.stream().destroy(), hangUp.abort()) };
    };
    const signedOut = await createSession(server.app.db, studentId, 12, auth);
    const doomed = await open(signedOut.token);
    // The same student's portal, streaming beside it.
    const other = await open((await createSession(server.app.db, studentId, 12)).token, "/app/api/events");
    await deleteSession(server.app.db, signedOut.token);
    for (let i = 0; i < 6 && !doomed.ended(); i++) await new Promise((resolve) => setImmediate(resolve));
    expect(doomed.ended()).toBe(true);
    expect(other.ended()).toBe(false);
    doomed.stop();
    other.stop();
  });
});
