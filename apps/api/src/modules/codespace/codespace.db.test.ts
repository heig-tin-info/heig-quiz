/**
 * The `codespace` module (ADR-047 as amended 2026-10-07, merge task M6-06)
 * over the real application, with Quiz's App against the fake GitHub and
 * the local bare repositories (a student's Accept really provisions), the
 * portal a stub on `portal.test`, the clock moved by hand:
 *
 * - the work mode: an owner with the grant only (an assistant `403
 *   owner_required`, an owner without the grant `403
 *   codespace_not_granted`), never a group project, frozen once a
 *   workspace was launched; the invitation's permission by mode;
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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodespaceAssignmentSync,
  LAUNCH_AUDIENCE,
  LaunchTokenClaims,
  ProjectSummary,
  ProjectWorkspace,
  ProjectWorkspaceSessions,
  SERVICE_AUDIENCE,
  type AdminTeacher,
  type SessionKind,
} from "@quiz/contracts";
import { verifyHs256 } from "@quiz/domain";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import type { AppConfig } from "../../config.js";
import {
  auditLog,
  codespaceProjects,
  courseStaff,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectRepos,
  teacherGrants,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive, type Seeded } from "../../test/live.js";
import { repoWorld } from "../project/testing.js";
import { runCodespaceSync } from "./service.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const SECRET = "s".repeat(40);
const PORTAL = "http://portal.test";
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
  CODESPACE_URL: PORTAL,
  CODESPACE_LAUNCH_SECRET: SECRET,
};
const NOW = "2026-10-07T08:00:00.000Z";
/** The verifier's clock: the tokens are signed by the server's, set to NOW. */
const AT_NOW = () => Math.floor(Date.parse(NOW) / 1000);
/** What `runCodespaceSync` reads of the configuration. */
const CONFIG = { CODESPACE_URL: PORTAL, CODESPACE_LAUNCH_SECRET: SECRET } as AppConfig;
const DEADLINE = "2026-10-14T22:00:00.000Z";

type Headers = Record<string, string>;
interface Person {
  id: string;
  headers: Headers;
}
interface Student extends Person {
  login: string;
}

let server: TestServer;
let owner: Person;
let nextOrg = 82_000;
let nextAccount = 85_000;

// ---------------------------------------------------------------- the stub portal

interface PortalCall {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}
const portal = {
  calls: [] as PortalCall[],
  /** What `PUT /api/assignments/:id` answers. */
  putStatus: 200,
  /** What `GET /api/assignments/:id/sessions` answers: a body, or a status. */
  sessions: [] as unknown[] | number,
  down: false,
};

async function portalFetch(url: URL, init: RequestInit): Promise<Response> {
  if (portal.down) throw new TypeError("fetch failed");
  const headers = new Headers(init.headers);
  const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
  portal.calls.push({ method: init.method ?? "GET", path: url.pathname, authorization: headers.get("authorization"), body });
  if (init.method === "PUT" && /^\/api\/assignments\/[^/]+$/.test(url.pathname)) {
    if (portal.putStatus !== 200) return json({ error: "nope" }, portal.putStatus);
    return json({ id: (body as { id: string }).id, configKey: null, sebLink: null });
  }
  if (/^\/api\/assignments\/[^/]+\/sessions$/.test(url.pathname)) {
    return typeof portal.sessions === "number" ? json({ error: "x" }, portal.sessions) : json(portal.sessions);
  }
  return json({ error: "not_found" }, 404);
}

const fetchStub = (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return url.origin === PORTAL ? portalFetch(url, init) : gh.fetch(input, init);
};

// ---------------------------------------------------------------- the world

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

const call = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function newStudent(): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `kid${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

/** A teacher whose `teacher_grants` row says `enabled` (no row at all with `null`). */
async function grantedTeacher(enabled: boolean | null, maxActiveSessions = 3): Promise<Person> {
  const email = `t-${randomUUID().slice(0, 8)}@heig.test`;
  const signed = await server.signIn("teacher", email);
  if (enabled !== null) {
    await server.app.db.insert(teacherGrants).values({
      id: randomUUID(),
      email,
      createdBy: signed.id,
      codespaceEnabled: enabled,
      codespaceMaxActiveSessions: maxActiveSessions,
    });
  }
  return signed;
}

interface Room extends Seeded {
  org: string;
}

/** A classroom of `owner`'s course, `students` enrolled, connected to a fresh organization holding `starter`. */
async function connectedClassroom(students: { id: string }[]): Promise<Room> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: owner.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const org = `corg-${n}`;
  world.orgIds[org] = n;
  world.source(org, "starter", { main: { "README.md": "# Lab" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: owner.id, linkedAt: new Date() });
  return { ...seeded, org };
}

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
  call("PUT", `/app/api/projects/${projectId}/workspace/mode`, who.headers, { mode });
const accept = async (projectId: string, who: Person) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  expect(res.statusCode, res.body).toBe(200);
};
const start = (projectId: string, headers: Headers = {}) => call("GET", `/app/codespace/start/${projectId}`, headers);
const repoOf = async (projectId: string, userId: string) =>
  (await server.app.db.select().from(projectRepos).where(and(eq(projectRepos.projectId, projectId), eq(projectRepos.userId, userId))))[0]!;

async function sessionOf(
  userId: string,
  auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string; projectId?: string; sebConfigKey?: string },
): Promise<Headers> {
  const s = await createSession(server.app.db, userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    projectId: auth.projectId ?? null,
    sebConfigKey: auth.sebConfigKey ?? null,
  });
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

/** Every line pino writes (the request loggers share `app.log`'s stream), as `githubLink.db.test.ts` captures it. */
const logLines: string[] = [];
function captureLog(app: TestServer["app"]) {
  const log = app.log as unknown as Record<symbol, { write: (line: string) => boolean }>;
  const streamSym = Object.getOwnPropertySymbols(Object.getPrototypeOf(log))
    .concat(Object.getOwnPropertySymbols(log))
    .find((s) => s.description === "pino.stream");
  if (!streamSym) throw new Error("pino stream not found");
  log[streamSym]!.write = (line: string) => {
    logLines.push(line);
    return true;
  };
  app.log.level = "trace";
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchStub);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  captureLog(server.app);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
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

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the work mode

describe("the work mode (ADR-047 as amended 2026-10-07)", () => {
  it("is set by an owner with the grant; an assistant and an owner without it are refused", async () => {
    const room = await connectedClassroom([]);
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
    expect(audits.map((a) => a.payload)).toEqual([{ from: "free", to: "online" }]);
  });

  it("keeps a group project in the students' own tools, both ways", async () => {
    const room = await connectedClassroom([]);
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
    const room = await connectedClassroom([a, b]);
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

// ---------------------------------------------------------------- the sync

describe("the sync (codespace.sync)", () => {
  it("PUTs the project with a service token the portal verifies, and the quota of its creator", async () => {
    const room = await connectedClassroom([]);
    const lab = await project(room, "Synced lab");
    portal.calls.length = 0;
    expect((await setMode(lab.id, "online")).statusCode).toBe(200);

    const [put] = portal.calls;
    expect(put).toMatchObject({ method: "PUT", path: `/api/assignments/${lab.id}` });
    const verdict = await verifyHs256(put!.authorization!.replace(/^Bearer /, ""), SECRET, {
      audience: SERVICE_AUDIENCE,
      issuer: "heig-quiz",
      now: AT_NOW,
    });
    expect(verdict.ok).toBe(true);
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
    const room = await connectedClassroom([]);
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
    const room = await connectedClassroom([]);
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
    const room = await connectedClassroom([]);
    const exam = await project(room, "Synced exam");
    portal.calls.length = 0;
    expect((await setMode(exam.id, "online_seb")).statusCode).toBe(200);
    expect(CodespaceAssignmentSync.parse(portal.calls.at(-1)!.body)).toMatchObject({ mode: "online_seb", browserExamKeys: [] });
    const resync = await call("POST", `/app/api/projects/${exam.id}/workspace/sync`, owner.headers);
    expect(resync.statusCode, resync.body).toBe(202);
  });

  it("launches from its seb session only: the token carries the session's Config Key", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const exam = await project(room, "SEB launch");
    await setMode(exam.id, "online_seb");
    await accept(exam.id, student);
    const configKey = "c".repeat(64);
    const sebHeaders = await sessionOf(student.id, { kind: "seb", projectId: exam.id, sebConfigKey: configKey });

    // From the portal: Safe Exam Browser is required, nothing is issued.
    expect((await start(exam.id, student.headers)).headers.location).toBe(`/projects/${exam.id}?workspace=seb_required`);

    const res = await start(exam.id, sebHeaders);
    expect(res.statusCode).toBe(303);
    const token = new URL(res.headers.location as string).searchParams.get("token")!;
    const verdict = await verifyHs256<Record<string, unknown>>(token, SECRET, { audience: LAUNCH_AUDIENCE, issuer: "heig-quiz", now: AT_NOW });
    const claims = LaunchTokenClaims.parse(verdict.ok ? verdict.claims : null);
    expect(claims).toMatchObject({ sub: student.id, assignmentId: exam.id, seb: { configKey } });
    const [issued] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, exam.id)));
    expect(issued!.payload).toEqual({ jti: claims.jti, mode: "online_seb", seb: true });

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
    const room = await connectedClassroom([student]);
    const exam = await project(room, "SEB other");
    await setMode(exam.id, "online_seb");
    await accept(exam.id, student);
    const elsewhere = await project(room, "SEB elsewhere");
    await setMode(elsewhere.id, "online_seb");
    const otherProject = await sessionOf(student.id, { kind: "seb", projectId: elsewhere.id, sebConfigKey: "c".repeat(64) });
    expect((await start(exam.id, otherProject)).statusCode).toBe(404);
    const evaluation = await sessionOf(student.id, { kind: "seb", evaluationId: room.evaluationId, sebConfigKey: "c".repeat(64) });
    expect((await start(exam.id, evaluation)).headers.location).toMatch(/^\/app\/auth\/login\?/);
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, exam.id)));
    expect(issued).toEqual([]);
  });
});

// ---------------------------------------------------------------- the start route

describe("GET /app/codespace/start/:id", () => {
  it("sends an anonymous visitor and a confined session through the sign-in, and 404s an impersonation and a stranger", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Start lab");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    const admin = await server.signIn("admin");
    const stranger = await newStudent();
    const outsider = await grantedTeacher(true);

    const anonymous = await start(lab.id);
    expect([anonymous.statusCode, anonymous.headers.location]).toEqual([303, `/app/auth/login?next=${encodeURIComponent(`/app/codespace/start/${lab.id}`)}`]);
    for (const kind of ["seb", "kiosk"] as const) {
      const confined = await start(lab.id, await sessionOf(student.id, { kind, evaluationId: room.evaluationId }));
      expect(confined.statusCode).toBe(303);
      expect(confined.headers.location).toMatch(/^\/app\/auth\/login\?/);
    }
    const impersonation = await start(lab.id, await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id }));
    expect(impersonation.statusCode).toBe(404);
    const { token } = await createApiToken(server.app.db, student.id, { name: "t", expiresInDays: null });
    expect((await start(lab.id, { authorization: `Bearer ${token}` })).statusCode).toBe(404);
    expect((await start(lab.id, stranger.headers)).statusCode).toBe(404);
    expect((await start(lab.id, outsider.headers)).statusCode).toBe(404);
    expect((await start(randomUUID(), student.headers)).statusCode).toBe(404);
    expect((await start("not-a-uuid", student.headers)).statusCode).toBe(404);
    const issued = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "codespace.launch_issued"), eq(auditLog.subjectId, lab.id)));
    expect(issued).toEqual([]);
  });

  it("sends each refusal back to the project page: not online, SEB only, not accepted, closed", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const free = await project(room, "Free start");
    const exam = await project(room, "SEB start");
    await setMode(exam.id, "online_seb");
    const lab = await project(room, "Online start");
    await setMode(lab.id, "online");
    const refusal = async (id: string) => {
      const res = await start(id, student.headers);
      expect(res.statusCode).toBe(303);
      return res.headers.location;
    };
    expect(await refusal(free.id)).toBe(`/projects/${free.id}?workspace=not_online`);
    expect(await refusal(exam.id)).toBe(`/projects/${exam.id}?workspace=seb_required`);
    expect(await refusal(lab.id)).toBe(`/projects/${lab.id}?workspace=not_accepted`);
    await accept(lab.id, student);
    server.clock.set(new Date(new Date(DEADLINE).getTime() + 60_000));
    expect(await refusal(lab.id)).toBe(`/projects/${lab.id}?workspace=closed`);
    // No launch was issued: the mode is still free to change.
    server.clock.set(NOW);
    expect((await setMode(lab.id, "free")).statusCode).toBe(200);
  });

  it("launches: a token the portal verifies, its jti audited, the token nowhere else, the mode frozen", async () => {
    const student = await newStudent();
    const room = await connectedClassroom([student]);
    const lab = await project(room, "Launch lab");
    await setMode(lab.id, "online");
    await accept(lab.id, student);
    const repo = await repoOf(lab.id, student.id);
    logLines.length = 0;

    const res = await start(lab.id, student.headers);
    expect(res.statusCode).toBe(303);
    const location = new URL(res.headers.location as string);
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
    expect(view.workspace).toEqual({ mode: "online" });
    const [state] = await server.app.db.select().from(codespaceProjects).where(eq(codespaceProjects.projectId, lab.id));
    expect(state!.firstLaunchAt?.toISOString()).toBe(NOW);

    // A second launch is a new token, a new jti.
    const again = new URL((await start(lab.id, student.headers)).headers.location as string).searchParams.get("token")!;
    expect(again).not.toBe(token);

    const frozen = await setMode(lab.id, "free");
    expect([frozen.statusCode, frozen.json().error]).toEqual([409, "work_mode_frozen"]);
    const ws = ProjectWorkspace.parse((await call("GET", `/app/api/projects/${lab.id}/workspace`, owner.headers)).json());
    expect(ws).toMatchObject({ allowed: ["online"], refusal: "work_mode_frozen" });
  });
});

describe("a staff test seat (ADR-077)", () => {
  it("launches its own test repository's workspace without freezing the mode", async () => {
    const room = await connectedClassroom([]);
    const lab = await project(room, "Tester lab");
    await setMode(lab.id, "online");
    const tester = await grantedTeacher(null);
    const githubUserId = nextAccount++;
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

    const res = await start(lab.id, tester.headers);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(new RegExp(`^${PORTAL}/launch\\?token=`));
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
    const room = await connectedClassroom([student]);
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
    const verdict = await verifyHs256(portal.calls.at(-1)!.authorization!.replace(/^Bearer /, ""), SECRET, { audience: SERVICE_AUDIENCE, issuer: "heig-quiz", now: AT_NOW });
    expect(verdict.ok).toBe(true);

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
});
