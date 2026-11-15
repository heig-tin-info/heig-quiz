/**
 * The station's cookie over https is `__Host-quiz_kiosk` (ADR-089's amendment
 * of 2026-11-15, point 3; M6-11a), read by every reader of a station. The
 * bare `quiz_kiosk` of before is still read until the station's next
 * attestation moves it: that is the "bare-name fallback" block, which M6-11f
 * deletes with the fallback itself. Production mode throughout.
 */
import { CSRF_COOKIE } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSession, SESSION_COOKIE } from "../../auth/session.js";
import { fakeShort } from "../../test/fakeType.js";
import { testServer, type TestServer } from "../../test/http.js";
import { kioskStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";

const PREFIXED = "__Host-quiz_kiosk";
const BARE = "quiz_kiosk";

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

let host = 0;
const inject = (method: "GET" | "POST", url: string, cookie: string, payload?: object) =>
  server.app.inject({ method, url, remoteAddress: `10.9.0.${++host}`, headers: { cookie }, ...(payload ? { payload } : {}) });

/** A station, a kiosk session sitting a running exam on it, and the three readers of its cookie. */
async function seated() {
  const station = await kioskStation(server.app);
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const { evaluationId } = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], mode: "exam", settings: { kiosk: true } });
  const started = await server.app.inject({ method: "POST", url: `/app/api/evaluations/${evaluationId}/start`, headers: teacher.headers, payload: { confirm: true } });
  expect(started.statusCode, started.body).toBe(200);
  const s = await createSession(server.app.db, student.id, 12, {
    kind: "kiosk",
    actorUserId: null,
    evaluationId,
    projectId: null,
    deviceId: station.deviceId,
  });
  const session = `${server.app.cookieName(SESSION_COOKIE)}=${s.token}; ${server.app.cookieName(CSRF_COOKIE)}=${s.csrf}`;
  /** The status each reader answers with `cookie`: the trust check of a write, the station page, a pairing code. */
  const write = (cookie: string) =>
    server.app.inject({
      method: "POST",
      url: `/app/api/evaluations/${evaluationId}/attempt`,
      headers: { cookie: `${session}; ${cookie}`, "x-csrf-token": s.csrf },
      payload: {},
    });
  const readers = async (cookie: string) => [
    (await write(cookie)).statusCode,
    (await inject("GET", "/app/api/kiosk/station", cookie)).statusCode,
    (await inject("POST", "/app/api/kiosk/device_authorization", cookie, {})).statusCode,
  ];
  return { station, readers };
}

const setCookieLines = (res: { headers: Record<string, unknown> }) =>
  [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");

describe("the station cookie over https (ADR-089, point 3)", () => {
  it("is read under its prefixed name by every reader", async () => {
    const { station, readers } = await seated();
    expect(await readers(`${PREFIXED}=${station.credential}`)).toEqual([200, 200, 200]);
    expect(await readers(`${PREFIXED}=${"A".repeat(43)}`)).toEqual([401, 404, 403]);
  });
});

describe("the bare-name fallback — M6-11f deletes this block", () => {
  it("serves a station holding the bare cookie, then moves it at verify with the same credential", async () => {
    const { station, readers } = await seated();
    const bare = `${BARE}=${station.credential}`;
    expect(await readers(bare)).toEqual([200, 200, 200]);

    const res = await inject("POST", "/app/api/kiosk/attest/verify", bare, { response: `mock:${station.googleDeviceId}` });
    expect(res.statusCode, res.body).toBe(200);
    const lines = setCookieLines(res);
    expect(lines.find((l) => l.startsWith(`${PREFIXED}=`))!.split(";")[0]).toBe(`${PREFIXED}=${station.credential}`);
    const expiry = lines.find((l) => l.startsWith(`${BARE}=`))!;
    expect(expiry.split(";")[0]).toBe(`${BARE}=`);
    expect(expiry).toMatch(/; Max-Age=0/);
    expect(expiry).toMatch(/; Path=\/app\/api(;|$)/);
    expect(expiry).not.toMatch(/Domain=/i);

    // What the browser now holds: the prefixed cookie only. The sitting goes on.
    expect(await readers(`${PREFIXED}=${station.credential}`)).toEqual([200, 200, 200]);
  });

  it("lets the prefixed cookie win over the bare one", async () => {
    const { station, readers } = await seated();
    const unknown = "A".repeat(43);
    expect(await readers(`${BARE}=${unknown}; ${PREFIXED}=${station.credential}`)).toEqual([200, 200, 200]);
    expect(await readers(`${BARE}=${station.credential}; ${PREFIXED}=${unknown}`)).toEqual([401, 404, 403]);
  });
});
