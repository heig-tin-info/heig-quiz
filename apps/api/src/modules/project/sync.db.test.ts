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
 *   version, and never when the student's copy already is it (ADR-062);
 * - ADR-132 §10: the preview lists what the following sync commits (the
 *   hand-out, `whole`, the protected marked; the cap is the domain's test) and writes nothing;
 *   the teacher's message stored, replaced, cleared, capped, quoted inert
 *   in the pull request and its comment, shown to every student and the
 *   staff; the repositories graded before the latest update.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectDetail, ProjectErrorCode, ProjectSummary, ProjectSyncAccepted, ProjectSyncPreview, StudentProject } from "@quiz/contracts";
import { SYNC_MESSAGE_MAX } from "@quiz/domain";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { loadConfig } from "../../config.js";
import {
  auditLog,
  botCommits,
  githubOrganizations,
  gradeDispatches,
  projectCriteria,
  projectRepos,
  projects,
  projectSyncPrs,
  webhookDeliveries,
} from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { revertProtectedFiles } from "../../github/revert.js";
import { SYNC_COMMIT_MESSAGE } from "../../github/sync.js";
import { orgsRoute, signedDelivery } from "../../github/testing.js";
import { PROJECT_SYNC_QUEUE, type JobQueue } from "../../jobs.js";
import { seedLive } from "../../test/live.js";
import type { ProjectJob } from "./lease.js";
import { runSyncJob } from "./sync.js";
import {
  APP_ENV,
  call,
  gh,
  linkClassroom,
  newOrg,
  newStudent,
  server,
  teacher,
  useProjectWorld,
  usersRoute,
  WEBHOOK_SECRET,
  world,
} from "../../test/projectWorld.js";

const APP_BOT = "quiz-test[bot]";
const config = loadConfig({ NODE_ENV: "test", ...APP_ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const GRADING = ".github/workflows/grading.yml";
const HOUR = 3_600_000;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);
const short = (sha: string) => sha.slice(0, 7);

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
  const { login, orgId } = await newOrg("sorg");
  world.source(
    login,
    "starter",
    { main: { "README.md": "# Lab", "src/main.c": "int main(){}", [GRADING]: "grade: v1" }, dev: { "README.md": "# Dev" } },
    opts.commits ?? 1,
  );
  await linkClassroom(seeded.classroomId, orgId);
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
const deliver = (event: string, payload: object, id = randomUUID()) => signedDelivery(server.app, WEBHOOK_SECRET, payload, { event, id });
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

useProjectWorld({ routes: [orgsRoute(() => []), usersRoute, world.route] });

beforeEach(() => {
  server.clock.set(NOW);
  sent.length = 0;
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
  it("says in the pull request what grading takes from the update: nothing until merged, or, graded by a v3 snapshot, the protected files and criteria.yml either way (ADR-132 §7)", async () => {
    const p = await project();
    const parsed = parseCriteria("schema_version: 3\ncriteria:\n  code:\n    format: {description: Format, max_points: 1, command: [make]}\n", { version: 3 });
    if (!parsed.ok) throw new Error("the fixture does not parse");
    await server.app.db.update(projects).set({ gradingMode: "criteria" }).where(eq(projects.id, p.id));
    await server.app.db
      .insert(projectCriteria)
      .values({ projectId: p.id, fileSha: "f", sourceSha: head(p.distribution), criteria: parsed.criteria, loadedAt: new Date(NOW) });
    await sourcePush(p, { "src/util.c": "int util;" });
    await synced(p.id);
    const [pr] = pulls(p.repos[0]!.fullName!);
    expect(pr!.body).toContain("Merged or not, your work is graded with your teacher's version of the protected files and of `criteria.yml`");
    expect(pr!.body).not.toContain("never depends");
  });
  it("updates the distribution, pushes sync/<branch>, records the bot commit, opens ONE pull request per repository naming the distribution's sha, stores it; the source is no longer ahead; nothing of it reaches a student", async () => {
    const p = await project({ students: 2 });
    const [r1, r2] = p.repos as [Repo, Repo];
    const sourceSha = await sourcePush(p, { "src/util.c": "int util;", "README.md": "# Lab v2" });
    const distBefore = head(p.distribution);
    // A temporary ref a previous sync failed to delete: the next push forces it.
    world.git(p.distribution, "update-ref", "refs/quiz/tmp-main", distBefore);

    server.clock.set(at(NOW, HOUR));
    expect(await synced(p.id)).toEqual({ requestedAt: at(NOW, HOUR).toISOString() });

    // The distribution: one commit on top, the source's tree, no sha of the source in it (N-SEC-20).
    const distHead = head(p.distribution);
    expect(head(p.distribution, "main^")).toBe(distBefore);
    expect(world.git(p.distribution, "log", "-1", "--format=%s", "main").trim()).toBe(SYNC_COMMIT_MESSAGE);
    expect(world.read(p.distribution, "main", "src/util.c")).toBe("int util;");
    // That commit is the API's, GitHub-signed for the App (#917): the App's
    // author, GitHub's committer; the temporary ref that carried its tree
    // deleted.
    expect(world.git(p.distribution, "log", "-1", "--format=%H|%an|%cn", "main").trim()).toBe(`${distHead}|${world.botLogin}|GitHub`);
    expect(world.git(p.distribution, "for-each-ref", "--format=%(refname)", "refs/quiz").trim()).toBe("");
    const row = await projectRow(p.id);
    expect(row).toMatchObject({ sourceHeads: { main: sourceSha }, sourceAheadSha: null, sourceAhead: null, syncedAt: at(NOW, HOUR), syncJobAt: null });
    expect(await auditOf(p.id, "project.sync_requested")).toMatchObject([{ actorUserId: teacher.id, payload: { changed: ["main"] } }]);
    expect(await auditOf(p.id, "project.synced")).toMatchObject([
      { actorType: "system", payload: { opened: 2, updated: 0, upToDate: 0, failed: 0, skipped: 0, failedRepos: [] } },
    ]);

    for (const repo of [r1, r2]) {
      expect(head(repo.fullName!, "sync/main")).toBe(distHead);
      expect(head(repo.fullName!, "main")).not.toBe(distHead); // the student's branch untouched
      expect(world.git(repo.fullName!, "for-each-ref", "--format=%(refname)", "refs/quiz").trim()).toBe("");
      expect(await syncCommits(repo.id)).toMatchObject([{ sha: distHead }]);
      const [pr] = pulls(repo.fullName!);
      expect(pulls(repo.fullName!)).toHaveLength(1);
      expect(pr).toMatchObject({ title: `Project update (${short(distHead)})`, head: { ref: "sync/main" }, base: { ref: "main" }, state: "open" });
      expect(pr!.body).toContain("`src/util.c`");
      expect(pr!.body).toContain("Your score never depends on this pull request until you merge it.");
      expect(`${pr!.title}\n${pr!.body}`).not.toContain(short(sourceSha));
      expect(await prRows(repo.id)).toMatchObject([{ branch: "main", prNumber: pr!.number, state: "open" }]);
      expect(await repoRow(repo.id)).toMatchObject({ syncOutcome: "opened", syncOutcomeAt: at(NOW, HOUR) });
    }

    const d = await detail(p.id);
    expect(d.sync).toEqual({ ahead: null, inProgress: false, syncedAt: at(NOW, HOUR).toISOString(), last: { opened: 2, updated: 0, upToDate: 0, failed: 0, skipped: 0 }, message: null, gradedBefore: 0 });
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

  it("fails nothing when the temporary ref cannot be deleted: the distribution and the students get the signed commit (#917)", async () => {
    const p = await project();
    await sourcePush(p, { "src/util.c": "v1" });
    const routes = gh.routes;
    gh.routes = [(url, req) => (req.method === "DELETE" && url.pathname.includes("/git/refs/") ? new Response("{}", { status: 500 }) : undefined), ...routes];
    try {
      await synced(p.id);
    } finally {
      gh.routes = routes;
    }
    expect(world.git(p.distribution, "log", "-1", "--format=%an", "main").trim()).toBe(world.botLogin);
    expect(world.git(p.distribution, "for-each-ref", "--format=%(refname)", "refs/quiz").trim()).toBe("refs/quiz/tmp-main");
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
    expect(world.apiCommits.filter((c) => c.repo === p.distribution)).toEqual([]); // `whole` creates no commit
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

// ---------------------------------------------------------------- the preview, the message, the notice (ADR-132 §10)

const preview = (id: string, headers = teacher.headers) => call("GET", `/app/api/projects/${id}/sync/preview`, headers);
async function previewed(id: string) {
  const res = await preview(id);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectSyncPreview.parse(res.json());
}
/** What the distribution's last update changed, by git: `<change> <path>` sorted, as the preview lists it. */
function committed(fullName: string, from: string, to = "main"): string[] {
  const letter: Record<string, string> = { A: "added", D: "deleted", M: "modified" };
  return world
    .git(fullName, "diff", "--name-status", "--no-renames", from, to)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      return `${letter[status!]} ${path}`;
    })
    .sort();
}
const listed = (p: ProjectSyncPreview, branch = "main") =>
  p.branches.find((b) => b.branch === branch)!.paths.map((x) => `${x.change} ${x.path}`).sort();
/** Everything a preview must leave as it was: the distribution, its refs, the project's row, the audit. */
async function untouched(p: Project) {
  return {
    head: head(p.distribution),
    refs: world.git(p.distribution, "for-each-ref", "--format=%(refname) %(objectname)"),
    apiCommits: world.apiCommits.length,
    row: await projectRow(p.id),
    audit: (await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, p.id))).length,
  };
}
/** A schema-3 snapshot read at `sourceSha` (ADR-119), the project switched to `criteria`. */
async function criteriaV3(projectId: string, sourceSha: string) {
  const parsed = parseCriteria("schema_version: 3\ncriteria:\n  code:\n    format: {description: Format, max_points: 1, command: [make]}\n", { version: 3 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await server.app.db.update(projects).set({ gradingMode: "criteria" }).where(eq(projects.id, projectId));
  await server.app.db
    .insert(projectCriteria)
    .values({ projectId, fileSha: "f", sourceSha, criteria: parsed.criteria, loadedAt: new Date(NOW) })
    .onConflictDoUpdate({ target: projectCriteria.projectId, set: { sourceSha } });
}

describe("the sync's preview (ADR-132 §10)", () => {
  it("lists what the following sync commits — added, modified, deleted, the protected marked first —, and writes nothing", async () => {
    const p = await project();
    await sourcePush(p, { "src/util.c": "int util;", "README.md": "# Lab v2", "src/main.c": null, [GRADING]: "grade: v2" });
    const before = await untouched(p);
    const shown = await previewed(p.id);
    expect(shown).toEqual({
      protectedGraded: false,
      branches: [
        {
          branch: "main",
          paths: [
            { path: GRADING, change: "modified", protected: true },
            { path: "README.md", change: "modified", protected: false },
            { path: "src/main.c", change: "deleted", protected: false },
            { path: "src/util.c", change: "added", protected: false },
          ],
          more: 0,
        },
      ],
    });
    // Nothing written, on GitHub or here.
    expect(await untouched(p)).toEqual(before);

    await synced(p.id);
    expect(committed(p.distribution, before.head)).toEqual(listed(shown));
    // Synced: nothing left to send.
    expect(await previewed(p.id)).toEqual({ protectedGraded: false, branches: [{ branch: "main", paths: [], more: 0 }] });
    // Graded by a schema-3 snapshot: the protected paths are graded as the distribution has them, merged or not.
    await criteriaV3(p.id, head(p.distribution));
    expect((await previewed(p.id)).protectedGraded).toBe(true);
  });

  it("goes through the hand-out: a changed .studentignore takes a path out, the overlay and the ignore file never appear", async () => {
    const p = await project();
    await sourcePush(p, { ".studentignore": "src/main.c\n", "student/src/util.c": "/* todo */", "src/util.c": "int solved;" });
    const shown = await previewed(p.id);
    expect(listed(shown)).toEqual(["added src/util.c", "deleted src/main.c"]);
    const distBefore = head(p.distribution);
    await synced(p.id);
    expect(committed(p.distribution, distBefore)).toEqual(listed(shown));
    expect(world.read(p.distribution, "main", "src/util.c")).toBe("/* todo */");
  });

  it("under `whole`, lists the difference between the distribution's head and the source's; a rewritten source is refused as the sync is", async () => {
    const p = await project({ body: { sourceStrategy: "whole" }, commits: 2 });
    await sourcePush(p, { "src/util.c": "int util;", ".studentignore": "src/main.c\n" });
    const before = await untouched(p);
    const shown = await previewed(p.id);
    // No hand-out under `whole`: the ignore file is handed out as it is.
    expect(listed(shown)).toEqual(["added .studentignore", "added src/util.c"]);
    expect(await untouched(p)).toEqual(before);
    await synced(p.id);
    expect(committed(p.distribution, before.head)).toEqual(listed(shown));

    world.git(p.source, "update-ref", "refs/heads/main", "main~2");
    await sourcePush(p, { "README.md": "# Rewritten" });
    expect(refusal(await preview(p.id))).toEqual([409, "source_rewritten"]);
    expect(await auditOf(p.id, "project.sync_failed")).toHaveLength(0);
  });

  it("is refused while a sync runs and on an archived project; a student and a teacher off the staff get the 404 of a missing project", async () => {
    const p = await project();
    await sourcePush(p, { "src/util.c": "v1" });
    expect((await queued(() => sync(p.id))).statusCode).toBe(202);
    expect(refusal(await preview(p.id))).toEqual([409, "sync_in_progress"]);
    for (const job of jobsOf(p.id)) await runSyncJob(server.app, config, job);
    expect((await preview(p.id)).statusCode).toBe(200);

    const stranger = await server.signIn("teacher");
    expect((await preview(p.id, stranger.headers)).statusCode).toBe(404);
    expect((await preview(p.id, p.students[0]!.headers)).statusCode).toBe(404);
    expect((await call("POST", `/app/api/projects/${p.id}/archive`, teacher.headers)).statusCode).toBe(200);
    expect(refusal(await preview(p.id))).toEqual([409, "project_archived"]);
  });
});

describe("the teacher's message (ADR-132 §10)", () => {
  /** Every Markdown trap a message can hold: a team mention, an issue reference, a closing tag, a closing fence, inline code. */
  const HOSTILE = "Test 3 fixed, see #123 @org/team\n</details>\n```\n**merge now** `x`";
  const syncWith = (id: string, message: unknown) => call("POST", `/app/api/projects/${id}/sync`, teacher.headers, { message });
  /** The body's text outside the teacher's fenced block, and the block's content. */
  const split = (body: string) => {
    const [before, rest] = body.split("````text\n") as [string, string];
    const [inside, after] = rest.split("\n````") as [string, string];
    return { outside: before + after, inside };
  };

  it("is stored trimmed with the sync, quoted inert in the pull request and its comment, replaced by the next, cleared by none; shown to every student and the staff", async () => {
    const p = await project({ students: 2 });
    const [open, locked] = p.repos as [Repo, Repo];
    await server.app.db.update(projectRepos).set({ lockedAt: at(NOW) }).where(eq(projectRepos.id, locked.id));
    await sourcePush(p, { "src/util.c": "v1" });
    server.clock.set(at(NOW, HOUR));
    expect((await syncWith(p.id, `  ${HOSTILE}  \n`)).statusCode).toBe(202);
    expect(await projectRow(p.id)).toMatchObject({ syncMessage: HOSTILE, syncMessageAt: at(NOW, HOUR) });
    expect(await auditOf(p.id, "project.sync_requested")).toMatchObject([{ payload: { message: HOSTILE } }]);

    // The pull request quotes it in a fence no line of it can close: nothing of it acts on GitHub.
    const [pr] = pulls(open.fullName!);
    const body = split(pr!.body as string);
    expect(body.inside).toBe(HOSTILE);
    for (const live of ["@org", "#123", "</details>", "**merge now**"]) expect(body.outside, live).not.toContain(live);
    expect(pulls(locked.fullName!)).toHaveLength(0); // skipped: no pull request

    // The staff read it beside the last sync; every student on their page, the skipped one too, and nothing else of the sync.
    expect((await detail(p.id)).sync.message).toEqual({ text: HOSTILE, at: at(NOW, HOUR).toISOString() });
    for (const student of p.students) {
      const res = await call("GET", `/app/api/student/projects/${p.id}`, student.headers);
      expect(StudentProject.parse(res.json()).projectUpdate).toEqual({ text: HOSTILE, at: at(NOW, HOUR).toISOString() });
      for (const secret of ["starter", "syncMessage", "sync_message", "opened", "skipped"]) expect(res.body, secret).not.toContain(secret);
      const home = await call("GET", "/app/api/student/home", student.headers);
      expect(home.body).not.toContain("Test 3 fixed");
    }

    // The next sync's message replaces it, and the comment on the open pull request quotes the new one.
    await sourcePush(p, { "src/util.c": "v2" });
    expect((await syncWith(p.id, "Second fix")).statusCode).toBe(202);
    expect((await projectRow(p.id)).syncMessage).toBe("Second fix");
    expect(comments(open.fullName!, pr!.number)).toEqual([expect.stringContaining("```text\nSecond fix\n```")]);
    // The same text again (a retry) keeps its date and says nothing again; a new text with nothing new to send still reaches the open pull request.
    server.clock.set(at(NOW, 2 * HOUR));
    expect((await syncWith(p.id, "Second fix")).statusCode).toBe(202);
    expect(await projectRow(p.id)).toMatchObject({ syncMessage: "Second fix", syncMessageAt: at(NOW, HOUR) });
    expect(comments(open.fullName!, pr!.number)).toHaveLength(1);
    expect((await syncWith(p.id, "Third note")).statusCode).toBe(202);
    expect(comments(open.fullName!, pr!.number)).toHaveLength(2);
    expect(comments(open.fullName!, pr!.number)[1]).toBe("Your teacher's message:\n\n```text\nThird note\n```");
    // A sync with none, or an empty one, clears it.
    await sourcePush(p, { "src/util.c": "v3" });
    expect((await syncWith(p.id, "   ")).statusCode).toBe(202);
    expect(await projectRow(p.id)).toMatchObject({ syncMessage: null, syncMessageAt: null });
    expect((await call("GET", `/app/api/student/projects/${p.id}`, p.students[0]!.headers)).json()).toMatchObject({ projectUpdate: null });
    expect((await synced(p.id)).requestedAt).toBeTruthy(); // no body at all: as before
    expect((await detail(p.id)).sync.message).toBeNull();
  });

  it("refuses a message above the limit, and anything but text", async () => {
    const p = await project();
    expect((await syncWith(p.id, "x".repeat(SYNC_MESSAGE_MAX + 1))).statusCode).toBe(400);
    expect((await syncWith(p.id, 42)).statusCode).toBe(400);
    expect((await call("POST", `/app/api/projects/${p.id}/sync`, teacher.headers, { message: "ok", extra: 1 })).statusCode).toBe(400);
    // A control or direction character, refused before anything moves: a NUL would fail the write after the distribution's push.
    for (const bad of ["a\u0000b", "a\u0007b", "a\u0085b", "a\u202eb", "a\u2066b", "a\ud800b"]) {
      expect((await syncWith(p.id, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await auditOf(p.id, "project.sync_requested")).toHaveLength(0);
    // Trimmed first: spaces around a full message do not count.
    expect((await syncWith(p.id, ` ${"x".repeat(SYNC_MESSAGE_MAX)}\t `)).statusCode).toBe(202);
    expect(await auditOf(p.id, "project.sync_requested")).toHaveLength(1);
  });

  it("is never kept on a draft, which no student reads; published, it is", async () => {
    const draft = await project({ publish: false });
    expect((await syncWith(draft.id, "Before anyone started")).statusCode).toBe(202);
    expect(await projectRow(draft.id)).toMatchObject({ syncMessage: null, syncMessageAt: null });
    expect(await auditOf(draft.id, "project.sync_requested")).toMatchObject([{ payload: { message: null } }]);
    expect((await call("POST", `/app/api/projects/${draft.id}/publish`, teacher.headers)).statusCode).toBe(200);
    expect((await syncWith(draft.id, "Now it is read")).statusCode).toBe(202);
    expect(await projectRow(draft.id)).toMatchObject({ syncMessage: "Now it is read", syncMessageAt: at(NOW) });
  });
});

describe("the repositories graded before the latest update (ADR-132 §10)", () => {
  it("counts the frozen repositories whose latest final pass or Regrade grafted from another distribution commit than the snapshot's, in a criteria v3 project only", async () => {
    const p = await project({ students: 3 });
    const [a, b, c] = p.repos as [Repo, Repo, Repo];
    const db = server.app.db;
    const pass = (repoId: string, trigger: "deadline" | "regrade", distributionSha: string | null, minutes: number) =>
      db.insert(gradeDispatches).values({ id: randomUUID(), repoId, trigger, sha: "t".repeat(40), distributionSha, createdAt: at(NOW, minutes * 60_000) });
    const gradedBefore = async () => (await detail(p.id)).sync.gradedBefore;

    await db.update(projectRepos).set({ frozenAt: at(NOW) }).where(eq(projectRepos.projectId, p.id));
    await pass(a.id, "deadline", "v1", 1);
    await pass(b.id, "deadline", "v1", 1);
    await pass(c.id, "deadline", null, 1); // claimed before ADR-132: no commit recorded
    // Not graded by criteria v3: nothing.
    expect(await gradedBefore()).toBe(0);
    await criteriaV3(p.id, "v1");
    expect(await gradedBefore()).toBe(0);

    // A sync moved the snapshot: the two passes grafted from v1 were graded before it.
    await criteriaV3(p.id, "v2");
    expect(await gradedBefore()).toBe(2);
    // A Regrade of one grafts from the snapshot: it leaves the count; a repository not frozen is not counted.
    await pass(a.id, "regrade", "v2", 2);
    await db.update(projectRepos).set({ frozenAt: null }).where(eq(projectRepos.id, b.id));
    expect(await gradedBefore()).toBe(0);
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
