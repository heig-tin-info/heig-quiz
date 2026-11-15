/**
 * The station's cookie takes the `__Host-` prefix over https, and no station
 * is stranded by it (ADR-089's amendment of 2026-11-15, point 3; M6-11a). In
 * production mode: `__Host-quiz_kiosk; Path=/` is what an attestation sets;
 * the bare `quiz_kiosk` of before (`Path=/app/api`), which the production
 * stations hold at deploy, is still read wherever a station is read, until
 * the station's next attestation re-writes the SAME credential under the new
 * name and expires the bare one. Both present, the prefixed one wins.
 */
import { CSRF_COOKIE } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSession, SESSION_COOKIE } from "../../auth/session.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { KIOSK_COOKIE, recordAttested, updateDevice } from "./service.js";

const PREFIXED = "__Host-quiz_kiosk";
const BARE = KIOSK_COOKIE;

let server: TestServer;
let restore: () => void;

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer({ KIOSK_ATTESTATION: "mock" }, { production: true });
});
afterAll(async () => {
  await server.close();
  restore();
});

/** The `Set-Cookie` lines of a response. */
const setCookieLines = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");

/** A named, active station as an attestation made it; `googleDeviceId` is what `mock:<id>` names. */
async function station() {
  const googleDeviceId = `cookie-${crypto.randomUUID()}`;
  const { device, credential } = await recordAttested(server.app.db, googleDeviceId, server.app.clock.now());
  await updateDevice(server.app.db, device.id, { label: "Poste n° 19" });
  return { deviceId: device.id, googleDeviceId, credential };
}

/** A running kiosk exam with one seated student, and a `kiosk` session on `deviceId`. */
async function sitting(deviceId: string) {
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const { evaluationId } = await seedLive(server.app.db, {
    teacherId: teacher.id,
    studentIds: [student.id],
    mode: "exam",
    settings: { kiosk: true },
  });
  const started = await server.app.inject({
    method: "POST",
    url: `/app/api/evaluations/${evaluationId}/start`,
    headers: teacher.headers,
    payload: { confirm: true },
  });
  expect(started.statusCode, started.body).toBe(200);
  const s = await createSession(server.app.db, student.id, 12, {
    kind: "kiosk",
    actorUserId: null,
    evaluationId,
    projectId: null,
    deviceId,
  });
  const session = `${server.app.cookieName(SESSION_COOKIE)}=${s.token}; ${server.app.cookieName(CSRF_COOKIE)}=${s.csrf}`;
  /** The session's write (entering the attempt), with the station cookies given. */
  const write = (stationCookies: string) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/attempt`,
      headers: { cookie: `${session}; ${stationCookies}`, "x-csrf-token": s.csrf },
      payload: {},
    });
  return { write };
}

let host = 0;
const verify = (googleDeviceId: string, cookie: string) =>
  server.app.inject({
    method: "POST",
    url: "/app/api/kiosk/attest/verify",
    remoteAddress: `10.9.0.${++host}`,
    payload: { response: `mock:${googleDeviceId}` },
    headers: { cookie },
  });

const stationPage = (cookie: string) => server.app.inject({ method: "GET", url: "/app/api/kiosk/station", headers: { cookie } });
const pairingCode = (cookie: string) =>
  server.app.inject({
    method: "POST",
    url: "/app/api/kiosk/device_authorization",
    remoteAddress: `10.9.1.${++host}`,
    headers: { cookie },
    payload: {},
  });

/** An unknown credential: 43 base64url characters, so the lookup runs and finds nothing. */
const UNKNOWN = "A".repeat(43);

describe("the station cookie over https (ADR-089, point 3)", () => {
  it("is set as __Host-quiz_kiosk; Path=/; Secure; HttpOnly; SameSite=Strict, without a Domain", async () => {
    const res = await verify(`fresh-${host}`, "");
    expect(res.statusCode, res.body).toBe(200);
    const lines = setCookieLines(res);
    const line = lines.find((l) => l.startsWith(`${PREFIXED}=`))!;
    expect(line).toMatch(/; Path=\/(;|$)/);
    expect(line).toMatch(/; Secure/);
    expect(line).toMatch(/; HttpOnly/);
    expect(line).toMatch(/; SameSite=Strict/);
    expect(line).not.toMatch(/Domain=/i);
    // A station with no bare cookie is sent no expiry of one.
    expect(lines.some((l) => l.startsWith(`${BARE}=`))).toBe(false);
  });

  it("is read under its bare name until the next attestation: the trust check of a kiosk session's write", async () => {
    const s = await station();
    const { write } = await sitting(s.deviceId);
    expect((await write(`${BARE}=${s.credential}`)).statusCode).toBe(200);
  });

  it("is read under its bare name on the station routes", async () => {
    const s = await station();
    const page = await stationPage(`${BARE}=${s.credential}`);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ label: "Poste n° 19", status: "active" });
    expect((await pairingCode(`${BARE}=${s.credential}`)).statusCode).toBe(200);
  });

  it("moves at the next attestation: same credential, under the new name, the bare one expired where Quiz set it", async () => {
    const s = await station();
    const { write } = await sitting(s.deviceId);
    expect((await write(`${BARE}=${s.credential}`)).statusCode).toBe(200);

    const res = await verify(s.googleDeviceId, `${BARE}=${s.credential}`);
    expect(res.statusCode, res.body).toBe(200);
    const lines = setCookieLines(res);
    const prefixed = lines.find((l) => l.startsWith(`${PREFIXED}=`))!;
    expect(prefixed.split(";")[0]).toBe(`${PREFIXED}=${s.credential}`);
    const bare = lines.find((l) => l.startsWith(`${BARE}=`))!;
    expect(bare.split(";")[0]).toBe(`${BARE}=`);
    expect(bare).toMatch(/; Max-Age=0/);
    expect(bare).toMatch(/; Path=\/app\/api(;|$)/);
    expect(bare).not.toMatch(/Domain=/i);

    // What the browser now holds: the prefixed cookie only. The sitting goes on.
    expect((await write(`${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
    expect((await stationPage(`${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
  });

  it("is read under its prefixed name alone", async () => {
    const s = await station();
    const { write } = await sitting(s.deviceId);
    expect((await write(`${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
    expect((await stationPage(`${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
    expect((await pairingCode(`${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
  });

  it("prefers the prefixed cookie when both arrive", async () => {
    const s = await station();
    const { write } = await sitting(s.deviceId);
    expect((await write(`${BARE}=${UNKNOWN}; ${PREFIXED}=${s.credential}`)).statusCode).toBe(200);
    // A valid bare cookie does not rescue an unknown prefixed one.
    expect((await write(`${BARE}=${s.credential}; ${PREFIXED}=${UNKNOWN}`)).statusCode).toBe(401);
    expect((await stationPage(`${BARE}=${s.credential}; ${PREFIXED}=${UNKNOWN}`)).statusCode).toBe(404);
  });

  it("refuses an unknown credential, under either name, as before", async () => {
    const s = await station();
    const { write } = await sitting(s.deviceId);
    for (const name of [BARE, PREFIXED]) {
      expect((await write(`${name}=${UNKNOWN}`)).statusCode, name).toBe(401);
      expect((await stationPage(`${name}=${UNKNOWN}`)).statusCode, name).toBe(404);
      const code = await pairingCode(`${name}=${UNKNOWN}`);
      expect(code.statusCode, name).toBe(403);
    }
  });
});
