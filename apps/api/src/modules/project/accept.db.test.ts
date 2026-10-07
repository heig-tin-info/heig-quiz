/**
 * A student's Accept (F-PROJ-05, merge task M3-03), on a server built with
 * Quiz's App, against the fake GitHub (`github/testing.ts`) and the local
 * bare repositories git really clones and pushes to (`./testing.ts`):
 *
 * - the repository `<slug>-<login>` made from the distribution repository,
 *   its default branch, its ruleset (or none on the free plan), the student
 *   invited with `push`, never more;
 * - idempotent: a second click, two at once (`provision_in_progress`), a
 *   claim taken over after five minutes; a failure retried, replayed safely;
 *   an `ok` row never undone by a late failure; the staff told once;
 * - the GitHub account: not linked, deleted, renamed (followed), GitHub
 *   unreachable (the stored login), an invitation refused;
 * - the refusals: not started, deadline passed, no group (M3-15b), the App
 *   gone; a draft, an archived project, another classroom, an
 *   impersonation, a Bearer token, a `seb` session get the 404 (or 401);
 * - dead stays dead;
 * - N-SEC-20: no response names the source or the distribution repository.
 */
import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectAcceptance, ProjectAcceptErrorCode, ProjectSummary } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import {
  auditLog,
  classrooms,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectGroupMembers,
  projectGroups,
  projectRepoAccess,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { studentProject } from "../guards.js";
import { markProvisionFailed } from "./accept.js";
import { repoWorld } from "./testing.js";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const NOW = "2026-10-02T08:00:00.000Z";
const IN_A_WEEK = "2026-10-09T22:00:00.000Z";
const MINUTE = 60_000;

type Headers = Record<string, string>;
interface Student {
  id: string;
  headers: Headers;
  githubUserId: number;
  login: string;
}

let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 9000;
let nextAccount = 5000;

/** GitHub's accounts, by immutable id: today's login, or `down` for GitHub failing. Missing: deleted. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  if (login === "down") return json({ message: "Server Error" }, 500);
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** Every body a student received: none may name the source or the distribution (N-SEC-20). */
const studentBodies: string[] = [];

const call = (method: "GET" | "POST" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
const accept = async (projectId: string, who: { headers: Headers }) => {
  const res = await call("POST", `/app/api/student/projects/${projectId}/accept`, who.headers);
  studentBodies.push(res.body);
  return res;
};
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectAcceptErrorCode.parse(res.json().error)];

/** A student with a linked GitHub account (unless `linked: false`). */
async function newStudent(opts: { linked?: boolean; login?: string } = {}): Promise<Student> {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = opts.login ?? `kid${githubUserId}`;
  if (opts.linked !== false) {
    await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
    accounts.set(githubUserId, login);
  }
  return { ...signed, githubUserId, login };
}

interface Org {
  login: string;
  orgId: string;
}

/**
 * A classroom of `teacher`'s course connected to an organization holding the
 * source `starter` (a new one, unless `org` is given), `students` enrolled.
 */
async function connectedClassroom(students: Student[], org?: Org) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  if (org) {
    await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId: org.orgId, linkedBy: teacher.id, linkedAt: new Date() });
    return { id: seeded.classroomId, ...org };
  }
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" }, solution: { "README.md": "# Solution" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  return { id: seeded.classroomId, login, orgId };
}

/** A project `Lab 1` of a fresh classroom, published (unless `publish: false`), and its students. */
async function publishedProject(opts: { students?: Student[]; publish?: boolean; body?: object; org?: Org } = {}) {
  const students = opts.students ?? [await newStudent()];
  const room = await connectedClassroom(students, opts.org);
  const res = await call("POST", `/app/api/classrooms/${room.id}/projects`, teacher.headers, {
    name: "Lab 1",
    sourceRepo: "starter",
    deadlineAt: IN_A_WEEK,
    ...opts.body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const project = ProjectSummary.parse(res.json());
  if (opts.publish !== false) {
    const published = await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers);
    expect(published.statusCode, published.body).toBe(200);
  }
  return { project, room, students, student: students[0]! };
}

const repoRows = (projectId: string) => server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
const auditOf = (subjectId: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const repoCreations = (org: string) => gh.calls.filter((c) => c === `POST api.github.com/orgs/${org}/repos`);

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  world.allowPushes();
  world.freePlan = false;
});

afterAll(async () => {
  // N-SEC-20: whatever a student was answered, never the source nor the distribution repository.
  expect(studentBodies.length).toBeGreaterThan(20);
  for (const body of studentBodies) {
    expect(body).not.toMatch(/starter|squashed/);
  }
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the repository

describe("Accept gives the student their repository (F-PROJ-05)", () => {
  it("makes <slug>-<login> from the distribution, protected, the student invited with push", async () => {
    const { project, room, student } = await publishedProject();
    const res = await accept(project.id, student);
    expect(res.statusCode, res.body).toBe(200);
    const fullName = `${room.login}/lab-1-${student.login}`;
    // Exactly the three fields: nothing of the project's repositories.
    expect(res.json()).toEqual({ status: "ok", fullName, invitationStatus: "pending" });
    expect(ProjectAcceptance.parse(res.json())).toEqual(res.json());

    // The distribution's branch, pushed: a shared ancestor (F-PROJ-12).
    const distribution = `${room.login}/lab-1-squashed`;
    expect(world.git(fullName, "rev-parse", "main")).toBe(world.git(distribution, "rev-parse", "main"));
    expect(world.git(fullName, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim()).toBe("main");
    expect(world.rulesets.get(fullName)?.map((r) => r.name)).toEqual(["hgc-protect"]);
    // `push`, never more (N-SEC-21).
    expect(Object.fromEntries(world.collaborators.get(fullName)!)).toEqual({ [student.login]: "push" });

    const [row] = await repoRows(project.id);
    expect(row).toMatchObject({
      userId: student.id,
      groupId: null,
      fullName,
      githubRepoId: world.ids.get(fullName),
      defaultBranch: "main",
      provisionStatus: "ok",
      provisionError: null,
      invitationStatus: "pending",
      acceptedAt: new Date(NOW),
    });
    expect(row!.rulesetId).not.toBeNull();
    const audits = await auditOf(row!.id, "project.accept");
    expect(audits.map((a) => [a.actorUserId, a.payload])).toEqual([
      [student.id, { repo: fullName, invitation: "pending", protected: true }],
    ]);
  });

  it("answers a second click with the same row and no call to GitHub", async () => {
    const { project, student } = await publishedProject();
    const first = await accept(project.id, student);
    const before = gh.calls.length;
    // Even after the deadline: the repository is theirs.
    server.clock.set(new Date(Date.parse(IN_A_WEEK) + MINUTE));
    const second = await accept(project.id, student);
    expect([second.statusCode, second.json()]).toEqual([200, first.json()]);
    expect(gh.calls.length).toBe(before);
    expect(await repoRows(project.id)).toHaveLength(1);
  });

  it("tolerates a plan without rulesets: provisioned, unprotected", async () => {
    const { project, student } = await publishedProject();
    world.freePlan = true;
    const res = await accept(project.id, student);
    expect(res.json().status).toBe("ok");
    const [row] = await repoRows(project.id);
    expect(row!.rulesetId).toBeNull();
    expect((await auditOf(row!.id, "project.accept"))[0]?.payload).toMatchObject({ protected: false });
  });
});

// ---------------------------------------------------------------- one at a time

describe("one Accept provisions at a time", () => {
  it("refuses a concurrent Accept with provision_in_progress, and makes one repository", async () => {
    const { project, room, student } = await publishedProject();
    world.stallPushes = true;
    const pending = accept(project.id, student);
    // The repository is created once the row is claimed: its push then stalls.
    for (let i = 0; i < 400 && !world.exists(`${room.login}/lab-1-${student.login}`); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const [claimed] = await repoRows(project.id);
    expect([claimed?.provisionStatus, claimed?.provisionClaimedAt]).toEqual(["pending", new Date(NOW)]);
    expect(refusal(await accept(project.id, student))).toEqual([409, "provision_in_progress"]);
    world.release(true);
    expect((await pending).json().status).toBe("ok");
    expect((await accept(project.id, student)).json().status).toBe("ok");
    expect(await repoRows(project.id)).toHaveLength(1);
    expect(repoCreations(room.login)).toHaveLength(2); // the distribution, the student's
  });

  it("takes over a claim older than five minutes", async () => {
    const { project, student } = await publishedProject();
    const id = randomUUID();
    await server.app.db.insert(projectRepos).values({
      id,
      projectId: project.id,
      userId: student.id,
      acceptedAt: new Date(NOW),
      provisionClaimedAt: new Date(Date.parse(NOW) - 4 * MINUTE),
    });
    expect(refusal(await accept(project.id, student))).toEqual([409, "provision_in_progress"]);
    server.clock.set(new Date(Date.parse(NOW) + 2 * MINUTE));
    const res = await accept(project.id, student);
    expect(res.json().status).toBe("ok");
    expect((await repoRows(project.id)).map((r) => [r.id, r.provisionStatus])).toEqual([[id, "ok"]]);
  });
});

// ---------------------------------------------------------------- failures

describe("a failure leaves a state the student retries", () => {
  it("records the failure, tells the staff once, and a retry replays safely", async () => {
    const { project, room, student } = await publishedProject();
    world.refusePushes = true;
    expect(refusal(await accept(project.id, student))).toEqual([502, "provision_failed"]);
    let [row] = await repoRows(project.id);
    expect([row!.provisionStatus, row!.fullName]).toEqual(["error", null]);
    expect(row!.provisionError).toMatch(/refused|failed/i);
    // The retry: the repository exists (422, adopted), its push refused again.
    expect(refusal(await accept(project.id, student))).toEqual([502, "provision_failed"]);
    const failures = await auditOf(row!.id, "project.accept_failed");
    // The first failure only is the one the staff hear of (M3-09 sends it).
    expect(failures.map((f) => f.payload)).toEqual([
      { notify: true, reason: "github_error" },
      { notify: false, reason: "github_error" },
    ]);

    world.allowPushes();
    const res = await accept(project.id, student);
    expect(res.json()).toEqual({ status: "ok", fullName: `${room.login}/lab-1-${student.login}`, invitationStatus: "pending" });
    [row] = await repoRows(project.id);
    expect([row!.provisionStatus, row!.provisionError]).toEqual(["ok", null]);
    expect(repoCreations(room.login)).toHaveLength(4); // the distribution, three attempts
    expect(world.git(row!.fullName!, "rev-parse", "main")).toBe(world.git(`${room.login}/lab-1-squashed`, "rev-parse", "main"));
  });

  it("never turns an ok row back into an error", async () => {
    const { project, student } = await publishedProject();
    await accept(project.id, student);
    const [row] = await repoRows(project.id);
    expect(await markProvisionFailed(server.app.db, row!.id, row!.provisionClaimedAt!, "a late failure")).toBe(false);
    const [after] = await repoRows(project.id);
    expect([after!.provisionStatus, after!.provisionError]).toEqual(["ok", null]);
  });

  it("never records a stale holder's failure over the claim that took it over", async () => {
    const { project, student } = await publishedProject();
    const id = randomUUID();
    const takenOver = new Date(Date.parse(NOW) - 10 * MINUTE);
    await server.app.db.insert(projectRepos).values({
      id,
      projectId: project.id,
      userId: student.id,
      acceptedAt: new Date(NOW),
      provisionClaimedAt: new Date(NOW),
    });
    expect(await markProvisionFailed(server.app.db, id, takenOver, "late")).toBe(false);
    const [row] = await repoRows(project.id);
    expect([row!.provisionStatus, row!.provisionError]).toEqual(["pending", null]);
    expect(await markProvisionFailed(server.app.db, id, new Date(NOW), "now")).toBe(true);
  });

  it("never adopts a repository it did not make: a login naming the distribution", async () => {
    // `lab-1` + the login `squashed` = `lab-1-squashed`, the project's own distribution.
    const student = await newStudent({ login: "squashed" });
    const { project, room } = await publishedProject({ students: [student] });
    const distribution = `${room.login}/lab-1-squashed`;
    const head = world.git(distribution, "rev-parse", "main");
    const before = gh.calls.length;
    expect(refusal(await accept(project.id, student))).toEqual([409, "repo_name_taken"]);
    // The create's 422 and the read of the repository: nothing pushed, changed or granted.
    expect(gh.calls.slice(before).filter((c) => c.includes("/repos/"))).toEqual([`GET api.github.com/repos/${distribution}`]);
    expect(world.collaborators.get(distribution)).toBeUndefined();
    expect(world.rulesets.get(distribution)).toBeUndefined();
    expect(world.git(distribution, "rev-parse", "main")).toBe(head);
    const [row] = await repoRows(project.id);
    expect([row!.provisionStatus, row!.githubRepoId, row!.fullName]).toEqual(["error", null, null]);
  });

  it("gives one repository name to one row only, when two rows map to it", async () => {
    // The same student in two classrooms of one organization, a project `Lab 1` in each.
    const student = await newStudent();
    const first = await publishedProject({ students: [student] });
    const second = await publishedProject({ students: [student], org: { login: first.room.login, orgId: first.room.orgId } });
    const name = `${first.room.login}/lab-1-${student.login}`;
    expect((await accept(first.project.id, student)).json()).toMatchObject({ status: "ok", fullName: name });
    const seats = Object.fromEntries(world.collaborators.get(name)!);
    expect(refusal(await accept(second.project.id, student))).toEqual([409, "repo_name_taken"]);
    expect(Object.fromEntries(world.collaborators.get(name)!)).toEqual(seats);
    const [other] = await repoRows(second.project.id);
    expect([other!.provisionStatus, other!.githubRepoId]).toEqual(["error", null]);
  });
});

// ---------------------------------------------------------------- the GitHub account

describe("the student's GitHub account", () => {
  it("refuses an account not linked, then a deleted one, before anything is written", async () => {
    const unlinked = await newStudent({ linked: false });
    const { project } = await publishedProject({ students: [unlinked] });
    expect(refusal(await accept(project.id, unlinked))).toEqual([409, "github_not_linked"]);
    await server.app.db.insert(githubAccounts).values({ userId: unlinked.id, githubUserId: unlinked.githubUserId, login: unlinked.login });
    // Linked, but GitHub no longer has the account.
    expect(refusal(await accept(project.id, unlinked))).toEqual([409, "github_account_stale"]);
    expect(await repoRows(project.id)).toEqual([]);
  });

  it("follows a renamed account to its new login", async () => {
    const { project, room, student } = await publishedProject();
    accounts.set(student.githubUserId, `${student.login}-new`);
    const res = await accept(project.id, student);
    expect(res.json().fullName).toBe(`${room.login}/lab-1-${student.login}-new`);
    const [account] = await server.app.db.select().from(githubAccounts).where(eq(githubAccounts.userId, student.id));
    expect(account!.login).toBe(`${student.login}-new`);
    expect(await auditOf(student.id, "github.renamed")).toHaveLength(1);
    expect([...world.collaborators.get(res.json().fullName)!.keys()]).toEqual([`${student.login}-new`]);
  });

  it("names nothing when GitHub cannot tell today's login: 502, retried", async () => {
    const { project, room, student } = await publishedProject();
    accounts.set(student.githubUserId, "down");
    expect(refusal(await accept(project.id, student))).toEqual([502, "provision_failed"]);
    expect(await repoRows(project.id)).toEqual([]);
    accounts.set(student.githubUserId, student.login);
    expect((await accept(project.id, student)).json()).toMatchObject({ status: "ok", fullName: `${room.login}/lab-1-${student.login}` });
  });

  it("answers an invitation GitHub refuses with github_account_stale, the staff not told", async () => {
    const { project, student } = await publishedProject();
    world.uninvitable.add(student.login);
    expect(refusal(await accept(project.id, student))).toEqual([409, "github_account_stale"]);
    const [row] = await repoRows(project.id);
    expect(row!.provisionStatus).toBe("error");
    expect((await auditOf(row!.id, "project.accept_failed")).map((f) => f.payload)).toEqual([{ notify: false, reason: "invitation_refused" }]);
    world.uninvitable.delete(student.login);
  });
});

// ---------------------------------------------------------------- refusals

describe("what Accept refuses", () => {
  it("refuses before the start and after the deadline, on the server's clock", async () => {
    const { project, student } = await publishedProject({
      body: { publishMode: "scheduled", startAt: "2026-10-03T08:00:00.000Z", deadlineAt: IN_A_WEEK },
    });
    expect(refusal(await accept(project.id, student))).toEqual([409, "not_started"]);
    server.clock.set(IN_A_WEEK);
    expect(refusal(await accept(project.id, student))).toEqual([409, "deadline_passed"]);
    expect(await repoRows(project.id)).toEqual([]);
  });

  it("refuses a group project whose copy places the student nowhere (M3-15b) and an organization the App left", async () => {
    const { project, room, student } = await publishedProject();
    await server.app.db.update(projects).set({ groupMode: true }).where(eq(projects.id, project.id));
    expect(refusal(await accept(project.id, student))).toEqual([409, "no_group"]);
    await server.app.db.update(projects).set({ groupMode: false }).where(eq(projects.id, project.id));
    await server.app.db.update(githubOrganizations).set({ installationId: null }).where(eq(githubOrganizations.id, room.orgId));
    expect(refusal(await accept(project.id, student))).toEqual([409, "app_not_installed"]);
  });

  it("answers the 404 of a missing project to everyone else", async () => {
    const { project, room, student } = await publishedProject();
    const draft = await publishedProject({ publish: false, students: [student] });
    const stranger = await newStudent();
    await publishedProject({ students: [stranger] });
    const admin = await server.signIn("admin");
    const session = async (auth: Parameters<typeof createSession>[3]): Promise<Headers> => {
      const s = await createSession(server.app.db, student.id, 8, auth);
      return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    };
    const { token } = await createApiToken(server.app.db, student.id, { name: "t", expiresInDays: null });
    const callers: [string, string, { headers: Headers }][] = [
      ["a draft", draft.project.id, student],
      ["a student of another classroom", project.id, stranger],
      ["the course's teacher", project.id, teacher],
      ["a random id", randomUUID(), student],
      ["a Bearer token", project.id, { headers: { authorization: `Bearer ${token}` } }],
    ];
    for (const [who, id, caller] of callers) {
      const res = await accept(id, caller);
      expect([res.statusCode, res.json().error], who).toEqual([404, "not_found"]);
    }
    // An impersonation: read-only outside development (ADR-034 §4), and the
    // loader's 404 in development too, where it may write.
    const impersonation = await session({ kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null });
    const refused = await accept(project.id, { headers: impersonation });
    expect([refused.statusCode, refused.json().error]).toEqual([403, "impersonation_read_only"]);
    const sent: unknown[] = [];
    const reply = { code: (status: number) => ({ send: (body: unknown) => sent.push([status, body]) }) } as unknown as FastifyReply;
    const req = { auth: { kind: "impersonation", actorUserId: admin.id }, caller: { id: student.id, role: "student", reach: "seats" } };
    expect(await studentProject(server.app, req as unknown as FastifyRequest, reply, { id: project.id })).toBeNull();
    expect(sent).toEqual([[404, { error: "not_found" }]]);
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const seb = await session({ kind: "seb", actorUserId: null, projectId: null, evaluationId: seeded.evaluationId });
    expect((await accept(project.id, { headers: seb })).statusCode).toBe(401);

    await server.app.db.update(classrooms).set({ archivedAt: new Date(NOW) }).where(eq(classrooms.id, room.id));
    expect((await accept(project.id, student)).statusCode, "an archived classroom").toBe(404);
    await server.app.db.update(classrooms).set({ archivedAt: null }).where(eq(classrooms.id, room.id));

    await server.app.db.update(projects).set({ archivedAt: new Date(NOW) }).where(eq(projects.id, project.id));
    expect((await accept(project.id, student)).statusCode).toBe(404);
    expect(await repoRows(project.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- a staff seat tests (ADR-077)

describe("a teacher's staff seat accepts an individual project (ADR-077)", () => {
  /** A teacher with a claimed STAFF seat of `roomId` and a linked GitHub account of their own. */
  async function staffSeat(roomId: string): Promise<Student & { enrollmentId: string }> {
    const signed = await server.signIn("teacher");
    const githubUserId = nextAccount++;
    const login = `teacher${githubUserId}`;
    const enrollmentId = randomUUID();
    await server.app.db.insert(enrollments).values({
      id: enrollmentId,
      classroomId: roomId,
      nom: "Test",
      prenom: "Teacher",
      email: `t-${randomUUID().slice(0, 6)}@heig.test`,
      userId: signed.id,
      claimedAt: new Date(),
      staff: true,
    });
    await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
    accounts.set(githubUserId, login);
    return { ...signed, githubUserId, login, enrollmentId };
  }

  it("gets its own repository, counted nowhere, badged on the staff page, never read by a student", async () => {
    const { project, room, student } = await publishedProject();
    const other = await newStudent();
    const tester = await staffSeat(room.id);
    const res = await accept(project.id, tester);
    expect(res.statusCode, res.body).toBe(200);
    const fullName = `${room.login}/lab-1-${tester.login}`;
    expect(res.json()).toMatchObject({ status: "ok", fullName });

    // The holder reads it, as a staff seat.
    const own = await call("GET", `/app/api/student/projects/${project.id}`, tester.headers);
    expect(own.json()).toMatchObject({ seat: "staff", repo: { fullName } });

    // The staff page: a badged row, in no count.
    const detail = await call("GET", `/app/api/projects/${project.id}`, teacher.headers);
    const body = detail.json();
    expect(body.counts).toMatchObject({ students: 1, accepted: 0, live: 0, frozen: 0 });
    expect(body.rows.filter((r: { staff: boolean }) => r.staff)).toHaveLength(1);
    expect(body.rows.find((r: { staff: boolean }) => r.staff).repo.fullName).toBe(fullName);
    expect(body.rows.filter((r: { staff: boolean }) => !r.staff).every((r: { repo: unknown }) => r.repo === null)).toBe(true);

    // N-SEC-20: nothing a student receives names it.
    await accept(project.id, student);
    for (const who of [student, other]) {
      const view = await call("GET", `/app/api/student/projects/${project.id}`, who.headers);
      const home = await call("GET", "/app/api/student/home", who.headers);
      expect(view.body).not.toContain(tester.login);
      expect(home.body).not.toContain(tester.login);
    }
  });

  it("answers a group project 409 no_group: staff seats are never placed", async () => {
    const { project, room } = await publishedProject();
    await server.app.db.update(projects).set({ groupMode: true }).where(eq(projects.id, project.id));
    const tester = await staffSeat(room.id);
    expect(refusal(await accept(project.id, tester))).toEqual([409, "no_group"]);
    expect(await repoRows(project.id)).toEqual([]);
  });

  it("resends its pending invitation like a student (200)", async () => {
    const { project, room } = await publishedProject();
    const tester = await staffSeat(room.id);
    expect((await accept(project.id, tester)).statusCode).toBe(200);
    const res = await call("POST", `/app/api/student/projects/${project.id}/invite`, tester.headers);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("loses its access when the staff seat is removed (F-PROJ-17)", async () => {
    const { project, room } = await publishedProject();
    const tester = await staffSeat(room.id);
    expect((await accept(project.id, tester)).statusCode).toBe(200);
    const grants = () => server.app.db.select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, tester.enrollmentId));
    expect((await grants()).filter((g) => g.revokedAt === null)).toHaveLength(1);
    const removed = await call("DELETE", `/app/api/classrooms/${room.id}/roster/${tester.enrollmentId}`, teacher.headers);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await grants()).filter((g) => g.revokedAt === null)).toEqual([]);
  });

  it("never reads nor joins a group repository of a copy it kept from before it was a staff seat", async () => {
    const { project, room } = await publishedProject();
    const tester = await staffSeat(room.id);
    const db = server.app.db;
    await db.update(projects).set({ groupMode: true }).where(eq(projects.id, project.id));
    const groupId = randomUUID();
    await db.insert(projectGroups).values({ id: groupId, projectId: project.id, name: "Group 1", slug: "group-1", position: 0 });
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: project.id, groupId, enrollmentId: tester.enrollmentId });
    const groupName = `${room.login}/lab-1-group-1`;
    await db.insert(projectRepos).values({
      id: randomUUID(),
      projectId: project.id,
      userId: (await newStudent()).id,
      groupId,
      acceptedAt: new Date(NOW),
      fullName: groupName,
      githubRepoId: 424242,
      provisionStatus: "ok",
      invitationStatus: "pending",
    });
    const bodies = [
      (await accept(project.id, tester)).body,
      (await call("GET", `/app/api/student/projects/${project.id}`, tester.headers)).body,
      (await call("GET", "/app/api/student/home", tester.headers)).body,
      (await call("POST", `/app/api/student/projects/${project.id}/invite`, tester.headers)).body,
    ];
    expect((await accept(project.id, tester)).statusCode).toBe(409);
    expect(JSON.parse(bodies[1]!).repo).toBeNull();
    for (const body of bodies) expect(body).not.toContain(groupName);
    expect(await db.select().from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, tester.enrollmentId))).toEqual([]);
  });

  it("is refused to a teacher without a seat, and to an impersonation of the staff seat", async () => {
    const { project, room } = await publishedProject();
    const tester = await staffSeat(room.id);
    const seatless = await server.signIn("teacher");
    expect((await accept(project.id, seatless)).statusCode).toBe(404);
    const admin = await server.signIn("admin");
    const s = await createSession(server.app.db, tester.id, 8, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null });
    const headers = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    expect((await accept(project.id, { headers })).statusCode).toBe(403);
    expect(await repoRows(project.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- dead stays dead

describe("a repository deleted on GitHub", () => {
  it("is answered as it stands, never made again", async () => {
    const { project, student } = await publishedProject();
    await accept(project.id, student);
    const [row] = await repoRows(project.id);
    await server.app.db
      .update(projectRepos)
      .set({ deletedAt: new Date(NOW), provisionStatus: "error" })
      .where(eq(projectRepos.id, row!.id));
    const before = gh.calls.length;
    const res = await accept(project.id, student);
    expect([res.statusCode, res.json()]).toEqual([200, { status: "error", fullName: row!.fullName, invitationStatus: "pending" }]);
    expect(gh.calls.length).toBe(before);
  });
});
