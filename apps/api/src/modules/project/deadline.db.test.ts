/**
 * A project's deadline (merge task M3-05a, ADR-064) on a server built with
 * Quiz's App, against the fake GitHub (`github/testing.ts`) and the local
 * bare repositories (`./testing.ts`), the clock moved by hand. Ported from
 * heig-classroom's `deadline.test` and the reopen of its lifecycle, plus
 * what Quiz decided on 2026-10-02:
 *
 * - the ticker claims and enqueues only: no HTTP inside a tick, one claim
 *   per project (its lease), a scheduled draft published by
 *   `publishProject`'s guard (an incomplete group project stays a draft);
 * - the job locks (the ruleset), falls back to archiving only where
 *   rulesets cannot exist, never on GitHub failing; a 404 is terminal; the
 *   `commit` strategy is idempotent and recorded before the ref moves;
 * - leases: rescheduling between the sweep and the run, a crashed job's
 *   work claimed again once its lease expired, a reopen in the middle of
 *   a job wins;
 * - the freeze: provisional at the effective deadline, refreshed during the
 *   grace, definitive at deadline + grace;
 * - a repository's own deadline (D13 amended): that repository stays open,
 *   its receipts are on time, it freezes at its own; moved later after it
 *   was applied, it is unlocked;
 * - the reopen: markers cleared, runs requalified, scores reselected,
 *   teacher scores and a release kept, the locks lifted and an archive
 *   undone; the staff's unlock never locked again;
 * - the J−n checkpoints follow a moved deadline in calendar days.
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectRepoDeadlineState, ProjectSummary } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { loadConfig } from "../../config.js";
import {
  auditLog,
  botCommits,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectCheckpoints,
  projectGradeRuns,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import type { JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { accessibleProjectRepo } from "../guards.js";
import { refreshScoreSelection, ingestCompletedRun } from "./grading.js";
import { DEADLINE_LEASE_MS, FAILED_RETRY_MS, projectTick, runDeadlineJob, type DeadlineJob } from "./jobs.js";
import { repoContext } from "./repos.js";
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
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 22_000;
let nextAccount = 25_000;

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};
/** While set, GitHub fails a ruleset's creation with a 500: a failure to retry, never a reason to archive. */
let rulesetsDown = false;
const rulesetsFailing: Route = (url, req) =>
  rulesetsDown && req.method === "POST" && url.pathname.endsWith("/rulesets") ? json({ message: "Server Error" }, 500) : undefined;
/** Runs before GitHub answers a ruleset's creation, once: what happens "in the middle of a job". */
let duringLock: (() => Promise<void>) | null = null;
const lockHook: Route = (url, req) => {
  if (!duringLock || req.method !== "POST" || !url.pathname.endsWith("/rulesets")) return undefined;
  const run = duringLock;
  duringLock = null;
  // The fake's fetch returns what a route returns: a pending answer delays GitHub's.
  return run().then(() => world.route(url, req)) as unknown as Response;
};

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `dl${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

/** A published project of a connected classroom, and the accepted repositories of `students` students. */
async function project(opts: { students?: number; body?: Record<string, unknown>; freePlan?: boolean; publish?: boolean } = {}) {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const login = `dorg-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" }, dev: { "README.md": "# Dev" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Lab",
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    ...opts.body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  if (opts.publish === false) return { id: summary.id, classroomId: seeded.classroomId, repos: [] as Repo[], students };
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  world.freePlan = opts.freePlan ?? false;
  try {
    for (const s of students) {
      const accepted = await call("POST", `/app/api/student/projects/${summary.id}/accept`, s.headers);
      expect(accepted.statusCode, accepted.body).toBe(200);
    }
  } finally {
    world.freePlan = false;
  }
  const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, summary.id));
  // In the students' order.
  const ordered = students.map((s) => repos.find((r) => r.userId === s.id)!);
  return { id: summary.id, classroomId: seeded.classroomId, repos: ordered, students };
}
type Repo = typeof projectRepos.$inferSelect;

const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const projectRow = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const lockRuleset = (fullName: string) => (world.rulesets.get(fullName) ?? []).some((r) => r.name === "hgc-deadline-lock");
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));

/** The jobs the ticker sent, as a queue would have carried them. */
const sent: DeadlineJob[] = [];
/** One pass of the ticker, a queue in place; true when it made no request to GitHub. */
async function tick(): Promise<boolean> {
  const queue: JobQueue = {
    createQueue: async () => {},
    send: async (_name, data) => void sent.push(data as DeadlineJob),
    work: async () => {},
    stop: async () => {},
  };
  const app = server.app as { boss?: JobQueue };
  const before = gh.calls.length;
  app.boss = queue;
  try {
    await projectTick(server.app, config);
  } finally {
    delete app.boss;
  }
  return gh.calls.length === before;
}
/** The jobs sent for `projectId` since the last call, taken off the list. */
function jobsOf(projectId: string): DeadlineJob[] {
  const mine = sent.filter((j) => j.projectId === projectId);
  for (const job of mine) sent.splice(sent.indexOf(job), 1);
  return mine;
}
async function runJobs(projectId: string): Promise<void> {
  for (const job of jobsOf(projectId)) await runDeadlineJob(server.app, config, job);
}
/** A completed run of `sha` on the repository, stored and selected as the pipeline does. */
async function scoredRun(repo: Repo, points: number, completedAt: Date, afterDeadline = false) {
  const id = randomUUID();
  await server.app.db.insert(projectGradeRuns).values({
    id,
    repoId: repo.id,
    workflowRunId: Math.floor(Math.random() * 1e9),
    headBranch: "main",
    headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    conclusion: "success",
    points,
    max: 6,
    parseStatus: "ok",
    afterDeadline,
    completedAt,
  });
  await refreshScoreSelection(server.app.db, { repo });
  return id;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, rulesetsFailing, lockHook, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  sent.length = 0;
  rulesetsDown = false;
  duringLock = null;
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the ticker

describe("the ticker (ADR-006, ADR-064)", () => {
  it("publishes a scheduled draft at its start through publishProject, never an incomplete group project", async () => {
    const scheduled = { publishMode: "scheduled", startAt: "2026-10-03T08:00:00Z", deadlineAt: DEADLINE };
    const plain = await project({ publish: false, body: scheduled });
    const grouped = await project({ publish: false, body: { ...scheduled, groupMode: true } });

    server.clock.set("2026-10-03T07:59:00Z");
    expect(await tick()).toBe(true);
    expect((await projectRow(plain.id)).state).toBe("draft");

    server.clock.set("2026-10-03T08:00:00Z");
    expect(await tick()).toBe(true);
    expect((await projectRow(plain.id)).state).toBe("published");
    expect(await auditOf(plain.id, "project.auto_publish")).toHaveLength(1);
    // A student in no group, no group at all: it stays a draft, silently.
    expect((await projectRow(grouped.id)).state).toBe("draft");
    expect(await auditOf(grouped.id, "project.auto_publish")).toHaveLength(0);
    await tick();
    expect(await auditOf(plain.id, "project.auto_publish")).toHaveLength(1);
  });

  it("applies a deadline once: the project locked, the provisional freeze, one job, and no HTTP inside a tick", async () => {
    const p = await project();
    const [repo] = p.repos;
    const current = await scoredRun(repo!, 4, at(DEADLINE, -MINUTE));

    server.clock.set(at(DEADLINE, -1000));
    expect(await tick()).toBe(true);
    expect(jobsOf(p.id)).toEqual([]);

    server.clock.set(at(DEADLINE, 1000));
    expect(await tick()).toBe(true);
    expect(await projectRow(p.id)).toMatchObject({ state: "locked", deadlineAppliedAt: at(DEADLINE, 1000) });
    expect(await repoRow(repo!.id)).toMatchObject({ deadlineAppliedAt: at(DEADLINE, 1000), frozenGradeRunId: current, frozenAt: null });
    expect(await auditOf(p.id, "project.deadline_applied")).toHaveLength(1);
    const [job] = jobsOf(p.id);
    expect(job).toEqual({ projectId: p.id, lease: at(DEADLINE, 1000).toISOString() });

    // A single claim: the lease is held, a second pass sends nothing.
    server.clock.advance(20_000);
    expect(await tick()).toBe(true);
    expect(jobsOf(p.id)).toEqual([]);

    await runDeadlineJob(server.app, config, job!);
    expect(lockRuleset(repo!.fullName!)).toBe(true);
    expect((await repoRow(repo!.id)).lockedAt).not.toBeNull();
    expect((await projectRow(p.id)).deadlineJobAt).toBeNull();
    const [enforced] = await auditOf(p.id, "project.deadline_enforced");
    expect(enforced!.payload).toEqual({ strategy: "lock", locked: 1, unlocked: 0, committed: 0, deleted: 0, failed: [] });

    // Settled: nothing left to claim.
    server.clock.advance(20_000);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
  });

  it("follows a deadline moved between the sweep and the job: the job finds nothing to lock", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    const [job] = jobsOf(p.id);
    // The reopen: its own request for the work finds the lease held.
    const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-12T22:00:00Z" });
    expect(moved.statusCode, moved.body).toBe(200);
    await runDeadlineJob(server.app, config, job!);
    expect(lockRuleset(p.repos[0]!.fullName!)).toBe(false);
    expect(await repoRow(p.repos[0]!.id)).toMatchObject({ lockedAt: null, deadlineAppliedAt: null });
    expect(await projectRow(p.id)).toMatchObject({ state: "published", deadlineJobAt: null });
  });

  it("claims the work of a crashed job again once its lease expired; the stale job then does nothing", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    const [crashed] = jobsOf(p.id);

    server.clock.advance(DEADLINE_LEASE_MS - MINUTE);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);

    server.clock.advance(2 * MINUTE);
    await tick();
    const [resumed] = jobsOf(p.id);
    expect(resumed!.lease).not.toBe(crashed!.lease);
    const calls = gh.calls.length;
    await runDeadlineJob(server.app, config, crashed!);
    expect(gh.calls.length).toBe(calls);
    await runDeadlineJob(server.app, config, resumed!);
    expect(lockRuleset(p.repos[0]!.fullName!)).toBe(true);
  });

  it("backdates the lease of a job GitHub failed, never archives on a 5xx, and locks some 30 s later", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    const [job] = jobsOf(p.id);
    rulesetsDown = true;
    await expect(runDeadlineJob(server.app, config, job!)).rejects.toThrow(/incomplete/);
    expect(world.archived.has(p.repos[0]!.fullName!)).toBe(false);
    expect((await repoRow(p.repos[0]!.id)).lockedAt).toBeNull();
    // Held still, but expiring 30 s on (N-PERF-07), not ten minutes.
    expect((await projectRow(p.id)).deadlineJobAt).toEqual(at(DEADLINE, 1000 - DEADLINE_LEASE_MS + FAILED_RETRY_MS));
    rulesetsDown = false;
    server.clock.advance(FAILED_RETRY_MS - 1000);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    server.clock.advance(2000);
    await tick();
    await runJobs(p.id);
    expect(lockRuleset(p.repos[0]!.fullName!)).toBe(true);
    expect((await projectRow(p.id)).deadlineJobAt).toBeNull();
  });

  it("renews the lease of a slow job: never overlapped while it works", async () => {
    const p = await project({ students: 2 });
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    const [job] = jobsOf(p.id);
    // One repository settles nine minutes on; while the other is still being
    // locked, eighteen minutes after the claim, the ticker looks again.
    server.clock.advance(9 * MINUTE);
    let overlapping: DeadlineJob[] | null = null;
    duringLock = async () => {
      await vi.waitFor(
        async () => expect((await projectRow(p.id)).deadlineJobAt).toEqual(at(DEADLINE, 1000 + 9 * MINUTE)),
        { timeout: 20_000 },
      );
      server.clock.advance(9 * MINUTE);
      await tick();
      overlapping = jobsOf(p.id);
    };
    await runDeadlineJob(server.app, config, job!);
    expect(overlapping).toEqual([]);
    for (const repo of p.repos) expect(lockRuleset(repo.fullName!)).toBe(true);
    expect((await projectRow(p.id)).deadlineJobAt).toBeNull();
  });

  it("stops a job whose lease another job took over", async () => {
    const p = await project({ students: 2 });
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    const [job] = jobsOf(p.id);
    duringLock = async () => {
      // The lease taken over meanwhile (this job outlived it).
      await server.app.db.update(projects).set({ deadlineJobAt: at(DEADLINE, 2000) }).where(eq(projects.id, p.id));
    };
    await runDeadlineJob(server.app, config, job!);
    // The lease left as the other job holds it; this one did not give it back.
    expect((await projectRow(p.id)).deadlineJobAt).toEqual(at(DEADLINE, 2000));
  });

  it("claims no GitHub work without a queue: no job ever runs in the ticker's process", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    const calls = gh.calls.length;
    await projectTick(server.app, config);
    expect(gh.calls.length).toBe(calls);
    expect(await projectRow(p.id)).toMatchObject({ state: "locked", deadlineJobAt: null });
    expect(lockRuleset(p.repos[0]!.fullName!)).toBe(false);
  });

  it("marks a repository GitHub no longer has deleted, for good", async () => {
    const p = await project();
    rmSync(join(world.dir, `${p.repos[0]!.fullName}.git`), { recursive: true, force: true });
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    expect((await repoRow(p.repos[0]!.id)).deletedAt).toEqual(at(DEADLINE, 1000));
    const [deleted] = await auditOf(p.repos[0]!.id, "project_repo.deleted");
    expect(deleted!.payload).toEqual({ via: "deadline" });
    expect((await projectRow(p.id)).deadlineJobAt).toBeNull();
    server.clock.advance(DEADLINE_LEASE_MS * 2);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the strategies

describe("the strategies (F-PROJ-09)", () => {
  it("archives where the repository was provisioned without rulesets, and a reopen un-archives it", async () => {
    const p = await project({ freePlan: true });
    const [repo] = p.repos;
    expect(repo!.rulesetId).toBeNull();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    expect(world.archived.has(repo!.fullName!)).toBe(true);
    expect(await repoRow(repo!.id)).toMatchObject({ lockedAt: at(DEADLINE, 1000), archivedAt: at(DEADLINE, 1000) });
    expect(await auditOf(repo!.id, "project_repo.archived")).toHaveLength(1);

    // F-PROJ-09: the locks lifted — the archive undone.
    const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-12T22:00:00Z" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(world.archived.has(repo!.fullName!)).toBe(false);
    expect(await repoRow(repo!.id)).toMatchObject({ lockedAt: null, archivedAt: null });
  });

  it("archives when GitHub refuses the ruleset for the plan", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    world.freePlan = true;
    try {
      await runJobs(p.id);
    } finally {
      world.freePlan = false;
    }
    expect(world.archived.has(p.repos[0]!.fullName!)).toBe(true);
  });

  it("commit: one empty commit of the App per branch, recorded before the ref moves, never twice", async () => {
    const p = await project({ body: { deadlineStrategy: "commit", branches: ["main", "dev"] } });
    const [repo] = p.repos;
    const before = { main: world.git(repo!.fullName!, "rev-parse", "main").trim(), dev: world.git(repo!.fullName!, "rev-parse", "dev").trim() };
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    const heads = { main: world.git(repo!.fullName!, "rev-parse", "main").trim(), dev: world.git(repo!.fullName!, "rev-parse", "dev").trim() };
    for (const branch of ["main", "dev"] as const) {
      expect(heads[branch]).not.toBe(before[branch]);
      expect(world.git(repo!.fullName!, "rev-parse", `${branch}^`).trim()).toBe(before[branch]);
      expect(world.git(repo!.fullName!, "log", "-1", "--format=%s", branch).trim()).toBe(
        "chore(deadline): deadline reached — Lab (2026-10-10T00:00:00+02:00)",
      );
    }
    const marks = await server.app.db.select().from(botCommits).where(and(eq(botCommits.repoId, repo!.id), eq(botCommits.kind, "deadline")));
    expect(marks.map((m) => m.sha).sort()).toEqual([heads.main, heads.dev].sort());
    expect(await repoRow(repo!.id)).toMatchObject({ lockedAt: null, deadlineCommittedAt: at(DEADLINE, 1000) });

    // A crash before the mark: the pass again finds the heads already the deadline's.
    await server.app.db.update(projectRepos).set({ deadlineCommittedAt: null }).where(eq(projectRepos.id, repo!.id));
    server.clock.advance(MINUTE);
    await tick();
    await runJobs(p.id);
    expect(world.git(repo!.fullName!, "rev-parse", "main").trim()).toBe(heads.main);
    expect(world.git(repo!.fullName!, "rev-parse", "dev").trim()).toBe(heads.dev);
  });
});

// ---------------------------------------------------------------- the freeze

describe("the freeze (F-PROJ-11, ADR-012)", () => {
  it("is provisional at the deadline, refreshed during the grace, definitive at deadline + grace", async () => {
    const p = await project();
    const [repo] = p.repos;
    const first = await scoredRun(repo!, 3, at(DEADLINE, -MINUTE));
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    expect((await repoRow(repo!.id)).frozenGradeRunId).toBe(first);

    // A run on a commit received in time, finished in the grace: it counts.
    const better = await scoredRun(repo!, 5, at(DEADLINE, 10 * MINUTE));
    expect((await repoRow(repo!.id)).frozenGradeRunId).toBe(better);

    server.clock.set(at(DEADLINE, 30 * MINUTE - 1000));
    await tick();
    expect((await repoRow(repo!.id)).frozenAt).toBeNull();
    server.clock.set(at(DEADLINE, 30 * MINUTE));
    await tick();
    expect((await repoRow(repo!.id)).frozenAt).toEqual(at(DEADLINE, 30 * MINUTE));
    expect((await auditOf(repo!.id, "project_repo.deadline_applied"))[0]!.payload).toEqual({ projectId: p.id, deadlineAt: DEADLINE });
    expect((await auditOf(repo!.id, "project_repo.frozen"))[0]!.payload).toEqual({ projectId: p.id, deadlineAt: DEADLINE });
    await tick();
    expect(await auditOf(repo!.id, "project_repo.frozen")).toHaveLength(1);

    // Definitive: a later run is the current score's at most.
    const later = await scoredRun(repo!, 6, at(DEADLINE, 40 * MINUTE));
    expect(await repoRow(repo!.id)).toMatchObject({ frozenGradeRunId: better, currentGradeRunId: later });
  });
});

// ---------------------------------------------------------------- a repository's own deadline

describe("a repository's own deadline (D13 amended)", () => {
  const OWN = "2026-10-11T22:00:00.000Z";
  const setOwn = (p: { id: string }, repo: Repo, deadlineAt: string | null, headers = teacher.headers) =>
    call("PUT", `/app/api/projects/${p.id}/repos/${repo.id}/deadline`, headers, { deadlineAt });

  it("keeps that repository open, its receipts on time, and freezes it at its own deadline + grace", async () => {
    const p = await project({ students: 2 });
    const [a, b] = p.repos;
    // Its staff only; a date ahead.
    const outsider = await server.signIn("teacher");
    expect((await setOwn(p, b!, OWN, outsider.headers)).statusCode).toBe(404);
    const past = await setOwn(p, b!, NOW);
    expect([past.statusCode, past.json().error]).toEqual([422, "deadline_past"]);
    const set = await setOwn(p, b!, OWN);
    expect(set.statusCode, set.body).toBe(200);
    expect(ProjectRepoDeadlineState.parse(set.json())).toMatchObject({ deadlineAt: OWN, effectiveDeadlineAt: OWN, locked: false });

    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    expect((await projectRow(p.id)).state).toBe("locked");
    expect(lockRuleset(a!.fullName!)).toBe(true);
    expect(lockRuleset(b!.fullName!)).toBe(false);
    expect(await repoRow(b!.id)).toMatchObject({ deadlineAppliedAt: null, lockedAt: null });

    // A push received after the project's deadline, before its own: on time.
    const sha = "c".repeat(40);
    await server.app.db.insert(pushReceipts).values({
      id: randomUUID(),
      githubRepoId: b!.githubRepoId!,
      branch: "main",
      headSha: sha,
      receivedAt: at(DEADLINE, 60 * MINUTE),
    });
    server.clock.set(at(DEADLINE, 61 * MINUTE));
    const octokit = { request: async () => ({ data: { workflow_runs: [] } }) } as unknown as Octokit;
    const runId = await ingestCompletedRun(server.app, octokit, (await repoContext(server.app.db, b!.githubRepoId!))!, {
      workflowRunId: 1,
      runAttempt: 1,
      headBranch: "main",
      headSha: sha,
      conclusion: "success",
      path: ".github/workflows/build.yml",
      event: "push",
      checkSuiteId: null,
      completedAt: at(DEADLINE, 61 * MINUTE),
    });
    const [run] = await server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.id, runId!));
    expect(run!.afterDeadline).toBe(false);

    // Its own deadline, its own freeze.
    server.clock.set(at(OWN, 1000));
    await tick();
    await runJobs(p.id);
    expect(lockRuleset(b!.fullName!)).toBe(true);
    expect((await repoRow(b!.id)).deadlineAppliedAt).toEqual(at(OWN, 1000));
    server.clock.set(at(OWN, 30 * MINUTE));
    await tick();
    expect((await repoRow(b!.id)).frozenAt).toEqual(at(OWN, 30 * MINUTE));
  });

  it("moved later on a locked repository, reopens and unlocks that one alone", async () => {
    const p = await project({ students: 2 });
    const [a, b] = p.repos;
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    server.clock.set(at(DEADLINE, 31 * MINUTE));
    await tick();
    expect((await repoRow(b!.id)).frozenAt).not.toBeNull();

    const set = await setOwn(p, b!, OWN);
    expect(set.statusCode, set.body).toBe(200);
    expect(ProjectRepoDeadlineState.parse(set.json())).toMatchObject({ locked: false, deadlineAppliedAt: null, frozenAt: null });
    expect(lockRuleset(b!.fullName!)).toBe(false);
    expect(lockRuleset(a!.fullName!)).toBe(true);
    expect((await projectRow(p.id)).state).toBe("locked");
    const [entry] = await auditOf(b!.id, "project_repo.deadline_set");
    expect(entry!.payload).toMatchObject({ deadlineAt: OWN, previous: null, reopened: true });
  });
});

// ---------------------------------------------------------------- the reopen and the staff's hand

describe("the reopen (F-PROJ-09)", () => {
  it("undoes the freeze, requalifies the runs, keeps the teacher's score and the release, lifts the locks", async () => {
    const p = await project();
    const [repo] = p.repos;
    const inTime = await scoredRun(repo!, 3, at(DEADLINE, -MINUTE));
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    const late = await scoredRun(repo!, 6, at(DEADLINE, 5 * MINUTE), true);
    server.clock.set(at(DEADLINE, 31 * MINUTE));
    await tick();
    await server.app.db
      .update(projectRepos)
      .set({ teacherPoints: 5, releasedPoints: 3, releasedMax: 6 })
      .where(eq(projectRepos.id, repo!.id));
    expect(await repoRow(repo!.id)).toMatchObject({ currentGradeRunId: inTime, frozenGradeRunId: inTime });

    server.clock.set("2026-10-10T08:00:00Z");
    const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-12T22:00:00Z" });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await projectRow(p.id)).toMatchObject({ state: "published", deadlineAppliedAt: null, reviewDispatchedAt: null });
    // The late run was received before the new deadline: it is the score now.
    const [lateRun] = await server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.id, late));
    expect(lateRun!.afterDeadline).toBe(false);
    expect(await repoRow(repo!.id)).toMatchObject({
      currentGradeRunId: late,
      frozenGradeRunId: null,
      frozenAt: null,
      deadlineAppliedAt: null,
      lockedAt: null,
      teacherPoints: 5,
      releasedPoints: 3,
    });
    expect(lockRuleset(repo!.fullName!)).toBe(false);
    const [entry] = await auditOf(p.id, "project.deadline_reopened");
    expect(entry!.payload).toMatchObject({ deadlineAt: "2026-10-12T22:00:00.000Z", previous: DEADLINE, repos: 1 });
  });

  it("wins in the middle of a job: a lock GitHub made meanwhile is lifted", async () => {
    const p = await project();
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    duringLock = async () => {
      const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-12T22:00:00Z" });
      expect(moved.statusCode, moved.body).toBe(200);
    };
    await runJobs(p.id);
    expect(duringLock).toBeNull();
    expect(lockRuleset(p.repos[0]!.fullName!)).toBe(false);
    expect(await repoRow(p.repos[0]!.id)).toMatchObject({ lockedAt: null, deadlineAppliedAt: null });
    expect((await projectRow(p.id)).deadlineJobAt).toBeNull();
  });

  it("never locks again a repository its staff unlocked, until its deadline moves", async () => {
    const p = await project();
    const [repo] = p.repos;
    const lock = (action: "lock" | "unlock") => call("POST", `/app/api/projects/${p.id}/repos/${repo!.id}/${action}`, teacher.headers);

    // Before the deadline: locked by hand, unlocked by hand — the deadline still locks it.
    expect(ProjectRepoDeadlineState.parse((await lock("lock")).json())).toMatchObject({ locked: true, staffLock: true });
    expect(ProjectRepoDeadlineState.parse((await lock("unlock")).json())).toMatchObject({ locked: false, staffLock: null });
    server.clock.set(at(DEADLINE, 1000));
    await tick();
    await runJobs(p.id);
    expect(lockRuleset(repo!.fullName!)).toBe(true);

    // After it: "one more push" — an exemption no pass overrides.
    expect(ProjectRepoDeadlineState.parse((await lock("unlock")).json())).toMatchObject({ locked: false, staffLock: false });
    expect(lockRuleset(repo!.fullName!)).toBe(false);
    expect(await auditOf(repo!.id, "project_repo.unlock")).toHaveLength(2);
    server.clock.advance(DEADLINE_LEASE_MS * 2);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    expect(lockRuleset(repo!.fullName!)).toBe(false);

    // Its deadline moved: the exemption is gone, the new deadline locks it.
    const OWN = "2026-10-12T22:00:00.000Z";
    expect((await call("PUT", `/app/api/projects/${p.id}/repos/${repo!.id}/deadline`, teacher.headers, { deadlineAt: OWN })).statusCode).toBe(200);
    expect((await repoRow(repo!.id)).staffLock).toBeNull();
    server.clock.set(at(OWN, 1000));
    await tick();
    await runJobs(p.id);
    expect(lockRuleset(repo!.fullName!)).toBe(true);
  });

  it("refuses the hand on a repository GitHub no longer has", async () => {
    const p = await project();
    await server.app.db.update(projectRepos).set({ deletedAt: new Date(NOW) }).where(eq(projectRepos.id, p.repos[0]!.id));
    const res = await call("POST", `/app/api/projects/${p.id}/repos/${p.repos[0]!.id}/lock`, teacher.headers);
    expect([res.statusCode, res.json().error]).toEqual([409, "repo_unavailable"]);
    // Another project's repository is as missing as none.
    const other = await project({ publish: false });
    expect((await call("POST", `/app/api/projects/${other.id}/repos/${p.repos[0]!.id}/lock`, teacher.headers)).statusCode).toBe(404);
    // An archived project takes no new work (#476).
    const archived = await project();
    await server.app.db.update(projects).set({ archivedAt: new Date(NOW) }).where(eq(projects.id, archived.id));
    const refused = await call("PUT", `/app/api/projects/${archived.id}/repos/${archived.repos[0]!.id}/deadline`, teacher.headers, {
      deadlineAt: "2026-10-12T22:00:00Z",
    });
    expect([refused.statusCode, refused.json().error]).toEqual([409, "repo_unavailable"]);
  });

  it("answers a Bearer token and an impersonation as nobody (invariant 6)", async () => {
    const p = await project();
    const repo = p.repos[0]!;
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "t", expiresInDays: null });
    const s = await createSession(server.app.db, teacher.id, 8, { kind: "impersonation", actorUserId: (await server.signIn("admin")).id, evaluationId: null });
    const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    const routes = [
      ["PUT", `/app/api/projects/${p.id}/repos/${repo.id}/deadline`, { deadlineAt: "2026-10-12T22:00:00Z" }],
      ["POST", `/app/api/projects/${p.id}/repos/${repo.id}/lock`, undefined],
    ] as const;
    for (const [method, url, body] of routes) {
      const bearer = await call(method, url, { authorization: `Bearer ${token}` }, body);
      expect([bearer.statusCode, bearer.json().error], `Bearer ${url}`).toEqual([404, "not_found"]);
      // Read-only outside development (ADR-034 §4) ...
      const refused = await call(method, url, impersonation, body);
      expect([refused.statusCode, refused.json().error], `impersonation ${url}`).toEqual([403, "impersonation_read_only"]);
    }
    // ... and the loader's 404 where an impersonation may write.
    const sent: unknown[] = [];
    const reply = { code: (status: number) => ({ send: (body: unknown) => sent.push([status, body]) }) } as unknown as FastifyReply;
    const req = { auth: { kind: "impersonation", actorUserId: teacher.id }, caller: { id: teacher.id, role: "teacher", reach: "seats" } };
    expect(await accessibleProjectRepo(server.app, req as unknown as FastifyRequest, reply, { id: p.id, rid: repo.id })).toBeNull();
    expect(sent).toEqual([[404, { error: "not_found" }]]);
    expect(await repoRow(repo.id)).toMatchObject({ deadlineAt: null, staffLock: null });
  });
});

describe("the J−n checkpoints (F-PROJ-11)", () => {
  it("follow a moved deadline in calendar days, across the change of the clocks", async () => {
    const p = await project();
    const id = randomUUID();
    await server.app.db
      .insert(projectCheckpoints)
      .values({ id, projectId: p.id, name: "mid", dueAt: at(DEADLINE, -3 * 86_400_000), offsetDays: -3 });
    const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-27T22:59:00Z" });
    expect(moved.statusCode, moved.body).toBe(200);
    const [checkpoint] = await server.app.db.select().from(projectCheckpoints).where(eq(projectCheckpoints.id, id));
    // 23:59 on the 24th, summer time: 73 hours before 23:59 on the 27th, winter time.
    expect(checkpoint!.dueAt).toEqual(new Date("2026-10-24T21:59:00Z"));
  });
});
