/**
 * The pairing of a kiosk station from the student's phone (ADR-051 §7, RFC
 * 8628 adapted), over the real application: the station's two routes, the
 * phone's two, the `kiosk` session that comes out of them and what it
 * reaches — and its end with the attempt.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEVICE_CODE_GRANT, KioskDeviceAuthorization, PairPreview } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { createSession, CSRF_COOKIE, SESSION_COOKIE } from "../../auth/session.js";
import { auditLog, kioskPairings, sessions } from "../../db/schema.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { kioskStation, type TestStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";
import { PAIR_MAX_FAILURES } from "./pairing.js";
import { PAIR_PREVIEW_LIMIT } from "./routes.js";

let server: TestServer;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer({ KIOSK_ATTESTATION: "mock" });
});
afterAll(async () => {
  await server.close();
  restore();
});

type Headers = Record<string, string>;

/** Each station call from its own address: the attestation limiter is not under test. */
let host = 0;
const nextAddress = () => `10.9.${Math.floor(++host / 250)}.${host % 250}`;

const stationPost = (url: string, station: TestStation | null, payload?: Payload) =>
  server.app.inject({
    method: "POST",
    url,
    remoteAddress: nextAddress(),
    headers: station ? { cookie: station.cookie } : {},
    ...(payload ? { payload } : {}),
  });

async function authorize(station: TestStation) {
  const res = await stationPost("/app/api/kiosk/device_authorization", station);
  expect(res.statusCode, res.body).toBe(200);
  return KioskDeviceAuthorization.parse(res.json());
}

const poll = (station: TestStation | null, deviceCode: string) =>
  stationPost("/app/api/kiosk/token", station, { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode });

const preview = (headers: Headers, code: string) =>
  server.app.inject({ method: "GET", url: `/app/api/pair/${encodeURIComponent(code)}`, headers });

const approve = (headers: Headers, code: string, evaluationId: string) =>
  server.app.inject({ method: "POST", url: "/app/api/pair", headers, payload: { code, evaluationId } });

/** A running exam with `settings`, and a student seated in it. */
async function running(settings: { safeExamBrowser?: boolean; kiosk?: boolean } = { kiosk: true }) {
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], settings });
  const started = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${seeded.evaluationId}/start`,
    headers: teacher.headers,
    payload: { confirm: true },
  });
  expect(started.statusCode, started.body).toBe(200);
  return { evaluationId: seeded.evaluationId, student, teacher };
}

/** The session cookies a response set, as one `cookie` header value. */
function sessionCookies(res: { headers: Record<string, unknown> }) {
  const all = [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");
  const pick = (name: string) => all.find((c) => c.startsWith(`${name}=`))?.split(";")[0];
  const session = pick(SESSION_COOKIE);
  const csrf = pick(CSRF_COOKIE);
  expect(session).toBeDefined();
  return { cookie: `${session}; ${csrf}`, csrf: csrf!.slice(CSRF_COOKIE.length + 1) };
}

/** A station paired for `student` on `evaluationId`: the headers of its kiosk session, station cookie included. */
async function paired(station: TestStation, student: { headers: Headers }, evaluationId: string) {
  const auth = await authorize(station);
  expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(200);
  const res = await poll(station, auth.device_code);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json()).toEqual({ redirect: `/take/${evaluationId}` });
  const { cookie, csrf } = sessionCookies(res);
  return {
    station: { cookie: `${cookie}; ${station.cookie}`, "x-csrf-token": csrf },
    alone: { cookie, "x-csrf-token": csrf },
  };
}

const me = (headers: Headers) => server.app.inject({ method: "GET", url: "/app/api/me", headers });
const enter = (evaluationId: string, headers: Headers) =>
  server.app.inject({ method: "POST", url: `/app/api/evaluations/${evaluationId}/attempt`, headers, payload: {} });

describe("the station asks for a code (RFC 8628 §3.1–3.2)", () => {
  it("answers the RFC's fields, the complete URI on /pair, and stores only digests", async () => {
    const station = await kioskStation(server.app.db, { label: "Poste de secours n° 3" });
    const auth = await authorize(station);
    expect(auth.user_code).toMatch(/^[BCDFGHJKMNPQRSTVWXZ2-9]{4}-[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/);
    expect(auth.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(auth).toMatchObject({ expires_in: 300, interval: 2, label: "Poste de secours n° 3" });
    expect(auth.verification_uri).toMatch(/\/pair$/);
    expect(auth.verification_uri_complete).toBe(`${auth.verification_uri}?code=${auth.user_code}`);

    const rows = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(auth.user_code);
    expect(JSON.stringify(rows)).not.toContain(auth.device_code);
  });

  it("expires the station's previous pending code when it asks again", async () => {
    const station = await kioskStation(server.app.db);
    const first = await authorize(station);
    const second = await authorize(station);
    const { student } = await running();
    expect((await preview(student.headers, first.user_code)).statusCode).toBe(404);
    expect((await preview(student.headers, second.user_code)).statusCode).toBe(200);
    expect((await poll(station, first.device_code)).json()).toEqual({ error: "expired_token" });
  });

  it("refuses an unnamed or retired station, or none, with the one 403", async () => {
    const unnamed = await kioskStation(server.app.db, { label: null });
    const retired = await kioskStation(server.app.db, { status: "retired" });
    for (const station of [unnamed, retired, null]) {
      const res = await stationPost("/app/api/kiosk/device_authorization", station);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "not_recognised" });
    }
  });
});

describe("the whole pairing, station → phone → station", () => {
  it("opens a kiosk session that reaches its exam, from its station only, and nothing else", async () => {
    const { evaluationId, student } = await running();
    const other = await running();
    // The student also sits in another kiosk exam, which this session must not reach.
    const station = await kioskStation(server.app.db, { label: "Poste n° 12" });
    const auth = await authorize(station);

    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "authorization_pending" });

    // The phone: lower case and no dash are forgiven.
    const looked = await preview(student.headers, auth.user_code.toLowerCase().replace("-", ""));
    expect(looked.statusCode, looked.body).toBe(200);
    const body = PairPreview.parse(looked.json());
    expect(body.station).toEqual({ label: "Poste n° 12" });
    expect(body.evaluations.map((e) => e.id)).toEqual([evaluationId]);
    expect(body.evaluations[0]).toMatchObject({ title: "Test évaluation" });

    const ok = await approve(student.headers, auth.user_code, evaluationId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ station: { label: "Poste n° 12" } });

    const res = await poll(station, auth.device_code);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ redirect: `/take/${evaluationId}` });
    expect(res.headers["cache-control"]).toBe("no-store");
    const { cookie, csrf } = sessionCookies(res);
    const withStation = { cookie: `${cookie}; ${station.cookie}`, "x-csrf-token": csrf };

    // The session: the student, the exam, the station — and no actor.
    const [row] = await server.app.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, student.id), eq(sessions.kind, "kiosk")));
    expect(row).toMatchObject({ evaluationId, deviceId: station.deviceId, actorUserId: null });

    const who = await me(withStation);
    expect(who.statusCode).toBe(200);
    expect(who.json().session).toMatchObject({ kind: "kiosk", evaluationId, readOnly: false });
    expect((await enter(evaluationId, withStation)).statusCode).toBe(200);
    // Nothing else: another exam, a portal route.
    expect((await enter(other.evaluationId, withStation)).statusCode).toBe(404);
    expect((await server.app.inject({ method: "GET", url: "/app/api/student/home", headers: withStation })).statusCode).toBe(401);

    // Without the station's cookie, the session cookie is worth nothing.
    const alone = { cookie, "x-csrf-token": csrf };
    expect((await me(alone)).statusCode).toBe(401);
    expect((await enter(evaluationId, alone)).statusCode).toBe(401);
    // Nor with another station's.
    const elsewhere = await kioskStation(server.app.db);
    expect((await me({ ...alone, cookie: `${cookie}; ${elsewhere.cookie}` })).statusCode).toBe(401);

    // The audit names the pairing, never a code.
    const entries = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "kiosk.paired"), eq(auditLog.actorUserId, student.id)));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toEqual({ evaluationId, deviceId: station.deviceId });
    expect(JSON.stringify(entries)).not.toContain(auth.user_code);
  });

  it("stops holding the station once it is retired", async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const { station: headers } = await paired(station, student, evaluationId);
    expect((await me(headers)).statusCode).toBe(200);
    await server.app.inject({
      method: "PATCH",
      url: `/app/api/admin/kiosk-devices/${station.deviceId}`,
      headers: (await server.signIn("admin")).headers,
      payload: { status: "retired" },
    });
    // Ended at once, not at its next request: the row (and so its stream) is gone.
    const held = await server.app.db.select().from(sessions).where(eq(sessions.deviceId, station.deviceId));
    expect(held).toHaveLength(0);
    expect((await me(headers)).statusCode).toBe(401);
  });
});

describe("what the pairing refuses", () => {
  it("an expired code, on the phone and on the station", async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    server.clock.advance(301_000);
    expect((await preview(student.headers, auth.user_code)).json()).toEqual({ error: "pairing_not_found" });
    expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(404);
    const res = await poll(station, auth.device_code);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "expired_token" });
  });

  it("a code approved twice, and a pairing consumed twice", async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(200);
    expect((await approve(student.headers, auth.user_code, evaluationId)).json()).toEqual({
      error: "pairing_not_found",
    });
    expect((await poll(station, auth.device_code)).statusCode).toBe(200);
    const again = await poll(station, auth.device_code);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "access_denied" });
  });

  it("a student with no seat in the classroom", async () => {
    const { evaluationId } = await running();
    const stranger = await server.signIn("student");
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    const looked = await preview(stranger.headers, auth.user_code);
    expect(looked.statusCode).toBe(200);
    expect(looked.json().evaluations).toEqual([]);
    const res = await approve(stranger.headers, auth.user_code, evaluationId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("evaluation_not_pairable");
    // Still pending: the right student may still use it.
    const [row] = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
    expect(row!.state).toBe("pending");
  });

  it("an exam that does not accept the kiosk, or is not open", async () => {
    const portal = await running({});
    const sebOnly = await running({ safeExamBrowser: true });
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    for (const { evaluationId, student } of [portal, sebOnly]) {
      expect((await preview(student.headers, auth.user_code)).json().evaluations).toEqual([]);
      expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(409);
    }
    // Draft: never started.
    const student = await server.signIn("student");
    const teacher = await server.signIn("teacher");
    const draft = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], settings: { kiosk: true } });
    expect((await preview(student.headers, auth.user_code)).json().evaluations).toEqual([]);
    expect((await approve(student.headers, auth.user_code, draft.evaluationId)).statusCode).toBe(409);
  });

  it("an exam closed between the approval and the station's poll", async () => {
    const { evaluationId, student, teacher } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(200);
    const closed = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/close`,
      headers: teacher.headers,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    const res = await poll(station, auth.device_code);
    expect(res.json()).toEqual({ error: "access_denied" });
    expect(await server.app.db.select().from(sessions).where(eq(sessions.userId, student.id))).toHaveLength(1);
  });

  it("another station's device_code", async () => {
    const mine = await kioskStation(server.app.db);
    const theirs = await kioskStation(server.app.db);
    const auth = await authorize(theirs);
    const res = await poll(mine, auth.device_code);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_grant" });
    expect((await poll(mine, "not-a-code")).json()).toEqual({ error: "invalid_grant" });
    // And a poll with no station at all.
    expect((await poll(null, auth.device_code)).statusCode).toBe(403);
  });

  it("a station that polls too fast is slowed down, five seconds at a time", async () => {
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "authorization_pending" });
    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "slow_down" });
    server.clock.advance(3_000);
    // The interval is 7 s now: 3 s is too soon.
    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "slow_down" });
    server.clock.advance(12_000);
    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "authorization_pending" });
  });

  it("a delegated session (ADR-034) finds nothing to approve", async () => {
    const { evaluationId, student } = await running();
    const admin = await server.signIn("admin");
    const s = await createSession(server.app.db, student.id, 1, {
      kind: "impersonation",
      actorUserId: admin.id,
      evaluationId: null,
    });
    const headers = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    expect((await preview(headers, auth.user_code)).statusCode).toBe(404);
    expect((await approve(headers, auth.user_code, evaluationId)).statusCode).toBeGreaterThanOrEqual(403);
    const [row] = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
    expect(row!.state).toBe("pending");
  });

  it("a signed-out phone, or a mutation without its CSRF header", async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    expect((await preview({}, auth.user_code)).statusCode).toBe(401);
    expect((await approve({ cookie: student.headers.cookie! }, auth.user_code, evaluationId)).statusCode).toBe(403);
  });

  it(`more than ${PAIR_MAX_FAILURES} wrong codes in ten minutes`, async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    for (let i = 0; i < PAIR_MAX_FAILURES; i += 1) {
      expect((await approve(student.headers, "BBBB-BBBB", evaluationId)).statusCode).toBe(404);
    }
    const limited = await preview(student.headers, auth.user_code);
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(429);
    const refused = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "kiosk.pair_refused"), eq(auditLog.actorUserId, student.id)));
    expect(refused).toHaveLength(PAIR_MAX_FAILURES);
    expect(JSON.stringify(refused)).not.toContain("BBBB");
    // The window slides: ten minutes later the right code works.
    server.clock.advance(10 * 60_000 + 1_000);
    const later = await authorize(station);
    expect((await approve(student.headers, later.user_code, evaluationId)).statusCode).toBe(200);
  });

  it("wrong codes previewed by GET: never counted, so no other site can lock a student out", async () => {
    const { evaluationId, student } = await running();
    const station = await kioskStation(server.app.db);
    const auth = await authorize(station);
    // A GET rides a cross-site navigation with the portal cookie.
    for (let i = 0; i < PAIR_MAX_FAILURES * 2; i += 1) {
      const code = i % 2 === 0 ? "CCCC-CCCC" : "not a code";
      expect((await preview(student.headers, code)).statusCode).toBe(404);
    }
    const refused = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "kiosk.pair_refused"), eq(auditLog.actorUserId, student.id)));
    expect(refused).toHaveLength(0);
    expect((await preview(student.headers, auth.user_code)).statusCode).toBe(200);
    expect((await approve(student.headers, auth.user_code, evaluationId)).statusCode).toBe(200);
  });

  it(`more than ${PAIR_PREVIEW_LIMIT} previews in a minute are slowed down, not counted`, async () => {
    const { student } = await running();
    for (let i = 0; i < PAIR_PREVIEW_LIMIT; i += 1) {
      expect((await preview(student.headers, "DDDD-DDDD")).statusCode).toBe(404);
    }
    const slowed = await preview(student.headers, "DDDD-DDDD");
    expect(slowed.statusCode).toBe(429);
    expect(Number(slowed.headers["retry-after"])).toBeGreaterThan(0);
    server.clock.advance(60_000);
    expect((await preview(student.headers, "DDDD-DDDD")).statusCode).toBe(404);
  });
});

describe("one station, one session; and the end of the sitting (ADR-051 §7)", () => {
  it("a second pairing of the same station ends the first session", async () => {
    const first = await running();
    const second = await running();
    const station = await kioskStation(server.app.db);
    const a = await paired(station, first.student, first.evaluationId);
    expect((await me(a.station)).statusCode).toBe(200);
    const b = await paired(station, second.student, second.evaluationId);
    expect((await me(a.station)).statusCode).toBe(401);
    expect((await me(b.station)).statusCode).toBe(200);
    const rows = await server.app.db.select().from(sessions).where(eq(sessions.deviceId, station.deviceId));
    expect(rows.map((r) => r.userId)).toEqual([second.student.id]);
  });

  it("the submit ends the kiosk session, and leaves a seb one and the phone alone", async () => {
    const { evaluationId, student } = await running({ kiosk: true, safeExamBrowser: true });
    const station = await kioskStation(server.app.db);
    const { station: headers } = await paired(station, student, evaluationId);
    const entered = await enter(evaluationId, headers);
    expect(entered.statusCode, entered.body).toBe(200);
    const attemptId = entered.json().view.attempt.id as string;
    const submitted = await server.app.inject({
      method: "POST",
      url: `/app/api/attempts/${attemptId}/submit`,
      headers,
      payload: { confirm: true },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().state).toBe("submitted");
    expect((await me(headers)).statusCode).toBe(401);
    expect((await me(student.headers)).statusCode).toBe(200);

    // A seb session of the same kind of end is kept (ADR-027).
    const other = await running({ kiosk: true, safeExamBrowser: true });
    const seb = await createSession(server.app.db, other.student.id, 12, {
      kind: "seb",
      actorUserId: null,
      evaluationId: other.evaluationId,
    });
    const sebHeaders = { cookie: `${SESSION_COOKIE}=${seb.token}; ${CSRF_COOKIE}=${seb.csrf}`, "x-csrf-token": seb.csrf };
    const sebAttempt = (await enter(other.evaluationId, sebHeaders)).json().view.attempt.id as string;
    await server.app.inject({
      method: "POST",
      url: `/app/api/attempts/${sebAttempt}/submit`,
      headers: sebHeaders,
      payload: { confirm: true },
    });
    const kept = await server.app.db.select().from(sessions).where(eq(sessions.userId, other.student.id));
    expect(kept.map((s) => s.kind).sort()).toEqual(["portal", "seb"]);
  });

  it("closing the evaluation ends every station seated for it, a waiting one included", async () => {
    const { evaluationId, student, teacher } = await running();
    const station = await kioskStation(server.app.db);
    const { station: headers } = await paired(station, student, evaluationId);
    // Paired, never entered: no attempt to end, the session goes all the same.
    const closed = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/close`,
      headers: teacher.headers,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await me(headers)).statusCode).toBe(401);
  });

  it("the teacher's close of one attempt, and the ticker's expiry, end it too", async () => {
    const { evaluationId, student, teacher } = await running();
    const station = await kioskStation(server.app.db);
    const { station: headers } = await paired(station, student, evaluationId);
    const attemptId = (await enter(evaluationId, headers)).json().view.attempt.id as string;
    const closed = await server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/attempts/${attemptId}/close`,
      headers: teacher.headers,
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect((await me(headers)).statusCode).toBe(401);

    const late = await running();
    const again = await paired(await kioskStation(server.app.db), late.student, late.evaluationId);
    expect((await enter(late.evaluationId, again.station)).statusCode).toBe(200);
    const { expireDueAttempts } = await import("../live/service.js");
    server.clock.advance(31 * 60_000);
    await expireDueAttempts(server.app.db, server.clock.now());
    expect((await me(again.station)).statusCode).toBe(401);
  });
});
