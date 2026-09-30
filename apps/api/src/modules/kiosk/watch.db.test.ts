/**
 * ADR-051 §6–8 over the real application: a station's re-attestation
 * suspends its sitting (refused, silent) or only alerts (unavailable), the
 * submit wants a fresh check, the supervisor is told once per change, sees
 * how each student sits, and can pair a station for a student without a
 * phone.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_CODE_GRANT, DashboardView, KioskDeviceAuthorization, type ServerEvent } from "@quiz/contracts";
import { KIOSK_SILENT_AFTER_MS } from "@quiz/domain";
import { registerForTests } from "@quiz/registry/server";

import { createSession, CSRF_COOKIE, SESSION_COOKIE } from "../../auth/session.js";
import { auditLog, kioskDevices, kioskPairings, sessions } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { kioskStation, type TestStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";
import { AttestationUnavailable } from "./attestation.js";
import { PAIR_MAX_FAILURES } from "./pairing.js";
import { KIOSK_COOKIE } from "./service.js";
import { sweepSilentStations } from "./watch.js";

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

/** Every `dashboard.alert` the bus carries during a test. */
let alerts: Extract<ServerEvent, { type: "dashboard.alert" }>[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  alerts = [];
  unsubscribe = subscribe((m) => {
    if (m.kind === "data" && m.event.type === "dashboard.alert") alerts.push(m.event);
  });
});
afterEach(() => unsubscribe());

let host = 0;
const nextAddress = () => `10.8.${Math.floor(++host / 250)}.${host % 250}`;

const inject = (method: "GET" | "POST", url: string, headers: Headers, payload?: Payload) =>
  server.app.inject({ method, url, headers, remoteAddress: nextAddress(), ...(payload ? { payload } : {}) });

/** A running exam that accepts the kiosk, a student seated in it, its teacher. */
async function running(settings: { kiosk?: boolean; safeExamBrowser?: boolean } = { kiosk: true }) {
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], settings });
  const started = await inject("POST", `/app/api/evaluations/${seeded.evaluationId}/start`, teacher.headers, {
    confirm: true,
  });
  expect(started.statusCode, started.body).toBe(200);
  return { ...seeded, student, teacher };
}

function setCookie(res: { headers: Record<string, unknown> }, name: string) {
  const all = [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0];
}

/** The station's code, approved by `approve`, and the kiosk session the station's poll gets. */
async function pairStation(station: TestStation, approve: (code: string) => Promise<void>) {
  const auth = KioskDeviceAuthorization.parse(
    (await inject("POST", "/app/api/kiosk/device_authorization", { cookie: station.cookie })).json(),
  );
  await approve(auth.user_code);
  const res = await inject("POST", "/app/api/kiosk/token", { cookie: station.cookie }, {
    grant_type: DEVICE_CODE_GRANT,
    device_code: auth.device_code,
  });
  expect(res.statusCode, res.body).toBe(200);
  const session = setCookie(res, SESSION_COOKIE)!;
  const csrf = setCookie(res, CSRF_COOKIE)!;
  return { session, csrf, token: csrf.slice(CSRF_COOKIE.length + 1) };
}

/**
 * A student sitting `evaluationId` on a fresh station, and the station's
 * handles: its session's headers (which follow the rotating `quiz_kiosk`
 * cookie) and its re-attestation.
 */
async function sitting(exam: Awaited<ReturnType<typeof running>>) {
  const station = await kioskStation(server.app);
  const [row] = await server.app.db.select().from(kioskDevices).where(eq(kioskDevices.id, station.deviceId));
  const googleId = row!.googleDeviceId;
  const credential = station.credential;
  const paired = await pairStation(station, async (code) => {
    const res = await inject("POST", "/app/api/pair", exam.student.headers, { code, evaluationId: exam.evaluationId });
    expect(res.statusCode, res.body).toBe(200);
  });
  const headers = (): Headers => ({
    cookie: `${paired.session}; ${paired.csrf}; ${KIOSK_COOKIE}=${credential}`,
    "x-csrf-token": paired.token,
  });
  /** One re-attestation from the station's page: `ok`, `refuse` or `unavailable`. */
  const attest = async (outcome: "ok" | "refuse" | "unavailable") => {
    const res = await inject("POST", "/app/api/kiosk/attest/verify", headers(), {
      response: outcome === "ok" ? `mock:${googleId}` : `mock:${outcome}`,
    });
    const reissued = setCookie(res, KIOSK_COOKIE);
    // The station keeps its credential: the cookie is only re-set, to last 12 h more.
    if (reissued) expect(reissued).toBe(`${KIOSK_COOKIE}=${credential}`);
    return res.statusCode;
  };
  // Seating told the supervisor where the student sits: that one is `seated`'s test.
  alerts.length = 0;
  const entered = await inject("POST", `/app/api/evaluations/${exam.evaluationId}/attempt`, headers(), {});
  expect(entered.statusCode, entered.body).toBe(200);
  const attemptId = entered.json().view.attempt.id as string;
  const flag = () =>
    inject("POST", `/app/api/attempts/${attemptId}/answers/${exam.itemIds[0]}/flag`, headers(), { flagged: true });
  return { deviceId: station.deviceId, headers, attest, attemptId, flag };
}

const watchAudits = (deviceId: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.subjectId, deviceId),
        inArray(auditLog.action, ["kiosk.suspended", "kiosk.resumed"]),
      ),
    )
    .orderBy(auditLog.id);

describe("a refused attestation suspends the sitting (ADR-051 §6)", () => {
  it("answers 423 to writes, lets GET and the stream through, and resumes on the next ok", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    expect((await seat.flag()).statusCode).toBe(200);

    expect(await seat.attest("refuse")).toBe(403);
    const refused = await seat.flag();
    expect(refused.statusCode).toBe(423);
    expect(refused.json()).toEqual({ error: "kiosk_suspended" });
    expect((await inject("GET", `/app/api/attempts/${seat.attemptId}`, seat.headers())).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", seat.headers())).statusCode).toBe(200);
    const hangUp = new AbortController();
    const stream = await server.app.inject({
      method: "GET",
      url: `/app/api/events?watch=attempt:${seat.attemptId}`,
      headers: seat.headers(),
      payloadAsStream: true,
      signal: hangUp.signal,
    });
    expect(stream.statusCode).toBe(200);
    stream.stream().destroy();
    hangUp.abort();

    // A second refusal is no new change: told once.
    expect(await seat.attest("refuse")).toBe(403);
    expect(await seat.attest("ok")).toBe(200);
    expect((await seat.flag()).statusCode).toBe(200);
    expect(await seat.attest("ok")).toBe(200);

    const rows = await watchAudits(seat.deviceId);
    expect(rows.map((r) => [r.action, r.payload])).toEqual([
      ["kiosk.suspended", { reason: "refused", userId: exam.student.id, evaluationId: exam.evaluationId }],
      ["kiosk.resumed", { userId: exam.student.id, evaluationId: exam.evaluationId }],
    ]);
    expect(alerts.map((a) => [a.kind, a.userId, a.evaluationId])).toEqual([
      ["kiosk_suspended", exam.student.id, exam.evaluationId],
      ["kiosk_resumed", exam.student.id, exam.evaluationId],
    ]);
  });
});

describe("a re-attestation keeps the station's credential (ADR-051 §5)", () => {
  it("serves a write sent with the cookie of before the attestation, and rotates only without one", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    const before = seat.headers();
    expect(await seat.attest("ok")).toBe(200);
    // A write in flight during the attestation carries the old headers: still the station's.
    expect((await inject("POST", `/app/api/attempts/${seat.attemptId}/answers/${exam.itemIds[0]}/flag`, before, { flagged: false })).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", before)).statusCode).toBe(200);
    // Without its cookie (lost, expired), the same device gets a new credential.
    const [device] = await server.app.db.select().from(kioskDevices).where(eq(kioskDevices.id, seat.deviceId));
    const res = await inject("POST", "/app/api/kiosk/attest/verify", {}, { response: `mock:${device!.googleDeviceId}` });
    expect(res.statusCode).toBe(200);
    expect(setCookie(res, KIOSK_COOKIE)).not.toBe(before.cookie!.split("; ").find((c) => c.startsWith(KIOSK_COOKIE)));
    expect((await seat.flag()).statusCode).toBe(401);
  });
});

describe("a station that starts sitting is told at once (ADR-051 §6, §8)", () => {
  it("says the station's state on its pairing, one suspended before it sat included", async () => {
    const exam = await running();
    const station = await kioskStation(server.app);
    await pairStation(station, async (code) => {
      await inject("POST", "/app/api/pair", exam.student.headers, { code, evaluationId: exam.evaluationId });
    });
    expect(alerts.map((a) => [a.kind, a.userId])).toEqual([["kiosk_resumed", exam.student.id]]);

    // Refused while it sat nothing: stored, told to nobody.
    const late = await running();
    const silent = await kioskStation(server.app);
    expect((await inject("POST", "/app/api/kiosk/attest/verify", { cookie: silent.cookie }, { response: "mock:refuse" })).statusCode).toBe(403);
    expect(await watchAudits(silent.deviceId)).toEqual([]);
    const auth = KioskDeviceAuthorization.parse(
      (await inject("POST", "/app/api/kiosk/device_authorization", { cookie: silent.cookie })).json(),
    );
    await inject("POST", "/app/api/pair", late.student.headers, { code: auth.user_code, evaluationId: late.evaluationId });
    alerts.length = 0;
    const res = await inject("POST", "/app/api/kiosk/token", { cookie: silent.cookie }, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: auth.device_code,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(alerts.map((a) => [a.kind, a.userId])).toEqual([["kiosk_suspended", late.student.id]]);
    expect((await watchAudits(silent.deviceId)).map((r) => r.action)).toEqual(["kiosk.suspended"]);
    const [device] = await server.app.db.select().from(kioskDevices).where(eq(kioskDevices.id, silent.deviceId));
    expect(device!.watch).toBe("suspended");
  });
});

describe("an unavailable Google suspends nothing (ADR-051 §6)", () => {
  it("keeps the writes, alerts the supervisor once, and clears the alert", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    expect(await seat.attest("unavailable")).toBe(403);
    expect((await seat.flag()).statusCode).toBe(200);
    expect(await seat.attest("unavailable")).toBe(403);
    expect(await seat.attest("ok")).toBe(200);
    expect(await watchAudits(seat.deviceId)).toEqual([]);
    expect(alerts.map((a) => a.kind)).toEqual(["kiosk_unavailable", "kiosk_resumed"]);
  });

  it("counts a challenge Google cannot give as an attempt: unavailable, never silent", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    server.clock.advance(KIOSK_SILENT_AFTER_MS - 60_000);
    vi.spyOn(server.app.kioskAttestor!, "challenge").mockRejectedValueOnce(new AttestationUnavailable("down"));
    const res = await inject("POST", "/app/api/kiosk/attest/challenge", seat.headers());
    expect(res.statusCode).toBe(503);
    server.clock.advance(2 * 60_000);
    expect((await seat.flag()).statusCode).toBe(200);
    expect(alerts.map((a) => a.kind)).toEqual(["kiosk_unavailable"]);
  });
});

describe("a silent station is suspended (ADR-051 §6)", () => {
  it("refuses writes after twelve minutes, and the ticker tells it once", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    server.clock.advance(KIOSK_SILENT_AFTER_MS);
    expect((await seat.flag()).statusCode).toBe(423);
    await sweepSilentStations(server.app.db, server.app.clock.now());
    server.clock.advance(60_000);
    await sweepSilentStations(server.app.db, server.app.clock.now());
    const rows = await watchAudits(seat.deviceId);
    expect(rows.map((r) => r.action)).toEqual(["kiosk.suspended"]);
    expect(rows[0]!.payload).toMatchObject({ reason: "silent" });
    // The stations of the tests before this one fell silent too: this one's alerts only.
    expect(alerts.filter((a) => a.userId === exam.student.id).map((a) => a.kind)).toEqual(["kiosk_suspended"]);

    expect(await seat.attest("ok")).toBe(200);
    expect((await seat.flag()).statusCode).toBe(200);
    expect((await watchAudits(seat.deviceId)).map((r) => r.action)).toEqual(["kiosk.suspended", "kiosk.resumed"]);
  });
});

describe("the submit wants a fresh check (ADR-051 §6)", () => {
  it("answers 423 kiosk_attestation_stale past two minutes, and submits after a re-attestation", async () => {
    const exam = await running();
    const seat = await sitting(exam);
    server.clock.advance(3 * 60_000);
    const submit = () => inject("POST", `/app/api/attempts/${seat.attemptId}/submit`, seat.headers(), { confirm: true });
    const stale = await submit();
    expect(stale.statusCode).toBe(423);
    expect(stale.json()).toEqual({ error: "kiosk_attestation_stale" });
    // Writes other than the submit are not held to it.
    expect((await seat.flag()).statusCode).toBe(200);
    expect(await seat.attest("unavailable")).toBe(403);
    const done = await submit();
    expect(done.statusCode, done.body).toBe(200);
  });
});

describe("the dashboard says how each student sits (ADR-051 §8)", () => {
  it("portal, seb, or the station's label with its alert", async () => {
    const exam = await running({ kiosk: true, safeExamBrowser: true });
    const dashboard = async () => {
      const res = await inject("GET", `/app/api/evaluations/${exam.evaluationId}/dashboard`, exam.teacher.headers);
      expect(res.statusCode, res.body).toBe(200);
      return DashboardView.parse(res.json()).rows.find((r) => r.userId === exam.student.id)!.access;
    };
    expect(await dashboard()).toEqual({ kind: "portal", station: null, alert: null });

    await createSession(server.app.db, exam.student.id, 12, {
      kind: "seb",
      actorUserId: null,
      evaluationId: exam.evaluationId,
      sebConfigKey: "k",
    });
    expect(await dashboard()).toEqual({ kind: "seb", station: null, alert: null });

    // The station supersedes the SEB session (§4).
    const seat = await sitting(exam);
    expect(await dashboard()).toEqual({ kind: "kiosk", station: "Poste n° 7", alert: null });
    expect(await seat.attest("unavailable")).toBe(403);
    expect(await dashboard()).toEqual({ kind: "kiosk", station: "Poste n° 7", alert: "unavailable" });
    expect(await seat.attest("refuse")).toBe(403);
    expect(await dashboard()).toEqual({ kind: "kiosk", station: "Poste n° 7", alert: "suspended" });
  });
});

describe("the supervisor pairs a station for a student without a phone (ADR-051 §7)", () => {
  const assign = (evaluationId: string, headers: Headers, payload: Payload) =>
    inject("POST", `/app/api/evaluations/${evaluationId}/kiosk-assign`, headers, payload);

  it("approves the same pairing: the student's kiosk session, no actor, approved by the teacher", async () => {
    const exam = await running();
    const station = await kioskStation(server.app, { label: "Poste de secours n° 4" });
    const paired = await pairStation(station, async (code) => {
      const res = await assign(exam.evaluationId, exam.teacher.headers, { userCode: code.toLowerCase(), userId: exam.student.id });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ station: { label: "Poste de secours n° 4" } });
    });
    expect(paired.session).toBeDefined();
    const [session] = await server.app.db.select().from(sessions).where(eq(sessions.deviceId, station.deviceId));
    expect(session).toMatchObject({
      kind: "kiosk",
      userId: exam.student.id,
      evaluationId: exam.evaluationId,
      actorUserId: null,
    });
    const [pairing] = await server.app.db
      .select()
      .from(kioskPairings)
      .where(eq(kioskPairings.deviceId, station.deviceId));
    expect(pairing).toMatchObject({ userId: exam.student.id, approvedBy: exam.teacher.id, state: "consumed" });
    const [entry] = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "kiosk.assigned"), eq(auditLog.subjectId, pairing!.id)));
    expect(entry).toMatchObject({ actorUserId: exam.teacher.id });
    expect(entry!.payload).toEqual({
      evaluationId: exam.evaluationId,
      userId: exam.student.id,
      deviceId: station.deviceId,
    });
  });

  it("is a 404 for a teacher off the evaluation's staff, and refused to a student", async () => {
    const exam = await running();
    const station = await kioskStation(server.app);
    const auth = KioskDeviceAuthorization.parse(
      (await inject("POST", "/app/api/kiosk/device_authorization", { cookie: station.cookie })).json(),
    );
    const stranger = await server.signIn("teacher");
    const body = { userCode: auth.user_code, userId: exam.student.id };
    expect((await assign(exam.evaluationId, stranger.headers, body)).statusCode).toBe(404);
    expect((await assign(exam.evaluationId, exam.student.headers, body)).statusCode).toBe(403);
    const [pairing] = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
    expect(pairing!.state).toBe("pending");
  });

  it("refuses a student who cannot sit this exam on a station now", async () => {
    const exam = await running();
    const outsider = await server.signIn("student");
    const portalOnly = await running({});
    const station = await kioskStation(server.app);
    const auth = KioskDeviceAuthorization.parse(
      (await inject("POST", "/app/api/kiosk/device_authorization", { cookie: station.cookie })).json(),
    );
    const outside = await assign(exam.evaluationId, exam.teacher.headers, { userCode: auth.user_code, userId: outsider.id });
    expect(outside.statusCode).toBe(409);
    expect(outside.json()).toEqual({ error: "evaluation_not_pairable" });
    const noKiosk = await assign(portalOnly.evaluationId, portalOnly.teacher.headers, {
      userCode: auth.user_code,
      userId: portalOnly.student.id,
    });
    expect(noKiosk.statusCode).toBe(409);
  });

  it("counts wrong codes against the supervisor", async () => {
    const exam = await running();
    for (let i = 0; i < PAIR_MAX_FAILURES; i++) {
      const res = await assign(exam.evaluationId, exam.teacher.headers, { userCode: "BCDF-GHJK", userId: exam.student.id });
      expect(res.statusCode).toBe(404);
    }
    const limited = await assign(exam.evaluationId, exam.teacher.headers, { userCode: "BCDF-GHJK", userId: exam.student.id });
    expect(limited.statusCode).toBe(429);
    const refusals = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "kiosk.pair_refused"), eq(auditLog.actorUserId, exam.teacher.id)));
    expect(refusals).toHaveLength(PAIR_MAX_FAILURES);
    // The student's own budget is untouched.
    expect((await inject("GET", "/app/api/pair/BCDF-GHJK", exam.student.headers)).statusCode).toBe(404);
  });
});
