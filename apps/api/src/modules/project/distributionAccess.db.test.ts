/**
 * A staff member's own read access to the distribution repository
 * (F-PROJ-02 as amended 2026-10-26, #899), on a server built with Quiz's App
 * against the fake GitHub and the local bare repositories:
 *
 * - the caller invited with `pull`, by the login GitHub knows today, audited;
 *   GitHub's 204 for a collaborator already in is `accepted`;
 * - a permission already held, at least `read`, is left as it is;
 * - no linked account: `409 github_not_linked`;
 * - off the staff: the 404 of a missing project; an impersonation: refused
 *   as every write of one is; Super Powers without a seat: `403
 *   staff_seat_required`.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CSRF_COOKIE, ProjectDistributionAccess, ProjectSummary } from "@quiz/contracts";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { loadConfig } from "../../config.js";
import { auditLog, githubAccounts, githubClassroomLinks, githubOrganizations, projects } from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
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
// The fake GitHub is the config's too.
loadConfig({ NODE_ENV: "test", ...ENV });

type Headers = Record<string, string>;
let server: TestServer;
let nextOrg = 66_000;
let nextAccount = 67_000;

/** GitHub's accounts by id, for the login lookups. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** A teacher, with a linked GitHub account unless `linked` is false. */
async function newTeacher(linked = true) {
  const signed = await server.signIn("teacher");
  if (!linked) return { ...signed, login: null };
  const githubUserId = nextAccount++;
  const login = `da${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

/** A draft project of a connected classroom, its distribution built, `teacher` on the course staff. */
async function project(teacher: { id: string; headers: Headers }) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
  const n = nextOrg++;
  const org = `dorg-${n}`;
  world.orgIds[org] = n;
  world.source(org, "starter", { main: { "README.md": "# Lab" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: org, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${seeded.classroomId}/projects`,
    headers: teacher.headers,
    payload: { name: "Lab", sourceRepo: "starter", deadlineAt: "2026-12-09T22:00:00.000Z" },
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  return { id: summary.id, fullName: summary.distribution!.fullName };
}

const ask = (projectId: string, headers: Headers) =>
  server.app.inject({ method: "POST", url: `/app/api/projects/${projectId}/distribution/access`, headers });
const audits = (projectId: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, projectId), eq(auditLog.action, "project.distribution_access")));
const invites = (fullName: string, login: string) =>
  gh.calls.filter((c) => c === `PUT api.github.com/repos/${fullName}/collaborators/${login}`).length;

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("a staff member's access to the distribution repository (#899)", () => {
  it("invites the caller with pull, audited, and answers accepted once they are in", async () => {
    const teacher = await newTeacher();
    const p = await project(teacher);
    const res = await ask(p.id, teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectDistributionAccess.parse(res.json())).toEqual({
      status: "pending",
      invitationsUrl: `https://github.com/${p.fullName}/invitations`,
    });
    expect(world.collaborators.get(p.fullName)?.get(teacher.login!)).toBe("pull");
    const [entry] = await audits(p.id);
    expect(entry).toMatchObject({
      actorUserId: teacher.id,
      subjectType: "project",
      payload: { fullName: p.fullName, login: teacher.login, permission: "pull", status: "pending" },
    });
    expect(JSON.stringify(entry!.payload)).not.toMatch(/token/i);

    // The invitation accepted on GitHub: a second click finds the caller in, and invites nobody.
    world.invitations.get(p.fullName)!.clear();
    const again = await ask(p.id, teacher.headers);
    expect([again.statusCode, again.json().status]).toEqual([200, "accepted"]);
    expect(invites(p.fullName, teacher.login!)).toBe(1);
    expect((await audits(p.id)).map((a) => (a.payload as { status: string }).status)).toEqual(["pending", "accepted"]);
  });

  it("answers 204 from GitHub as accepted", async () => {
    const teacher = await newTeacher();
    const p = await project(teacher);
    // A collaborator GitHub does not report through the permission read: the PUT answers 204.
    world.collaborators.set(p.fullName, new Map([[teacher.login!, "pull"]]));
    const before = gh.routes;
    gh.routes = [
      (url, req) =>
        req.method === "GET" && url.pathname.endsWith(`/collaborators/${teacher.login}/permission`)
          ? json({ message: "Not Found" }, 404)
          : undefined,
      ...before,
    ];
    try {
      const res = await ask(p.id, teacher.headers);
      expect([res.statusCode, res.json().status]).toEqual([200, "accepted"]);
      expect(invites(p.fullName, teacher.login!)).toBe(1);
    } finally {
      gh.routes = before;
    }
  });

  it("leaves a higher permission as it is", async () => {
    const teacher = await newTeacher();
    const p = await project(teacher);
    world.collaborators.set(p.fullName, new Map([[teacher.login!, "admin"]]));
    const res = await ask(p.id, teacher.headers);
    expect([res.statusCode, res.json().status]).toEqual([200, "accepted"]);
    expect(world.collaborators.get(p.fullName)!.get(teacher.login!)).toBe("admin");
    expect(invites(p.fullName, teacher.login!)).toBe(0);
  });

  it("refuses a caller without a linked account, and a project whose distribution is not built", async () => {
    const teacher = await newTeacher(false);
    const p = await project(teacher);
    const res = await ask(p.id, teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "github_not_linked"]);
    const linked = await newTeacher();
    const q = await project(linked);
    await server.app.db.update(projects).set({ distributionFullName: null }).where(eq(projects.id, q.id));
    const missing = await ask(q.id, linked.headers);
    expect([missing.statusCode, missing.json().error]).toEqual([409, "distribution_missing"]);
    expect([...(await audits(p.id)), ...(await audits(q.id))]).toEqual([]);
  });

  it("answers a stranger as nobody, refuses an impersonation, and Super Powers without a seat with 403", async () => {
    const teacher = await newTeacher();
    const p = await project(teacher);
    const stranger = await newTeacher();
    const s = await createSession(server.app.db, teacher.id, 8, {
      kind: "impersonation",
      actorUserId: (await server.signIn("admin")).id,
      evaluationId: null,
      projectId: null,
    });
    const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    const off = await ask(p.id, stranger.headers);
    expect([off.statusCode, off.json().error]).toEqual([404, "not_found"]);
    // An impersonation writes nothing at all (ADR-034), this request included.
    const acted = await ask(p.id, impersonation);
    expect([acted.statusCode, acted.json().error]).toEqual([403, "impersonation_read_only"]);
    const admin = await server.signInWithSuperPowers();
    const powered = await ask(p.id, admin.headers);
    expect([powered.statusCode, powered.json().error]).toEqual([403, "staff_seat_required"]);
    expect(invites(p.fullName, teacher.login!)).toBe(0);
    expect(await audits(p.id)).toEqual([]);
  });
});
