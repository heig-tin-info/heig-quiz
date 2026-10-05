/**
 * The reconciliations of projects (merge task M3-06a, ADR-011 and its
 * addendum of 2026-10-05) on a server built with Quiz's App, against the
 * fake GitHub (`github/testing.ts`) and the local bare repositories
 * (`./testing.ts`), the clock moved by hand:
 *
 * - `reconcile.grades`: the completed runs of a quiet repository through
 *   the webhook's own ingestion — once, whichever path saw the run first;
 *   a repository active within 30 minutes left alone; the scope — 24 hours
 *   after the freeze unless a final review is pending —; a 404 from the
 *   run listing is no deletion; a rate limit stops the pass at once;
 * - `reconcile.repos`: a pending invitation re-invited once a day, by the
 *   claim on the row, never once frozen, found accepted meanwhile; the
 *   head moved for a person's commit only, with no receipt written; a
 *   rename followed, a 404 by id terminal;
 * - the audit of a pass, and both tasks in the catalog.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSummary } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  botCommits,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectGradeRuns,
  projectRepoAccess,
  projectRepos,
  projects,
  pushReceipts,
  webhookDeliveries,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, signedDelivery, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { SCHEDULED_TASKS } from "../system/catalog.js";
import { reconcileGrades, reconcileRepos } from "./reconcile.js";
import { repoWorld } from "./testing.js";

const SECRET = "w".repeat(40);
const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: SECRET,
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-05T08:00:00.000Z";
const DEADLINE = "2026-10-12T22:00:00.000Z";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const CI = ".github/workflows/ci.yml";
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 42_000;
let nextAccount = 45_000;
let nextRun = 9_000;

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** A completed run as GitHub lists it. */
interface ListedRun {
  id: number;
  head_sha: string;
  conclusion?: string;
  path?: string;
  event?: string;
  updated_at?: string;
  triggering_actor?: { login: string };
}
/** The completed runs GitHub lists for a repository, by full name. */
const listed = new Map<string, ListedRun[]>();
/** How the run listing of a repository fails: GitHub's 404, or its rate limit. */
const runsFailing = new Map<string, "404" | "rate_limit">();
const rateLimit = () =>
  new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    },
  });
const runsRoute: Route = (url, req) => {
  const m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const fullName = m[1]!;
  const failing = runsFailing.get(fullName);
  if (failing === "rate_limit") return rateLimit();
  if (failing === "404") return json({ message: "Not Found" }, 404);
  const headSha = url.searchParams.get("head_sha");
  const runs = (listed.get(fullName) ?? []).filter((r) => headSha === null || r.head_sha === headSha);
  return json({
    total_count: runs.length,
    workflow_runs: runs.map((r) => ({
      run_attempt: 1,
      head_branch: "main",
      conclusion: "success",
      path: CI,
      event: "push",
      check_suite_id: 1,
      status: "completed",
      updated_at: at(NOW, -HOUR).toISOString(),
      run_started_at: at(NOW, -HOUR - MINUTE).toISOString(),
      triggering_actor: { login: "somebody" },
      ...r,
    })),
  });
};

/** Who GitHub says authored and committed a commit, by sha: a login, or null for an account it cannot name. */
const authors = new Map<string, string | null>();
/** A repository's name on GitHub when it differs from the bare repository's (a rename). */
const aliases = new Map<string, string>();
/** Repositories whose head read fails with GitHub's 404 (not the read by id). */
const headMissing = new Set<string>();
const commitsRoute: Route = (url, req) => {
  const m = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const fullName = aliases.get(m[1]!) ?? m[1]!;
  if (headMissing.has(fullName)) return json({ message: "Not Found" }, 404);
  const sha = world.git(fullName, "rev-parse", url.searchParams.get("sha") ?? "main").trim();
  const login = authors.get(sha);
  const account = login === undefined || login === null ? null : { login, type: login.endsWith("[bot]") ? "Bot" : "User" };
  return json([
    {
      sha,
      commit: { author: { date: "2026-10-04T12:00:00Z" }, committer: { date: "2026-10-04T12:00:00Z" } },
      author: account,
      // A commit GitHub attributes only half: its author named, its committer's e-mail nobody's.
      committer: halfAttributed.has(sha) ? null : account,
    },
  ]);
};
/** Commits whose committer GitHub cannot name, while it names the author. */
const halfAttributed = new Set<string>();

/** GitHub's answer to "is this login a collaborator?": 204, or 404 for a stranger or a pending invitee. */
const collaboratorRoute: Route = (url, req) => {
  const m = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const [fullName, login] = [m[1]!, m[2]!];
  const pending = [...(world.invitations.get(fullName)?.values() ?? [])].includes(login);
  return !pending && world.collaborators.get(fullName)?.has(login) ? new Response(null, { status: 204 }) : json({ message: "Not Found" }, 404);
};

/** What GitHub answers for a repository by id, when the test overrides the world: a new name, or gone. */
const byId = new Map<number, { full_name: string } | "gone">();
const byIdRoute: Route = (url, req) => {
  const m = /^\/repositories\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const over = byId.get(Number(m[1]));
  if (over === undefined) return undefined;
  if (over === "gone") return json({ message: "Not Found" }, 404);
  return json({ id: Number(m[1]), full_name: over.full_name, default_branch: "main" });
};

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `rc${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login, githubUserId };
}

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

type Repo = typeof projectRepos.$inferSelect;

/** A published project of a connected classroom, and the accepted repositories of `students` students (invitations pending). */
async function project(opts: { students?: number } = {}) {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const login = `rcorg-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Lab",
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  for (const s of students) {
    const accepted = await call("POST", `/app/api/student/projects/${summary.id}/accept`, s.headers);
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  // In the order a pass reads them (by row id), the students paired with their repository.
  const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, summary.id)).orderBy(projectRepos.id);
  gh.calls.length = 0; // the provisioning's own requests are not the pass's
  return { id: summary.id, courseId: seeded.courseId, org: login, repos, students: repos.map((r) => students.find((s) => s.id === r.userId)!) };
}

const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const runsOf = (repo: Repo) => server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.repoId, repo.id));
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action))).orderBy(asc(auditLog.id));
/** The latest audit entry of a task's passes (one subject for the whole file). */
const lastPass = async (task: string) => (await auditOf(task, "project.reconciled")).at(-1)?.payload;
const head = (repo: Repo, branch = "main") => world.git(repo.fullName!, "rev-parse", branch).trim();
/** A completed run of `CI` on `sha`, listed by GitHub for the repository. */
function list(repo: Repo, sha: string, over: Partial<ListedRun> = {}): ListedRun {
  const run = { id: nextRun++, head_sha: sha, ...over };
  listed.set(repo.fullName!, [...(listed.get(repo.fullName!) ?? []), run]);
  return run;
}
/** The requests GitHub saw matching `pattern` since the calls were last reset. */
const callsTo = (pattern: RegExp) => gh.calls.filter((c) => pattern.test(c));

async function freeze(repo: Repo, frozenAt: Date) {
  await server.app.db
    .update(projectRepos)
    .set({ deadlineAppliedAt: frozenAt, frozenAt })
    .where(eq(projectRepos.id, repo.id));
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, byIdRoute, runsRoute, commitsRoute, collaboratorRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(async () => {
  // The projects of the earlier tests leave the scope: a pass reads this test's repositories only.
  await server.app.db.update(projects).set({ archivedAt: new Date() }).where(isNull(projects.archivedAt));
  server.clock.set(NOW);
  gh.calls.length = 0;
  listed.clear();
  runsFailing.clear();
  authors.clear();
  aliases.clear();
  headMissing.clear();
  halfAttributed.clear();
  byId.clear();
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("the catalog", () => {
  it("runs the grades every 15 minutes and the repositories daily, as scheduled tasks (D10)", () => {
    const periods = Object.fromEntries(SCHEDULED_TASKS.map((t) => [t.key, t.defaultIntervalMinutes]));
    expect(periods["reconcile.grades"]).toBe(15);
    expect(periods["reconcile.repos"]).toBe(24 * 60);
  });
});

// ---------------------------------------------------------------- reconcile.grades

describe("reconcile.grades", () => {
  it("ingests the completed runs of a quiet repository through the one path, once, and audits the pass", async () => {
    const { repos } = await project();
    const [repo] = repos;
    const sha = head(repo!);
    const first = list(repo!, sha);
    const second = list(repo!, sha, { conclusion: "failure" });

    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 2 runs ingested");
    const runs = await runsOf(repo!);
    expect(runs.map((r) => r.workflowRunId).sort()).toEqual([first.id, second.id].sort());
    expect(runs.every((r) => r.parseStatus === "fallback" && r.kind === "ci" && !r.afterDeadline)).toBe(true);
    // Reconciled runs have no receipt: on time while the deadline lies ahead (GR-14.3).
    const row = await repoRow(repo!.id);
    expect(row.currentGradeRunId).not.toBeNull();
    expect(row.ciStatus).toBe("fail");
    expect(await lastPass("reconcile.grades")).toMatchObject({ repos: 1, runsIngested: 2, deleted: 0, renamed: 0, stoppedOnRateLimit: false });
    const passes = (await auditOf("reconcile.grades", "project.reconciled")).length;

    // Again: nothing new to read, nothing written, no audit for a pass that changed nothing.
    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 0 runs ingested");
    expect(await runsOf(repo!)).toHaveLength(2);
    expect(await auditOf("reconcile.grades", "project.reconciled")).toHaveLength(passes);
  });

  it("writes one row for a run the webhook already delivered: the two paths build the same event (ADR-011)", async () => {
    const { repos } = await project();
    const [repo] = repos;
    const sha = head(repo!);
    const run = list(repo!, sha, { triggering_actor: { login: "kid" } });
    const id = randomUUID();
    const res = await signedDelivery(
      server.app,
      SECRET,
      {
        action: "completed",
        repository: { id: repo!.githubRepoId },
        workflow_run: {
          id: run.id,
          run_attempt: 1,
          head_branch: "main",
          head_sha: sha,
          conclusion: "success",
          path: CI,
          event: "push",
          check_suite_id: 1,
          updated_at: at(NOW, -HOUR).toISOString(),
          triggering_actor: { login: "kid" },
        },
      },
      { event: "workflow_run", id },
    );
    expect(res.statusCode).toBe(200);
    await vi.waitFor(async () => {
      const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
      expect(row?.processedAt).not.toBeNull();
    });
    expect(await runsOf(repo!)).toHaveLength(1);

    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 0 runs ingested");
    expect(await runsOf(repo!)).toHaveLength(1);
  });

  it("leaves a repository alone while something happened to it within 30 minutes", async () => {
    const { repos } = await project();
    const [repo] = repos;
    list(repo!, head(repo!));
    await server.app.db.insert(pushReceipts).values({
      id: randomUUID(),
      githubRepoId: repo!.githubRepoId!,
      branch: "main",
      headSha: head(repo!),
      receivedAt: at(NOW, -10 * MINUTE),
      isBot: false,
      forced: false,
    });
    expect(await reconcileGrades(server.app, config)).toBe("0 quiet repositories checked, 0 runs ingested");
    expect(await runsOf(repo!)).toHaveLength(0);

    server.clock.set(at(NOW, 21 * MINUTE).toISOString());
    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 1 runs ingested");
  });

  it("drops a repository a day after its definitive freeze, unless its final review was asked and not answered", async () => {
    const { repos } = await project({ students: 3 });
    const [recent, old, pending] = repos;
    for (const repo of repos) list(repo!, head(repo!));
    await freeze(recent!, at(NOW, -23 * HOUR));
    await freeze(old!, at(NOW, -25 * HOUR));
    await freeze(pending!, at(NOW, -25 * HOUR));
    await server.app.db.insert(gradeDispatches).values({ id: randomUUID(), repoId: pending!.id, trigger: "deadline", sha: head(pending!) });

    expect(await reconcileGrades(server.app, config)).toBe("2 quiet repositories checked, 2 runs ingested");
    expect(await runsOf(recent!)).toHaveLength(1);
    expect(await runsOf(old!)).toHaveLength(0);
    expect(await runsOf(pending!)).toHaveLength(1);

    // The review answered: the day is the bound again.
    await server.app.db.update(projectRepos).set({ reviewGradeRunId: randomUUID() }).where(eq(projectRepos.id, pending!.id));
    list(pending!, head(pending!));
    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 0 runs ingested");
    expect(await runsOf(pending!)).toHaveLength(1);
  });

  it("skips an archived project's repositories and a deleted one; a 404 from the run listing deletes nothing", async () => {
    const { id, repos } = await project({ students: 2 });
    const [gone, kept] = repos;
    for (const repo of repos) list(repo!, head(repo!));
    await server.app.db.update(projectRepos).set({ deletedAt: at(NOW) }).where(eq(projectRepos.id, gone!.id));
    runsFailing.set(kept!.fullName!, "404");

    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 0 runs ingested");
    expect((await repoRow(kept!.id)).deletedAt).toBeNull();
    expect(await auditOf(kept!.id, "project_repo.deleted")).toHaveLength(0);

    await server.app.db.update(projects).set({ archivedAt: at(NOW) }).where(eq(projects.id, id));
    expect(await reconcileGrades(server.app, config)).toBe("0 quiet repositories checked, 0 runs ingested");
  });

  it("stops at once on GitHub's rate limit, keeps what it did, and says so", async () => {
    const { repos } = await project({ students: 2 });
    const [first, second] = repos;
    for (const repo of repos) {
      list(repo!, head(repo!));
      runsFailing.set(repo!.fullName!, "rate_limit");
    }
    runsFailing.delete(first!.fullName!);

    const started = Date.now();
    expect(await reconcileGrades(server.app, config)).toBe("2 quiet repositories checked, 1 runs ingested, stopped on GitHub's rate limit");
    // Octokit would otherwise wait for the reset, an hour away.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await runsOf(first!)).toHaveLength(1);
    expect(await runsOf(second!)).toHaveLength(0);
    expect(callsTo(/actions\/runs$/)).toHaveLength(3); // the first repository's listing and CI state, the second's refusal
    expect(await lastPass("reconcile.grades")).toMatchObject({ repos: 2, runsIngested: 1, stoppedOnRateLimit: true });

    // The next period resumes: the second repository's runs, and nothing twice.
    runsFailing.clear();
    expect(await reconcileGrades(server.app, config)).toBe("2 quiet repositories checked, 1 runs ingested");
    expect(await runsOf(second!)).toHaveLength(1);
  });

  it("does nothing without Quiz's App", async () => {
    const off = loadConfig({ NODE_ENV: "test" });
    expect(await reconcileGrades(server.app, off)).toBe("GitHub App not configured");
    expect(await reconcileRepos(server.app, off)).toBe("GitHub App not configured");
  });
});

// ---------------------------------------------------------------- reconcile.repos

describe("reconcile.repos: the invitations", () => {
  const invites = () => callsTo(/^PUT .*\/collaborators\//);
  /** The student's invitation expired on GitHub: neither a collaborator nor invited any more. */
  function expired(repo: Repo, login: string) {
    world.collaborators.get(repo.fullName!)?.delete(login);
    for (const [id, invitee] of world.invitations.get(repo.fullName!) ?? []) if (invitee === login) world.invitations.get(repo.fullName!)!.delete(id);
  }

  it("re-invites a pending student once a day, the day claimed on the row before GitHub is called", async () => {
    const { repos, students } = await project();
    const [repo] = repos;
    expect(repo!.invitationStatus).toBe("pending");
    expired(repo!, students[0]!.login);

    expect(await reconcileRepos(server.app, config)).toBe("1 repositories checked, 1 re-invited, 0 invitations accepted, 0 heads moved, 0 renamed, 0 deleted");
    expect(invites()).toHaveLength(1);
    let row = await repoRow(repo!.id);
    expect(row.invitationReinvitedAt?.toISOString()).toBe(NOW);
    expect(row.invitationStatus).toBe("pending");
    expect(row.invitationResentAt).toBeNull(); // the staff's resend is another matter (M3-08b)
    expect(world.collaborators.get(repo!.fullName!)?.get(students[0]!.login)).toBe("push");
    const [entry] = await auditOf(repo!.id, "project_group.repo_invite");
    expect(entry?.payload).toMatchObject({ via: "reconcile", invitation: "pending", login: students[0]!.login });

    // The same day: no second invitation, the collaborators looked at instead.
    gh.calls.length = 0;
    expired(repo!, students[0]!.login);
    server.clock.set(at(NOW, 23 * HOUR).toISOString());
    expect(await reconcileRepos(server.app, config)).toContain("0 re-invited");
    expect(invites()).toHaveLength(0);
    expect(callsTo(/^GET .*\/collaborators\//)).toHaveLength(1);
    row = await repoRow(repo!.id);
    expect(row.invitationReinvitedAt?.toISOString()).toBe(NOW);

    // A day on: invited again.
    server.clock.set(at(NOW, DAY).toISOString());
    expect(await reconcileRepos(server.app, config)).toContain("1 re-invited");
    expect(invites()).toHaveLength(1);
    expect((await repoRow(repo!.id)).invitationReinvitedAt?.toISOString()).toBe(at(NOW, DAY).toISOString());
  });

  it("finds an invitation accepted meanwhile (GitHub sends no event for it) and marks the row", async () => {
    const { repos, students } = await project();
    const [repo] = repos;
    await server.app.db.update(projectRepos).set({ invitationReinvitedAt: at(NOW, -HOUR) }).where(eq(projectRepos.id, repo!.id));
    // Accepted on GitHub: the invitation gone, the seat kept.
    for (const [id, invitee] of world.invitations.get(repo!.fullName!) ?? []) if (invitee === students[0]!.login) world.invitations.get(repo!.fullName!)!.delete(id);

    expect(await reconcileRepos(server.app, config)).toContain("1 invitations accepted");
    expect((await repoRow(repo!.id)).invitationStatus).toBe("accepted");
    expect(invites()).toHaveLength(0);

    // Nothing pending any more: no call about it.
    gh.calls.length = 0;
    await reconcileRepos(server.app, config);
    expect(callsTo(/collaborators/)).toHaveLength(0);
  });

  it("leaves an access a revocation is taking away alone: neither re-invited nor found accepted", async () => {
    const { repos, students } = await project();
    const [repo] = repos;
    expired(repo!, students[0]!.login);
    // The revocation asked GitHub, no answer yet (M3-15b-2).
    await server.app.db.update(projectRepoAccess).set({ revokingAt: at(NOW, -MINUTE) }).where(eq(projectRepoAccess.repoId, repo!.id));

    expect(await reconcileRepos(server.app, config)).toContain("0 re-invited, 0 invitations accepted");
    expect(invites()).toHaveLength(0);
    expect(callsTo(/^GET .*\/collaborators\//)).toHaveLength(0);
    const row = await repoRow(repo!.id);
    expect(row.invitationReinvitedAt).toBeNull();
    expect(row.invitationStatus).toBe("pending");
  });

  it("stops re-inviting once the repository is frozen, and re-invites nobody without a linked account", async () => {
    const { repos, students } = await project({ students: 2 });
    const [frozen, unlinked] = repos;
    expired(frozen!, students[0]!.login);
    await freeze(frozen!, at(NOW, -HOUR));
    expired(unlinked!, students[1]!.login);
    await server.app.db.delete(githubAccounts).where(eq(githubAccounts.userId, students[1]!.id));

    expect(await reconcileRepos(server.app, config)).toContain("0 re-invited");
    expect(invites()).toHaveLength(0);
    expect((await repoRow(frozen!.id)).invitationReinvitedAt).toBeNull();
    // The day was claimed all the same: the student relinks and asks for their own resend.
    expect((await repoRow(unlinked!.id)).invitationReinvitedAt?.toISOString()).toBe(NOW);
  });
});

describe("reconcile.repos: the head", () => {
  const receipts = (repo: Repo) => server.app.db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, repo.githubRepoId!));

  it("moves the last commit to a person's head, with its CI state, and writes no receipt", async () => {
    const { repos, students } = await project();
    const [repo] = repos;
    expect(repo!.lastCommitSha).toBeNull();
    const sha = world.commit(repo!.fullName!, "main", { "src/main.c": "int main(){return 1;}" });
    authors.set(sha, students[0]!.login);
    list(repo!, sha, { conclusion: "success" });

    expect(await reconcileRepos(server.app, config)).toContain("1 heads moved");
    const row = await repoRow(repo!.id);
    expect(row.lastCommitSha).toBe(sha);
    expect(row.lastCommitAt?.toISOString()).toBe("2026-10-04T12:00:00.000Z");
    expect(row.ciStatus).toBe("pass");
    expect(await receipts(repo!)).toHaveLength(0);
    expect(await lastPass("reconcile.repos")).toMatchObject({ repos: 1, heads: 1 });

    // Known already: nothing to move.
    expect(await reconcileRepos(server.app, config)).toContain("0 heads moved");
  });

  it("never moves it to a bot's head, nor to one GitHub attributes to nobody or only half: no pusher means no head move", async () => {
    const { repos, students } = await project({ students: 4 });
    const [workflow, restored, nobody, half] = repos;
    authors.set(world.commit(workflow!.fullName!, "main", { "notes.txt": "graded" }), "github-actions[bot]");
    const restore = world.commit(restored!.fullName!, "main", { "src/main.c": "int main(){}" });
    authors.set(restore, students[1]!.login);
    await server.app.db.insert(botCommits).values({ repoId: restored!.id, sha: restore, kind: "revert" });
    // The App's own commits carry no GitHub account: the provisioning's head, as GitHub lists it.
    authors.set(world.commit(nobody!.fullName!, "main", { "x": "y" }), null);
    // A student's authorship on a commit nobody is named as committing (an App commit `bot_commits` missed).
    const halfSha = world.commit(half!.fullName!, "main", { "x": "z" });
    authors.set(halfSha, students[3]!.login);
    halfAttributed.add(halfSha);

    expect(await reconcileRepos(server.app, config)).toContain("0 heads moved");
    for (const repo of repos) expect((await repoRow(repo!.id)).lastCommitSha).toBeNull();
  });

  it("skips a head GitHub cannot serve, without taking the repository for deleted", async () => {
    const { repos } = await project();
    const [repo] = repos;
    headMissing.add(repo!.fullName!);
    expect(await reconcileRepos(server.app, config)).toContain("0 deleted");
    expect((await repoRow(repo!.id)).deletedAt).toBeNull();
  });
});

describe("reconcile.repos: the repository itself", () => {
  it("follows a rename GitHub made, through the webhook's path", async () => {
    const { repos, org } = await project();
    const [repo] = repos;
    const renamed = `${org}/lab-renamed`;
    byId.set(repo!.githubRepoId!, { full_name: renamed });
    aliases.set(renamed, repo!.fullName!);

    expect(await reconcileRepos(server.app, config)).toContain("1 renamed");
    expect((await repoRow(repo!.id)).fullName).toBe(renamed);
    expect(await lastPass("reconcile.repos")).toMatchObject({ renamed: 1 });

    // Settled: the next pass finds the name it stored.
    expect(await reconcileRepos(server.app, config)).toContain("0 renamed");
  });

  it("marks a repository deleted on a 404 by its id: terminal, audited once", async () => {
    const { repos } = await project({ students: 2 });
    const [gone, kept] = repos;
    byId.set(gone!.githubRepoId!, "gone");

    // The surviving repository is settled as usual (its pending invitation re-invited).
    const summary = await reconcileRepos(server.app, config);
    expect(summary).toMatch(/^2 repositories checked, 1 re-invited/);
    expect(summary).toContain("1 deleted");
    expect((await repoRow(gone!.id)).deletedAt?.toISOString()).toBe(NOW);
    expect((await repoRow(kept!.id)).deletedAt).toBeNull();
    const [entry] = await auditOf(gone!.id, "project_repo.deleted");
    expect(entry?.payload).toEqual({ via: "reconcile" });

    // Deleted rows are out of scope: nothing more happens to them.
    expect(await reconcileRepos(server.app, config)).toBe("1 repositories checked, 0 re-invited, 0 invitations accepted, 0 heads moved, 0 renamed, 0 deleted");
    expect(await auditOf(gone!.id, "project_repo.deleted")).toHaveLength(1);
  });

  it("the grades pass marks a repository deleted on its 404 by id too", async () => {
    const { repos } = await project();
    const [repo] = repos;
    list(repo!, head(repo!));
    byId.set(repo!.githubRepoId!, "gone");
    expect(await reconcileGrades(server.app, config)).toBe("1 quiet repositories checked, 0 runs ingested");
    expect((await repoRow(repo!.id)).deletedAt).not.toBeNull();
    expect(await runsOf(repo!)).toHaveLength(0);
    expect(await lastPass("reconcile.grades")).toMatchObject({ deleted: 1 });
  });
});
