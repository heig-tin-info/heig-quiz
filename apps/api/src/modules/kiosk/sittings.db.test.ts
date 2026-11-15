/**
 * Every end of a kiosk station's project sitting closes its portal session
 * (ADR-089, amendment of 2026-11-15, point 4; merge task M6-11d), over the
 * real application with the mock attestation and the portal stubbed:
 *
 * - each end — Leave, replacement, the effective deadline, the 6 h (lazy,
 *   purged or swept), the station's retirement, the account's
 *   pseudonymization, the project's deletion — asks for exactly one close of
 *   the sitting, and an exam's station for none;
 * - the close job: idempotent, retried, `"off"` when the portal is off, its
 *   exhaustion audited and the station held until an administrator's
 *   Retire then Reactivate gets a close through;
 * - the hold: no pairing code, no consumption, for an exam too, until
 *   `close_completed_at`; the station's own payload says it;
 * - the kill switch never stops a close: the sweep with both flags off;
 * - Leave this station ends the caller's own sitting only, and no other
 *   session kind reaches it.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_CODE_GRANT, KioskStation } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import { SYSTEM_ACTOR } from "../../audit.js";
import { endKioskSessions, purgeExpiredSessions } from "../../auth/session.js";
import type { AppConfig } from "../../config.js";
import { auditLog, kioskDevices, kioskPairings, projects, sessions } from "../../db/schema.js";
import type { JobQueue } from "../../jobs.js";
import { fakeShort } from "../../test/fakeType.js";
import { sessionOf, testServer, type Payload, type TestServer } from "../../test/http.js";
import { authorize as authorizeStation, kioskStation, stationHeaders, stationPost as postAsStation, type TestStation } from "../../test/kiosk.js";
import { seedLive } from "../../test/live.js";
import { gradedProject } from "../../test/project.js";
import { pseudonymizeUser } from "../account/service.js";
import { runSittingClose, sweepProjectSittings } from "./jobs.js";
import { SITTING_START_GRACE_MS, closeSittingCloses, completeSittingClose, openSittingCloses, stationHeld, type SittingCloseJob } from "./sittings.js";

const PORTAL = "http://portal.test";
const CONFIG = {
  GITHUB_APP_ID: "",
  GITHUB_APP_PRIVATE_KEY_PATH: "",
  SUPER_ADMIN_EMAIL: "",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"],
  CODESPACE_URL: PORTAL,
  CODESPACE_LAUNCH_SECRET: "a-test-launch-secret-0123456789",
  KIOSK_ATTESTATION: "mock",
  KIOSK_PROJECTS: true,
} as unknown as AppConfig;

let server: TestServer;
let restore: () => void;

/** The portal's answer to a close, the closes it was sent, and what happens while it answers. */
let portalStatus = 204;
const closes: string[] = [];
let whileClosing: (() => Promise<void>) | null = null;

/** The queue `dropSessions` enqueues through, recording instead of running. */
const jobs: SittingCloseJob[] = [];
const recorder: JobQueue = {
  createQueue: async () => {},
  send: async (_name, data) => {
    jobs.push(data as SittingCloseJob);
  },
  work: async () => {},
  stop: async () => {},
};

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  server = await testServer({ KIOSK_ATTESTATION: "mock" });
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.origin !== PORTAL || url.pathname !== "/api/sittings/close" || init.method !== "POST") throw new TypeError("unexpected fetch");
    closes.push(String((init.headers as Record<string, string>).authorization));
    await whileClosing?.();
    return new Response(null, { status: portalStatus });
  });
});
afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  restore();
});
beforeEach(() => {
  jobs.length = 0;
  closes.length = 0;
  portalStatus = 204;
  whileClosing = null;
  openSittingCloses(recorder, server.app.log);
});
afterEach(() => closeSittingCloses());

type Headers = Record<string, string>;
const db = () => server.app.db;
const app = () => server.app;

/** A student seated in a classroom with an (unreleased) project, and its teacher. */
async function world() {
  const student = await server.signIn("student");
  const teacher = await server.signIn("teacher");
  const seeded = await seedLive(db(), { teacherId: teacher.id, studentIds: [student.id], settings: { kiosk: true } });
  const project = await gradedProject(db(), { classroomId: seeded.classroomId, name: "Lab", createdBy: teacher.id, released: false });
  return { student, teacher, evaluationId: seeded.evaluationId, projectId: project.id };
}

/** A pairing consumed long enough ago that the sweep may take it for forgotten. */
const settled = () => new Date(server.clock.now().getTime() - SITTING_START_GRACE_MS - 1000);

/** A consumed project pairing of `userId` with no session (yet). */
async function consumedPairing(deviceId: string, userId: string, activity: { projectId: string } | { evaluationId: string }, consumedAt: Date) {
  const id = randomUUID();
  await db()
    .insert(kioskPairings)
    .values({
      id,
      deviceId,
      deviceCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
      userCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
      state: "consumed",
      userId,
      ...activity,
      expiresAt: new Date(server.clock.now().getTime() + 300_000),
      consumedAt,
    });
  return id;
}

/** A station's sitting of `projectId` for `userId`: the consumed pairing and the session it opened. */
async function sitting(userId: string, activity: { projectId: string } | { evaluationId: string }, station?: TestStation) {
  const st = station ?? (await kioskStation(server.app));
  const id = await consumedPairing(st.deviceId, userId, activity, settled());
  const headers = await sessionOf(db(), userId, { kind: "kiosk", deviceId: st.deviceId, kioskPairingId: id, ...activity });
  return { station: st, sitting: id, headers: { ...headers, cookie: `${headers.cookie}; ${st.cookie}` } as Headers };
}

const pairingOf = async (id: string) => (await db().select().from(kioskPairings).where(eq(kioskPairings.id, id)))[0]!;
const sessionsOf = (id: string) => db().select().from(sessions).where(eq(sessions.kioskPairingId, id));
const inject = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: Payload) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const leave = (headers: Headers) => inject("POST", "/app/api/kiosk/leave", headers);
const run = (job: SittingCloseJob, lastTry = true, config = CONFIG) => runSittingClose(app(), config, job, { lastTry });
const audits = (action: "codespace.session_closed" | "codespace.session_close_failed", sittingId: string) =>
  db().select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.subjectId, sittingId)));

describe("every end asks for one close of a project sitting, none for an exam", () => {
  it("Leave this station", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    const res = await leave(s.headers);
    expect(res.statusCode, res.body).toBe(204);
    expect(await sessionsOf(s.sitting)).toEqual([]);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "left" }]);
    expect((await pairingOf(s.sitting)).closeRequestedAt).not.toBeNull();
  });

  it("replacement by a newer confined session of the pair", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await sessionOf(db(), student.id, { kind: "seb", projectId, sebConfigKey: "c".repeat(64) });
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "superseded" }]);
  });

  it("the station's retirement", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    const admin = await server.signIn("admin");
    const res = await inject("PATCH", `/app/api/admin/kiosk-devices/${s.station.deviceId}`, admin.headers, { status: "retired" });
    expect(res.statusCode, res.body).toBe(200);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "retired" }]);
  });

  it("the student's effective deadline, by the sweep: the repository's own when it has one", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([]);
    const [project] = await db().select({ deadlineAt: projects.deadlineAt }).from(projects).where(eq(projects.id, projectId));
    const before = server.clock.now();
    server.clock.set(new Date(project!.deadlineAt.getTime() + 1000));
    try {
      await sweepProjectSittings(app(), CONFIG);
    } finally {
      server.clock.set(before);
    }
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "deadline" }]);
    expect(await sessionsOf(s.sitting)).toEqual([]);
  });

  it("the 6 h: lazily at the next request, by the purge, and by the sweep", async () => {
    const { student, projectId } = await world();
    const past = new Date(Date.now() - 1000);
    const lazy = await sitting(student.id, { projectId });
    await db().update(sessions).set({ expiresAt: past }).where(eq(sessions.kioskPairingId, lazy.sitting));
    expect((await inject("GET", "/app/api/me", lazy.headers)).statusCode).toBe(401);
    const purged = await sitting(student.id, { projectId });
    await db().update(sessions).set({ expiresAt: past }).where(eq(sessions.kioskPairingId, purged.sitting));
    await purgeExpiredSessions(db(), new Date());
    const swept = await sitting(student.id, { projectId });
    await db().update(sessions).set({ expiresAt: server.clock.now() }).where(eq(sessions.kioskPairingId, swept.sitting));
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([
      { sitting: lazy.sitting, projectId, cause: "expired" },
      { sitting: purged.sitting, projectId, cause: "expired" },
      { sitting: swept.sitting, projectId, cause: "expired" },
    ]);
  });

  it("the account's pseudonymization, through dropSessions", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await pseudonymizeUser(db(), student.id, { by: "admin", actor: SYSTEM_ACTOR, config: CONFIG, log: server.app.log, now: server.clock.now() });
    expect(await sessionsOf(s.sitting)).toEqual([]);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "swept" }]);
  });

  it("the project's deletion, by the sweep's safety net, the sitting closed by its id alone", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await db().delete(projects).where(eq(projects.id, projectId));
    expect(await sessionsOf(s.sitting)).toEqual([]);
    expect(jobs).toEqual([]);
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId: null, cause: "swept" }]);
  });

  it("asks once: the sweep never enqueues a sitting already asked for", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    expect((await leave(s.headers)).statusCode).toBe(204);
    await sweepProjectSittings(app(), CONFIG);
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toHaveLength(1);
  });

  it("an exam's station: its end and its retirement ask for nothing", async () => {
    const { student, evaluationId } = await world();
    const s = await sitting(student.id, { evaluationId });
    await endKioskSessions(db(), { evaluationId, projectId: null });
    expect(await sessionsOf(s.sitting)).toEqual([]);
    const again = await sitting(student.id, { evaluationId }, s.station);
    const admin = await server.signIn("admin");
    expect((await inject("PATCH", `/app/api/admin/kiosk-devices/${s.station.deviceId}`, admin.headers, { status: "retired" })).statusCode).toBe(200);
    expect(await sessionsOf(again.sitting)).toEqual([]);
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([]);
    expect(await stationHeld(db(), s.station.deviceId)).toBe(false);
  });
});

describe("the close job", () => {
  async function ended() {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    expect((await leave(s.headers)).statusCode).toBe(204);
    const [job] = jobs.splice(0);
    return { ...s, job: job!, projectId };
  }

  it("tells the portal, completes the close, audits it with its cause — and is idempotent", async () => {
    const s = await ended();
    expect(await run(s.job)).toBe("closed");
    expect(closes).toHaveLength(1);
    expect((await pairingOf(s.sitting)).closeCompletedAt).toEqual(server.clock.now());
    expect((await audits("codespace.session_closed", s.sitting)).map((a) => a.payload)).toEqual([{ projectId: s.projectId, cause: "left" }]);
    expect(await run(s.job)).toBe("done");
    expect(closes).toHaveLength(1);
    expect(await audits("codespace.session_closed", s.sitting)).toHaveLength(1);
  });

  it("throws for the queue to retry, audits the last try only, and the station stays held", async () => {
    const s = await ended();
    portalStatus = 503;
    await expect(run(s.job, false)).rejects.toThrow("503");
    expect(await audits("codespace.session_close_failed", s.sitting)).toEqual([]);
    await expect(run(s.job, true)).rejects.toThrow("503");
    const [failed] = await audits("codespace.session_close_failed", s.sitting);
    expect(failed?.payload).toMatchObject({ projectId: s.projectId, cause: "left" });
    expect(JSON.stringify(failed?.payload)).not.toContain("Bearer");
    expect((await pairingOf(s.sitting)).closeCompletedAt).toBeNull();
    // Given up: the sweep does not ask again, the station stays held.
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([]);
    expect(await stationHeld(db(), s.station.deviceId)).toBe(true);

    // An administrator's Retire, then Reactivate once the portal answers: each asks again.
    const admin = await server.signIn("admin");
    const patch = (status: "retired" | "active") =>
      inject("PATCH", `/app/api/admin/kiosk-devices/${s.station.deviceId}`, admin.headers, { status });
    expect((await patch("retired")).statusCode).toBe(200);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId: s.projectId, cause: "retired" }]);
    await expect(run(jobs.pop()!, true)).rejects.toThrow("503");
    portalStatus = 204;
    expect((await patch("active")).statusCode).toBe(200);
    expect(await stationHeld(db(), s.station.deviceId)).toBe(true);
    expect(await run(jobs.pop()!)).toBe("closed");
    expect(await stationHeld(db(), s.station.deviceId)).toBe(false);
  });

  it("completes without a call when the portal is off: no portal session can exist then", async () => {
    const s = await ended();
    expect(await run(s.job, true, { ...CONFIG, CODESPACE_URL: "" })).toBe("off");
    expect(closes).toEqual([]);
    expect((await pairingOf(s.sitting)).closeCompletedAt).not.toBeNull();
    expect(await audits("codespace.session_closed", s.sitting)).toEqual([]);
  });

  it("closes nothing while the sitting still has its session, and gives its request back", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await db().update(kioskPairings).set({ closeRequestedAt: server.clock.now() }).where(eq(kioskPairings.id, s.sitting));
    expect(await run({ sitting: s.sitting, projectId, cause: "swept" })).toBe("live");
    expect(closes).toEqual([]);
    expect(await pairingOf(s.sitting)).toMatchObject({ closeCompletedAt: null, closeRequestedAt: null });
  });

  it("does not complete a close when a session appeared while the portal was told: the station stays held", async () => {
    const s = await ended();
    const [row] = await db().select({ userId: kioskPairings.userId }).from(kioskPairings).where(eq(kioskPairings.id, s.sitting));
    whileClosing = async () => {
      await sessionOf(db(), row!.userId!, { kind: "kiosk", deviceId: s.station.deviceId, kioskPairingId: s.sitting, projectId: s.projectId });
    };
    expect(await run(s.job)).toBe("live");
    expect(closes).toHaveLength(1);
    expect(await pairingOf(s.sitting)).toMatchObject({ closeCompletedAt: null, closeRequestedAt: null });
    expect(await audits("codespace.session_closed", s.sitting)).toEqual([]);
    expect(await stationHeld(db(), s.station.deviceId)).toBe(true);
  });
});

describe("a session dropped between the completion's UPDATE and what follows it (final review of #1108)", () => {
  /** `builder`'s promise, `hook` run once it resolved: the drop lands right after the UPDATE. */
  function after<T extends object>(builder: T, hook: () => Promise<void>): T {
    return new Proxy(builder, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "then") {
          const then = (value as PromiseLike<unknown>["then"]).bind(target);
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => then(async (v) => (await hook(), v)).then(ok, ko);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out !== null && typeof out === "object" ? after(out, hook) : out;
        };
      },
    });
  }

  it("gives the request back, so that the sweep asks again", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await db().update(kioskPairings).set({ closeRequestedAt: server.clock.now() }).where(eq(kioskPairings.id, s.sitting));
    // The session's own drop, its request lost to the mark still set: no job.
    const drop = async () => {
      await db().delete(sessions).where(eq(sessions.kioskPairingId, s.sitting));
    };
    let first = true;
    const racing = new Proxy(db(), {
      get(target, prop) {
        const value = Reflect.get(target, prop, target) as unknown;
        if (prop === "update" && first) {
          first = false;
          return (...args: unknown[]) => after((value as (...a: unknown[]) => object).apply(target, args), drop);
        }
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await completeSittingClose(racing, s.sitting, server.clock.now())).toBe("done");
    expect(await pairingOf(s.sitting)).toMatchObject({ closeCompletedAt: null, closeRequestedAt: null });
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([{ sitting: s.sitting, projectId, cause: "swept" }]);
  });
});

describe("a sitting still starting (security review of #1108, S1)", () => {
  it("is not taken for forgotten by the sweep until its consumption is two minutes old", async () => {
    const { student, projectId } = await world();
    const station = await kioskStation(server.app);
    // The station's poll consumed the pairing; its session has not committed yet.
    const starting = await consumedPairing(station.deviceId, student.id, { projectId }, server.clock.now());
    await sweepProjectSittings(app(), CONFIG);
    expect(jobs).toEqual([]);
    expect((await pairingOf(starting)).closeRequestedAt).toBeNull();
    const before = server.clock.now();
    server.clock.advance(SITTING_START_GRACE_MS + 1000);
    try {
      await sweepProjectSittings(app(), CONFIG);
    } finally {
      server.clock.set(before);
    }
    expect(jobs).toEqual([{ sitting: starting, projectId, cause: "swept" }]);
  });
});

describe("the hold (amendment point 4)", () => {
  const stationPost = (url: string, station: TestStation, payload?: Payload) => postAsStation(server.app, url, station, payload);
  const poll = (station: TestStation, deviceCode: string) =>
    stationPost("/app/api/kiosk/token", station, { grant_type: DEVICE_CODE_GRANT, device_code: deviceCode });
  const stationView = async (station: TestStation) =>
    KioskStation.parse((await server.app.inject({ method: "GET", url: "/app/api/kiosk/station", headers: { cookie: station.cookie } })).json());

  it("refuses a pairing code, for an exam too, until the close completes, then lifts", async () => {
    const { student, projectId, evaluationId, teacher } = await world();
    await inject("POST", `/app/api/evaluations/${evaluationId}/start`, teacher.headers, { confirm: true });
    const s = await sitting(student.id, { projectId });
    // Held while the sitting runs, and once it has ended until its close completes.
    expect(await stationView(s.station)).toMatchObject({ held: true });
    expect((await leave(s.headers)).statusCode).toBe(204);
    const refused = await stationPost("/app/api/kiosk/device_authorization", s.station);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "station_held" });
    expect(await stationView(s.station)).toMatchObject({ held: true });

    expect(await run(jobs.pop()!)).toBe("closed");
    expect(await stationView(s.station)).toMatchObject({ held: false });
    const auth = await authorizeStation(server.app, s.station);
    const approved = await inject("POST", "/app/api/pair", student.headers, { code: auth.user_code, evaluationId });
    expect(approved.statusCode, approved.body).toBe(200);
    const polled = await poll(s.station, auth.device_code);
    expect(polled.json()).toEqual({ redirect: `/take/${evaluationId}` });
    expect((await inject("GET", "/app/api/me", stationHeaders(polled, s.station))).statusCode).toBe(200);
  });

  it("keeps an approved code unconsumed while the station is held", async () => {
    const { student, projectId, evaluationId, teacher } = await world();
    await inject("POST", `/app/api/evaluations/${evaluationId}/start`, teacher.headers, { confirm: true });
    const station = await kioskStation(server.app);
    const auth = await authorizeStation(server.app, station);
    expect((await inject("POST", "/app/api/pair", student.headers, { code: auth.user_code, evaluationId })).statusCode).toBe(200);
    // A project sitting of the station left without a close since.
    const held = await sitting(student.id, { projectId }, station);
    await db().delete(sessions).where(eq(sessions.kioskPairingId, held.sitting));
    expect((await poll(station, auth.device_code)).json()).toEqual({ error: "authorization_pending" });
    await db().update(kioskPairings).set({ closeCompletedAt: server.clock.now() }).where(eq(kioskPairings.id, held.sitting));
    server.clock.advance(5_000);
    expect((await poll(station, auth.device_code)).json()).toEqual({ redirect: `/take/${evaluationId}` });
  });
});

describe("the kill switch never stops a close", () => {
  it("with both flags off, the sweep ends every station session of a project and closes them, exams untouched", async () => {
    const { student, projectId, evaluationId } = await world();
    const project = await sitting(student.id, { projectId });
    const exam = await sitting(student.id, { evaluationId });
    const off = { ...CONFIG, KIOSK_ATTESTATION: "off", KIOSK_PROJECTS: false } as AppConfig;
    // No queue here (`JOBS_DISABLED`): the sweep closes inline.
    closeSittingCloses();
    await sweepProjectSittings(app(), off);
    expect(await sessionsOf(project.sitting)).toEqual([]);
    expect(await sessionsOf(exam.sitting)).toHaveLength(1);
    // The session went this pass; its sitting, left without a close, is closed on the same pass
    // (the station sessions of the earlier tests' projects with it: every one ends).
    expect(closes.length).toBeGreaterThan(0);
    expect((await pairingOf(project.sitting)).closeCompletedAt).not.toBeNull();
    expect((await audits("codespace.session_closed", project.sitting)).map((a) => a.payload)).toEqual([{ projectId, cause: "swept" }]);
  });
});

describe("Leave this station", () => {
  it("ends the caller's own sitting only: the student's other sessions stay", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    const other = await sitting((await server.signIn("student")).id, { projectId });
    expect((await leave(s.headers)).statusCode).toBe(204);
    expect((await inject("GET", "/app/api/me", student.headers)).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", other.headers)).statusCode).toBe(200);
    expect((await inject("GET", "/app/api/me", s.headers)).statusCode).toBe(401);
  });

  it("answers a suspended station the 423 of every write of its sitting", async () => {
    const { student, projectId } = await world();
    const s = await sitting(student.id, { projectId });
    await db().update(kioskDevices).set({ attestation: "refused" }).where(eq(kioskDevices.id, s.station.deviceId));
    const res = await leave(s.headers);
    expect(res.statusCode).toBe(423);
    expect(res.json()).toEqual({ error: "kiosk_suspended" });
    expect(await sessionsOf(s.sitting)).toHaveLength(1);
  });

  it("is refused to every other session kind, and without the CSRF header", async () => {
    const { student, projectId, evaluationId } = await world();
    const seb = await sessionOf(db(), student.id, { kind: "seb", projectId, sebConfigKey: "c".repeat(64) });
    const exam = await sitting(student.id, { evaluationId });
    for (const headers of [student.headers, seb, exam.headers]) {
      expect((await leave(headers)).statusCode).toBe(401);
    }
    expect(await sessionsOf(exam.sitting)).toHaveLength(1);
    const s = await sitting(student.id, { projectId });
    const { "x-csrf-token": _, ...noCsrf } = s.headers;
    expect((await leave(noCsrf)).statusCode).toBe(403);
    expect(await sessionsOf(s.sitting)).toHaveLength(1);
    expect(jobs).toEqual([]);
  });
});
