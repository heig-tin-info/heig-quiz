/**
 * The review dispatches (merge task M3-05b, ADR-064 addendum) on a server
 * built with Quiz's App, against the fake GitHub (`github/testing.ts`) and
 * the local bare repositories (`./testing.ts`), the clock moved by hand.
 * Ported from heig-classroom's `dispatch.test` and `dispatch.db.test`, plus
 * what Quiz decided on 2026-10-02:
 *
 * - the ticker claims and enqueues only: no HTTP inside a tick, with a queue
 *   or without one;
 * - the final review per repository at ITS definitive freeze, at the frozen
 *   run's commit and the EFFECTIVE deadline, the sha recorded in the
 *   ledger; none without a frozen run, none for a project graded `none`,
 *   none for a repository archived as its lock (no ledger row, audited);
 * - at most once: the ledger claimed before GitHub is called, a row left
 *   unconfirmed never sent again, a refusal GitHub answered given back and
 *   sent on the next pass, a 404 terminal; a reopen in the middle wins;
 * - the checkpoints: their routes (offset across the change of the clocks,
 *   `due_past`, `due_after_deadline`, a duplicate, the delete refused once a
 *   ledger row exists), their dispatch on the last commit no bot pushed
 *   before the date, to every repository whose deadline has not come, and
 *   the void checkpoint a deadline moved earlier leaves behind.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSummary, ReviewCheckpoint } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectCheckpoints,
  projectGradeRuns,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { PROJECT_DEADLINE_QUEUE, PROJECT_DISPATCH_QUEUE, type JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { refreshScoreSelection } from "./grading.js";
import { projectTick, runDeadlineJob } from "./jobs.js";
import { FAILED_RETRY_MS, LEASE_MS, type ProjectJob } from "./lease.js";
import { runReviewJob } from "./review.js";
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
const DAY = 86_400_000;
const GRACE = 30 * MINUTE;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 32_000;
let nextAccount = 35_000;

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** The `repository_dispatch` events GitHub accepted, by repository. */
const dispatched: { fullName: string; body: { event_type: string; client_payload: Record<string, unknown> } }[] = [];
/** How GitHub answers a dispatch to a repository: refused (422), gone (404), failing (502), or never (the connection dies). */
const failing = new Map<string, "422" | "404" | "502" | "network">();
/** Runs while GitHub receives a dispatch, once: what happens "in the middle of a job". */
let duringDispatch: (() => Promise<void>) | null = null;
const dispatchesRoute: Route = (url, req) => {
  const m = /^\/repos\/([^/]+\/[^/]+)\/dispatches$/.exec(url.pathname);
  if (req.method !== "POST" || !m) return undefined;
  const fullName = m[1]!;
  const answer = async () => {
    if (duringDispatch) {
      const run = duringDispatch;
      duringDispatch = null;
      await run();
    }
    const mode = failing.get(fullName);
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "422") return json({ message: "Validation Failed" }, 422);
    if (mode === "502") return json({ message: "Bad Gateway" }, 502);
    if (mode === "404") return json({ message: "Not Found" }, 404);
    dispatched.push({ fullName, body: JSON.parse(String(req.body)) });
    return new Response(null, { status: 204 });
  };
  // The fake's fetch returns what a route returns: a pending answer delays GitHub's.
  return answer() as unknown as Response;
};

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `rv${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

type Repo = typeof projectRepos.$inferSelect;

/** A published project of a connected classroom, and the accepted repositories of `students` students. */
async function project(opts: { students?: number; body?: Record<string, unknown>; freePlan?: boolean } = {}) {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const login = `rorg-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", { main: { "README.md": "# Lab", "src/main.c": "int main(){}" } });
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
  return { id: summary.id, repos: students.map((s) => repos.find((r) => r.userId === s.id)!), students };
}

const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const projectRow = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const ledger = (repoId: string) => server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, repoId));
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const sentTo = (fullName: string) => dispatched.filter((d) => d.fullName === fullName);

/** The jobs the ticker sent, as a queue would have carried them, by queue. */
const sent: { name: string; job: ProjectJob }[] = [];
/** One pass of the ticker, a queue in place unless `queue` is false; true when it made no request to GitHub. */
async function tick(queue = true): Promise<boolean> {
  const boss: JobQueue = {
    createQueue: async () => {},
    send: async (name, data) => void sent.push({ name, job: data as ProjectJob }),
    work: async () => {},
    stop: async () => {},
  };
  const app = server.app as { boss?: JobQueue };
  const before = gh.calls.length;
  if (queue) app.boss = boss;
  try {
    await projectTick(server.app, config);
  } finally {
    delete app.boss;
  }
  return gh.calls.length === before;
}
/** The jobs of `queue` sent for `projectId` since the last call, taken off the list. */
function jobsOf(projectId: string, queue = PROJECT_DISPATCH_QUEUE): ProjectJob[] {
  const mine = sent.filter((s) => s.name === queue && s.job.projectId === projectId);
  for (const s of mine) sent.splice(sent.indexOf(s), 1);
  return mine.map((s) => s.job);
}
async function runDispatches(projectId: string): Promise<void> {
  for (const job of jobsOf(projectId)) await runReviewJob(server.app, config, job);
}
async function runDeadlines(projectId: string): Promise<void> {
  for (const job of jobsOf(projectId, PROJECT_DEADLINE_QUEUE)) await runDeadlineJob(server.app, config, job);
}

/** A scored run of a fresh commit received before the deadline, selected as the pipeline does: its sha. */
async function scoredRun(repo: Repo, points = 4): Promise<string> {
  const headSha = randomUUID().replace(/-/g, "").padEnd(40, "0");
  await server.app.db.insert(projectGradeRuns).values({
    id: randomUUID(),
    repoId: repo.id,
    workflowRunId: Math.floor(Math.random() * 1e9),
    headBranch: "main",
    headSha,
    conclusion: "success",
    points,
    max: 6,
    parseStatus: "ok",
    completedAt: at(DEADLINE, -MINUTE),
  });
  await refreshScoreSelection(server.app.db, { repo });
  return headSha;
}

/** The ticks of a deadline: applied, then frozen for good once the grace is over. */
async function freeze(projectId: string, deadline = DEADLINE): Promise<void> {
  server.clock.set(at(deadline, 1000));
  await tick();
  await runDeadlines(projectId);
  server.clock.set(at(deadline, GRACE + 1000));
  expect(await tick()).toBe(true);
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, dispatchesRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  sent.length = 0;
  dispatched.length = 0;
  failing.clear();
  duringDispatch = null;
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the final review

describe("the final review (F-PROJ-11, GR-16)", () => {
  it("is claimed by the ticker without HTTP, then sent once per repository at its freeze, the sha in the ledger", async () => {
    const p = await project({ students: 2 });
    const [scored, empty] = p.repos;
    const sha = await scoredRun(scored!);

    // Applied, not frozen yet: nothing to review.
    server.clock.set(at(DEADLINE, 1000));
    expect(await tick()).toBe(true);
    expect(jobsOf(p.id)).toEqual([]);

    server.clock.set(at(DEADLINE, GRACE + 1000));
    expect(await tick()).toBe(true);
    const [job] = jobsOf(p.id);
    expect(job).toEqual({ projectId: p.id, lease: at(DEADLINE, GRACE + 1000).toISOString() });
    // A single claim: the lease is held.
    server.clock.advance(20_000);
    expect(await tick()).toBe(true);
    expect(jobsOf(p.id)).toEqual([]);

    await runReviewJob(server.app, config, job!);
    expect(sentTo(scored!.fullName!).map((d) => d.body)).toEqual([
      {
        event_type: "grade-final",
        client_payload: { sha, assignment_id: p.id, deadline: DEADLINE, trigger: "deadline" },
      },
    ]);
    // No frozen run: nothing to review, and no ledger row.
    expect(sentTo(empty!.fullName!)).toEqual([]);
    expect(await ledger(empty!.id)).toEqual([]);
    const [row] = await ledger(scored!.id);
    expect(row).toMatchObject({ trigger: "deadline", checkpointId: null, sha, dispatchedAt: at(DEADLINE, GRACE + 21_000) });
    expect((await projectRow(p.id)).dispatchJobAt).toBeNull();
    const [entry] = await auditOf(p.id, "project.review_dispatched");
    expect(entry!.payload).toEqual({ dispatched: 1, deleted: 0, unconfirmed: 0, failed: [] });

    // Settled: nothing claimed again, ever.
    server.clock.advance(LEASE_MS * 2);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    expect(dispatched).toHaveLength(1);
  });

  it("carries a repository's EFFECTIVE deadline, at ITS freeze", async () => {
    const p = await project({ students: 2 });
    const [own, follows] = p.repos;
    const OWN = "2026-10-12T22:00:00.000Z";
    const put = await call("PUT", `/app/api/projects/${p.id}/repos/${own!.id}/deadline`, teacher.headers, { deadlineAt: OWN });
    expect(put.statusCode, put.body).toBe(200);
    await scoredRun(own!);
    await scoredRun(follows!);

    await freeze(p.id);
    await runDispatches(p.id);
    expect(sentTo(follows!.fullName!)).toHaveLength(1);
    expect(sentTo(own!.fullName!)).toEqual([]);

    await freeze(p.id, OWN);
    await runDispatches(p.id);
    expect(sentTo(own!.fullName!).map((d) => d.body.client_payload.deadline)).toEqual([OWN]);
  });

  it("never dispatches for a project graded none", async () => {
    const p = await project({ body: { gradingMode: "none" } });
    await scoredRun(p.repos[0]!);
    await freeze(p.id);
    expect(jobsOf(p.id)).toEqual([]);
    expect(await ledger(p.repos[0]!.id)).toEqual([]);
  });

  it("skips a repository archived as its lock (H8): no ledger row, audited degraded, never un-archived", async () => {
    const p = await project({ freePlan: true });
    const [repo] = p.repos;
    await scoredRun(repo!);
    await freeze(p.id);
    expect(await repoRow(repo!.id)).toMatchObject({ archivedAt: at(DEADLINE, 1000) });
    expect(jobsOf(p.id)).toEqual([]);
    expect(await ledger(repo!.id)).toEqual([]);
    const [skipped] = await auditOf(repo!.id, "project_repo.review_skipped");
    expect(skipped!.payload).toEqual({ projectId: p.id, reason: "archived" });
    expect(world.archived.has(repo!.fullName!)).toBe(true);
  });

  it("skips a repository whose protected files are no longer restored: audited, the teacher's score settles it", async () => {
    const p = await project({ students: 2 });
    const [suspended, plain] = p.repos;
    await scoredRun(suspended!);
    await scoredRun(plain!);
    await server.app.db.update(projectRepos).set({ protectionSuspendedAt: new Date(NOW) }).where(eq(projectRepos.id, suspended!.id));
    await freeze(p.id);
    await runDispatches(p.id);
    expect(sentTo(suspended!.fullName!)).toEqual([]);
    expect(sentTo(plain!.fullName!)).toHaveLength(1);
    expect(await ledger(suspended!.id)).toEqual([]);
    const [skipped] = await auditOf(suspended!.id, "project_repo.review_skipped");
    expect(skipped!.payload).toEqual({ projectId: p.id, reason: "protection_suspended" });
  });
});

describe("at most once (product owner, 2026-10-02)", () => {
  it("never sends again a dispatch claimed and left unconfirmed — a crash, an answer that never came, a 5xx", async () => {
    const p = await project({ students: 3 });
    const [crashed, silent, failing5xx] = p.repos;
    for (const repo of p.repos) await scoredRun(repo);
    // A crash between the claim and the call: the row is there, unconfirmed.
    await server.app.db
      .insert(gradeDispatches)
      .values({ id: randomUUID(), repoId: crashed!.id, trigger: "deadline", sha: "c".repeat(40), createdAt: at(DEADLINE, GRACE) });
    failing.set(silent!.fullName!, "network");
    // GitHub may have acted on a 502 before failing: never sent again either.
    failing.set(failing5xx!.fullName!, "502");

    await freeze(p.id);
    await runDispatches(p.id);
    expect(dispatched).toEqual([]);
    for (const repo of [silent!, failing5xx!]) expect(await ledger(repo.id)).toEqual([expect.objectContaining({ dispatchedAt: null })]);
    const [entry] = await auditOf(p.id, "project.review_dispatched");
    expect(entry!.payload).toMatchObject({ dispatched: 0, unconfirmed: 2, failed: [] });
    // Not a failure: the lease given back, and nothing claimed again.
    expect((await projectRow(p.id)).dispatchJobAt).toBeNull();
    failing.clear();
    server.clock.advance(LEASE_MS * 2);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(await ledger(crashed!.id)).toHaveLength(1);
  });

  it("gives back the claim GitHub refused (a 4xx) and sends it some 30 s on; a 404 is terminal", async () => {
    const p = await project({ students: 2 });
    const [refused, gone] = p.repos;
    await scoredRun(refused!);
    await scoredRun(gone!);
    failing.set(refused!.fullName!, "422");
    failing.set(gone!.fullName!, "404");
    await freeze(p.id);
    const [job] = jobsOf(p.id);
    await expect(runReviewJob(server.app, config, job!)).rejects.toThrow(/incomplete/);
    expect(await ledger(refused!.id)).toEqual([]);
    expect((await repoRow(gone!.id)).deletedAt).not.toBeNull();
    const [deleted] = await auditOf(gone!.id, "project_repo.deleted");
    expect(deleted!.payload).toEqual({ via: "dispatch" });
    expect((await projectRow(p.id)).dispatchJobAt).toEqual(at(DEADLINE, GRACE + 1000 - LEASE_MS + FAILED_RETRY_MS));

    failing.clear();
    server.clock.advance(FAILED_RETRY_MS - 1000);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    server.clock.advance(2000);
    await tick();
    await runDispatches(p.id);
    expect(sentTo(refused!.fullName!)).toHaveLength(1);
    expect(sentTo(gone!.fullName!)).toEqual([]);
    expect((await ledger(refused!.id))[0]!.dispatchedAt).not.toBeNull();
  });

  it("re-reads the freeze: a reopen between the sweep and the job, or in the middle of it, wins", async () => {
    const p = await project();
    const [repo] = p.repos;
    const sha = await scoredRun(repo!);
    const moveTo = async (deadlineAt: string) => {
      const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt });
      expect(moved.statusCode, moved.body).toBe(200);
    };

    // Reopened between the sweep and the job: the job finds nothing to send.
    await freeze(p.id);
    const [stale] = jobsOf(p.id);
    await moveTo("2026-10-14T22:00:00Z");
    await runReviewJob(server.app, config, stale!);
    expect(dispatched).toEqual([]);
    expect(await ledger(repo!.id)).toEqual([]);
    expect((await projectRow(p.id)).dispatchJobAt).toBeNull();

    // Reopened while GitHub receives the dispatch: the reopen forgets the
    // claim, so the next freeze reviews again, at its own deadline.
    await freeze(p.id, "2026-10-14T22:00:00.000Z");
    const [job] = jobsOf(p.id);
    duringDispatch = () => moveTo("2026-10-16T22:00:00Z");
    await runReviewJob(server.app, config, job!);
    expect(duringDispatch).toBeNull();
    expect(dispatched).toHaveLength(1);
    expect(await repoRow(repo!.id)).toMatchObject({ frozenAt: null, reviewGradeRunId: null });
    expect(await ledger(repo!.id)).toEqual([]);

    await freeze(p.id, "2026-10-16T22:00:00.000Z");
    await runDispatches(p.id);
    expect(dispatched.map((d) => d.body.client_payload)).toEqual([
      expect.objectContaining({ sha, deadline: "2026-10-14T22:00:00.000Z" }),
      expect.objectContaining({ sha, deadline: "2026-10-16T22:00:00.000Z" }),
    ]);
  });

  it("claims nothing without a queue: no dispatch ever runs in the ticker's process", async () => {
    const p = await project();
    await scoredRun(p.repos[0]!);
    server.clock.set(at(DEADLINE, GRACE + 1000));
    expect(await tick(false)).toBe(true);
    expect((await repoRow(p.repos[0]!.id)).frozenAt).not.toBeNull();
    expect((await projectRow(p.id)).dispatchJobAt).toBeNull();
    expect(await ledger(p.repos[0]!.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------- the checkpoints

describe("the checkpoints' routes (F-PROJ-11)", () => {
  const url = (id: string) => `/app/api/projects/${id}/checkpoints`;

  it("resolve J−n in calendar days across the change of the clocks, and refuse a date past or after the deadline", async () => {
    // 23:59 on the 30th, winter time; J−7 is 23:59 on the 23rd, summer time.
    const p = await project({ body: { deadlineAt: "2026-10-30T22:59:00Z" } });
    const created = await call("POST", url(p.id), teacher.headers, { name: "mid-review", offsetDays: -7 });
    expect(created.statusCode, created.body).toBe(201);
    expect(ReviewCheckpoint.parse(created.json())).toMatchObject({
      name: "mid-review",
      dueAt: "2026-10-23T21:59:00.000Z",
      offsetDays: -7,
      dispatchedAt: null,
    });
    const absolute = await call("POST", url(p.id), teacher.headers, { name: "draft_1", dueAt: "2026-10-05T08:00:00Z" });
    expect(ReviewCheckpoint.parse(absolute.json())).toMatchObject({ dueAt: "2026-10-05T08:00:00.000Z", offsetDays: null });
    const listed = await call("GET", url(p.id), teacher.headers);
    expect(listed.json().map((c: ReviewCheckpoint) => c.name)).toEqual(["draft_1", "mid-review"]);
    const [entry] = await auditOf(absolute.json().id, "project_checkpoint.create");
    expect(entry!.payload).toMatchObject({ projectId: p.id, name: "draft_1", offsetDays: null });

    const refusals = [
      [{ name: "past", dueAt: "2026-10-02T07:00:00Z" }, 422, "due_past"],
      [{ name: "late", dueAt: "2026-10-30T22:59:00Z" }, 422, "due_after_deadline"],
      [{ name: "mid-review", offsetDays: -2 }, 409, "duplicate_checkpoint"],
    ] as const;
    for (const [body, status, error] of refusals) {
      const res = await call("POST", url(p.id), teacher.headers, body);
      expect([res.statusCode, res.json().error], body.name).toEqual([status, error]);
    }
    // A J−n reaching back before now is past too.
    const back = await call("POST", url(p.id), teacher.headers, { name: "back", offsetDays: -30 });
    expect([back.statusCode, back.json().error]).toEqual([422, "due_past"]);
    for (const body of [
      { name: "both", dueAt: "2026-10-05T08:00:00Z", offsetDays: -2 },
      { name: "neither" },
      { name: "Bad Name", offsetDays: -2 },
      { name: "zero", offsetDays: 0 },
    ]) {
      expect((await call("POST", url(p.id), teacher.headers, body)).statusCode, body.name).toBe(400);
    }
  });

  it("are the staff's alone", async () => {
    const p = await project();
    const student = p.students[0]!;
    expect((await call("GET", url(p.id), student.headers)).statusCode).toBe(404);
    expect((await call("POST", url(p.id), student.headers, { name: "x", offsetDays: -1 })).statusCode).toBe(404);
  });

  it("delete a checkpoint until a dispatch of it was claimed", async () => {
    const p = await project();
    const create = async (name: string) =>
      ReviewCheckpoint.parse((await call("POST", url(p.id), teacher.headers, { name, offsetDays: -2 })).json());
    const free = await create("free");
    const used = await create("used");
    expect((await call("DELETE", `${url(p.id)}/${free.id}`, teacher.headers)).statusCode).toBe(204);
    expect(await auditOf(free.id, "project_checkpoint.delete")).toHaveLength(1);
    expect((await call("DELETE", `${url(p.id)}/${free.id}`, teacher.headers)).statusCode).toBe(404);

    // Claimed but never confirmed is enough: the ledger keeps what was asked.
    await server.app.db.insert(gradeDispatches).values({
      id: randomUUID(),
      repoId: p.repos[0]!.id,
      trigger: "checkpoint",
      checkpointId: used.id,
      sha: "d".repeat(40),
      createdAt: new Date(NOW),
    });
    const refused = await call("DELETE", `${url(p.id)}/${used.id}`, teacher.headers);
    expect([refused.statusCode, refused.json().error]).toEqual([409, "checkpoint_dispatched"]);
    // Another project's checkpoint is as missing as none.
    const other = await project();
    expect((await call("DELETE", `${url(other.id)}/${used.id}`, teacher.headers)).statusCode).toBe(404);
  });
});

describe("a checkpoint's dispatch (F-PROJ-11)", () => {
  const DUE = "2026-10-06T22:00:00.000Z";

  /** A push receipt on the repository, as the intake writes it. */
  const receipt = (repo: Repo, sha: string, receivedAt: Date, over: { branch?: string; isBot?: boolean } = {}) =>
    server.app.db.insert(pushReceipts).values({
      id: randomUUID(),
      githubRepoId: repo.githubRepoId!,
      branch: over.branch ?? "main",
      headSha: sha,
      receivedAt,
      isBot: over.isBot ?? false,
    });

  it("reviews the last commit no bot pushed before its date, on every repository whose deadline has not come", async () => {
    const p = await project({ students: 4 });
    const [follows, later, earlier, silent] = p.repos;
    const put = (repo: Repo, deadlineAt: string) =>
      call("PUT", `/app/api/projects/${p.id}/repos/${repo.id}/deadline`, teacher.headers, { deadlineAt });
    expect((await put(later!, "2026-10-12T22:00:00Z")).statusCode).toBe(200);
    expect((await put(earlier!, "2026-10-05T22:00:00Z")).statusCode).toBe(200);
    const created = await call("POST", `/app/api/projects/${p.id}/checkpoints`, teacher.headers, { name: "mid", dueAt: DUE });
    const checkpoint = ReviewCheckpoint.parse(created.json());

    const sha = (c: string) => c.repeat(40);
    await receipt(follows!, sha("1"), at(DUE, -2 * DAY));
    await receipt(follows!, sha("2"), at(DUE, -MINUTE)); // the last before it: the one
    await receipt(follows!, sha("3"), at(DUE, -30_000), { isBot: true }); // a bot's: never reviewed
    await receipt(follows!, sha("4"), at(DUE, -20_000), { branch: "wip" }); // not handed out
    await receipt(follows!, sha("5"), at(DUE, MINUTE)); // after it
    await receipt(later!, sha("6"), at(DUE, -DAY));
    await receipt(earlier!, sha("7"), at(DUE, -2 * DAY));

    // The repository with an earlier own deadline is frozen meanwhile.
    server.clock.set("2026-10-05T22:00:01Z");
    await tick();
    expect((await repoRow(earlier!.id)).deadlineAppliedAt).not.toBeNull();
    server.clock.set(at(DUE, -1000));
    await tick();
    expect(jobsOf(p.id)).toEqual([]);

    server.clock.set(at(DUE, 1000));
    expect(await tick()).toBe(true);
    await runDispatches(p.id);
    expect(sentTo(follows!.fullName!).map((d) => d.body)).toEqual([
      {
        event_type: "grade-milestone",
        client_payload: { sha: sha("2"), assignment_id: p.id, milestone_id: checkpoint.id, milestone: "mid", due: DUE, trigger: "milestone" },
      },
    ]);
    expect(sentTo(later!.fullName!).map((d) => d.body.client_payload.sha)).toEqual([sha("6")]);
    expect(sentTo(earlier!.fullName!)).toEqual([]);
    expect(sentTo(silent!.fullName!)).toEqual([]); // never pushed: nothing to review
    expect((await ledger(follows!.id))[0]).toMatchObject({ trigger: "checkpoint", checkpointId: checkpoint.id, sha: sha("2") });
    const [row] = await server.app.db.select().from(projectCheckpoints).where(eq(projectCheckpoints.id, checkpoint.id));
    expect(row!.dispatchedAt).toEqual(at(DUE, 1000));
    const [entry] = await auditOf(p.id, "project.checkpoint_dispatched");
    expect(entry!.payload).toEqual({ checkpointId: checkpoint.id, name: "mid", dispatched: 2, deleted: 0, unconfirmed: 0, failed: [] });

    server.clock.advance(LEASE_MS * 2);
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    expect(dispatched).toHaveLength(2);
  });

  it("is void once the deadline moved before it: never fires, and may be deleted", async () => {
    const p = await project();
    await receipt(p.repos[0]!, "e".repeat(40), new Date(NOW));
    const created = await call("POST", `/app/api/projects/${p.id}/checkpoints`, teacher.headers, { name: "late", dueAt: DUE });
    const checkpoint = ReviewCheckpoint.parse(created.json());
    const moved = await call("PATCH", `/app/api/projects/${p.id}`, teacher.headers, { deadlineAt: "2026-10-05T22:00:00Z" });
    expect(moved.statusCode, moved.body).toBe(200);

    server.clock.set(at(DUE, 1000));
    await tick();
    expect(jobsOf(p.id)).toEqual([]);
    expect(dispatched).toEqual([]);
    const listed = await call("GET", `/app/api/projects/${p.id}/checkpoints`, teacher.headers);
    expect(listed.json()).toEqual([expect.objectContaining({ id: checkpoint.id, dispatchedAt: null })]);
    expect((await call("DELETE", `/app/api/projects/${p.id}/checkpoints/${checkpoint.id}`, teacher.headers)).statusCode).toBe(204);
  });
});
