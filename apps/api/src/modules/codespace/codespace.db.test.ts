/**
 * The `codespace` module (ADR-047 as amended 2026-10-07, merge task M6-06)
 * over the real application, with Quiz's App against the fake GitHub and
 * the local bare repositories (a student's Accept really provisions), the
 * portal a stub on `portal.test`, the clock moved by hand:
 *
 * - the work mode: an owner with the grant only (an assistant `403
 *   owner_required`, an owner without the grant `403
 *   codespace_not_granted`), never a group project, frozen once a
 *   workspace was launched; an administrator always granted, with the
 *   default quota (amendment 2026-10-08); the invitation's permission by mode;
 * - the sync: the PUT the portal receives (a service token it verifies, a
 *   `CodespaceAssignmentSync`, the quota of the holder of decision C), a
 *   failure recorded, the staff's *Resync*;
 * - the start route: anonymous, impersonation, `seb`, `kiosk`, a stranger,
 *   each refusal sent back to the project page, and the launch — a token
 *   `verifyHs256` accepts with the right claims, its `jti` audited, the
 *   token itself in no audit row, no log line, no student payload;
 * - the staff's sessions, matched to the classroom's students;
 * - the administrator's grant.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE,
  CodespaceAssignmentSync,
  DEFAULT_MAX_ACTIVE_SESSIONS,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  ProjectSummary,
  ProjectWorkspace,
  ProjectWorkspaceSessions,
  SERVICE_AUDIENCE,
  ServiceTokenClaims,
  StudentClassroomPage,
  StudentHome,
  WorkspaceStart,
  WorkspaceStartRefusal,
  workspaceStartPath,
  type AdminTeacher,
  type SessionKind,
} from "@quiz/contracts";
import { bindingMismatch, requestBinding, verifyHs256 } from "@quiz/domain";

import { createApiToken } from "../../auth/tokens.js";
import type { AppConfig } from "../../config.js";
import {
  auditLog,
  codespaceProjects,
  courseStaff,
  enrollments,
  githubAccounts,
  projectRepos,
  projects,
  userEmails,
  users,
} from "../../db/schema.js";
import { orgsRoute } from "../../github/testing.js";
import { sessionOf } from "../../test/http.js";
import { grantOf, runCodespaceSync } from "./service.js";
import {
  CODESPACE_ENV,
  PORTAL,
  PORTAL_SECRET,
  captureLog,
  connectedClassroom,
  fakePortal,
  grantedTeacher,
  workModeBody,
  type PortalCall,
  type Room,
} from "./testing.js";
import {
  accounts,
  call,
  freshAccountId,
  newStudent,
  server,
  useProjectWorld,
  usersRoute,
  world,
  type Headers,
} from "../../test/projectWorld.js";

const SECRET = PORTAL_SECRET;
const NOW = "2026-10-07T08:00:00.000Z";
/** The verifier's clock: the tokens are signed by the server's, set to NOW. */
const AT_NOW = () => Math.floor(Date.parse(NOW) / 1000);
/** What `runCodespaceSync` reads of the configuration. */
const CONFIG = CODESPACE_ENV as AppConfig;
const DEADLINE = "2026-10-14T22:00:00.000Z";

interface Person {
  id: string;
  headers: Headers;
}

let owner: Person;

// ---------------------------------------------------------------- the stub portal

const portal = fakePortal();

/**
 * The portal's own checks (audit L25): the token verifies, parses as the
 * contract's, carries a `jti`, and binds exactly the request it rode on.
 */
async function expectBoundServiceToken(call: PortalCall): Promise<void> {
  const verdict = await verifyHs256(call.authorization!.replace(/^Bearer /, ""), SECRET, {
    audience: SERVICE_AUDIENCE,
    issuer: "heig-quiz",
    requireJti: true,
    now: AT_NOW,
  });
  expect(verdict.ok).toBe(true);
  const claims = ServiceTokenClaims.parse(verdict.ok ? verdict.claims : null);
  expect(bindingMismatch(claims, await requestBinding(call.method, call.path, call.raw))).toBeNull();
}

// ---------------------------------------------------------------- the world

/** A classroom of `owner`'s course, `students` enrolled, connected to a fresh organization holding `starter`. */
const connected = (students: { id: string }[]) => connectedClassroom(owner, students, { prefix: "corg" });

/** A seat of `role` on the room's course. */
const seat = (room: Room, userId: string, role: "owner" | "assistant", createdAt?: Date) =>
  server.app.db.insert(courseStaff).values({ courseId: room.courseId, userId, role, ...(createdAt ? { createdAt } : {}) });

async function project(room: Room, name: string, opts: { publish?: boolean; body?: object; by?: Person } = {}): Promise<ProjectSummary> {
  const created = await call("POST", `/app/api/classrooms/${room.classroomId}/projects`, (opts.by ?? owner).headers, {
    name,
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    ...opts.body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  if (opts.publish !== false) {
    expect((await call("POST", `/app/api/projects/${summary.id}/publish`, owner.headers)).statusCode).toBe(200);
  }
  return summary;
}

const setMode = (projectId: string, mode: string, who: Person = owner) =>
  call("PUT", `/app/api/projects/${projectId}/workspace/mode`, who.headers, workModeBody(mode));
const accept = async (projectId: string, who: Person) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  expect(res.statusCode, res.body).toBe(200);
};
const start = (projectId: string, headers: Headers = {}) => call("POST", workspaceStartPath(projectId), headers);
/** The portal URL a launch answers, and its token. */
const launchUrl = async (projectId: string, headers: Headers) => {
  const res = await start(projectId, headers);
  expect(res.statusCode, res.body).toBe(200);
  return new URL(WorkspaceStart.parse(res.json()).url);
};
const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;

/** Every line pino writes, from `beforeAll` on. */
let logLines: string[] = [];

/** The role rule's administrator, for the grant row of their own address (ADR-047, amendment 2026-11-16). */
const SUPER_ADMIN_EMAIL = "boss@heig.test";

useProjectWorld({ routes: [orgsRoute(() => []), usersRoute, world.route], env: { ...CODESPACE_ENV, SUPER_ADMIN_EMAIL }, fetch: portal.fetch, teacher: false });

beforeAll(async () => {
  logLines = captureLog(server.app);
  owner = await grantedTeacher(true, 3);
});

beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
  portal.calls.length = 0;
  portal.putStatus = 200;
  portal.sessions = [];
  portal.down = false;
});

// ---------------------------------------------------------------- the work mode

describe("the work mode (ADR-047 as amended 2026-10-07)", () => {
  it("is set by an owner with the grant; an assistant and an owner without it are refused", async () => {
    const room = await connected([]);
    const lab = await project(room, "Mode lab");
    const assistant = await grantedTeacher(true);
    await seat(room, assistant.id, "assistant");
    const ungranted = await grantedTeacher(false);
    await seat(room, ungranted.id, "owner");
    const unlisted = await grantedTeacher(null);
    await seat(room, unlisted.id, "owner");

    // The assistant's malformed body is the same 403: the role is the loader's (ADR-068).
    const byAssistant = await setMode(lab.id, "not-a-mode", assistant);
    expect([byAssistant.statusCode, byAssistant.json().error]).toEqual([403, "owner_required"]);
    for (const who of [ungranted, unlisted]) {
      const res = await setMode(lab.id, "online", who);
      expect([res.statusCode, res.json().error]).toEqual([403, "codespace_not_granted"]);
    }
    const read = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, assistant.headers)).json());
    expect(read).toMatchObject({ mode: "free", allowed: ["free"], refusal: "owner_required" });

    const set = await setMode(lab.id, "online");
    expect(set.statusCode, set.body).toBe(200);
    expect(ProjectWorkspace.parse(set.json())).toMatchObject({ mode: "online", allowed: ["free", "online", "online_seb"], refusal: null });
    // Going back to free needs no grant, but still an owner.
    const back = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, ungranted.headers)).json());
    expect(back).toMatchObject({ allowed: ["free", "online"], refusal: "codespace_not_granted" });
    const audits = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.work_mode"), eq(auditLog.subjectId, lab.id)));
    expect(audits.map((a) => a.payload)).toEqual([{ from: "free", to: "online", devices: { from: "any", to: "any" } }]);
  });

  it("is always granted to an administrator, with the default quota (amendment 2026-10-08)", async () => {
    const room = await connected([]);
    const admin = await server.signIn("admin", `a-${randomUUID().slice(0, 8)}@heig.test`);
    await seat(room, admin.id, "owner");
    const unlisted = await grantedTeacher(null);
    await seat(room, unlisted.id, "owner");
    const lab = await project(room, "Admin lab", { by: admin });

    // No `teacher_grants` row for the administrator, and no Super Powers: the role alone.
    const read = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, admin.headers)).json());
    expect(read).toMatchObject({ allowed: ["free", "online", "online_seb"], refusal: null });
    const online = await setMode(lab.id, "online", admin);
    expect(online.statusCode, online.body).toBe(200);
    // The administrator created the project and holds an owner seat: their quota, the default one.
    expect(CodespaceAssignmentSync.parse(portal.calls.at(-1)!.body)).toMatchObject({
      teacher: { id: admin.id },
      quota: { maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS },
    });
    expect((await setMode(lab.id, "online_seb", admin)).statusCode).toBe(200);

    // A teacher without a grant is still refused.
    const refused = await setMode(lab.id, "online", unlisted);
    expect([refused.statusCode, refused.json().error]).toEqual([403, "codespace_not_granted"]);
  });

  it("keeps a group project in the students' own tools, both ways", async () => {
    const room = await connected([]);
    const group = await project(room, "Group lab", { publish: false, body: { groupMode: true } });
    const refused = await setMode(group.id, "online");
    expect([refused.statusCode, refused.json().error]).toEqual([409, "work_mode_group"]);

    const solo = await project(room, "Solo lab", { publish: false });
    expect((await setMode(solo.id, "online")).statusCode).toBe(200);
    const patch = await call("PATCH", `/app/api/projects/${solo.id}`, owner.headers, { groupMode: true });
    expect([patch.statusCode, patch.json().error]).toEqual([409, "work_mode_group"]);
  });

  it("invites with pull online and nobody under Safe Exam Browser (ADR-047 §2)", async () => {
    const [a, b] = [await newStudent(), await newStudent()];
    const room = await connected([a, b]);
    const online = await project(room, "Pull lab");
    await setMode(online.id, "online");
    await accept(online.id, a);
    const repo = await repoOf(online.id, a.id);
    expect(world.collaborators.get(repo.fullName!)?.get(a.login)).toBe("pull");

    const exam = await project(room, "Exam lab");
    await setMode(exam.id, "online_seb");
    await accept(exam.id, b);
    const examRepo = await repoOf(exam.id, b.id);
    expect([examRepo.provisionStatus, examRepo.invitationStatus]).toEqual(["ok", "none"]);
    expect(world.collaborators.get(examRepo.fullName!)?.has(b.login) ?? false).toBe(false);
    // A second Accept answers the repository, and still invites nobody.
    await accept(exam.id, b);
    expect(world.collaborators.get(examRepo.fullName!)?.has(b.login) ?? false).toBe(false);
  });
});

describe("kiosk stations for projects, flag off (ADR-089, amendment point 1)", () => {
  // This server has `KIOSK_ATTESTATION=off`: `kioskProjectsOn` is false. Its other side is `kiosk.db.test.ts`.
  const level = (projectId: string, devices: string) =>
    call("PUT", `/app/api/projects/${projectId}/workspace/mode`, owner.headers, { mode: "online_seb", devices });

  it("refuses a change TO a station level (422 kiosk_unavailable), and says so in the payload", async () => {
    const room = await connected([]);
    const lab = await project(room, "No station lab");
    for (const devices of ["either", "kiosk"]) {
      const refused = await level(lab.id, devices);
      expect([refused.statusCode, refused.json().error]).toEqual([422, "kiosk_unavailable"]);
    }
    const ok = await level(lab.id, "seb");
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ProjectWorkspace.parse(ok.json())).toMatchObject({ mode: "online_seb", devices: "seb", kioskOffered: false });
  });

  it("lets a live project keep the station level it holds: re-sent unchanged passes, leaving passes, coming back is refused", async () => {
    const room = await connected([]);
    const lab = await project(room, "Held station lab");
    // The level it got while the flag was on.
    await server.app.db.update(projects).set({ workMode: "online_seb", devices: "kiosk" }).where(eq(projects.id, lab.id));
    const read = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect(read).toMatchObject({ mode: "online_seb", devices: "kiosk", kioskOffered: false, refusal: null });
    expect((await level(lab.id, "kiosk")).statusCode).toBe(200);
    expect((await level(lab.id, "seb")).statusCode).toBe(200);
    expect((await level(lab.id, "kiosk")).json().error).toBe("kiosk_unavailable");
  });
});

// ---------------------------------------------------------------- the sync

describe("the sync (codespace.sync)", () => {
  it("PUTs the project with a service token the portal verifies, and the quota of its creator", async () => {
    const room = await connected([]);
    const lab = await project(room, "Synced lab");
    portal.calls.length = 0;
    expect((await setMode(lab.id, "online")).statusCode).toBe(200);

    const [put] = portal.calls;
    expect(put).toMatchObject({ method: "PUT", path: `/api/assignments/${lab.id}` });
    await expectBoundServiceToken(put!);
    const body = CodespaceAssignmentSync.parse(put!.body);
    expect(body).toMatchObject({
      id: lab.id,
      mode: "online",
      classroomId: room.classroomId,
      browserExamKeys: [],
      teacher: { id: owner.id },
      quota: { maxActiveSessions: 3 },
      deadlineAt: DEADLINE,
    });
    // Seeded from the distribution repository, never the teacher's source (N-SEC-20).
    expect(body.sourceRepo.fullName).toBe(lab.distribution!.fullName);
    const ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect([ws.syncedAt, ws.syncError]).toEqual([NOW, null]);

    // A rename is the portal's to know.
    portal.calls.length = 0;
    await call("PATCH", `/app/api/projects/${lab.id}`, owner.headers, { name: "Synced lab 2" });
    expect(CodespaceAssignmentSync.parse(portal.calls[0]!.body).name).toBe("Synced lab 2");
  });

  it("carries the quota of the oldest owner once the creator holds no owner seat (decision C)", async () => {
    const room = await connected([]);
    const creator = await grantedTeacher(true, 5);
    await seat(room, creator.id, "owner");
    const elder = await grantedTeacher(true, 7);
    await seat(room, elder.id, "owner", new Date("2020-01-01T00:00:00Z"));
    const lab = await project(room, "Quota lab", { by: creator });
    await setMode(lab.id, "online", creator);
    expect(CodespaceAssignmentSync.parse(portal.calls.at(-1)!.body).quota).toEqual({ maxActiveSessions: 5 });

    await server.app.db.update(courseStaff).set({ role: "assistant" }).where(eq(courseStaff.userId, creator.id));
    portal.calls.length = 0;
    expect(await runCodespaceSync(server.app, CONFIG, lab.id, server.app.log)).toBe("synced");
    const body = CodespaceAssignmentSync.parse(portal.calls[0]!.body);
    expect(body.teacher.id).toBe(elder.id);
    expect(body.quota).toEqual({ maxActiveSessions: 7 });
  });

  it("records a failure for the staff, and resyncs on their request; a free project has nothing to resync", async () => {
    const room = await connected([]);
    const lab = await project(room, "Failing lab");
    portal.putStatus = 503;
    expect((await setMode(lab.id, "online")).statusCode).toBe(200);
    let ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect(ws.syncedAt).toBeNull();
    expect(ws.syncError).toMatch(/^portal answered 503/);
    expect(ws.syncError).not.toContain("Bearer");

    portal.putStatus = 200;
    const resync = await call("POST", `/app/api/projects/${lab.id}/workspace/sync`, owner.headers);
    expect(resync.statusCode, resync.body).toBe(202);
    ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect([ws.syncedAt, ws.syncError]).toEqual([NOW, null]);

    const free = await project(room, "Free lab");
    const refused = await call("POST", `/app/api/projects/${free.id}/workspace/sync`, owner.headers);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "not_online"]);
  });
});

// ---------------------------------------------------------------- Safe Exam Browser (D21, M6-07)

describe("an online_seb project (D21)", () => {
  it("is synced like an online project, with no Browser Exam Key: the Config Key alone", async () => {
    const room = await connected([]);
    const exam = await project(room, "Synced exam");
    portal.calls.length = 0;
    expect((await setMode(exam.id, "online_seb")).statusCode).toBe(200);
    expect(CodespaceAssignmentSync.parse(portal.calls.at(-1)!.body)).toMatchObject({ mode: "online_seb", browserExamKeys: [] });
    const resync = await call("POST", `/app/api/projects/${exam.id}/workspace/sync`, owner.headers);
    expect(resync.statusCode, resync.body).toBe(202);
  });

  it("launches from its seb session only: the token carries the session's Config Key", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const exam = await project(room, "SEB launch");
    await setMode(exam.id, "online_seb");
    await accept(exam.id, student);
    const configKey = "c".repeat(64);
    const sebHeaders = await sessionOf(server.app.db, student.id, { kind: "seb", projectId: exam.id, sebConfigKey: configKey });

    // From the portal: Safe Exam Browser is required, nothing is issued.
    expect((await start(exam.id, student.headers)).json()).toEqual({ error: "seb_required" });

    const token = (await launchUrl(exam.id, sebHeaders)).searchParams.get("token")!;
    const verdict = await verifyHs256<Record<string, unknown>>(token, SECRET, { audience: LAUNCH_AUDIENCE, issuer: "heig-quiz", now: AT_NOW });
    const claims = LaunchTokenClaims.parse(verdict.ok ? verdict.claims : null);
    expect(claims).toMatchObject({ sub: student.id, assignmentId: exam.id, seb: { configKey } });
    const [issued] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, exam.id)));
    expect(issued!.payload).toEqual({ jti: claims.jti, mode: "online_seb", seb: true });

    // Nobody was invited (ADR-047 §2): the student's view says so, never a "pending" invitation.
    expect((await call("GET", `/app/api/student/projects/${exam.id}`, student.headers)).json().repo.invitation).toBeNull();
    // The token reaches the student from neither session.
    for (const headers of [student.headers, sebHeaders]) {
      const body = (await call("GET", `/app/api/student/projects/${exam.id}`, headers)).body;
      expect(body).not.toContain(token.split(".")[2]!);
    }
    const frozen = await setMode(exam.id, "online");
    expect([frozen.statusCode, frozen.json().error]).toEqual([409, "work_mode_frozen"]);
  });

  it("a seb session of another project, or of an evaluation, launches nothing", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const exam = await project(room, "SEB other");
    await setMode(exam.id, "online_seb");
    await accept(exam.id, student);
    const elsewhere = await project(room, "SEB elsewhere");
    await setMode(elsewhere.id, "online_seb");
    const otherProject = await sessionOf(server.app.db, student.id, { kind: "seb", projectId: elsewhere.id, sebConfigKey: "c".repeat(64) });
    expect((await start(exam.id, otherProject)).statusCode).toBe(404);
    const evaluation = await sessionOf(server.app.db, student.id, { kind: "seb", evaluationId: room.evaluationId, sebConfigKey: "c".repeat(64) });
    expect((await start(exam.id, evaluation)).statusCode).toBe(401);
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, exam.id)));
    expect(issued).toEqual([]);
  });
});

// ---------------------------------------------------------------- the start route

describe("POST /app/api/projects/:id/workspace/start", () => {
  it("answers 401 without a session it serves, 403 an impersonation, and 404s a token and a stranger", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "Start lab");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    const admin = await server.signIn("admin");
    const stranger = await newStudent();
    const outsider = await grantedTeacher(true);

    expect((await start(lab.id)).statusCode).toBe(401);
    for (const kind of ["seb", "kiosk"] as const) {
      const confined = await start(lab.id, await sessionOf(server.app.db, student.id, { kind, evaluationId: room.evaluationId }));
      expect(confined.statusCode).toBe(401);
    }
    const impersonation = await start(lab.id, await sessionOf(server.app.db, student.id, { kind: "impersonation", actorUserId: admin.id }));
    // A session acting as a student writes nothing (ADR-034): refused before the route.
    expect([impersonation.statusCode, impersonation.json().error]).toEqual([403, "impersonation_read_only"]);
    const { token } = await createApiToken(server.app.db, student.id, { name: "t", expiresInDays: null, scope: "api" });
    expect((await start(lab.id, { authorization: `Bearer ${token}` })).statusCode).toBe(404);
    expect((await start(lab.id, stranger.headers)).statusCode).toBe(404);
    expect((await start(lab.id, outsider.headers)).statusCode).toBe(404);
    expect((await start(randomUUID(), student.headers)).statusCode).toBe(404);
    expect((await start("not-a-uuid", student.headers)).statusCode).toBe(404);
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued).toEqual([]);
  });

  it("cannot be launched by a cross-site request: a GET, or a POST without the CSRF header (audit L7)", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "Cross-site lab");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    const { "x-csrf-token": _, ...cookieOnly } = student.headers;
    const forged = await start(lab.id, cookieOnly);
    expect([forged.statusCode, forged.json().error]).toEqual([403, "csrf"]);
    // The old navigable GET is gone (a 404 for the API's unknown routes).
    expect((await call("GET", `/app/codespace/start/${lab.id}`, student.headers)).statusCode).toBe(404);
    expect((await call("GET", workspaceStartPath(lab.id), student.headers)).statusCode).toBe(404);
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued).toEqual([]);
    // The mode is not frozen: nothing was launched.
    expect((await setMode(lab.id, "free")).statusCode).toBe(200);
  });

  it("says nothing of a scheduled project, its mode included: the start and the .seb are 404s until it opens (ADR-127, N-SEC-20)", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const exam = await project(room, "Scheduled SEB", { publish: false });
    await setMode(exam.id, "online_seb");
    const lab = await project(room, "Scheduled online", { publish: false });
    await setMode(lab.id, "online");
    for (const id of [exam.id, lab.id]) await server.app.db.update(projects).set({ state: "scheduled" }).where(eq(projects.id, id));
    for (const id of [exam.id, lab.id]) {
      const res = await start(id, student.headers);
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).not.toMatch(/online|seb_required|not_accepted/);
    }
    expect((await call("GET", `/app/api/projects/${exam.id}/seb`, student.headers)).statusCode).toBe(404);
    // Published, the same routes answer as for any open project.
    for (const id of [exam.id, lab.id]) await server.app.db.update(projects).set({ state: "published" }).where(eq(projects.id, id));
    expect((await start(exam.id, student.headers)).json()).toEqual({ error: "seb_required" });
    expect((await start(lab.id, student.headers)).json()).toEqual({ error: "not_accepted" });
    expect((await call("GET", `/app/api/projects/${exam.id}/seb`, student.headers)).statusCode).toBe(200);
  });

  it("answers each refusal the project page words: not online, SEB only, not accepted, closed", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const free = await project(room, "Free start");
    const exam = await project(room, "SEB start");
    await setMode(exam.id, "online_seb");
    const lab = await project(room, "Online start");
    await setMode(lab.id, "online");
    const refusal = async (id: string) => {
      const res = await start(id, student.headers);
      expect(res.statusCode).toBe(409);
      return WorkspaceStartRefusal.parse(res.json().error);
    };
    expect(await refusal(free.id)).toBe("not_online");
    expect(await refusal(exam.id)).toBe("seb_required");
    expect(await refusal(lab.id)).toBe("not_accepted");
    await accept(lab.id, student);
    server.clock.set(new Date(new Date(DEADLINE).getTime() + 60_000));
    expect(await refusal(lab.id)).toBe("closed");
    // No launch was issued: the mode is still free to change.
    server.clock.set(NOW);
    expect((await setMode(lab.id, "free")).statusCode).toBe(200);
  });

  it("under commit, opens past the deadline plus the grace while the repository is writable; the portal gets no deadline (#958)", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "Commit start");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    portal.calls.length = 0;
    expect((await call("PATCH", `/app/api/projects/${lab.id}`, owner.headers, { deadlineStrategy: "commit" })).statusCode).toBe(200);
    expect(CodespaceAssignmentSync.parse(portal.calls[0]!.body).deadlineAt).toBeNull();
    const repo = await repoOf(lab.id, student.id);
    const db = server.app.db;
    await db.update(projectRepos).set({ deadlineAppliedAt: new Date(DEADLINE) }).where(eq(projectRepos.id, repo.id));
    server.clock.set(new Date(new Date(DEADLINE).getTime() + 24 * 3_600_000));
    expect((await start(lab.id, student.headers)).statusCode).toBe(200);
    // The staff's lock closes it; under lock the deadline does.
    const closed = async () => {
      const res = await start(lab.id, student.headers);
      return [res.statusCode, res.json().error];
    };
    await db.update(projectRepos).set({ staffLock: true }).where(eq(projectRepos.id, repo.id));
    expect(await closed()).toEqual([409, "closed"]);
    await db.update(projectRepos).set({ staffLock: null }).where(eq(projectRepos.id, repo.id));
    await db.update(projects).set({ deadlineStrategy: "lock" }).where(eq(projects.id, lab.id));
    expect(await closed()).toEqual([409, "closed"]);
  });

  it("launches: a token the portal verifies, its jti audited, the token nowhere else, the mode frozen", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "Launch lab");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    logLines.length = 0;

    const res = await start(lab.id, student.headers);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const location = new URL(WorkspaceStart.parse(res.json()).url);
    expect(`${location.origin}${location.pathname}`).toBe(`${PORTAL}/launch`);
    const token = location.searchParams.get("token")!;
    const verdict = await verifyHs256<Record<string, unknown>>(token, SECRET, {
      audience: LAUNCH_AUDIENCE,
      issuer: "heig-quiz",
      requireJti: true,
      now: AT_NOW,
    });
    expect(verdict.ok).toBe(true);
    const claims = LaunchTokenClaims.parse(verdict.ok ? verdict.claims : null);
    expect(claims).toMatchObject({
      iss: "heig-quiz",
      aud: LAUNCH_AUDIENCE,
      sub: student.id,
      assignmentId: lab.id,
      githubLogin: student.login,
      repo: { fullName: repo.fullName, defaultBranch: "main" },
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.seb).toBeUndefined();

    const audits = await server.app.db.select().from(auditLog).where(eq(auditLog.action, "codespace.launch_issued"));
    const mine = audits.filter((a) => a.subjectId === lab.id);
    expect(mine.map((a) => [a.actorUserId, a.payload])).toEqual([[student.id, { jti: claims.jti, mode: "online" }]]);
    const signature = token.split(".")[2]!;
    const everything = JSON.stringify(await server.app.db.select().from(auditLog));
    expect(everything).not.toContain(signature);
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(signature);
    for (const url of [`/app/api/student/projects/${lab.id}`, "/app/api/student/home", `/app/api/student/classrooms/${room.classroomId}`]) {
      const body = (await call("GET", url, student.headers)).body;
      expect(body).not.toContain(signature);
    }
    const view = (await call("GET", `/app/api/student/projects/${lab.id}`, student.headers)).json();
    expect(view.workspace).toEqual({ mode: "online", devices: "any" });
    // The home's and the classroom's card say the same (one rule, `studentWorkspace`): the card offers Open workspace.
    const home = StudentHome.parse((await call("GET", "/app/api/student/home", student.headers)).json());
    const page = StudentClassroomPage.parse((await call("GET", `/app/api/student/classrooms/${room.classroomId}`, student.headers)).json());
    for (const cards of [home.open, page.activities.open]) {
      const card = cards.find((c) => c.kind === "project" && c.id === lab.id);
      expect(card?.kind === "project" ? card.workspace : "missing").toEqual({ mode: "online", devices: "any" });
    }
    const [state] = await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, lab.id));
    expect(state!.firstLaunchAt?.toISOString()).toBe(NOW);

    // A second launch is a new token, a new jti.
    const again = (await launchUrl(lab.id, student.headers)).searchParams.get("token")!;
    expect(again).not.toBe(token);

    const frozen = await setMode(lab.id, "free");
    expect([frozen.statusCode, frozen.json().error]).toEqual([409, "work_mode_frozen"]);
    const ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect(ws).toMatchObject({ allowed: ["online"], refusal: "work_mode_frozen" });
  });
});

describe("a staff test seat (ADR-077)", () => {
  it("launches its own test repository's workspace without freezing the mode", async () => {
    const room = await connected([]);
    const lab = await project(room, "Tester lab");
    await setMode(lab.id, "online");
    const tester = await grantedTeacher(null);
    const githubUserId = freshAccountId();
    const login = `teacher${githubUserId}`;
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
    await server.app.db.insert(githubAccounts).values({ userId: tester.id, githubUserId, login });
    accounts.set(githubUserId, login);
    await accept(lab.id, tester);

    expect((await launchUrl(lab.id, tester.headers)).href).toMatch(new RegExp(`^${PORTAL}/launch\\?token=`));
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued.map((a) => a.actorUserId)).toEqual([tester.id]);
    // Not frozen: the owner may still change the mode.
    expect((await setMode(lab.id, "free")).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- the staff's sessions

describe("the project's workspaces", () => {
  it("matches the portal's users to the classroom's students, and says when the portal cannot be asked", async () => {
    const student = await newStudent();
    const room = await connected([student]);
    const lab = await project(room, "Sessions lab");
    await setMode(lab.id, "online");
    const other = await newStudent();
    const row = (userId: string, sessionId: string) => ({
      sessionId,
      userId,
      email: "x@heig.test",
      state: "running",
      createdAt: NOW,
      lastSeenAt: NOW,
      lastPushAt: null,
    });
    portal.sessions = [row(student.id, "s1"), row(other.id, "s2"), row("classroom-legacy", "s3")];
    // `row` gives each the same address: none reaches the staff.
    const read = await call("GET", `/app/api/projects/${lab.id}/workspace/sessions`, owner.headers);
    expect(read.statusCode, read.body).toBe(200);
    const listed = ProjectWorkspaceSessions.parse(read.json());
    expect(listed.reachable).toBe(true);
    expect(listed.sessions.map((s) => [s.sessionId, s.user?.id ?? null])).toEqual([
      ["s1", student.id],
      ["s2", null],
      ["s3", null],
    ]);
    expect(read.body).not.toContain("x@heig.test");
    await expectBoundServiceToken(portal.calls.at(-1)!);

    portal.sessions = 404;
    expect(ProjectWorkspaceSessions.parse((await call("GET", `/app/api/projects/${lab.id}/workspace/sessions`, owner.headers)).json())).toEqual({ reachable: true, sessions: [] });
    portal.down = true;
    expect(ProjectWorkspaceSessions.parse((await call("GET", `/app/api/projects/${lab.id}/workspace/sessions`, owner.headers)).json())).toEqual({ reachable: false, sessions: [] });
    // A student of the classroom reads none of it.
    expect((await call("GET", `/app/api/projects/${lab.id}/workspace/sessions`, student.headers)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/projects/${lab.id}/workspace`, student.headers)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- the administrator's grant

describe("the workspace grant (admin)", () => {
  it("is listed and edited by an administrator only", async () => {
    const admin = await server.signIn("admin");
    const email = `g-${randomUUID().slice(0, 8)}@heig.test`;
    const created = await call("POST", "/app/api/admin/teachers", admin.headers, { email });
    expect(created.statusCode).toBe(201);
    const gid = created.json().id as string;
    const listed = () => (call("GET", "/app/api/admin/teachers", admin.headers).then((r) => r.json() as AdminTeacher[]));
    expect((await listed()).find((t) => t.id === gid)?.codespace).toEqual({ enabled: false, maxActiveSessions: 2 });

    const patch = await call("PATCH", `/app/api/admin/teachers/${gid}/codespace`, admin.headers, { enabled: true, maxActiveSessions: 4 });
    expect(patch.statusCode, patch.body).toBe(200);
    expect((await listed()).find((t) => t.id === gid)?.codespace).toEqual({ enabled: true, maxActiveSessions: 4 });
    expect((await call("PATCH", `/app/api/admin/teachers/${gid}/codespace`, admin.headers, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/app/api/admin/teachers/${gid}/codespace`, admin.headers, { maxActiveSessions: -1 })).statusCode).toBe(400);
    expect((await call("PATCH", `/app/api/admin/teachers/${randomUUID()}/codespace`, admin.headers, { enabled: true })).statusCode).toBe(404);
    expect((await call("PATCH", `/app/api/admin/teachers/${gid}/codespace`, owner.headers, { enabled: false })).statusCode).toBe(403);
    const [audit] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "teacher.codespace_grant"), eq(auditLog.subjectId, gid)));
    expect(audit?.payload).toEqual({ email, enabled: true, maxActiveSessions: 4 });
  });

  it("sets an administrator's quota on a row of their address, never their switch (amendment 2026-11-16)", async () => {
    const email = SUPER_ADMIN_EMAIL;
    const admin = await server.signIn("admin", email);
    // A verified address in the set: the grant and the revoke recompute the role.
    await server.app.db.insert(userEmails).values({ userId: admin.id, email, source: "login", verified: true });
    const created = await call("POST", "/app/api/admin/teachers", admin.headers, { email });
    expect(created.statusCode, created.body).toBe(201);
    const gid = created.json().id as string;
    const listed = async () => {
      const res = await call("GET", "/app/api/admin/teachers", admin.headers);
      expect(res.statusCode, res.body).toBe(200);
      return res.json<AdminTeacher[]>().find((t) => t.id === gid);
    };
    const path = `/app/api/admin/teachers/${gid}/codespace`;

    // The row is stored off, but the administrator's workspace is always on.
    expect(await listed()).toMatchObject({ admin: true, codespace: { enabled: true, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS } });
    for (const enabled of [false, true]) {
      const refused = await call("PATCH", path, admin.headers, { enabled, maxActiveSessions: 30 });
      expect([refused.statusCode, refused.json().error]).toEqual([409, "is_admin"]);
    }
    expect(await grantOf(server.app.db, admin.id)).toEqual({ enabled: true, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS });

    // Above the default, the row's quota; below it, the default still.
    const raised = await call("PATCH", path, admin.headers, { maxActiveSessions: 30 });
    expect([raised.statusCode, raised.json()]).toEqual([200, { enabled: true, maxActiveSessions: 30 }]);
    expect(await grantOf(server.app.db, admin.id)).toEqual({ enabled: true, maxActiveSessions: 30 });
    expect((await listed())?.codespace).toEqual({ enabled: true, maxActiveSessions: 30 });
    expect((await call("PATCH", path, admin.headers, { maxActiveSessions: 0 })).statusCode).toBe(200);
    expect(await grantOf(server.app.db, admin.id)).toEqual({ enabled: true, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS });

    // Revoked: the default grant again, and the role untouched.
    expect((await call("DELETE", `/app/api/admin/teachers/${gid}`, admin.headers)).statusCode).toBe(204);
    expect(await grantOf(server.app.db, admin.id)).toEqual({ enabled: true, maxActiveSessions: DEFAULT_MAX_ACTIVE_SESSIONS });
    const [stored] = await server.app.db.select({ role: users.role }).from(users).where(eq(users.id, admin.id));
    expect(stored?.role).toBe("admin");
  });
});
