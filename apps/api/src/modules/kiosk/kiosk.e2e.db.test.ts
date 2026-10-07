/**
 * ADR-051 end to end, over HTTP only, with the mock attestation: a station
 * and a phone talk to the real application the way they do in an exam room.
 * The station attests (`mock:<device id>`), an admin names it, it shows a
 * code, the student's phone approves it, the station's poll opens the kiosk
 * session, the student sits, the station re-attests, the student submits and
 * the station is back on its pairing screen. Then each way it can go wrong.
 *
 * Nothing under test is reached through a service: a step is a request. The
 * fixtures (`seedLive`, `signIn`) only build the course, the exam and the
 * accounts. The clock is the server's, moved by hand (invariant 5).
 */
import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEVICE_CODE_GRANT,
  DashboardView,
  KioskAttested,
  KioskDevice,
  KioskDeviceAuthorization,
  PairPreview,
  type ServerEvent,
} from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { CSRF_COOKIE, SESSION_COOKIE } from "../../auth/session.js";
import { auditLog } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type Method, type Payload, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { KIOSK_COOKIE } from "./service.js";

let server: TestServer;
let restore: () => void;
/** Every code and cookie value the run saw, which the audit must never hold. */
const secrets = new Set<string>();

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer({ KIOSK_ATTESTATION: "mock" });
});
afterAll(async () => {
  await server.close();
  restore();
});

/** Every `dashboard.alert` the bus carries during a test: what the supervisor's page hears. */
let alerts: Extract<ServerEvent, { type: "dashboard.alert" }>[] = [];
let unsubscribe: () => void = () => {};
beforeEach(() => {
  alerts = [];
  unsubscribe = subscribe((m) => {
    if (m.kind === "data" && m.event.type === "dashboard.alert") alerts.push(m.event);
  });
});
afterEach(() => unsubscribe());

// ---------------------------------------------------------------------------
// A client: a cookie jar, and the double-submit header a page sends
// ---------------------------------------------------------------------------

/** Each station from its own address: the attestation limiter is not under test. */
let host = 0;

/**
 * What a browser does with cookies, as far as this API needs it: keeps what
 * `set-cookie` sets, forgets what it clears, sends them all back, and echoes
 * the CSRF cookie in `x-csrf-token` as the SPA does.
 */
class Client {
  readonly jar = new Map<string, string>();
  readonly address = `10.7.${Math.floor(++host / 250)}.${host % 250}`;

  constructor(cookies: string = "") {
    for (const pair of cookies.split("; ").filter(Boolean)) this.keep(pair);
  }

  private keep(pair: string) {
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    const value = pair.slice(at + 1);
    if (value === "") this.jar.delete(name);
    else {
      this.jar.set(name, value);
      secrets.add(value);
    }
  }

  async send(method: Method, url: string, payload?: Payload) {
    const csrf = this.jar.get(CSRF_COOKIE);
    const res = await server.app.inject({
      method,
      url,
      remoteAddress: this.address,
      headers: {
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      ...(payload ? { payload } : {}),
    });
    for (const line of [res.headers["set-cookie"]].flat()) {
      if (typeof line !== "string") continue;
      const [pair, ...attrs] = line.split("; ");
      const cleared = attrs.some((a) => /^max-age=0$/i.test(a) || /^expires=thu, 01 jan 1970/i.test(a));
      if (cleared) this.jar.delete(pair!.slice(0, pair!.indexOf("=")));
      else this.keep(pair!);
    }
    return res;
  }

  get = (url: string) => this.send("GET", url);
  post = (url: string, payload?: Payload) => this.send("POST", url, payload);
}

/**
 * A Chromebook in kiosk mode on `/kiosk`: its Google device id, and what its
 * page does — attest (challenge, then the extension's response), ask for a
 * code, poll — and, once paired, sit through the same jar.
 */
class Station extends Client {
  readonly googleId = `e2e-${randomUUID().slice(0, 18)}`;

  /** One attestation: `ok` answers the mock's `mock:<id>`; the others are its two failures. */
  async attest(outcome: "ok" | "refuse" | "unavailable" = "ok") {
    const challenge = await this.post("/app/api/kiosk/attest/challenge");
    expect(challenge.statusCode, challenge.body).toBe(200);
    return this.post("/app/api/kiosk/attest/verify", {
      response: outcome === "ok" ? `mock:${this.googleId}` : `mock:${outcome}`,
    });
  }

  /** The pairing screen: a fresh attestation (ADR-051 §6), then a code. */
  async code() {
    expect((await this.attest()).statusCode).toBe(200);
    const res = await this.post("/app/api/kiosk/device_authorization");
    expect(res.statusCode, res.body).toBe(200);
    const auth = KioskDeviceAuthorization.parse(res.json());
    secrets.add(auth.user_code).add(auth.user_code.replace("-", "")).add(auth.device_code);
    return auth;
  }

  poll = (deviceCode: string) =>
    this.post("/app/api/kiosk/token", { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode });
}

/** A signed-in person's browser (a phone, the supervisor's laptop, the admin's). */
async function person(role: "student" | "teacher" | "admin") {
  const { id, headers } = await server.signIn(role);
  return Object.assign(new Client(headers.cookie), { id });
}

/** A station an admin has named, the way it happens: it attests, the admin finds it unnamed and names it. */
async function namedStation(label = "Poste de secours n° 7") {
  const station = new Station();
  expect((await station.attest()).statusCode).toBe(200);
  const admin = await person("admin");
  const devices = KioskDevice.array().parse((await admin.get("/app/api/admin/kiosk-devices")).json());
  const mine = devices.find((d) => d.googleDeviceId === station.googleId)!;
  const named = await admin.send("PATCH", `/app/api/admin/kiosk-devices/${mine.id}`, { label });
  expect(named.statusCode, named.body).toBe(200);
  return Object.assign(station, { deviceId: mine.id });
}

/** An exam that accepts the kiosk, in `state`, with its teacher and one enrolled student. */
async function exam(state: "running" | "lobby" | "draft" = "running") {
  const student = await person("student");
  const teacher = await person("teacher");
  const seeded = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    settings: { kiosk: true },
  });
  const base = `/app/api/evaluations/${seeded.evaluationId}`;
  if (state === "lobby") expect((await teacher.post(`${base}/state`, { to: "lobby" })).statusCode).toBe(200);
  if (state === "running") expect((await teacher.post(`${base}/start`, { confirm: true })).statusCode).toBe(200);
  return { ...seeded, student, teacher, base };
}

/** The phone's two steps: read the code, approve it for `evaluationId`. */
async function approveOnPhone(phone: Client, userCode: string, evaluationId: string) {
  const looked = await phone.get(`/app/api/pair/${userCode}`);
  expect(looked.statusCode, looked.body).toBe(200);
  expect(PairPreview.parse(looked.json()).evaluations.map((e) => e.id)).toContain(evaluationId);
  const ok = await phone.post("/app/api/pair", { code: userCode, evaluationId });
  expect(ok.statusCode, ok.body).toBe(200);
}

/** A station seated for the exam's student, its attempt entered: the station's jar now sits. */
async function seated(e: Awaited<ReturnType<typeof exam>>) {
  const station = await namedStation();
  const auth = await station.code();
  await approveOnPhone(e.student, auth.user_code, e.evaluationId);
  expect((await station.poll(auth.device_code)).statusCode).toBe(200);
  const entered = await station.post(`${e.base}/attempt`, {});
  expect(entered.statusCode, entered.body).toBe(200);
  const attemptId = entered.json().view.attempt.id as string;
  const save = (revision: number) =>
    station.send("PUT", `/app/api/attempts/${attemptId}/answers/${e.itemIds[0]}`, {
      payload: `answer-${revision}`,
      revision,
      clientTs: server.clock.now().toISOString(),
    });
  const submit = () => station.post(`/app/api/attempts/${attemptId}/submit`, { confirm: true });
  return { station, attemptId, save, submit };
}

async function accessOf(e: Awaited<ReturnType<typeof exam>>) {
  const res = await e.teacher.get(`${e.base}/dashboard`);
  expect(res.statusCode, res.body).toBe(200);
  return DashboardView.parse(res.json()).rows.find((r) => r.userId === e.student.id)!.access;
}

// ---------------------------------------------------------------------------
// The whole story
// ---------------------------------------------------------------------------

describe("a sitting on a kiosk station, from its first attestation to the next student", () => {
  it("names, pairs, sits, re-attests, submits, and returns the station to its pairing screen", async () => {
    const e = await exam();

    // The Chromebook attests for the first time: known, unnamed, not pairable.
    const station = new Station();
    const first = await station.attest();
    expect(first.statusCode, first.body).toBe(200);
    expect(KioskAttested.parse(first.json()).station).toEqual({ label: null, status: "unnamed" });
    expect(station.jar.has(KIOSK_COOKIE)).toBe(true);
    expect((await station.post("/app/api/kiosk/device_authorization")).json()).toEqual({ error: "not_recognised" });

    // The admin finds it in the registry by its serial, and names it.
    const admin = await person("admin");
    const devices = KioskDevice.array().parse((await admin.get("/app/api/admin/kiosk-devices")).json());
    const row = devices.find((d) => d.googleDeviceId === station.googleId)!;
    expect(row).toMatchObject({ label: null, status: "unnamed", attestation: "ok" });
    const named = await admin.send("PATCH", `/app/api/admin/kiosk-devices/${row.id}`, { label: "Poste de secours n° 7" });
    expect(named.json()).toMatchObject({ label: "Poste de secours n° 7", status: "active" });
    expect((await station.get("/app/api/kiosk/station")).json()).toEqual({
      label: "Poste de secours n° 7",
      status: "active",
    });

    // The station shows a code; nothing is approved yet.
    const auth = await station.code();
    expect(auth.label).toBe("Poste de secours n° 7");
    expect(auth.verification_uri_complete).toMatch(new RegExp(`/pair\\?code=${auth.user_code}$`));
    expect((await station.poll(auth.device_code)).json()).toEqual({ error: "authorization_pending" });

    // The phone reads the code: the station's label and the exam.
    const looked = await e.student.get(`/app/api/pair/${auth.user_code}`);
    expect(looked.statusCode, looked.body).toBe(200);
    const preview = PairPreview.parse(looked.json());
    expect(preview.station).toEqual({ label: "Poste de secours n° 7" });
    expect(preview.evaluations).toEqual([expect.objectContaining({ id: e.evaluationId, title: "Test évaluation" })]);
    // ADR-079 §7: the conditions, read on the phone, since the station begins the attempt directly.
    expect(preview.evaluations[0]!.conditions.imposed[0]).toEqual({
      key: "trusted_client",
      kind: "forbidden",
      clients: ["kiosk"],
    });
    const approved = await e.student.post("/app/api/pair", { code: auth.user_code, evaluationId: e.evaluationId });
    expect(approved.json()).toEqual({ station: { label: "Poste de secours n° 7" } });

    // The station's next poll (past the interval) gets the kiosk session.
    server.clock.advance(auth.interval * 1000);
    const token = await station.poll(auth.device_code);
    expect(token.statusCode, token.body).toBe(200);
    expect(token.json()).toEqual({ redirect: `/take/${e.evaluationId}` });
    expect(station.jar.has(SESSION_COOKIE)).toBe(true);
    const me = await station.get("/app/api/me");
    expect(me.json().session).toMatchObject({ kind: "kiosk", evaluationId: e.evaluationId, readOnly: false });

    // The student sits: enters, answers.
    const entered = await station.post(`${e.base}/attempt`, {});
    expect(entered.statusCode, entered.body).toBe(200);
    const attemptId = entered.json().view.attempt.id as string;
    const answer = (revision: number) =>
      station.send("PUT", `/app/api/attempts/${attemptId}/answers/${e.itemIds[0]}`, {
        payload: `answer-${revision}`,
        revision,
        clientTs: server.clock.now().toISOString(),
      });
    expect((await answer(1)).statusCode).toBe(200);

    // The supervisor sees where the student sits.
    expect(await accessOf(e)).toEqual({ kind: "kiosk", station: "Poste de secours n° 7", alert: null });

    // Ten minutes later the page re-attests; the credential is kept, and the student goes on.
    server.clock.advance(10 * 60_000);
    const credential = station.jar.get(KIOSK_COOKIE);
    expect((await station.attest()).statusCode).toBe(200);
    expect(station.jar.get(KIOSK_COOKIE)).toBe(credential);
    expect((await answer(2)).statusCode).toBe(200);

    // The submit (fresh check) ends the kiosk session, never the phone's.
    const submitted = await station.post(`/app/api/attempts/${attemptId}/submit`, { confirm: true });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json().state).toBe("submitted");
    expect((await station.get("/app/api/me")).statusCode).toBe(401);
    expect((await station.get(`/app/api/attempts/${attemptId}`)).statusCode).toBe(401);
    expect((await e.student.get("/app/api/me")).statusCode).toBe(200);

    // The station, still holding its own cookie, is back on its pairing screen.
    const next = await station.code();
    expect(next.user_code).not.toBe(auth.user_code);
    expect(next.label).toBe("Poste de secours n° 7");
  });
});

// ---------------------------------------------------------------------------
// What goes wrong
// ---------------------------------------------------------------------------

describe("the pairing refuses", () => {
  it("an expired code: the station is told expired_token, the phone finds nothing", async () => {
    const e = await exam();
    const station = await namedStation();
    const auth = await station.code();
    server.clock.advance(5 * 60_000 + 1_000);
    const polled = await station.poll(auth.device_code);
    expect(polled.statusCode).toBe(400);
    expect(polled.json()).toEqual({ error: "expired_token" });
    expect((await e.student.get(`/app/api/pair/${auth.user_code}`)).statusCode).toBe(404);
    expect((await e.student.post("/app/api/pair", { code: auth.user_code, evaluationId: e.evaluationId })).statusCode).toBe(404);
  });

  it("a code used twice: a second approval, and a second consumption", async () => {
    const e = await exam();
    const station = await namedStation();
    const auth = await station.code();
    await approveOnPhone(e.student, auth.user_code, e.evaluationId);
    const again = await e.student.post("/app/api/pair", { code: auth.user_code, evaluationId: e.evaluationId });
    expect(again.statusCode).toBe(404);
    expect((await station.poll(auth.device_code)).statusCode).toBe(200);
    const twice = await station.poll(auth.device_code);
    expect(twice.statusCode).toBe(400);
    expect(twice.json()).toEqual({ error: "access_denied" });
  });

  it("a student with no seat in the classroom: no exam offered, the approval refused", async () => {
    const e = await exam();
    const stranger = await person("student");
    const station = await namedStation();
    const auth = await station.code();
    const looked = await stranger.get(`/app/api/pair/${auth.user_code}`);
    expect(looked.statusCode).toBe(200);
    expect(PairPreview.parse(looked.json()).evaluations).toEqual([]);
    const refused = await stranger.post("/app/api/pair", { code: auth.user_code, evaluationId: e.evaluationId });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "evaluation_not_pairable" });
    expect((await station.poll(auth.device_code)).json()).toEqual({ error: "authorization_pending" });
  });

  it("an exam outside its window: draft, scheduled, closed are neither offered nor approved", async () => {
    const station = await namedStation();
    const draft = await exam("draft");
    const closed = await exam();
    expect((await closed.teacher.post(`${closed.base}/close`)).statusCode).toBe(200);
    const scheduled = await exam("draft");
    const opensAt = new Date(server.clock.now().getTime() + 3_600_000);
    const timed = await scheduled.teacher.send("PATCH", scheduled.base, {
      opensAt: opensAt.toISOString(),
      closesAt: new Date(opensAt.getTime() + 3_600_000).toISOString(),
    });
    expect(timed.statusCode, timed.body).toBe(200);
    const moved = await scheduled.teacher.post(`${scheduled.base}/state`, { to: "scheduled" });
    expect(moved.statusCode, moved.body).toBe(200);

    for (const e of [draft, scheduled, closed]) {
      const auth = await station.code();
      expect(PairPreview.parse((await e.student.get(`/app/api/pair/${auth.user_code}`)).json()).evaluations).toEqual([]);
      expect((await e.student.post("/app/api/pair", { code: auth.user_code, evaluationId: e.evaluationId })).statusCode).toBe(409);
    }

    // The lobby is open for pairing.
    const lobby = await exam("lobby");
    const auth = await station.code();
    await approveOnPhone(lobby.student, auth.user_code, lobby.evaluationId);
  });

  it("an exam closed between the phone's approval and the station's poll: access_denied", async () => {
    const e = await exam();
    const station = await namedStation();
    const auth = await station.code();
    await approveOnPhone(e.student, auth.user_code, e.evaluationId);
    expect((await e.teacher.post(`${e.base}/close`)).statusCode).toBe(200);
    const polled = await station.poll(auth.device_code);
    expect(polled.statusCode).toBe(400);
    expect(polled.json()).toEqual({ error: "access_denied" });
    expect(station.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it("an unnamed station, and a retired one: not_recognised", async () => {
    const unnamed = new Station();
    expect((await unnamed.attest()).statusCode).toBe(200);
    const refused = await unnamed.post("/app/api/kiosk/device_authorization");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "not_recognised" });

    const retired = await namedStation();
    const admin = await person("admin");
    await admin.send("PATCH", `/app/api/admin/kiosk-devices/${retired.deviceId}`, { status: "retired" });
    expect((await retired.attest()).statusCode).toBe(200);
    expect((await retired.post("/app/api/kiosk/device_authorization")).statusCode).toBe(403);
  });
});

describe("the attestation during the sitting (ADR-051 §6)", () => {
  it("a refused attestation suspends the writes, not the reads, alerts the supervisor, and lifts on the next ok", async () => {
    const e = await exam();
    const sitting = await seated(e);
    expect((await sitting.save(1)).statusCode).toBe(200);

    alerts.length = 0;
    expect((await sitting.station.attest("refuse")).statusCode).toBe(403);
    const refused = await sitting.save(2);
    expect(refused.statusCode).toBe(423);
    expect(refused.json()).toEqual({ error: "kiosk_suspended" });
    expect((await sitting.station.get(`/app/api/attempts/${sitting.attemptId}`)).statusCode).toBe(200);
    expect(alerts.map((a) => [a.kind, a.userId])).toEqual([["kiosk_suspended", e.student.id]]);
    expect(await accessOf(e)).toMatchObject({ kind: "kiosk", alert: "suspended" });

    expect((await sitting.station.attest()).statusCode).toBe(200);
    expect((await sitting.save(3)).statusCode).toBe(200);
    expect(alerts.map((a) => a.kind)).toEqual(["kiosk_suspended", "kiosk_resumed"]);
    expect(await accessOf(e)).toMatchObject({ kind: "kiosk", alert: null });
  });

  it("an unavailable Google suspends nothing, and the supervisor sees it", async () => {
    const e = await exam();
    const sitting = await seated(e);
    expect((await sitting.station.attest("unavailable")).statusCode).toBe(403);
    expect((await sitting.save(1)).statusCode).toBe(200);
    expect(await accessOf(e)).toMatchObject({ kind: "kiosk", alert: "unavailable" });
  });

  it("a submit on a stale check: 423 kiosk_attestation_stale, then accepted after a re-attestation", async () => {
    const e = await exam();
    const sitting = await seated(e);
    server.clock.advance(3 * 60_000);
    const stale = await sitting.submit();
    expect(stale.statusCode).toBe(423);
    expect(stale.json()).toEqual({ error: "kiosk_attestation_stale" });
    expect((await sitting.station.attest()).statusCode).toBe(200);
    const done = await sitting.submit();
    expect(done.statusCode, done.body).toBe(200);
    expect((await sitting.station.get("/app/api/me")).statusCode).toBe(401);
  });
});

describe("the supervisor pairs a station for a student without a phone (ADR-051 §7)", () => {
  it("approves the station's code for the student, who then sits as on their own pairing", async () => {
    const e = await exam();
    const station = await namedStation("Poste de secours n° 4");
    const auth = await station.code();
    const assigned = await e.teacher.post(`${e.base}/kiosk-assign`, { userCode: auth.user_code, userId: e.student.id });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toEqual({ station: { label: "Poste de secours n° 4" } });
    expect((await station.poll(auth.device_code)).statusCode).toBe(200);
    const me = await station.get("/app/api/me");
    expect(me.json().id).toBe(e.student.id);
    expect(me.json().session).toMatchObject({ kind: "kiosk", readOnly: false });
    expect((await station.post(`${e.base}/attempt`, {})).statusCode).toBe(200);
    expect(await accessOf(e)).toEqual({ kind: "kiosk", station: "Poste de secours n° 4", alert: null });
  });
});

// Last: every entry the run wrote, searched for what it must never hold.
describe("the audit (ADR-051 §8)", () => {
  it("never holds a code, a device_code or a cookie value", async () => {
    // The server is this file's own: its whole audit is this run's.
    const entries = await server.app.db.select().from(auditLog);
    const kiosk = entries.filter((row) => row.action.startsWith("kiosk."));
    expect(kiosk.length).toBeGreaterThan(10);
    const text = JSON.stringify(entries);
    expect(secrets.size).toBeGreaterThan(20);
    for (const secret of secrets) expect(text, secret).not.toContain(secret);
  });
});
