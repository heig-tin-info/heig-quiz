/**
 * Kiosk stations for supervised projects, the API part (ADR-089 and its
 * amendment of 2026-11-15, merge task M6-11b), over the real application
 * with `KIOSK_PROJECTS` on, the mock attestation, Quiz's App against the
 * fake GitHub and the portal a stub:
 *
 * - the setting: a station level set by an owner, carried by the payload
 *   and the audit, frozen with the mode at the first student launch;
 * - the pairing: `GET /pair/:code` lists the projects a student can start
 *   on a station, the approval re-checks that list, and the station's poll
 *   opens a `kiosk` session confined to the project, pointing to its
 *   pairing — the sitting;
 * - the start route: each level × each client (portal, `seb`, `kiosk`, a
 *   staff seat), the station's launch token and its `kiosk` claim, a stale
 *   attestation refused, Kiosk only serving no `.seb`;
 * - invariant 6: a project's kiosk session reaches its project only, and no
 *   other route; an evaluation's kiosk session reaches no project; a
 *   delegated one is no confined session of the project;
 * - the station's watch naming the project it sits.
 *
 * The flag's other side (off: the write's `422`, the payload's
 * `kioskOffered`, a live project keeping its level) is `codespace.db.test.ts`.
 */
import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE,
  DEVICE_CODE_GRANT,
  KioskDeviceAuthorization,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  PairPreview,
  ProjectSummary,
  ProjectWorkspace,
  WorkspaceStart,
  workspaceStartPath,
} from "@quiz/contracts";
import { verifyHs256 } from "@quiz/domain";

import { SESSION_COOKIE } from "../../auth/session.js";
import { auditLog, enrollments, kioskDevices, kioskPairings, projects, sessions } from "../../db/schema.js";
import { orgsRoute } from "../../github/testing.js";
import { routesOf, sessionOf } from "../../test/http.js";
import { kioskStation, type TestStation } from "../../test/kiosk.js";
import { call, newStudent, server, useProjectWorld, usersRoute, world, type Headers } from "../../test/projectWorld.js";
import { recordAttempt } from "../kiosk/watch.js";
import { CODESPACE_ENV, PORTAL_SECRET, connectedClassroom, fakePortal, grantedTeacher, workModeBody, type Room } from "./testing.js";

const NOW = "2026-10-07T08:00:00.000Z";
const AT_NOW = () => Math.floor(server.clock.now().getTime() / 1000);
const DEADLINE = "2026-10-14T22:00:00.000Z";

type Level = "seb" | "either" | "kiosk";
interface Person {
  id: string;
  headers: Headers;
}

const portal = fakePortal();
let owner: Person;

useProjectWorld({
  routes: [orgsRoute(() => []), usersRoute, world.route],
  env: { ...CODESPACE_ENV, KIOSK_ATTESTATION: "mock", KIOSK_PROJECTS: "1" },
  fetch: portal.fetch,
  teacher: false,
});

beforeAll(async () => {
  owner = await grantedTeacher(true, 3);
});

beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
  portal.calls.length = 0;
  portal.down = false;
});

// ---------------------------------------------------------------- the world

const setMode = (projectId: string, mode: string, devices?: Level) =>
  call("PUT", `/app/api/projects/${projectId}/workspace/mode`, owner.headers, workModeBody(mode, devices));

/** A published project of `room` at `level` (`online_seb`), or in another mode. */
async function project(room: Room, name: string, level: Level | "online" | "free" = "either"): Promise<ProjectSummary> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, owner.headers, {
    name,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, owner.headers)).statusCode).toBe(200);
  if (level !== "free") {
    const set = level === "online" ? await setMode(summary.id, "online") : await setMode(summary.id, "online_seb", level);
    expect(set.statusCode, set.body).toBe(200);
  }
  return summary;
}

const accept = async (projectId: string, who: Person) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  expect(res.statusCode, res.body).toBe(200);
};

const start = (projectId: string, headers: Headers) => call("POST", workspaceStartPath(projectId), headers);
const view = (projectId: string, headers: Headers) => call("GET", `/app/api/student/projects/${projectId}`, headers);

/** Each station call from its own address: the attestation limiter is not under test. */
let host = 0;
const stationPost = (url: string, station: TestStation, payload?: object) =>
  server.app.inject({
    method: "POST",
    url,
    remoteAddress: `10.11.${Math.floor(++host / 250)}.${host % 250}`,
    headers: { cookie: station.cookie },
    ...(payload ? { payload } : {}),
  });

async function authorize(station: TestStation) {
  const res = await stationPost("/app/api/kiosk/device_authorization", station);
  expect(res.statusCode, res.body).toBe(200);
  return KioskDeviceAuthorization.parse(res.json());
}

const preview = (who: Person, code: string) => call("GET", `/app/api/pair/${encodeURIComponent(code)}`, who.headers);
const approve = (who: Person, code: string, activity: { projectId: string } | { evaluationId: string }) =>
  call("POST", "/app/api/pair", who.headers, { code, ...activity });

/** The headers of a session a response set, beside the station's cookie: what the station's browser sends. */
function stationHeaders(res: { headers: Record<string, unknown> }, station: TestStation): Headers {
  const all = [res.headers["set-cookie"]].flat().filter((c): c is string => typeof c === "string");
  const pick = (name: string) => all.find((c) => c.startsWith(`${name}=`))!.split(";")[0]!;
  const csrf = pick(CSRF_COOKIE);
  return { cookie: `${pick(SESSION_COOKIE)}; ${csrf}; ${station.cookie}`, "x-csrf-token": csrf.slice(CSRF_COOKIE.length + 1) };
}

/** A station paired for `student` on `projectId` through the real flow: its headers, and the sitting (the pairing's id). */
async function seated(station: TestStation, student: Person, projectId: string) {
  const auth = await authorize(station);
  const approved = await approve(student, auth.user_code, { projectId });
  expect(approved.statusCode, approved.body).toBe(200);
  const polled = await stationPost("/app/api/kiosk/token", station, { grant_type: DEVICE_CODE_GRANT, device_code: auth.device_code });
  expect(polled.statusCode, polled.body).toBe(200);
  expect(polled.json()).toEqual({ redirect: `/projects/${projectId}` });
  const [pairing] = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
  return { headers: stationHeaders(polled, station), sitting: pairing!.id };
}

/**
 * A station's session of `projectId` for `userId`, as a consumed pairing
 * opens one — the pairing row written here, for the cells of the matrix the
 * pairing list would never offer (a station on a SEB-only project).
 */
async function kioskSession(userId: string, projectId: string, opts: { actorUserId?: string; evaluationId?: string } = {}) {
  const station = await kioskStation(server.app);
  const pairingId = randomUUID();
  const now = server.clock.now();
  await server.app.db.insert(kioskPairings).values({
    id: pairingId,
    deviceId: station.deviceId,
    deviceCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
    userCodeHash: createHash("sha256").update(randomUUID()).digest("hex"),
    state: "consumed",
    userId,
    ...(opts.evaluationId ? { evaluationId: opts.evaluationId } : { projectId }),
    expiresAt: new Date(now.getTime() + 300_000),
    consumedAt: now,
  });
  const headers = await sessionOf(server.app.db, userId, {
    kind: "kiosk",
    deviceId: station.deviceId,
    kioskPairingId: pairingId,
    ...(opts.evaluationId ? { evaluationId: opts.evaluationId } : { projectId }),
    ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}),
  });
  return { headers: { ...headers, cookie: `${headers.cookie}; ${station.cookie}` }, station, sitting: pairingId };
}

const sebSession = (userId: string, projectId: string) =>
  sessionOf(server.app.db, userId, { kind: "seb", projectId, sebConfigKey: "c".repeat(64) });

const launchClaims = async (res: { statusCode: number; body: string; json: () => unknown }) => {
  expect(res.statusCode, res.body).toBe(200);
  const token = new URL(WorkspaceStart.parse(res.json()).url).searchParams.get("token")!;
  const verdict = await verifyHs256<Record<string, unknown>>(token, PORTAL_SECRET, { audience: LAUNCH_AUDIENCE, issuer: "heig-quiz", now: AT_NOW });
  return LaunchTokenClaims.parse(verdict.ok ? verdict.claims : null);
};

// ---------------------------------------------------------------- the setting

describe("the device level of a supervised project (ADR-089 point 2)", () => {
  it("is set by an owner with the flag on, shown in the payload, audited with both levels", async () => {
    const room = await connectedClassroom(owner, [], { prefix: "korg" });
    const lab = await project(room, "Station lab", "free");
    const set = await setMode(lab.id, "online_seb", "kiosk");
    expect(set.statusCode, set.body).toBe(200);
    expect(ProjectWorkspace.parse(set.json())).toMatchObject({ mode: "online_seb", devices: "kiosk", kioskOffered: true });
    const [row] = await server.app.db.select({ devices: projects.devices }).from(projects).where(eq(projects.id, lab.id));
    expect(row!.devices).toBe("kiosk");
    // Back to the workspace without supervision: the level is `any` again.
    expect(ProjectWorkspace.parse((await setMode(lab.id, "online")).json())).toMatchObject({ mode: "online", devices: "any" });
    const audits = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.work_mode"), eq(auditLog.subjectId, lab.id)));
    expect(audits.map((a) => a.payload)).toEqual([
      { from: "free", to: "online_seb", devices: { from: "any", to: "kiosk" } },
      { from: "online_seb", to: "online", devices: { from: "kiosk", to: "any" } },
    ]);
  });

  it("refuses a mismatched pair at the schema (invariant 7)", async () => {
    const room = await connectedClassroom(owner, [], { prefix: "korg" });
    const lab = await project(room, "Schema lab", "free");
    for (const body of [{ mode: "online_seb" }, { mode: "online_seb", devices: "any" }, { mode: "online", devices: "kiosk" }]) {
      const res = await call("PUT", `/app/api/projects/${lab.id}/workspace/mode`, owner.headers, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("freezes with the mode at the first student launch; the pair re-sent unchanged passes", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Frozen lab", "either");
    await accept(lab.id, student);
    const { headers } = await seated(await kioskStation(server.app), student, lab.id);
    expect((await start(lab.id, headers)).statusCode).toBe(200);
    for (const level of ["seb", "kiosk"] as const) {
      const refused = await setMode(lab.id, "online_seb", level);
      expect([refused.statusCode, refused.json().error]).toEqual([409, "work_mode_frozen"]);
    }
    expect((await setMode(lab.id, "online_seb", "either")).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- the pairing

describe("pairing a station for a project (ADR-089 §5)", () => {
  it("lists the open projects at a station level of the student's classrooms, before their deadline", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const either = await project(room, "Either lab", "either");
    const only = await project(room, "Kiosk lab", "kiosk");
    await project(room, "SEB lab", "seb");
    await project(room, "Online lab", "online");
    await project(room, "Own tools lab", "free");
    const elsewhere = await connectedClassroom(owner, [], { prefix: "korg" });
    await project(elsewhere, "Not my class", "kiosk");

    const station = await kioskStation(server.app, { label: "Poste n° 12" });
    const auth = await authorize(station);
    const listed = PairPreview.parse((await preview(student, auth.user_code)).json());
    expect(listed.station).toEqual({ label: "Poste n° 12" });
    expect(listed.projects.map((p) => p.id).sort()).toEqual([either.id, only.id].sort());
    expect(listed.projects.find((p) => p.id === only.id)).toEqual({
      id: only.id,
      title: "Kiosk lab",
      classroomName: expect.any(String),
      courseCode: expect.any(String),
    });

    // Past the deadline, nothing is listed any more (a new code: the first one has expired).
    server.clock.set(DEADLINE);
    const later = await authorize(station);
    expect(PairPreview.parse((await preview(student, later.user_code)).json()).projects).toEqual([]);
  });

  it("refuses to approve a project the list would not show, audited on the project; approves a listed one", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const sebOnly = await project(room, "SEB only lab", "seb");
    const online = await project(room, "Online lab", "online");
    const stranger = await newStudent();
    const listed = await project(room, "Listed lab", "kiosk");
    const station = await kioskStation(server.app);
    const auth = await authorize(station);

    for (const projectId of [sebOnly.id, online.id, randomUUID()]) {
      const refused = await approve(student, auth.user_code, { projectId });
      expect([refused.statusCode, refused.json()]).toEqual([409, { error: "project_not_pairable" }]);
    }
    // A student without a seat in the classroom: the same refusal.
    expect((await approve(stranger, auth.user_code, { projectId: listed.id })).json()).toEqual({ error: "project_not_pairable" });
    const refusals = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "kiosk.pair_refused"), eq(auditLog.subjectId, sebOnly.id)));
    expect(refusals.map((r) => [r.subjectType, r.payload])).toEqual([["project", { reason: "project" }]]);

    const ok = await approve(student, auth.user_code, { projectId: listed.id });
    expect(ok.statusCode, ok.body).toBe(200);
    const [pairing] = await server.app.db.select().from(kioskPairings).where(eq(kioskPairings.deviceId, station.deviceId));
    expect(pairing).toMatchObject({ state: "approved", userId: student.id, projectId: listed.id, evaluationId: null, closeCompletedAt: null });
    const [paired] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "kiosk.paired"), eq(auditLog.subjectId, pairing!.id)));
    expect(paired!.payload).toEqual({ projectId: listed.id, deviceId: station.deviceId });
  });

  it("opens a kiosk session confined to the project, pointing to its pairing; refused if the project left the list meanwhile", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Seated lab", "either");
    const station = await kioskStation(server.app);
    const { headers, sitting } = await seated(station, student, lab.id);
    const me = await call("GET", "/app/api/me", headers);
    expect(me.json().session).toMatchObject({ kind: "kiosk", evaluationId: null, projectId: lab.id });
    const [row] = await server.app.db.select().from(sessions).where(eq(sessions.deviceId, station.deviceId));
    expect(row).toMatchObject({ kind: "kiosk", projectId: lab.id, kioskPairingId: sitting, userId: student.id });

    // Approved, then the project leaves the list (SEB only now) before the station polls: no session.
    const other = await project(room, "Moved lab", "either");
    const late = await kioskStation(server.app);
    const auth = await authorize(late);
    expect((await approve(student, auth.user_code, { projectId: other.id })).statusCode).toBe(200);
    expect((await setMode(other.id, "online_seb", "seb")).statusCode).toBe(200);
    const polled = await stationPost("/app/api/kiosk/token", late, { grant_type: DEVICE_CODE_GRANT, device_code: auth.device_code });
    expect([polled.statusCode, polled.json()]).toEqual([400, { error: "access_denied" }]);
  });
});

// ---------------------------------------------------------------- the start route

describe("the start route from a station (ADR-089 §4)", () => {
  it("answers each level for each client: portal, seb, kiosk and a staff seat (amendment point 2)", async () => {
    const student = await newStudent();
    const tester = await newStudent({ prefix: "staff" });
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    await server.app.db.insert(enrollments).values({
      id: randomUUID(),
      classroomId: room.classroomId,
      nom: "Test",
      prenom: "Teacher",
      email: `s-${randomUUID().slice(0, 6)}@heig.test`,
      userId: tester.id,
      claimedAt: new Date(),
      staff: true,
    });
    const verdicts: Record<string, (string | number)[]> = {};
    for (const level of ["seb", "either", "kiosk"] as const) {
      const lab = await project(room, `Matrix ${level}`, level);
      await accept(lab.id, student);
      await accept(lab.id, tester);
      const answer = async (headers: Headers) => {
        const res = await start(lab.id, headers);
        return res.statusCode === 200 ? 200 : (res.json().error as string);
      };
      verdicts[level] = [
        await answer(student.headers),
        await answer(await sebSession(student.id, lab.id)),
        await answer((await kioskSession(student.id, lab.id)).headers),
        await answer(tester.headers),
      ];
    }
    expect(verdicts).toEqual({
      seb: ["seb_required", 200, "seb_required", "seb_required"],
      either: ["seb_required", 200, 200, "seb_required"],
      kiosk: ["kiosk_required", "kiosk_required", 200, "kiosk_required"],
    });
  });

  it("carries the station and the sitting in the kiosk claim, never a session's key; audited kiosk: true", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Claim lab", "kiosk");
    await accept(lab.id, student);
    const station = await kioskStation(server.app);
    const { headers, sitting } = await seated(station, student, lab.id);
    const claims = await launchClaims(await start(lab.id, headers));
    expect(claims).toMatchObject({ sub: student.id, assignmentId: lab.id, kiosk: { deviceId: station.deviceId, sitting } });
    expect(claims.seb).toBeUndefined();
    const hashes = (await server.app.db.select({ sid: sessions.sidHash }).from(sessions)).map((s) => s.sid);
    expect(hashes).not.toContain(claims.kiosk!.sitting);
    const [issued] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued!.payload).toEqual({ jti: claims.jti, mode: "online_seb", kiosk: true });
  });

  it("needs an attestation under two minutes old (423 kiosk_attestation_stale), and serves no .seb at Kiosk only", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Stale lab", "kiosk");
    await accept(lab.id, student);
    const station = await kioskStation(server.app);
    const { headers } = await seated(station, student, lab.id);
    server.clock.set(new Date(Date.parse(NOW) + 3 * 60_000).toISOString());
    const stale = await start(lab.id, headers);
    expect([stale.statusCode, stale.json()]).toEqual([423, { error: "kiosk_attestation_stale" }]);
    // The page re-attests (here, the check written as an accepted one), and the launch goes through.
    await server.app.db.update(kioskDevices).set({ checkedAt: server.clock.now(), attestedAt: server.clock.now(), attestation: "ok" }).where(eq(kioskDevices.id, station.deviceId));
    expect((await start(lab.id, headers)).statusCode).toBe(200);

    // Kiosk only: no `.seb` for the student's portal; "SEB or kiosk" still serves one.
    expect((await call("GET", `/app/api/projects/${lab.id}/seb`, student.headers)).statusCode).toBe(404);
    const either = await project(room, "Either seb lab", "either");
    expect((await call("GET", `/app/api/projects/${either.id}/seb`, student.headers)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- invariant 6

describe("a project's kiosk session reaches its project only (invariant 6)", () => {
  it("is a 404 on another project, and an evaluation's kiosk session reaches no project", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Own lab", "either");
    const other = await project(room, "Other lab", "either");
    await accept(lab.id, student);
    await accept(other.id, student);
    const { headers } = await kioskSession(student.id, lab.id);
    expect((await view(lab.id, headers)).statusCode).toBe(200);
    for (const id of [other.id, randomUUID()]) {
      expect((await view(id, headers)).statusCode).toBe(404);
      expect((await start(id, headers)).statusCode).toBe(404);
    }
    // It sits no evaluation: the attempt route does not serve a project's session.
    expect((await call("POST", `/app/api/evaluations/${room.evaluationId}/attempt`, headers, {})).statusCode).toBe(401);

    // An evaluation's kiosk session is not served on a project's routes at all (ADR-027): anonymous.
    const exam = await kioskSession(student.id, lab.id, { evaluationId: room.evaluationId });
    expect((await view(lab.id, exam.headers)).statusCode).toBe(401);
    expect((await start(lab.id, exam.headers)).statusCode).toBe(401);
    expect(await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, other.id)))).toEqual([]);
  });

  it("a delegated kiosk session is no station's: read-only like an impersonation (ADR-034), it launches nothing", async () => {
    const student = await newStudent();
    const stranger = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Delegated lab", "either");
    await accept(lab.id, student);
    const admin = await server.signIn("admin");
    const { headers } = await kioskSession(student.id, lab.id, { actorUserId: admin.id });
    const write = await start(lab.id, headers);
    expect([write.statusCode, write.json().error]).toEqual([403, "impersonation_read_only"]);
    // It reads as an impersonation does, through the student's own seat only (`classroomPayload`).
    expect((await view(lab.id, headers)).statusCode).toBe(200);
    const theirs = await kioskSession(stranger.id, lab.id, { actorUserId: admin.id });
    expect((await view(lab.id, theirs.headers)).statusCode).toBe(404);
    expect(await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)))).toEqual([]);
  });

  it("is no session at all on every route that does not declare it", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Sweep lab", "either");
    const { headers } = await kioskSession(student.id, lab.id);
    // The station's cookie stays in both: only the session differs.
    const anonymous = { ...headers, cookie: headers.cookie!.split("; ").filter((c) => !c.startsWith(`${SESSION_COOKIE}=`)).join("; ") };
    const declared = new Set(["GET /app/api/me", "GET /app/api/student/projects/:id", "POST /app/api/projects/:id/workspace/start"]);
    for (const { method, path } of routesOf(server.app.printRoutes({ commonPrefix: false }))) {
      if (declared.has(`${method} ${path}`) || /^\/app\/auth\/(login|callback)$/.test(path)) continue;
      const url = path.replace(/:\w+/g, "00000000-0000-4000-8000-000000000000").replace("*", "x");
      const [asKiosk, asNobody] = [await call(method, url, headers), await call(method, url, anonymous)];
      expect(asKiosk.statusCode, `${method} ${path}`).toBe(asNobody.statusCode);
    }
  });
});

// ---------------------------------------------------------------- the watch

describe("the station's watch (ADR-051 §6) names the project it sits", () => {
  it("audits a suspension with the project, and tells no evaluation's dashboard", async () => {
    const student = await newStudent();
    const room = await connectedClassroom(owner, [student], { prefix: "korg" });
    const lab = await project(room, "Watched lab", "kiosk");
    const station = await kioskStation(server.app);
    await seated(station, student, lab.id);
    await recordAttempt(server.app.db, station.deviceId, "refused", server.clock.now());
    const [suspended] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "kiosk.suspended"), eq(auditLog.subjectId, station.deviceId)));
    expect(suspended!.payload).toMatchObject({ userId: student.id, projectId: lab.id });
    expect(suspended!.payload).not.toHaveProperty("evaluationId");
  });
});
