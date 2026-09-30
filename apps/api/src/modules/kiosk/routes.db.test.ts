import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { KioskDevice } from "@quiz/contracts";

import { auditLog, kioskDevices } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";
import { ATTEST_LIMIT } from "./routes.js";
import { KIOSK_COOKIE } from "./service.js";

let server: TestServer;

beforeAll(async () => {
  server = await testServer({ KIOSK_ATTESTATION: "mock" });
});

afterAll(async () => {
  await server.close();
});

/** The `quiz_kiosk` credential a response sets, with the cookie's attributes. */
function kioskCookie(res: { headers: Record<string, unknown> }) {
  const all = [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");
  const line = all.find((c) => c.startsWith(`${KIOSK_COOKIE}=`));
  return line ? { value: line.split(";")[0]!.slice(KIOSK_COOKIE.length + 1), line } : null;
}

/** Each call from its own address, so no test but the limiter's meets the limiter. */
let host = 0;
const nextAddress = () => `10.0.${Math.floor(++host / 250)}.${host % 250}`;

const attest = (payload: Payload, credential?: string, headers: Record<string, string> = {}) =>
  server.app.inject({
    method: "POST",
    url: "/app/api/kiosk/attest/verify",
    remoteAddress: nextAddress(),
    payload,
    headers: { ...headers, ...(credential ? { cookie: `${KIOSK_COOKIE}=${credential}` } : {}) },
  });

const station = (credential: string) =>
  server.app.inject({
    method: "GET",
    url: "/app/api/kiosk/station",
    headers: { cookie: `${KIOSK_COOKIE}=${credential}` },
  });

const device = async (googleDeviceId: string) =>
  (await server.app.db.select().from(kioskDevices).where(eq(kioskDevices.googleDeviceId, googleDeviceId)))[0]!;

const audits = (action: string, subjectId?: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.action, action), ...(subjectId ? [eq(auditLog.subjectId, subjectId)] : [])),
    );

describe("the station's attestation (ADR-051 §5)", () => {
  it("hands out a challenge", async () => {
    const res = await server.app.inject({
      method: "POST",
      url: "/app/api/kiosk/attest/challenge",
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().challenge).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("registers a new device unnamed, and sets the station's cookie", async () => {
    const res = await attest({ response: "mock:station-new" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ station: { label: null, status: "unnamed" } });

    const cookie = kioskCookie(res)!;
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cookie.line).toMatch(/HttpOnly/);
    expect(cookie.line).toMatch(/SameSite=Strict/);
    expect(cookie.line).toMatch(/Path=\/app\/api(;|$)/);
    expect(cookie.line).toMatch(/Max-Age=43200/);

    const row = await device("station-new");
    expect(row).toMatchObject({ status: "unnamed", label: null, attestation: "ok" });
    expect(row.attestedAt).toEqual(server.clock.now());
    expect(row.checkedAt).toEqual(server.clock.now());
    // Only the hash is kept.
    expect(row.credentialHash).not.toBe(cookie.value);
    expect(row.credentialHash).toMatch(/^[0-9a-f]{64}$/);

    expect(await audits("kiosk.device_registered", row.id)).toHaveLength(1);
    expect(await audits("kiosk.attested", row.id)).toHaveLength(1);

    expect((await station(cookie.value)).json()).toEqual({ label: null, status: "unnamed" });
  });

  it("rotates the credential on every accepted attestation", async () => {
    const first = kioskCookie(await attest({ response: "mock:station-rot" }))!.value;
    server.clock.advance(60_000);
    const second = kioskCookie(await attest({ response: "mock:station-rot" }, first))!.value;
    expect(second).not.toBe(first);

    expect((await station(first)).statusCode).toBe(404);
    expect((await station(second)).statusCode).toBe(200);
    const row = await device("station-rot");
    expect(row.attestedAt).toEqual(server.clock.now());
    // Registered once, attested twice.
    expect(await audits("kiosk.device_registered", row.id)).toHaveLength(1);
    expect(await audits("kiosk.attested", row.id)).toHaveLength(2);
  });

  it("records a failure on the station its cookie names, and tells the client nothing", async () => {
    const credential = kioskCookie(await attest({ response: "mock:station-fail" }))!.value;
    const { id, attestedAt } = await device("station-fail");

    server.clock.advance(60_000);
    const refused = await attest({ response: "mock:refuse" }, credential);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: "not_attested" });
    expect(kioskCookie(refused)).toBeNull();
    expect(await device("station-fail")).toMatchObject({
      attestation: "refused",
      checkedAt: server.clock.now(),
      attestedAt,
    });

    // The extension's own failure is a refusal too; its text is kept nowhere.
    server.clock.advance(60_000);
    await attest({ error: "challengeKey failed: secret-looking detail" }, credential);
    server.clock.advance(60_000);
    await attest({ response: "mock:unavailable" }, credential);
    expect(await device("station-fail")).toMatchObject({
      attestation: "unavailable",
      checkedAt: server.clock.now(),
    });

    const failed = await audits("kiosk.attest_failed", id);
    expect(failed.map((a) => a.payload)).toEqual([
      { reason: "refused" },
      { reason: "refused" },
      { reason: "unavailable" },
    ]);
    // The cookie still names the station: a failure does not unregister it.
    expect((await station(credential)).statusCode).toBe(200);
  });

  it("audits a failure of an unknown caller without a device", async () => {
    const before = (await audits("kiosk.attest_failed", "unknown")).length;
    const res = await attest({ response: "not-a-mock-response" }, "x".repeat(43));
    expect(res.statusCode).toBe(403);
    const after = await audits("kiosk.attest_failed", "unknown");
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.payload).toEqual({ reason: "refused" });
  });

  it("never writes a response, a challenge or a cookie to the audit", async () => {
    const credential = kioskCookie(await attest({ response: "mock:station-secret" }))!.value;
    await attest({ response: "mock:refuse" }, credential);
    const rows = await server.app.db.select().from(auditLog).where(like(auditLog.action, "kiosk.%"));
    const text = JSON.stringify(rows);
    expect(text).not.toContain(credential);
    expect(text).not.toContain("mock:");
    expect(text).not.toContain("secret-looking");
  });

  it("validates the body", async () => {
    expect((await attest({})).statusCode).toBe(400);
    expect((await attest({ response: "" })).statusCode).toBe(400);
    expect((await attest({ response: "mock:a", error: "x" })).statusCode).toBe(400);
  });

  it("refuses a cross-site POST from a browser signed in on this origin", async () => {
    const res = await attest({ response: "mock:station-csrf" }, undefined, {
      cookie: "quiz_csrf=abc",
      "x-csrf-token": "not-abc",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "csrf" });
  });

  it("limits the attestation calls of one address, challenge and verify together", async () => {
    const from = (url: string, remoteAddress: string) =>
      server.app.inject({
        method: "POST",
        url,
        remoteAddress,
        ...(url.endsWith("verify") ? { payload: { response: "mock:refuse" } } : {}),
      });
    for (let i = 0; i < ATTEST_LIMIT / 2; i++) {
      expect((await from("/app/api/kiosk/attest/challenge", "192.0.2.1")).statusCode).toBe(200);
      expect((await from("/app/api/kiosk/attest/verify", "192.0.2.1")).statusCode).toBe(403);
    }
    server.clock.advance(15_000);
    const limited = await from("/app/api/kiosk/attest/challenge", "192.0.2.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(limited.headers["retry-after"]).toBe("45");
    expect((await from("/app/api/kiosk/attest/verify", "192.0.2.1")).statusCode).toBe(429);
    // Another address has its own budget, and the window reopens.
    expect((await from("/app/api/kiosk/attest/challenge", "192.0.2.2")).statusCode).toBe(200);
    server.clock.advance(45_000);
    expect((await from("/app/api/kiosk/attest/challenge", "192.0.2.1")).statusCode).toBe(200);
  });

  it("answers 404 for a station without a cookie, or with a stranger's", async () => {
    expect((await server.app.inject({ method: "GET", url: "/app/api/kiosk/station" })).statusCode).toBe(404);
    expect((await station("y".repeat(43))).statusCode).toBe(404);
  });
});

describe("the station registry (admin)", () => {
  const list = (headers: Record<string, string> = {}) =>
    server.app.inject({ method: "GET", url: "/app/api/admin/kiosk-devices", headers });
  const patch = (id: string, payload: Payload, headers: Record<string, string>) =>
    server.app.inject({ method: "PATCH", url: `/app/api/admin/kiosk-devices/${id}`, payload, headers });

  it("is an admin's, and a 404 for anyone else", async () => {
    const admin = await server.signIn("admin");
    const teacher = await server.signIn("teacher");
    await attest({ response: "mock:station-list" });
    const { id } = await device("station-list");

    const res = await list(admin.headers);
    expect(res.statusCode).toBe(200);
    const rows = z.array(KioskDevice).parse(res.json());
    expect(rows.find((r) => r.id === id)).toMatchObject({
      googleDeviceId: "station-list",
      status: "unnamed",
      label: null,
      attestation: "ok",
    });
    // The stations waiting for a name come first.
    const rank = { unnamed: 0, active: 1, retired: 2 };
    const ranks = rows.map((r) => rank[r.status]);
    expect(ranks).toEqual([...ranks].sort());

    expect((await list(teacher.headers)).statusCode).toBe(404);
    expect((await patch(id, { label: "x" }, teacher.headers)).statusCode).toBe(404);
    expect((await list()).statusCode).toBe(401);
  });

  it("names a station (active), renames it, retires and reactivates it", async () => {
    const admin = await server.signIn("admin");
    await attest({ response: "mock:station-name" });
    const { id } = await device("station-name");

    const named = await patch(id, { label: "  Poste de secours n° 7  " }, admin.headers);
    expect(named.statusCode).toBe(200);
    expect(named.json()).toMatchObject({ id, label: "Poste de secours n° 7", status: "active" });

    const renamed = await patch(id, { label: "Poste n° 8" }, admin.headers);
    expect(renamed.json()).toMatchObject({ label: "Poste n° 8", status: "active" });

    const retired = await patch(id, { status: "retired" }, admin.headers);
    expect(retired.json()).toMatchObject({ label: "Poste n° 8", status: "retired" });
    // Renaming a retired station leaves it retired.
    expect((await patch(id, { label: "Poste n° 9" }, admin.headers)).json()).toMatchObject({
      status: "retired",
    });
    const back = await patch(id, { status: "active" }, admin.headers);
    expect(back.json()).toMatchObject({ label: "Poste n° 9", status: "active" });

    expect((await audits("kiosk.device_labeled", id)).map((a) => a.payload)).toEqual([
      { from: null, to: "Poste de secours n° 7" },
      { from: "Poste de secours n° 7", to: "Poste n° 8" },
      { from: "Poste n° 8", to: "Poste n° 9" },
    ]);
    expect(await audits("kiosk.device_retired", id)).toHaveLength(1);
    expect(await audits("kiosk.device_reactivated", id)).toHaveLength(1);
    expect((await audits("kiosk.device_labeled", id))[0]!.actorUserId).toBe(admin.id);
  });

  it("never makes a station active without a name", async () => {
    const admin = await server.signIn("admin");
    await attest({ response: "mock:station-anon" });
    const { id } = await device("station-anon");
    expect((await patch(id, { status: "retired" }, admin.headers)).json()).toMatchObject({
      status: "retired",
      label: null,
    });
    const refused = await patch(id, { status: "active" }, admin.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("label_required");
    expect((await patch(id, { status: "active", label: "Poste 3" }, admin.headers)).json()).toMatchObject({
      status: "active",
      label: "Poste 3",
    });
  });

  it("validates the patch, and answers 404 for an unknown station", async () => {
    const admin = await server.signIn("admin");
    await attest({ response: "mock:station-val" });
    const { id } = await device("station-val");
    expect((await patch(id, {}, admin.headers)).statusCode).toBe(400);
    expect((await patch(id, { label: "   " }, admin.headers)).statusCode).toBe(400);
    expect((await patch(id, { label: "x".repeat(81) }, admin.headers)).statusCode).toBe(400);
    expect((await patch(id, { status: "unnamed" }, admin.headers)).statusCode).toBe(400);
    expect(
      (await patch("00000000-0000-4000-8000-000000000000", { label: "x" }, admin.headers)).statusCode,
    ).toBe(404);
  });
});

describe("KIOSK_ATTESTATION=off", () => {
  it("has no kiosk route at all", async () => {
    const off = await testServer();
    try {
      const admin = await off.signIn("admin");
      for (const [method, url] of [
        ["POST", "/app/api/kiosk/attest/challenge"],
        ["POST", "/app/api/kiosk/attest/verify"],
        ["GET", "/app/api/kiosk/station"],
        ["GET", "/app/api/admin/kiosk-devices"],
      ] as const) {
        const res = await off.app.inject({ method, url, headers: admin.headers });
        expect(res.statusCode, `${method} ${url}`).toBe(404);
      }
      const config = await off.app.inject({ method: "GET", url: "/app/api/config" });
      expect(config.json().kiosk).toBeNull();
    } finally {
      await off.close();
    }
  });

  it("says in the public configuration that the attestation is the mock", async () => {
    const res = await server.app.inject({ method: "GET", url: "/app/api/config" });
    expect(res.json().kiosk).toEqual({ extensionId: null, mock: true });
  });
});
