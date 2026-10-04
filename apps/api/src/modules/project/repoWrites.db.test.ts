/**
 * The staff's writes on one repository besides its score (merge task
 * M3-08b): the protected files re-enabled (F-PROJ-08) and a pending
 * invitation resent (F-PROJ-07), on a server built with Quiz's App against
 * the fake GitHub and the local bare repositories, the clock moved by hand.
 * The product owner's decisions of 2026-10-02:
 *
 * - re-enabling clears the suspension, restores nothing by itself, keeps
 *   the runs flagged meanwhile to verify, counts only the restores after it
 *   toward the cap, and makes the final review due again;
 * - a resend goes to a pending invitation only, once a minute at most, with
 *   the `push` permission, audited; the minute is given back when GitHub
 *   refuses;
 * - staff only (invariant 6).
 */
import { randomUUID } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDetail, ProjectInvitationResent, ProjectRepoProtection, ProjectSummary } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import {
  auditLog,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectGradeRuns,
  projectRepos,
  reverts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { accessibleProjectRepo } from "../guards.js";
import { refreshScoreSelection } from "./grading.js";
import { MAX_RESTORES_PER_HOUR, protectFiles } from "./protection.js";
import { repoContext } from "./repos.js";
import { claimReviewWork } from "./review.js";
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
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const MINUTE = 60_000;
const GRACE = 30 * MINUTE;
const GRADING = ".github/workflows/grading.yml";
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 62_000;
let nextAccount = 65_000;

/** GitHub's accounts by id, for the login lookups. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `rw${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login, githubUserId };
}

const call = (method: "GET" | "POST", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

type Repo = typeof projectRepos.$inferSelect;

/** A published project protecting `grading.yml`, of a connected classroom, and the accepted repositories of its students. */
async function project(opts: { students?: number } = {}) {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const login = `worg-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}", [GRADING]: "grade: v1" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Lab",
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    protectedFiles: [GRADING],
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  for (const s of students) {
    const accepted = await call("POST", `/app/api/student/projects/${summary.id}/accept`, s.headers);
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, summary.id));
  return { id: summary.id, repos: students.map((s) => repos.find((r) => r.userId === s.id)!), students };
}

const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const restores = (repoId: string) => server.app.db.select().from(reverts).where(eq(reverts.repoId, repoId));
const head = (fullName: string) => world.git(fullName, "rev-parse", "main").trim();

/**
 * A student's push touching `grading.yml`, answered as the webhook would
 * (`protectFiles`, without the delivery): the pushed head, restored or not.
 */
async function tamper(repo: Repo, content: string): Promise<string> {
  const ctx = (await repoContext(server.app.db, repo.githubRepoId!))!;
  const before = head(repo.fullName!);
  const after = world.commit(repo.fullName!, "main", { [GRADING]: content });
  await protectFiles(server.app, config, ctx, { branch: "main", before, after, forced: false, commits: [{ modified: [GRADING] }] });
  return after;
}
const restored = (repo: Repo, pushed: string) => head(repo.fullName!) !== pushed && world.read(repo.fullName!, head(repo.fullName!), GRADING) === "grade: v1";

/** `n` tampering pushes a minute apart, every one restored. */
async function restoredPushes(repo: Repo, n: number, tag: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    server.clock.advance(MINUTE);
    expect(restored(repo, await tamper(repo, `grade: ${tag} ${i}`)), `${tag} ${i}`).toBe(true);
  }
}

const reenable = (projectId: string, repoId: string, headers = teacher.headers) =>
  call("POST", `/app/api/projects/${projectId}/repos/${repoId}/protection`, headers);
const resend = (projectId: string, repoId: string, headers = teacher.headers) =>
  call("POST", `/app/api/projects/${projectId}/repos/${repoId}/invite`, headers);
const inviteCalls = (login: string) => gh.calls.filter((c) => c.includes(`/collaborators/${login}`)).length;

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("the protection re-enabled (F-PROJ-08)", () => {
  it("clears the suspension, restores nothing, keeps the flagged runs, and counts the restores afresh", async () => {
    const p = await project();
    const [repo] = p.repos;
    await restoredPushes(repo!, MAX_RESTORES_PER_HOUR, "first");
    server.clock.advance(MINUTE);
    const sixth = await tamper(repo!, "grade: sixth");
    expect(head(repo!.fullName!)).toBe(sixth);
    expect((await repoRow(repo!.id)).protectionSuspendedAt).toEqual(server.clock.now());
    const flagged = randomUUID();
    await server.app.db.insert(projectGradeRuns).values({
      id: flagged,
      repoId: repo!.id,
      workflowRunId: 1,
      headBranch: "main",
      headSha: sixth,
      conclusion: "success",
      points: 6,
      max: 6,
      parseStatus: "ok",
      toVerify: true,
      completedAt: server.clock.now(),
    });

    server.clock.advance(MINUTE);
    const reenabledAt = server.clock.now();
    const res = await reenable(p.id, repo!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectRepoProtection.parse(res.json())).toEqual({ reenabledAt: reenabledAt.toISOString() });
    expect(await repoRow(repo!.id)).toMatchObject({ protectionSuspendedAt: null, protectionReenabledAt: reenabledAt });
    // Nothing restored by the re-enable itself; the run flagged meanwhile stays to verify.
    expect(head(repo!.fullName!)).toBe(sixth);
    expect(world.read(repo!.fullName!, sixth, GRADING)).toBe("grade: sixth");
    expect((await server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.id, flagged)))[0]!.toVerify).toBe(true);
    const [entry] = await auditOf(repo!.id, "project_repo.protection_reenabled");
    expect(entry).toMatchObject({ actorUserId: teacher.id, payload: { suspendedAt: at(NOW, 6 * MINUTE).toISOString() } });

    // Five restores stand within the hour: they no longer count. Five more
    // are restored, the sixth after the re-enable suspends again.
    await restoredPushes(repo!, MAX_RESTORES_PER_HOUR, "second");
    expect((await repoRow(repo!.id)).protectionSuspendedAt).toBeNull();
    expect(await restores(repo!.id)).toHaveLength(2 * MAX_RESTORES_PER_HOUR);
    server.clock.advance(MINUTE);
    const again = await tamper(repo!, "grade: again");
    expect(head(repo!.fullName!)).toBe(again);
    expect((await repoRow(repo!.id)).protectionSuspendedAt).toEqual(server.clock.now());
    expect(await auditOf(repo!.id, "project_repo.revert_cap")).toHaveLength(2);
  });

  it("is a no-op on a repository not suspended, and refused on one deleted", async () => {
    const p = await project({ students: 2 });
    const [plain, deleted] = p.repos;
    const res = await reenable(p.id, plain!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectRepoProtection.parse(res.json())).toEqual({ reenabledAt: null });
    expect(await auditOf(plain!.id, "project_repo.protection_reenabled")).toEqual([]);

    await server.app.db.update(projectRepos).set({ deletedAt: server.clock.now(), protectionSuspendedAt: server.clock.now() }).where(eq(projectRepos.id, deleted!.id));
    const gone = await reenable(p.id, deleted!.id);
    expect([gone.statusCode, gone.json().error]).toEqual([409, "repo_unavailable"]);
  });

  it("makes the final review due again, and the page say so", async () => {
    const p = await project();
    const [repo] = p.repos;
    await server.app.db.insert(projectGradeRuns).values({
      id: randomUUID(),
      repoId: repo!.id,
      workflowRunId: 2,
      headBranch: "main",
      headSha: head(repo!.fullName!),
      conclusion: "success",
      points: 4,
      max: 6,
      parseStatus: "ok",
      completedAt: at(DEADLINE, -MINUTE),
    });
    await refreshScoreSelection(server.app.db, { repo: repo! });
    const frozenAt = at(DEADLINE, GRACE);
    await server.app.db
      .update(projectRepos)
      .set({
        deadlineAppliedAt: at(DEADLINE),
        frozenAt,
        frozenGradeRunId: (await repoRow(repo!.id)).currentGradeRunId,
        protectionSuspendedAt: at(DEADLINE, -MINUTE),
      })
      .where(eq(projectRepos.id, repo!.id));
    server.clock.set(at(DEADLINE, GRACE + 1000));
    const mine = (jobs: { projectId: string }[]) => jobs.filter((j) => j.projectId === p.id);

    // Suspended: no review due, the page says skipped and why.
    expect(mine(await claimReviewWork(server.app.db, server.clock.now()))).toEqual([]);
    const before = ProjectDetail.parse((await call("GET", `/app/api/projects/${p.id}`, teacher.headers)).json());
    expect(before.rows[0]!.repo!.review).toEqual({ status: "skipped", reason: "protection_suspended", askedAt: null, sha: null, runId: null });

    expect((await reenable(p.id, repo!.id)).statusCode).toBe(200);
    expect(mine(await claimReviewWork(server.app.db, server.clock.now()))).toHaveLength(1);
    const after = ProjectDetail.parse((await call("GET", `/app/api/projects/${p.id}`, teacher.headers)).json());
    expect(after.rows[0]!.repo!.review).toMatchObject({ status: "pending", reason: null });
    expect(after.rows[0]!.repo!.flags.protectionSuspended).toBe(false);
  });
});

describe("the invitation resent (F-PROJ-07)", () => {
  it("re-invites a pending invitation with push, once a minute, audited", async () => {
    const p = await project();
    const [repo] = p.repos;
    const student = p.students[0]!;
    expect(repo!.invitationStatus).toBe("pending");
    // GitHub let the invitation expire: the student is nobody on the repository.
    world.collaborators.get(repo!.fullName!)!.delete(student.login);

    const res = await resend(p.id, repo!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectInvitationResent.parse(res.json())).toEqual({ invitationStatus: "pending", resentAt: NOW });
    expect(world.collaborators.get(repo!.fullName!)!.get(student.login)).toBe("push");
    expect(await repoRow(repo!.id)).toMatchObject({ invitationStatus: "pending", invitationResentAt: at(NOW) });
    const [entry] = await auditOf(repo!.id, "project_repo.invite_resent");
    expect(entry).toMatchObject({ actorUserId: teacher.id, payload: { login: student.login, invitationStatus: "pending" } });

    // Too soon: nothing asked of GitHub.
    const calls = inviteCalls(student.login);
    server.clock.advance(MINUTE - 1000);
    const soon = await resend(p.id, repo!.id);
    expect([soon.statusCode, soon.json().error]).toEqual([429, "resend_too_soon"]);
    expect(inviteCalls(student.login)).toBe(calls);

    // A minute later, the student had accepted meanwhile: the row follows GitHub's answer.
    server.clock.advance(1000);
    const later = await resend(p.id, repo!.id);
    expect(later.statusCode, later.body).toBe(200);
    expect(ProjectInvitationResent.parse(later.json()).invitationStatus).toBe("accepted");
    expect((await repoRow(repo!.id)).invitationStatus).toBe("accepted");
    expect(await auditOf(repo!.id, "project_repo.invite_resent")).toHaveLength(2);

    // Accepted: nothing to resend.
    server.clock.advance(MINUTE);
    const done = await resend(p.id, repo!.id);
    expect([done.statusCode, done.json().error]).toEqual([409, "invitation_not_pending"]);
  });

  it("refuses a deleted repository and an archived project, and gives the minute back when GitHub knows the account no more", async () => {
    const p = await project({ students: 2 });
    const [stale, deleted] = p.repos;
    const student = p.students[0]!;
    await server.app.db.update(projectRepos).set({ deletedAt: server.clock.now() }).where(eq(projectRepos.id, deleted!.id));
    const gone = await resend(p.id, deleted!.id);
    expect([gone.statusCode, gone.json().error]).toEqual([409, "repo_unavailable"]);

    expect((await call("POST", `/app/api/projects/${p.id}/archive`, teacher.headers)).statusCode).toBe(200);
    const archived = await resend(p.id, stale!.id);
    expect([archived.statusCode, archived.json().error]).toEqual([409, "repo_unavailable"]);
    expect((await call("POST", `/app/api/projects/${p.id}/unarchive`, teacher.headers)).statusCode).toBe(200);
    expect((await repoRow(stale!.id)).invitationResentAt).toBeNull();

    accounts.delete(student.githubUserId);
    const refused = await resend(p.id, stale!.id);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "github_account_stale"]);
    expect(await auditOf(stale!.id, "project_repo.invite_resent")).toEqual([]);
    // The minute was given back: the account relinked, the next resend goes through at once.
    accounts.set(student.githubUserId, student.login);
    const retried = await resend(p.id, stale!.id);
    expect(retried.statusCode, retried.body).toBe(200);
  });
});

describe("staff only (invariant 6)", () => {
  it("answers a student, another teacher, an impersonation and a token as nobody", async () => {
    const p = await project();
    const [repo] = p.repos;
    const student = p.students[0]!;
    const stranger = await server.signIn("teacher");
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "t", expiresInDays: null });
    const s = await createSession(server.app.db, teacher.id, 8, {
      kind: "impersonation",
      actorUserId: (await server.signIn("admin")).id,
      evaluationId: null,
    });
    const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    // An impersonation is read-only outside development (ADR-034 §4): the hook's 403 comes first ...
    const callers: [string, Headers, [number, string]][] = [
      ["student", student.headers, [404, "not_found"]],
      ["stranger", stranger.headers, [404, "not_found"]],
      ["impersonation", impersonation, [403, "impersonation_read_only"]],
      ["token", { authorization: `Bearer ${token}` }, [404, "not_found"]],
    ];
    const calls = inviteCalls(student.login);
    for (const [who, headers, expected] of callers) {
      for (const [name, res] of [
        ["protection", await reenable(p.id, repo!.id, headers)],
        ["invite", await resend(p.id, repo!.id, headers)],
      ] as const) {
        expect([res.statusCode, res.json().error], `${who} ${name}`).toEqual(expected);
      }
    }
    // ... and the loader answers its 404 where an impersonation may write.
    const sent: unknown[] = [];
    const reply = { code: (status: number) => ({ send: (body: unknown) => sent.push([status, body]) }) } as unknown as FastifyReply;
    const req = { auth: { kind: "impersonation", actorUserId: teacher.id }, caller: { id: teacher.id, role: "teacher", reach: "seats" } };
    expect(await accessibleProjectRepo(server.app, req as unknown as FastifyRequest, reply, { id: p.id, rid: repo!.id })).toBeNull();
    expect(sent).toEqual([[404, { error: "not_found" }]]);
    expect(inviteCalls(student.login)).toBe(calls);
    expect((await repoRow(repo!.id)).invitationResentAt).toBeNull();
  });
});
