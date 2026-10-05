/**
 * The source's sync (F-PROJ-12 as amended 2026-10-05; merge task M3-07,
 * ADR-073) on a server built with Quiz's App, against the fake GitHub
 * (`github/testing.ts`) and the local bare repositories (`./testing.ts`)
 * git really pushes to. heig-classroom had no test of its `sync.ts`; these
 * are new, over what the product owner decided on 2026-10-05:
 *
 * - the source ahead: a push to a handed-out branch of the source marks
 *   every non-archived project of it, drafts included, with the commits
 *   counted; another branch, an archived project, a push the distribution
 *   already holds: nothing;
 * - the request: the distribution updated in the request (one commit on
 *   top with `squash`, naming no source sha), the handed-out shas recorded,
 *   202; the pass pushes `sync/<branch>`, records the bot commit, opens ONE
 *   pull request per branch with the DISTRIBUTION's sha, stores it; the
 *   source is no longer ahead; nothing of it reaches a student (N-SEC-20);
 * - never two: a second sync comments on the open pull request (only when
 *   the head moved), a repository that merged it is up to date, a closed
 *   one is replaced, a lost row is found again by its head;
 * - skipped: locked, past the effective deadline, deleted on GitHub;
 * - a failed repository: recorded, the pass goes on, the source stays
 *   ahead, the lease frees within a minute, the retry reaches it;
 * - `whole` on a rewritten source: 409, audited, nothing changed, the lease
 *   given back; the refusals; a draft syncs its distribution only;
 * - `pull_request` events: the App's, from `sync/*`, replays about an older
 *   pull request ignored;
 * - after a sync, a protected file is restored to the NEW distribution
 *   version, and never when the student's copy already is it (ADR-062).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDetail, ProjectErrorCode, ProjectSummary, ProjectSyncAccepted } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  botCommits,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  projectRepos,
  projects,
  projectSyncPrs,
  webhookDeliveries,
} from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { revertProtectedFiles } from "../../github/revert.js";
import { SYNC_COMMIT_MESSAGE } from "../../github/sync.js";
import { appKey, fakeGithub, json, orgsRoute, signedDelivery, type Route } from "../../github/testing.js";
import { PROJECT_SYNC_QUEUE, type JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import type { ProjectJob } from "./lease.js";
import { runSyncJob } from "./sync.js";
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
const APP_BOT = "quiz-test[bot]";
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const GRADING = ".github/workflows/grading.yml";
const HOUR = 3_600_000;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);
const short = (sha: string) => sha.slice(0, 7);

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 31_000;
let nextAccount = 34_000;

const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `sy${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

type Repo = typeof projectRepos.$inferSelect;

/**
 * A connected classroom whose organization holds a source `starter` (`main`
 * handed out, `dev` not), a project of it — published unless told, its
 * repositories accepted by `students` students.
 */
async function project(opts: { students?: number; body?: Record<string, unknown>; publish?: boolean; commits?: number } = {}) {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: opts.students ?? 1 }, () => newStudent()));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const n = nextOrg++;
  const login = `sorg-${n}`;
  world.orgIds[login] = n;
  world.source(
    login,
    "starter",
    { main: { "README.md": "# Lab", "src/main.c": "int main(){}", [GRADING]: "grade: v1" }, dev: { "README.md": "# Dev" } },
    opts.commits ?? 1,
  );
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Lab",
    sourceRepo: "starter",
    deadlineAt: DEADLINE,
    protectedFiles: [GRADING],
    ...opts.body,
  });
  expect(created.statusCode, created.body).toBe(201);
  const summary = ProjectSummary.parse(created.json());
  const base = {
    id: summary.id,
    classroomId: seeded.classroomId,
    org: login,
    source: `${login}/starter`,
    sourceRepoId: world.ids.get(`${login}/starter`)!,
    distribution: summary.distribution!.fullName,
    students,
  };
  if (opts.publish === false) return { ...base, repos: [] as Repo[] };
  expect((await call("POST", `/app/api/projects/${summary.id}/publish`, teacher.headers)).statusCode).toBe(200);
  for (const s of students) {
    const accepted = await call("POST", `/app/api/student/projects/${summary.id}/accept`, s.headers);
    expect(accepted.statusCode, accepted.body).toBe(200);
  }
  const repos = await db.select().from(projectRepos).where(eq(projectRepos.projectId, summary.id));
  return { ...base, repos: students.map((s) => repos.find((r) => r.userId === s.id)!) };
}
type Project = Awaited<ReturnType<typeof project>>;

const projectRow = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;
const repoRow = async (id: string) => (await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, id)))[0]!;
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const prRows = (repoId: string) => server.app.db.select().from(projectSyncPrs).where(eq(projectSyncPrs.repoId, repoId));
const syncCommits = (repoId: string) =>
  server.app.db.select().from(botCommits).where(and(eq(botCommits.repoId, repoId), eq(botCommits.kind, "sync")));
const head = (fullName: string, ref = "main") => world.git(fullName, "rev-parse", ref).trim();
const hasRef = (fullName: string, ref: string) => world.git(fullName, "for-each-ref", `refs/heads/${ref}`).trim() !== "";
const pulls = (fullName: string) => world.pulls.get(fullName) ?? [];
const comments = (fullName: string, number: number) => world.comments.get(fullName)?.get(number) ?? [];
async function detail(id: string) {
  const res = await call("GET", `/app/api/projects/${id}`, teacher.headers);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectDetail.parse(res.json());
}
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectErrorCode.parse(res.json().error)];

// The deliveries, through the real intake; the test server has no queue, so a handler runs before the 200 settles.
const deliver = (event: string, payload: object, id = randomUUID()) => signedDelivery(server.app, SECRET, payload, { event, id });
async function handled(event: string, payload: object, id = randomUUID()): Promise<void> {
  const res = await deliver(event, payload, id);
  expect(res.statusCode, res.body).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.error ?? null).toBeNull();
    expect(row?.processedAt).not.toBeNull();
  }, { timeout: 20_000 });
}

/** The teacher's commit of `files` on the source's `branch`, delivered as GitHub would; its sha. */
async function sourcePush(p: Project, files: Record<string, string | null>, branch = "main", commits = 1): Promise<string> {
  const before = head(p.source, branch);
  let after = before;
  for (let c = 0; c < commits; c++) after = world.commit(p.source, branch, files);
  await handled("push", { ref: `refs/heads/${branch}`, before, after, repository: { id: p.sourceRepoId }, sender: { login: "prof" } });
  return after;
}

/** The jobs a queue would have carried, when one is installed ({@link queued}). */
const sent: ProjectJob[] = [];
/** `fn` with a queue in place that records the sync jobs instead of running them. */
async function queued<T>(fn: () => Promise<T>): Promise<T> {
  const queue: JobQueue = {
    createQueue: async () => {},
    send: async (name, data) => void (name === PROJECT_SYNC_QUEUE && sent.push(data as ProjectJob)),
    work: async () => {},
    stop: async () => {},
  };
  const app = server.app as { boss?: JobQueue };
  app.boss = queue;
  try {
    return await fn();
  } finally {
    delete app.boss;
  }
}
const sync = (id: string, headers = teacher.headers) => call("POST", `/app/api/projects/${id}/sync`, headers);
/** A sync asked and, without a queue, run in the request: the 202's body. */
async function synced(id: string) {
  const res = await sync(id);
  expect(res.statusCode, res.body).toBe(202);
  return ProjectSyncAccepted.parse(res.json());
}
function jobsOf(projectId: string): ProjectJob[] {
  const mine = sent.filter((j) => j.projectId === projectId);
  for (const job of mine) sent.splice(sent.indexOf(job), 1);
  return mine;
}

/** A pull request of the App's `pull_request` event, on `repo`. */
const prEvent = (repo: Repo, over: { action: string; number: number; merged?: boolean; login?: string; headRef?: string }) => ({
  action: over.action,
  repository: { id: repo.githubRepoId },
  pull_request: {
    number: over.number,
    state: over.action === "closed" ? "closed" : "open",
    merged: over.merged ?? false,
    head: { ref: over.headRef ?? "sync/main" },
    base: { ref: "main" },
    user: { login: over.login ?? APP_BOT },
  },
});

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, world.route];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  sent.length = 0;
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- the source ahead

describe("the source ahead (F-PROJ-12)", () => {
  it("marks every non-archived project of the source — a draft too —, counts the commits, by the server's receipt; another branch, an archived project, a sha already handed out: nothing", async () => {
    const p = await project();
    const draft = ProjectSummary.parse(
      (await call("POST", `/app/api/classrooms/${p.classroomId}/projects`, teacher.headers, { name: "Lab draft", sourceRepo: "starter", deadlineAt: DEADLINE })).json(),
    );
    const archived = ProjectSummary.parse(
      (await call("POST", `/app/api/classrooms/${p.classroomId}/projects`, teacher.headers, { name: "Lab old", sourceRepo: "starter", deadlineAt: DEADLINE })).json(),
    );
    expect((await call("POST", `/app/api/projects/${archived.id}/archive`, teacher.headers)).statusCode).toBe(200);
    // The build recorded the sha handed out.
    expect((await projectRow(p.id)).sourceHeads).toEqual({ main: head(p.source) }); // `dev` is not handed out

    server.clock.set(at(NOW, HOUR));
    const after = await sourcePush(p, { "src/util.c": "int util;" }, "main", 2);
    for (const id of [p.id, draft.id]) {
      expect(await projectRow(id)).toMatchObject({ sourceAheadSha: after, sourcePushedAt: at(NOW, HOUR), sourceAhead: { main: 2 } });
    }
    expect((await projectRow(archived.id)).sourceAheadSha).toBeNull();

    // A branch not handed out changes nothing.
    await sourcePush(p, { "README.md": "# Dev 2" }, "dev");
    expect((await projectRow(p.id)).sourceAhead).toEqual({ main: 2 });

    const d = await detail(p.id);
    expect(d.sync).toMatchObject({ ahead: { pushedAt: at(NOW, HOUR).toISOString(), commits: 2 }, inProgress: false, syncedAt: null, last: null });
    expect(d.primaryAction).toBe("sync");

    // A push whose head the distribution already holds (a sync fetched it before the delivery was handled) marks nothing.
    await synced(p.id);
    expect((await projectRow(p.id)).sourceAheadSha).toBeNull();
    await handled("push", { ref: "refs/heads/main", before: "0".repeat(40), after, repository: { id: p.sourceRepoId }, sender: { login: "prof" } });
    expect((await projectRow(p.id)).sourceAheadSha).toBeNull();
  });
});

// ---------------------------------------------------------------- the request and the pass

describe("the request and the pass (F-PROJ-12)", () => {
  it("updates the distribution, pushes sync/<branch>, records the bot commit, opens ONE pull request per repository naming the distribution's sha, stores it; the source is no longer ahead; nothing of it reaches a student", async () => {
    const p = await project({ students: 2 });
    const [r1, r2] = p.repos as [Repo, Repo];
    const sourceSha = await sourcePush(p, { "src/util.c": "int util;", "README.md": "# Lab v2" });
    const distBefore = head(p.distribution);

    server.clock.set(at(NOW, HOUR));
    expect(await synced(p.id)).toEqual({ requestedAt: at(NOW, HOUR).toISOString() });

    // The distribution: one commit on top, the source's tree, no sha of the source in it (N-SEC-20).
    const distHead = head(p.distribution);
    expect(head(p.distribution, "main^")).toBe(distBefore);
    expect(world.git(p.distribution, "log", "-1", "--format=%s", "main").trim()).toBe(SYNC_COMMIT_MESSAGE);
    expect(world.read(p.distribution, "main", "src/util.c")).toBe("int util;");
    const row = await projectRow(p.id);
    expect(row).toMatchObject({ sourceHeads: { main: sourceSha }, sourceAheadSha: null, sourceAhead: null, syncedAt: at(NOW, HOUR), syncJobAt: null });
    expect(await auditOf(p.id, "project.sync_requested")).toMatchObject([{ actorUserId: teacher.id, payload: { changed: ["main"] } }]);
    expect(await auditOf(p.id, "project.synced")).toMatchObject([
      { actorType: "system", payload: { opened: 2, updated: 0, upToDate: 0, failed: 0, skipped: 0, failedRepos: [] } },
    ]);

    for (const repo of [r1, r2]) {
      expect(head(repo.fullName!, "sync/main")).toBe(distHead);
      expect(head(repo.fullName!, "main")).not.toBe(distHead); // the student's branch untouched
      expect(await syncCommits(repo.id)).toMatchObject([{ sha: distHead }]);
      const [pr] = pulls(repo.fullName!);
      expect(pulls(repo.fullName!)).toHaveLength(1);
      expect(pr).toMatchObject({ title: `Project update (${short(distHead)})`, head: { ref: "sync/main" }, base: { ref: "main" }, state: "open" });
      expect(pr!.body).toContain("`src/util.c`");
      expect(`${pr!.title}\n${pr!.body}`).not.toContain(short(sourceSha));
      expect(await prRows(repo.id)).toMatchObject([{ branch: "main", prNumber: pr!.number, state: "open" }]);
      expect(await repoRow(repo.id)).toMatchObject({ syncOutcome: "opened", syncOutcomeAt: at(NOW, HOUR) });
    }

    const d = await detail(p.id);
    expect(d.sync).toEqual({ ahead: null, inProgress: false, syncedAt: at(NOW, HOUR).toISOString(), last: { opened: 2, updated: 0, upToDate: 0, failed: 0, skipped: 0 } });
    expect(d.primaryAction).toBe("none");
    expect(d.rows.find((r) => r.repo?.id === r1.id)!.repo!.sync).toEqual({
      pr: { number: pulls(r1.fullName!)[0]!.number, state: "open" },
      outcome: "opened",
      at: at(NOW, HOUR).toISOString(),
    });

    // The student's view: their repository, never the source's sha, the distribution, the sync's words (N-SEC-20).
    const student = await call("GET", `/app/api/student/projects/${p.id}`, p.students[0]!.headers);
    expect(student.statusCode).toBe(200);
    for (const secret of [sourceSha, short(sourceSha), "squashed", "starter", "sourceAhead", "syncOutcome", "sync_pr"]) {
      expect(student.body, secret).not.toContain(secret);
    }
  });

  it("never two: comments on the open pull request when the head moved, leaves a repository that merged it up to date, replaces a closed one, finds a lost row by its head", async () => {
    const p = await project({ students: 2 });
    const [merged, pending] = p.repos as [Repo, Repo];
    await sourcePush(p, { "src/util.c": "v1" });
    await synced(p.id);
    const first = pulls(pending.fullName!)[0]!;

    await sourcePush(p, { "src/util.c": "v2" });
    await synced(p.id);
    const distHead = head(p.distribution);
    for (const repo of [merged, pending]) {
      expect(await repoRow(repo.id)).toMatchObject({ syncOutcome: "updated" });
      expect(pulls(repo.fullName!)).toHaveLength(1);
      expect(comments(repo.fullName!, pulls(repo.fullName!)[0]!.number)).toEqual([expect.stringContaining(`Updated to \`${short(distHead)}\``)]);
    }
    expect((await auditOf(p.id, "project.synced"))[1]!.payload).toMatchObject({ opened: 0, updated: 2, upToDate: 0 });

    // The first student merges (a fast-forward of their branch onto the update); a retry with
    // nothing new finds them up to date, and says nothing again on the other's pull request
    // (the head did not move).
    world.git(merged.fullName!, "update-ref", "refs/heads/main", head(merged.fullName!, "sync/main"));
    await synced(p.id);
    expect(await repoRow(merged.id)).toMatchObject({ syncOutcome: "up_to_date" });
    expect(pulls(merged.fullName!)).toHaveLength(1); // nothing new sent
    expect(comments(pending.fullName!, first.number)).toHaveLength(1);
    expect(await repoRow(pending.id)).toMatchObject({ syncOutcome: "updated" });
    expect((await auditOf(p.id, "project.synced"))[2]!.payload).toMatchObject({ opened: 0, updated: 1, upToDate: 1 });

    // The pull request closed on GitHub without merging: the next update opens a new one.
    first.state = "closed";
    await sourcePush(p, { "src/util.c": "v3" });
    await synced(p.id);
    expect(pulls(pending.fullName!)).toHaveLength(2);
    const second = pulls(pending.fullName!)[1]!;
    expect(await prRows(pending.id)).toMatchObject([{ prNumber: second.number, state: "open" }]);
    expect(await repoRow(pending.id)).toMatchObject({ syncOutcome: "opened" });

    // The row lost (an import, a hand-opened pull request): the open one is found by its head, never a second.
    await server.app.db.delete(projectSyncPrs).where(eq(projectSyncPrs.repoId, pending.id));
    await sourcePush(p, { "src/util.c": "v4" });
    await synced(p.id);
    expect(pulls(pending.fullName!)).toHaveLength(2);
    expect(await prRows(pending.id)).toMatchObject([{ prNumber: second.number, state: "open" }]);
    expect(comments(pending.fullName!, second.number)).toHaveLength(1);
    expect(await repoRow(pending.id)).toMatchObject({ syncOutcome: "updated" });
  });

  it("skips a locked repository and one past its effective deadline, re-read before the push; a repository gone from GitHub is marked deleted; the rest get the update", async () => {
    const p = await project({ students: 4 });
    const [locked, overdue, gone, open] = p.repos as [Repo, Repo, Repo, Repo];
    const db = server.app.db;
    await db.update(projectRepos).set({ lockedAt: at(NOW) }).where(eq(projectRepos.id, locked.id));
    await db.update(projectRepos).set({ deadlineAt: at(NOW, -HOUR) }).where(eq(projectRepos.id, overdue.id));
    rmSync(join(world.dir, `${gone.fullName}.git`), { recursive: true, force: true });

    await sourcePush(p, { "src/util.c": "v1" });
    await synced(p.id);
    for (const repo of [locked, overdue]) {
      expect(await repoRow(repo.id)).toMatchObject({ syncOutcome: "skipped", deletedAt: null });
      expect(hasRef(repo.fullName!, "sync/main")).toBe(false);
      expect(pulls(repo.fullName!)).toHaveLength(0);
    }
    expect(await repoRow(gone.id)).toMatchObject({ syncOutcome: "skipped", deletedAt: at(NOW) });
    expect(await auditOf(gone.id, "project_repo.deleted")).toMatchObject([{ payload: { via: "sync" } }]);
    expect(await repoRow(open.id)).toMatchObject({ syncOutcome: "opened" });
    expect((await auditOf(p.id, "project.synced"))[0]!.payload).toMatchObject({ opened: 1, skipped: 3, failed: 0 });
    // Nothing failed: the source is no longer ahead.
    expect((await projectRow(p.id)).sourceAheadSha).toBeNull();
  });

  it("records a failed repository, goes on with the others, keeps the source ahead, gives the lease back; the next sync opens the failed one's pull request and spares the rest a comment", async () => {
    const p = await project({ students: 2 });
    const [failing, fine] = p.repos as [Repo, Repo];
    const hook = join(world.dir, `${failing.fullName}.git`, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho refused >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const after = await sourcePush(p, { "src/util.c": "v1" });

    const res = await queued(() => sync(p.id));
    expect(res.statusCode, res.body).toBe(202);
    const [job] = jobsOf(p.id);
    await expect(runSyncJob(server.app, config, job!)).rejects.toThrow(/incomplete/);
    expect(await repoRow(failing.id)).toMatchObject({ syncOutcome: "failed" });
    expect(await repoRow(fine.id)).toMatchObject({ syncOutcome: "opened" });
    expect((await auditOf(p.id, "project.synced"))[0]!.payload).toMatchObject({ opened: 1, failed: 1, failedRepos: [failing.fullName] });
    expect(await projectRow(p.id)).toMatchObject({ sourceAheadSha: after, syncedAt: at(NOW) });
    expect((await detail(p.id)).sync).toMatchObject({ ahead: { commits: 1 }, last: { opened: 1, failed: 1 } });

    // The lease was given back: nothing re-claims a sync, the staff ask again at once.
    expect((await projectRow(p.id)).syncJobAt).toBeNull();
    rmSync(hook);
    await synced(p.id);
    expect(await repoRow(failing.id)).toMatchObject({ syncOutcome: "opened" });
    expect(pulls(failing.fullName!)).toHaveLength(1);
    // The other repository's pull request was current: no second comment.
    expect(comments(fine.fullName!, pulls(fine.fullName!)[0]!.number)).toHaveLength(0);
    expect((await projectRow(p.id)).sourceAheadSha).toBeNull();
  });

  it("keeps the source ahead when a push lands during the pass: the sha is no longer one the pass synced", async () => {
    const p = await project();
    await sourcePush(p, { "src/util.c": "v1" });
    const res = await queued(() => sync(p.id));
    expect(res.statusCode, res.body).toBe(202);
    // The job is queued, not run yet: the teacher pushes again meanwhile.
    const later = await sourcePush(p, { "src/util.c": "v2" });
    for (const job of jobsOf(p.id)) await runSyncJob(server.app, config, job);
    expect(await repoRow(p.repos[0]!.id)).toMatchObject({ syncOutcome: "opened" });
    expect(await projectRow(p.id)).toMatchObject({ sourceAheadSha: later, syncJobAt: null, syncedAt: at(NOW) });
    expect((await detail(p.id)).primaryAction).toBe("sync");
    // The next sync brings v2 and clears it.
    await synced(p.id);
    expect(world.read(p.distribution, "main", "src/util.c")).toBe("v2");
    expect((await projectRow(p.id)).sourceAheadSha).toBeNull();
  });

  it("refuses a rewritten source under `whole` (409 source_rewritten, audited, nothing changed, the lease given back)", async () => {
    const p = await project({ body: { sourceStrategy: "whole" }, commits: 2 });
    const distBefore = head(p.distribution);
    // The teacher rewrote the branch: its history no longer descends from what was handed out.
    world.git(p.source, "update-ref", "refs/heads/main", "main^");
    await sourcePush(p, { "README.md": "# Rewritten" });
    expect(refusal(await sync(p.id))).toEqual([409, "source_rewritten"]);
    expect(await auditOf(p.id, "project.sync_failed")).toMatchObject([{ payload: { reason: "source_rewritten" } }]);
    expect(head(p.distribution)).toBe(distBefore);
    expect(await projectRow(p.id)).toMatchObject({ syncJobAt: null, syncedAt: null });
    expect(await auditOf(p.id, "project.sync_requested")).toHaveLength(0);
    // Given back: the next request is refused for the same reason, not as in progress.
    expect(refusal(await sync(p.id))).toEqual([409, "source_rewritten"]);
  });

  it("refuses an archived project and a sync under way; a draft syncs its distribution only; a student, a stranger: 404", async () => {
    const p = await project();
    await sourcePush(p, { "src/util.c": "v1" });
    const res = await queued(() => sync(p.id));
    expect(res.statusCode, res.body).toBe(202);
    expect(refusal(await sync(p.id))).toEqual([409, "sync_in_progress"]);
    expect((await detail(p.id)).sync.inProgress).toBe(true);
    for (const job of jobsOf(p.id)) await runSyncJob(server.app, config, job);
    expect((await detail(p.id)).sync.inProgress).toBe(false);
    await synced(p.id);

    expect((await call("POST", `/app/api/projects/${p.id}/archive`, teacher.headers)).statusCode).toBe(200);
    expect(refusal(await sync(p.id))).toEqual([409, "project_archived"]);

    const draft = await project({ publish: false });
    const after = await sourcePush(draft, { "src/util.c": "v1" });
    await synced(draft.id);
    expect(world.read(draft.distribution, "main", "src/util.c")).toBe("v1");
    expect(await projectRow(draft.id)).toMatchObject({ sourceAheadSha: null, sourceHeads: { main: after }, state: "draft" });
    expect((await auditOf(draft.id, "project.synced"))[0]!.payload).toMatchObject({ opened: 0, skipped: 0 });

    const stranger = await server.signIn("teacher");
    expect((await sync(draft.id, stranger.headers)).statusCode).toBe(404);
    expect((await sync(p.id, p.students[0]!.headers)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- the pull requests

describe("the pull_request events (F-PROJ-12)", () => {
  it("keeps the state of the App's sync pull request — merged, closed —, ignores another author or head, and a replay about an older pull request", async () => {
    const p = await project();
    const repo = p.repos[0]!;
    await sourcePush(p, { "src/util.c": "v1" });
    await synced(p.id);
    const [pr] = pulls(repo.fullName!);

    await handled("pull_request", prEvent(repo, { action: "closed", number: pr!.number, merged: true }));
    expect(await prRows(repo.id)).toMatchObject([{ branch: "main", prNumber: pr!.number, state: "merged" }]);
    expect((await detail(p.id)).rows[0]!.repo!.sync.pr).toEqual({ number: pr!.number, state: "merged" });

    // A newer pull request opened on the branch (the next sync's): the row follows it.
    await handled("pull_request", prEvent(repo, { action: "opened", number: pr!.number + 1 }));
    expect(await prRows(repo.id)).toMatchObject([{ prNumber: pr!.number + 1, state: "open" }]);
    // A replay about the older one changes nothing.
    await handled("pull_request", prEvent(repo, { action: "closed", number: pr!.number, merged: false }));
    expect(await prRows(repo.id)).toMatchObject([{ prNumber: pr!.number + 1, state: "open" }]);
    // Another author's pull request from sync/main, and the App's from another head: not the sync's.
    await handled("pull_request", prEvent(repo, { action: "opened", number: 50, login: p.students[0]!.login }));
    await handled("pull_request", prEvent(repo, { action: "opened", number: 51, headRef: "feature/x" }));
    expect(await prRows(repo.id)).toMatchObject([{ prNumber: pr!.number + 1, state: "open" }]);
  });
});

// ---------------------------------------------------------------- protected files after a sync

describe("protected files after a sync (ADR-062 addendum)", () => {
  it("restores a protected file to the distribution's NEW version, and nothing when the student's copy already is it", async () => {
    const p = await project();
    const repo = p.repos[0]!;
    await sourcePush(p, { [GRADING]: "grade: v2" });
    await synced(p.id);
    const [org] = await server.app.db.select().from(githubOrganizations).where(eq(githubOrganizations.login, p.org));
    const { octokit } = await installationClient(config, org!.installationId!);
    const restore = () =>
      revertProtectedFiles({
        octokit,
        org: p.org,
        studentRepo: repo.fullName!.split("/")[1]!,
        squashedRepo: p.distribution.split("/")[1]!,
        branch: "main",
        paths: [GRADING],
        beforeMove: async () => true,
      });
    // The student's copy is the old version: restored to the new one, on top of their work.
    const studentHead = head(repo.fullName!);
    const { restored } = await restore();
    expect(restored).toMatchObject({ files: [GRADING], covered: studentHead });
    expect(world.read(repo.fullName!, "main", GRADING)).toBe("grade: v2");
    // Already the distribution's: nothing to restore (the head read, no restore commit).
    expect(await restore()).toEqual({ head: head(repo.fullName!), restored: null });
  });
});
