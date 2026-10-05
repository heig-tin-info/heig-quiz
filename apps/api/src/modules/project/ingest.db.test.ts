/**
 * GitHub's events on projects (merge task M3-04), through the real intake
 * (`POST /webhooks/github`, signed) on a server built with Quiz's App,
 * against the fake GitHub (`github/testing.ts`) and the local bare
 * repositories (`./testing.ts`) git really pushes to and the App's Git Data
 * API really commits in. Ported from heig-classroom's `grading.db.test` and
 * `webhooks.db.test`, plus what Quiz decided on 2026-10-02:
 *
 * - a push: the receipt (by the server's clock), the last commit, a
 *   workflow's commit recorded as a bot commit;
 * - protected files: restored to the distribution's CURRENT version after a
 *   student's push and after a workflow's commit, never after the App's; a
 *   long or forced push read through GitHub's compare; a redelivery never
 *   restores twice; past five restores in an hour, suspended, audited once,
 *   its runs `to_verify`; a run on a restored head never the score, in
 *   either order; the CI state of the student's commit after a restore;
 *   the restored-heads window read on the restore's branch and bounded by
 *   the covered head's receipt; a move GitHub refused (422) answered by a
 *   row without a restore, filled in by a retry that restores (M3-06b);
 * - runs: counted only on a handed-out branch and a head that is no bot
 *   commit; once per (repository, run, attempt); GRADE parsed (`ok`,
 *   `multiple`, `malformed` with its reason, `no_annotation`); the current
 *   score's rule, the `fallback` rule; GR-14.3; the review slot only once
 *   frozen; the grace refresh of the frozen slot;
 * - `member`, `repository` (renamed, deleted), `organization` renamed — a
 *   stale rename replayed changes nothing, another organization untouched;
 * - hints to the repository's student and the course's staff, never to the
 *   classroom nor another student (N-SEC-20, I41);
 * - a rate-limited delivery sent again at the reset, no retry spent.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectSummary } from "@quiz/contracts";
import { GRADING_WORKFLOW_PATH } from "@quiz/domain";

import { loadConfig } from "../../config.js";

import {
  auditLog,
  botCommits,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectGradeRuns,
  projectRepos,
  projects,
  pushReceipts,
  reverts,
  webhookDeliveries,
} from "../../db/schema.js";
import { subscribe, type BusMessage } from "../../events.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, json, orgsRoute, signedDelivery, type Route } from "../../github/testing.js";
import type { JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { processDelivery } from "../github/deliveries.js";
import { onEvent } from "../github/service.js";
import { MAX_RESTORES_PER_HOUR } from "./protection.js";
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
const ACTIONS_BOT = "github-actions[bot]";
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";
const MINUTE = 60_000;
const GRADING = ".github/workflows/grading.yml";

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 12_000;
let nextAccount = 15_000;

/** GitHub's accounts by id, for Accept's login lookup. */
const accounts = new Map<number, string>();
const usersRoute: Route = (url, req) => {
  const m = /^\/user\/(\d+)$/.exec(url.pathname);
  if (url.host !== "api.github.com" || req.method !== "GET" || !m) return undefined;
  const login = accounts.get(Number(m[1]));
  return login === undefined ? undefined : json({ id: Number(m[1]), login });
};

/** The CI of a commit, by sha: its check suite's annotations and its runs' conclusions. */
const ci = new Map<string, { suite: number; annotations: { title: string; message: string }[]; conclusions: string[] }>();
/** The check runs listed so far: their commit, or null for another workflow's suite. */
const checkRuns = new Map<number, string | null>();
let annotationReads = 0;
const ciRoute: Route = (url, req) => {
  if (url.host !== "api.github.com" || req.method !== "GET") return undefined;
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname))) {
    const c = ci.get(m[1]!);
    if (!c) return json({ total_count: 0, check_runs: [] });
    const own = checkRuns.size + 1;
    checkRuns.set(own, m[1]!);
    checkRuns.set(own + 1, null);
    return json({
      total_count: 2,
      check_runs: [
        { id: own, check_suite: { id: c.suite }, output: { annotations_count: c.annotations.length } },
        // Another workflow's suite on the same commit: its GRADE is never read.
        { id: own + 1, check_suite: { id: c.suite + 1 }, output: { annotations_count: 1 } },
      ],
    });
  }
  if ((m = /^\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)\/annotations$/.exec(url.pathname))) {
    annotationReads++;
    const sha = checkRuns.get(Number(m[1]));
    const annotations = sha ? (ci.get(sha)?.annotations ?? []) : [{ title: "GRADE", message: "6/6" }];
    return json(annotations.map((a) => ({ annotation_level: "notice", ...a })));
  }
  if (/^\/repos\/[^/]+\/[^/]+\/actions\/runs$/.test(url.pathname)) {
    const c = ci.get(url.searchParams.get("head_sha") ?? "");
    return json({ total_count: 0, workflow_runs: (c?.conclusions ?? []).map((conclusion) => ({ status: "completed", conclusion })) });
  }
  return undefined;
};

/** While true, GitHub refuses to read a branch's ref: a restore fails, its delivery stays to retry. */
let refsRefused = false;
const refsDown: Route = (url) =>
  refsRefused && /\/git\/ref\//.test(url.pathname) ? json({ message: "Unprocessable" }, 422) : undefined;
/** While set, GitHub refuses the NEXT move of a branch (a student's push raced the restore): the 422 of a fast-forward refused. */
let moveRefused = false;
const moveDown: Route = (url, req) => {
  if (!moveRefused || req.method !== "PATCH" || !/\/git\/refs\//.test(url.pathname)) return undefined;
  moveRefused = false;
  return json({ message: "Update is not a fast forward" }, 422);
};

/** Every hint published, as the bus carried it. */
const hints: Extract<BusMessage, { kind: "hint" }>[] = [];

const deliver = (event: string, payload: object, id = randomUUID()) => signedDelivery(server.app, SECRET, payload, { event, id });
async function handled(event: string, payload: object, id = randomUUID()): Promise<string> {
  const res = await deliver(event, payload, id);
  expect(res.statusCode, res.body).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.error ?? null).toBeNull();
    expect(row?.processedAt).not.toBeNull();
    // A restore is a few git processes: slower than waitFor's default second.
  }, { timeout: 20_000 });
  return id;
}
/** A push delivery whose handling fails (the error kept on its row, for a retry): its id. */
async function failedDelivery(payload: object): Promise<string> {
  const id = randomUUID();
  expect((await deliver("push", payload, id)).statusCode).toBe(200);
  await vi.waitFor(async () => {
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row?.error).toBeTruthy();
  }, { timeout: 20_000 });
  return id;
}

async function newStudent() {
  const signed = await server.signIn("student");
  const githubUserId = nextAccount++;
  const login = `kid${githubUserId}`;
  await server.app.db.insert(githubAccounts).values({ userId: signed.id, githubUserId, login });
  accounts.set(githubUserId, login);
  return { ...signed, login };
}

/** A student's accepted repository of a published project whose source protects `grading.yml`. */
async function acceptedRepo(opts: { protectedFiles?: string[]; branches?: string[] } = {}) {
  const db = server.app.db;
  const student = await newStudent();
  const other = await newStudent();
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id, other.id], questions: 0 });
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "starter", {
    main: { "README.md": "# Lab", "src/main.c": "int main(){}", [GRADING]: "grade: v1" },
    dev: { "README.md": "# Dev" },
  });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const created = await server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${seeded.classroomId}/projects`,
    headers: teacher.headers,
    payload: { name: "Lab 1", sourceRepo: "starter", deadlineAt: DEADLINE, protectedFiles: opts.protectedFiles ?? [GRADING], ...(opts.branches ? { branches: opts.branches } : {}) },
  });
  expect(created.statusCode, created.body).toBe(201);
  const project = ProjectSummary.parse(created.json());
  expect((await server.app.inject({ method: "POST", url: `/app/api/projects/${project.id}/publish`, headers: teacher.headers })).statusCode).toBe(200);
  const accepted = await server.app.inject({ method: "POST", url: `/app/api/student/projects/${project.id}/accept`, headers: student.headers });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const repo = await repoRow(project.id);
  return {
    projectId: project.id,
    courseId: seeded.courseId,
    classroomId: seeded.classroomId,
    org: login,
    githubOrgId: n,
    student,
    other,
    repo,
    fullName: repo.fullName!,
    distribution: `${login}/lab-1-squashed`,
    githubRepoId: repo.githubRepoId!,
  };
}
type Fixture = Awaited<ReturnType<typeof acceptedRepo>>;

async function repoRow(projectId: string) {
  const [row] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, projectId));
  return row!;
}
const head = (f: Fixture, branch = "main") => world.git(f.fullName, "rev-parse", branch).trim();

/** A push of `files` on `branch` by `login` (the student by default), delivered and handled. */
async function push(
  f: Fixture,
  files: Record<string, string | null>,
  opts: { login?: string; branch?: string; forced?: boolean; listed?: number } = {},
) {
  const branch = opts.branch ?? "main";
  const before = head(f, branch);
  const after = world.commit(f.fullName, branch, files);
  const payload = pushPayload(f, { branch, before, after, files, ...opts });
  await handled("push", payload);
  return { before, after, payload };
}
function pushPayload(
  f: Fixture,
  p: { branch: string; before: string; after: string; files: Record<string, string | null>; login?: string; forced?: boolean; listed?: number },
) {
  const changed = Object.keys(p.files);
  // `listed`: the payload's commits, as GitHub lists at most 20 — none of them naming the files.
  const commits =
    p.listed !== undefined
      ? Array.from({ length: p.listed }, () => ({ added: [], modified: ["notes.txt"], removed: [] }))
      : [{ added: [], modified: changed.filter((k) => p.files[k] !== null), removed: changed.filter((k) => p.files[k] === null) }];
  return {
    ref: `refs/heads/${p.branch}`,
    before: p.before,
    after: p.after,
    forced: p.forced ?? false,
    repository: { id: f.githubRepoId, full_name: f.fullName },
    sender: { login: p.login ?? f.student.login },
    head_commit: { timestamp: NOW },
    commits,
  };
}

/** A completed run of `workflow` on `sha`, as GitHub's `workflow_run` describes it. */
function runPayload(f: Fixture, sha: string, over: Record<string, unknown> = {}, action = "completed") {
  return {
    action,
    repository: { id: f.githubRepoId },
    workflow_run: {
      id: Math.floor(Math.random() * 1e9),
      run_attempt: 1,
      head_branch: "main",
      head_sha: sha,
      conclusion: "success",
      path: GRADING_WORKFLOW_PATH,
      event: "push",
      check_suite_id: 77,
      updated_at: server.clock.now().toISOString(),
      ...over,
    },
  };
}
function scored(sha: string, ...annotations: { title: string; message: string }[]) {
  ci.set(sha, { suite: 77, annotations, conclusions: ["success"] });
}
async function runs(f: Fixture) {
  return server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.repoId, f.repo.id));
}
async function runOf(f: Fixture, workflowRunId: number) {
  return (await runs(f)).find((r) => r.workflowRunId === workflowRunId);
}
const auditOf = (subjectId: string, action: string) =>
  server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
const restores = (f: Fixture) => server.app.db.select().from(reverts).where(eq(reverts.repoId, f.repo.id));

let unsubscribe: () => void;
beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), usersRoute, refsDown, moveDown, ciRoute, world.route];
  teacher = await server.signIn("teacher");
  unsubscribe = subscribe((m) => {
    if (m.kind === "hint") hints.push(m);
  });
});

beforeEach(() => {
  server.clock.set(NOW);
  hints.length = 0;
});

afterAll(async () => {
  unsubscribe();
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

// ---------------------------------------------------------------- pushes

describe("a push on a student's repository", () => {
  it("is received by the server's clock, records the last commit, and hints the student and the staff only", async () => {
    const f = await acceptedRepo();
    hints.length = 0;
    server.clock.set("2026-10-03T09:00:00.000Z");
    const { after } = await push(f, { "src/main.c": "int main(){return 0;}" });

    const [receipt] = await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.headSha, after));
    expect(receipt).toMatchObject({ githubRepoId: f.githubRepoId, branch: "main", isBot: false });
    expect(receipt!.receivedAt.toISOString()).toBe("2026-10-03T09:00:00.000Z");
    expect(await repoRow(f.projectId)).toMatchObject({ lastCommitSha: after });

    // N-SEC-20, I41: the student's own topic and the course's staff — never
    // the classroom's, where every student listens, nor another student's.
    const projectHints = hints.filter((h) => h.type === "projects");
    expect(projectHints.length).toBeGreaterThan(0);
    for (const h of projectHints) {
      expect(h.topics.sort()).toEqual([`course:${f.courseId}`, `user:${f.student.id}`].sort());
      expect(h.topics).not.toContain(`user:${f.other.id}`);
      expect(h.topics.some((t) => t.startsWith("classroom:"))).toBe(false);
    }
  });

  it("records a workflow's commit as a bot commit, not as the student's last commit; its runs never count", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const before = (await repoRow(f.projectId)).lastCommitSha;
    const { after } = await push(f, { "GRADING.yml": "review: 5/6" }, { login: ACTIONS_BOT });
    const [bot] = await server.app.db.select().from(botCommits).where(and(eq(botCommits.repoId, f.repo.id), eq(botCommits.sha, after)));
    expect(bot?.kind).toBe("grader");
    expect((await repoRow(f.projectId)).lastCommitSha).toBe(before);
    const [receipt] = await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.headSha, after));
    expect(receipt?.isBot).toBe(true);

    scored(after, { title: "GRADE", message: "6/6" });
    const payload = runPayload(f, after);
    await handled("workflow_run", payload);
    expect(await runOf(f, payload.workflow_run.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- protected files

describe("protected files (F-PROJ-08)", () => {
  it("restores a protected file a student changed, keeps the rest of their commit, once", async () => {
    const f = await acceptedRepo();
    const pushed = await push(f, { [GRADING]: "grade: always 6", "src/main.c": "int main(){return 1;}" });

    const restored = head(f);
    expect(restored).not.toBe(pushed.after);
    expect(world.git(f.fullName, "rev-parse", `${restored}^`).trim()).toBe(pushed.after); // a fast-forward on top
    expect(world.read(f.fullName, restored, GRADING)).toBe("grade: v1");
    expect(world.read(f.fullName, restored, "src/main.c")).toBe("int main(){return 1;}");

    const [bot] = await server.app.db.select().from(botCommits).where(and(eq(botCommits.repoId, f.repo.id), eq(botCommits.sha, restored)));
    expect(bot?.kind).toBe("revert");
    expect(await restores(f)).toEqual([expect.objectContaining({ revertSha: restored, files: [GRADING], headSha: pushed.after })]);
    expect(await auditOf(f.repo.id, "project_repo.restore")).toHaveLength(1);

    // The App's own push of the restore: no check, and not the student's last commit.
    await handled("push", { ...pushed.payload, before: pushed.after, after: restored, sender: { login: APP_BOT } });
    expect((await repoRow(f.projectId)).lastCommitSha).toBe(pushed.after);

    // The student's push redelivered (a new delivery id): nothing restored twice, nothing counted twice.
    await handled("push", pushed.payload);
    expect(head(f)).toBe(restored);
    expect(await restores(f)).toHaveLength(1);
  });

  it("never scores a run on a restored head, whether it finished before the restore or after", async () => {
    const f = await acceptedRepo();
    const honest = await push(f, { "src/main.c": "honest" });
    scored(honest.after, { title: "GRADE", message: "3/6" });
    const honestRun = runPayload(f, honest.after);
    await handled("workflow_run", honestRun);
    const honestId = (await runOf(f, honestRun.workflow_run.id))!.id;

    // Before: the tampered run is in, then the push is restored.
    const before = head(f);
    const tamperedFirst = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    scored(tamperedFirst, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const early = runPayload(f, tamperedFirst);
    await handled("workflow_run", early);
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, early.workflow_run.id))!.id);
    await handled("push", pushPayload(f, { branch: "main", before, after: tamperedFirst, files: { [GRADING]: "x" } }));
    expect(await runOf(f, early.workflow_run.id)).toMatchObject({ points: 6, toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe(honestId);

    // After: restored first, the run comes in flagged and out of the score.
    const late = await push(f, { [GRADING]: "grade: 6 again" });
    scored(late.after, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const after = runPayload(f, late.after);
    await handled("workflow_run", after);
    expect(await runOf(f, after.workflow_run.id)).toMatchObject({ points: 6, toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe(honestId);
  });

  it("never scores a later push the restore was built on (S, then S2 before S's delivery)", async () => {
    const f = await acceptedRepo();
    const honest = await push(f, { "src/main.c": "honest" });
    scored(honest.after, { title: "GRADE", message: "3/6" });
    const honestRun = runPayload(f, honest.after);
    await handled("workflow_run", honestRun);

    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    const s2 = world.commit(f.fullName, "main", { "src/main.c": "more work" });
    scored(s2, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const s2Run = runPayload(f, s2);
    await handled("workflow_run", s2Run);
    // S's delivery, handled once S2 is on the branch: the restore covers S2.
    await handled("push", pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(world.git(f.fullName, "rev-parse", `${head(f)}^`).trim()).toBe(s2);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s2 })]);
    // S2's push touches no protected file; its run still never counts.
    await handled("push", pushPayload(f, { branch: "main", before: s, after: s2, files: { "src/main.c": "more work" } }));
    expect(await runOf(f, s2Run.workflow_run.id)).toMatchObject({ points: 6, toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, honestRun.workflow_run.id))!.id);
  });

  it("never scores a head received between the tampering push and its restore (S, S1, S2); a later push counts again", async () => {
    const f = await acceptedRepo();
    const honest = await push(f, { "src/main.c": "honest" });
    scored(honest.after, { title: "GRADE", message: "3/6" });
    await handled("workflow_run", runPayload(f, honest.after));

    // S's delivery fails at first (GitHub refuses), S1 and S2 come in meanwhile.
    refsRefused = true;
    server.clock.advance(MINUTE);
    const base = head(f);
    const sha = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    const sId = await failedDelivery(pushPayload(f, { branch: "main", before: base, after: sha, files: { [GRADING]: "x" } }));
    refsRefused = false;
    const later: string[] = [];
    for (const content of ["more", "and more"]) {
      server.clock.advance(MINUTE);
      later.push((await push(f, { "src/main.c": content })).after);
    }
    server.clock.advance(MINUTE);
    await processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), sId);
    expect(world.git(f.fullName, "rev-parse", `${head(f)}^`).trim()).toBe(later[1]);

    const tampered = [];
    for (const h of [sha, ...later]) {
      scored(h, { title: "GRADE", message: "6/6" });
      server.clock.advance(MINUTE);
      const r = runPayload(f, h);
      await handled("workflow_run", r);
      tampered.push(r.workflow_run.id);
    }
    for (const id of tampered) expect(await runOf(f, id)).toMatchObject({ points: 6, toVerify: true });
    const honestRow = (await runs(f)).find((r) => r.headSha === honest.after)!;
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe(honestRow.id);

    // A push on top of the restore counts again.
    server.clock.advance(MINUTE);
    const fresh = await push(f, { "src/main.c": "after the restore" });
    scored(fresh.after, { title: "GRADE", message: "5/6" });
    server.clock.advance(MINUTE);
    const freshRun = runPayload(f, fresh.after);
    await handled("workflow_run", freshRun);
    expect(await runOf(f, freshRun.workflow_run.id)).toMatchObject({ toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, freshRun.workflow_run.id))!.id);
  });

  it("shows the CI state of the student's commit after a restore, never stuck pending", async () => {
    const f = await acceptedRepo();
    const { after } = await push(f, { [GRADING]: "grade: tampered", "src/main.c": "work" });
    scored(after, { title: "GRADE", message: "4/6" });
    await handled("workflow_run", runPayload(f, after, {}, "requested"));
    expect((await repoRow(f.projectId)).ciStatus).toBe("pending");
    // The restore's own run is a bot commit's: it never marks pending.
    await handled("workflow_run", runPayload(f, head(f), {}, "requested"));
    await handled("workflow_run", runPayload(f, after));
    expect((await repoRow(f.projectId)).ciStatus).toBe("pass");
  });

  it("puts back the distribution's CURRENT version of the branch (2026-10-02)", async () => {
    const f = await acceptedRepo();
    world.commit(f.distribution, "main", { [GRADING]: "grade: v2" });
    await push(f, { [GRADING]: null });
    expect(world.read(f.fullName, head(f), GRADING)).toBe("grade: v2");
  });

  it("restores a protected file a workflow committed (github-actions[bot] is checked too)", async () => {
    const f = await acceptedRepo();
    const { after } = await push(f, { [GRADING]: "grade: hacked by a workflow" }, { login: ACTIONS_BOT });
    expect(head(f)).not.toBe(after);
    expect(world.read(f.fullName, head(f), GRADING)).toBe("grade: v1");
    const kinds = await server.app.db.select().from(botCommits).where(eq(botCommits.repoId, f.repo.id));
    expect(kinds.map((k) => k.kind).sort()).toEqual(["grader", "revert"]);
  });

  it("never checks the App's own push", async () => {
    const f = await acceptedRepo();
    const { after } = await push(f, { [GRADING]: "grade: the App's" }, { login: APP_BOT });
    expect(head(f)).toBe(after);
    expect(await restores(f)).toHaveLength(0);
  });

  it("reads GitHub's compare for a forced push and for a push listing 20 commits", async () => {
    const f = await acceptedRepo();
    await push(f, { [GRADING]: "grade: forced" }, { forced: true, listed: 0 });
    expect(world.read(f.fullName, head(f), GRADING)).toBe("grade: v1");
    gh.calls.length = 0;
    await push(f, { [GRADING]: "grade: long" }, { listed: 20 });
    expect(world.read(f.fullName, head(f), GRADING)).toBe("grade: v1");
    expect(gh.calls.some((c) => c.includes("/compare/"))).toBe(true);
  });

  it("leaves a branch that is not handed out, and an unprotected file, alone", async () => {
    const f = await acceptedRepo();
    world.git(f.fullName, "branch", "experiment", "main");
    const { after } = await push(f, { [GRADING]: "grade: mine" }, { branch: "experiment" });
    expect(head(f, "experiment")).toBe(after);
    const second = await push(f, { "src/main.c": "int x;" });
    expect(head(f)).toBe(second.after);
    expect(await restores(f)).toHaveLength(0);
  });

  it("stops past five restores in an hour: suspended, audited once, its runs to verify", async () => {
    const f = await acceptedRepo();
    for (let i = 0; i < MAX_RESTORES_PER_HOUR; i++) {
      server.clock.advance(MINUTE);
      await push(f, { [GRADING]: `grade: attempt ${i}` });
    }
    expect(await restores(f)).toHaveLength(MAX_RESTORES_PER_HOUR);
    server.clock.advance(MINUTE);
    const sixth = await push(f, { [GRADING]: "grade: sixth" });
    expect(head(f)).toBe(sixth.after); // not restored
    expect((await repoRow(f.projectId)).protectionSuspendedAt?.toISOString()).toBe(server.clock.now().toISOString());
    const cap = await auditOf(f.repo.id, "project_repo.revert_cap");
    expect(cap).toHaveLength(1);
    expect(cap[0]!.payload).toMatchObject({ files: [GRADING], head: sixth.after });

    // Suspended: nothing restored, nothing audited again, even a redelivery.
    await handled("push", sixth.payload);
    const seventh = await push(f, { [GRADING]: "grade: seventh" });
    expect(head(f)).toBe(seventh.after);
    expect(await auditOf(f.repo.id, "project_repo.revert_cap")).toHaveLength(1);
    expect(await restores(f)).toHaveLength(MAX_RESTORES_PER_HOUR);

    scored(seventh.after, { title: "GRADE", message: "6/6" });
    const run = runPayload(f, seventh.after);
    await handled("workflow_run", run);
    expect(await runOf(f, run.workflow_run.id)).toMatchObject({ points: 6, toVerify: true });
  });

  it("counts an hour by the server's clock: restores an hour apart never suspend", async () => {
    const f = await acceptedRepo();
    for (let i = 0; i < MAX_RESTORES_PER_HOUR + 2; i++) {
      server.clock.advance(15 * MINUTE);
      await push(f, { [GRADING]: `grade: ${i}` });
    }
    expect(await restores(f)).toHaveLength(MAX_RESTORES_PER_HOUR + 2);
    expect((await repoRow(f.projectId)).protectionSuspendedAt).toBeNull();
  });

  it("reads the window on the restore's branch, not on the branch the tampering sha was first received on (M3-06b)", async () => {
    const f = await acceptedRepo({ branches: ["main", "dev"] });
    // `dev` on main's head, so that one commit can be pushed on both branches.
    const base = head(f);
    world.git(f.fullName, "branch", "-f", "dev", base);
    const s = world.commit(f.fullName, "dev", { [GRADING]: "grade: always 6" });
    await handled("push", pushPayload(f, { branch: "dev", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(await restores(f)).toHaveLength(0); // the distribution's `dev` has no grading.yml: nothing to restore, no row

    // An honest head on `dev`, received after S (the student moved `dev` back and pushed on).
    world.git(f.fullName, "update-ref", "refs/heads/dev", base);
    server.clock.advance(MINUTE);
    const honest = await push(f, { "src/main.c": "honest on dev" }, { branch: "dev" });

    // S pushed on `main`: its receipt stays `dev`'s (one per sha); the restore answers it on `main`.
    server.clock.advance(MINUTE);
    world.git(f.fullName, "update-ref", "refs/heads/main", s);
    await handled("push", pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s, branch: "main" })]);
    expect(world.read(f.fullName, head(f), GRADING)).toBe("grade: v1");

    // The honest head of `dev` is inside the window's times, on the other branch: it counts.
    scored(honest.after, { title: "GRADE", message: "4/6" });
    const run = runPayload(f, honest.after, { head_branch: "dev" });
    await handled("workflow_run", run);
    expect(await runOf(f, run.workflow_run.id)).toMatchObject({ points: 4, toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, run.workflow_run.id))!.id);
  });

  it("bounds the window by the covered head's receipt when it lands after the restore began (M3-06b)", async () => {
    const f = await acceptedRepo();
    const honest = await push(f, { "src/main.c": "honest" });
    scored(honest.after, { title: "GRADE", message: "3/6" });
    await handled("workflow_run", runPayload(f, honest.after));

    // S's delivery fails at first; S1 is received; X and S2 are pushed but their deliveries lag.
    refsRefused = true;
    server.clock.advance(MINUTE);
    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    const sId = await failedDelivery(pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    refsRefused = false;
    server.clock.advance(MINUTE);
    const s1 = (await push(f, { "src/main.c": "more" })).after;
    const x = world.commit(f.fullName, "main", { "src/main.c": "and more" });
    const s2 = world.commit(f.fullName, "main", { "src/main.c": "even more" });

    // The retry restores on S2 (`covered`), at `created_at`...
    server.clock.advance(MINUTE);
    await processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), sId);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s2 })]);
    // ...and X's and S2's receipts land after it: X ran the altered files too.
    for (const [before, after] of [[s1, x], [x, s2]] as const) {
      server.clock.advance(MINUTE);
      await handled("push", pushPayload(f, { branch: "main", before, after, files: { "src/main.c": "y" } }));
    }
    // A push on top of the restore, received after S2's receipt, counts again.
    server.clock.advance(MINUTE);
    const fresh = await push(f, { "src/main.c": "after the restore" });

    const flagged = [s, s1, x, s2];
    for (const h of [...flagged, fresh.after]) {
      scored(h, { title: "GRADE", message: "6/6" });
      server.clock.advance(MINUTE);
      await handled("workflow_run", runPayload(f, h));
    }
    const all = await runs(f);
    for (const h of flagged) expect(all.find((r) => r.headSha === h)).toMatchObject({ toVerify: true });
    const freshRun = all.find((r) => r.headSha === fresh.after)!;
    expect(freshRun).toMatchObject({ toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe(freshRun.id);
  });

  it("answers a push whose move GitHub refused and whose retry finds the files put back: a row without a restore, the head to verify, no restore counted (M3-06b)", async () => {
    const f = await acceptedRepo();
    const honest = await push(f, { "src/main.c": "honest" });
    scored(honest.after, { title: "GRADE", message: "3/6" });
    const honestRun = runPayload(f, honest.after);
    await handled("workflow_run", honestRun);

    // S's run is in before its push is handled: the current score, for now.
    server.clock.advance(MINUTE);
    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    scored(s, { title: "GRADE", message: "6/6" });
    const sRun = runPayload(f, s);
    await handled("workflow_run", sRun);
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, sRun.workflow_run.id))!.id);

    // The restore's move is refused (a 422 race): the row stays, without its restore.
    moveRefused = true;
    const sId = await failedDelivery(pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(head(f)).toBe(s);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, revertSha: null, coveredSha: s, branch: "main" })]);
    // S's run is flagged at once, not at the retry.
    expect(await runOf(f, sRun.workflow_run.id)).toMatchObject({ toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, honestRun.workflow_run.id))!.id);

    // The student puts the file back themselves: nothing to restore, and no row of its own.
    server.clock.advance(MINUTE);
    const fix = await push(f, { [GRADING]: "grade: v1" });
    expect(head(f)).toBe(fix.after);
    expect(await restores(f)).toHaveLength(1);

    // S's delivery retried: the row stays without a restore; S's run to verify and out of the score.
    server.clock.advance(MINUTE);
    await processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), sId);
    expect(head(f)).toBe(fix.after);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, revertSha: null })]);
    expect(await auditOf(f.repo.id, "project_repo.restore")).toHaveLength(0);
    expect(await runOf(f, sRun.workflow_run.id)).toMatchObject({ points: 6, toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, honestRun.workflow_run.id))!.id);

    // The fix is the student's own: it counts.
    scored(fix.after, { title: "GRADE", message: "5/6" });
    server.clock.advance(MINUTE);
    const fixRun = runPayload(f, fix.after);
    await handled("workflow_run", fixRun);
    expect(await runOf(f, fixRun.workflow_run.id)).toMatchObject({ toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, fixRun.workflow_run.id))!.id);

    // The row never counted toward the cap: five restores still pass.
    for (let i = 0; i < MAX_RESTORES_PER_HOUR; i++) {
      server.clock.advance(MINUTE);
      await push(f, { [GRADING]: `grade: attempt ${i}` });
    }
    expect((await restores(f)).filter((r) => r.revertSha !== null)).toHaveLength(MAX_RESTORES_PER_HOUR);
    expect((await repoRow(f.projectId)).protectionSuspendedAt).toBeNull();
  });

  it("fills the row in when the retry of a refused move restores; a redelivery is then answered (M3-06b)", async () => {
    const f = await acceptedRepo();
    server.clock.advance(MINUTE);
    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    moveRefused = true;
    const payload = pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } });
    const sId = await failedDelivery(payload);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s, revertSha: null })]);

    // The student pushes on, the file still tampered; the retry restores on S1.
    server.clock.advance(MINUTE);
    const s1 = (await push(f, { "src/main.c": "more" })).after;
    server.clock.advance(MINUTE);
    await processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), sId);
    const restored = head(f);
    expect(world.git(f.fullName, "rev-parse", `${restored}^`).trim()).toBe(s1);
    expect(world.read(f.fullName, restored, GRADING)).toBe("grade: v1");
    const [row] = await restores(f);
    expect(row).toMatchObject({ headSha: s, revertSha: restored, coveredSha: s1, branch: "main" });
    expect(row!.createdAt.toISOString()).toBe(server.clock.now().toISOString());
    expect(await auditOf(f.repo.id, "project_repo.restore")).toHaveLength(1);

    // A redelivery of S: answered, nothing restored nor counted twice.
    await handled("push", payload);
    expect(head(f)).toBe(restored);
    expect(await restores(f)).toHaveLength(1);

    // S1, received inside the filled row's window, never counts.
    scored(s1, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const run = runPayload(f, s1);
    await handled("workflow_run", run);
    expect(await runOf(f, run.workflow_run.id)).toMatchObject({ toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBeNull();
  });

  it("keeps the heads a refused attempt read: S and S1 (still tampered) to verify after the 422, the fix pushed after counts (M3-06b)", async () => {
    const f = await acceptedRepo();
    server.clock.advance(MINUTE);
    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    server.clock.advance(MINUTE);
    const s1 = (await push(f, { "src/main.c": "more work, grading.yml still tampered" })).after;
    scored(s1, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const s1Run = runPayload(f, s1);
    await handled("workflow_run", s1Run);
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, s1Run.workflow_run.id))!.id);

    // S's delivery: the restore built on S1 is refused (the fix landed meanwhile).
    moveRefused = true;
    server.clock.advance(MINUTE);
    const sId = await failedDelivery(pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s1, revertSha: null })]);
    expect(await runOf(f, s1Run.workflow_run.id)).toMatchObject({ toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBeNull();

    // The fix, pushed after the attempt read the branch: outside the window.
    server.clock.advance(MINUTE);
    const fix = await push(f, { [GRADING]: "grade: v1" });
    server.clock.advance(MINUTE);
    await processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), sId);
    expect(head(f)).toBe(fix.after);
    expect(await restores(f)).toEqual([expect.objectContaining({ headSha: s, coveredSha: s1, revertSha: null })]);

    scored(s, { title: "GRADE", message: "6/6" });
    server.clock.advance(MINUTE);
    const sRun = runPayload(f, s);
    await handled("workflow_run", sRun);
    expect(await runOf(f, sRun.workflow_run.id)).toMatchObject({ toVerify: true });
    scored(fix.after, { title: "GRADE", message: "5/6" });
    server.clock.advance(MINUTE);
    const fixRun = runPayload(f, fix.after);
    await handled("workflow_run", fixRun);
    expect(await runOf(f, fixRun.workflow_run.id)).toMatchObject({ toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, fixRun.workflow_run.id))!.id);
  });

  it("answers a tampering push whose head a clean head had overtaken before its delivery: its head alone to verify, no restore (M3-06b)", async () => {
    const f = await acceptedRepo();
    server.clock.advance(MINUTE);
    const base = head(f);
    const s = world.commit(f.fullName, "main", { [GRADING]: "grade: always 6" });
    const fix = world.commit(f.fullName, "main", { [GRADING]: "grade: v1" });
    scored(s, { title: "GRADE", message: "6/6" });
    const sRun = runPayload(f, s);
    await handled("workflow_run", sRun);

    // S's delivery, handled with the fix already on the branch: nothing to restore, the push answered all the same.
    await handled("push", pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(head(f)).toBe(fix);
    expect(await restores(f)).toEqual([
      expect.objectContaining({ headSha: s, revertSha: null, coveredSha: null, branch: "main", files: [GRADING] }),
    ]);
    expect(await auditOf(f.repo.id, "project_repo.restore")).toHaveLength(0);
    expect(await runOf(f, sRun.workflow_run.id)).toMatchObject({ toVerify: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBeNull();

    // The fix's own delivery: its head leaves the files the distribution's, no row; its run counts.
    server.clock.advance(MINUTE);
    await handled("push", pushPayload(f, { branch: "main", before: s, after: fix, files: { [GRADING]: "grade: v1" } }));
    expect(await restores(f)).toHaveLength(1);
    scored(fix, { title: "GRADE", message: "5/6" });
    server.clock.advance(MINUTE);
    const fixRun = runPayload(f, fix);
    await handled("workflow_run", fixRun);
    expect(await runOf(f, fixRun.workflow_run.id)).toMatchObject({ toVerify: false });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, fixRun.workflow_run.id))!.id);

    // A redelivery of S: answered, nothing more.
    await handled("push", pushPayload(f, { branch: "main", before: base, after: s, files: { [GRADING]: "x" } }));
    expect(await restores(f)).toHaveLength(1);
    expect(head(f)).toBe(fix);
  });
});

// ---------------------------------------------------------------- runs

describe("a completed run (F-PROJ-10, ADR-011)", () => {
  it("captures the GRADE of its own check suite and makes it the current score", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const { after } = await push(f, { "src/main.c": "v2" });
    scored(after, { title: "GRADE", message: "4.5/6" }, { title: "TESTS", message: "9/10" });
    const payload = runPayload(f, after);
    await handled("workflow_run", payload);
    const run = await runOf(f, payload.workflow_run.id);
    expect(run).toMatchObject({ parseStatus: "ok", points: 4.5, max: 6, testsPassed: 9, testsTotal: 10, kind: "ci", afterDeadline: false, toVerify: false });
    expect(await repoRow(f.projectId)).toMatchObject({ currentGradeRunId: run!.id, ciStatus: "pass" });
  });

  it("is ingested once per (repository, run, attempt): a replay reads nothing again", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const { after } = await push(f, { "src/main.c": "v3" });
    scored(after, { title: "GRADE", message: "5/6" });
    const payload = runPayload(f, after);
    await handled("workflow_run", payload);
    const reads = annotationReads;
    await handled("workflow_run", payload);
    expect(annotationReads).toBe(reads);
    await handled("workflow_run", { ...payload, workflow_run: { ...payload.workflow_run, run_attempt: 2 } });
    expect((await runs(f)).filter((r) => r.workflowRunId === payload.workflow_run.id)).toHaveLength(2);
  });

  it("ignores a run on a head received as a bot's push, even without its bot commit recorded", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const { after } = await push(f, { "src/main.c": "the App's" }, { login: APP_BOT });
    scored(after, { title: "GRADE", message: "6/6" });
    await handled("workflow_run", runPayload(f, after));
    expect(await runs(f)).toHaveLength(0);
  });

  it("ignores a run on a branch not handed out, and a run on a bot commit", async () => {
    const f = await acceptedRepo();
    const pushed = await push(f, { [GRADING]: "grade: 6" });
    const restored = head(f);
    scored(restored, { title: "GRADE", message: "6/6" });
    await handled("workflow_run", runPayload(f, restored));
    await handled("workflow_run", runPayload(f, pushed.after, { head_branch: "feature" }));
    expect(await runs(f)).toHaveLength(0);
  });

  it("keeps no score for several GRADE annotations, or a malformed one (its reason kept), or none", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const ok = await push(f, { "a.c": "1" });
    scored(ok.after, { title: "GRADE", message: "3/6" });
    const first = runPayload(f, ok.after);
    await handled("workflow_run", first);
    const okRun = await runOf(f, first.workflow_run.id);

    const cases = [
      { annotations: [{ title: "GRADE", message: "6/6" }, { title: "GRADE", message: "6/6" }], expected: { parseStatus: "multiple", parseDetail: null } },
      { annotations: [{ title: "GRADE", message: "seven out of six" }], expected: { parseStatus: "malformed", parseDetail: "seven out of six" } },
      { annotations: [], expected: { parseStatus: "no_annotation", parseDetail: null } },
    ];
    for (const c of cases) {
      server.clock.advance(MINUTE);
      const { after } = await push(f, { "a.c": c.expected.parseStatus });
      ci.set(after, { suite: 77, annotations: c.annotations, conclusions: ["success"] });
      const payload = runPayload(f, after);
      await handled("workflow_run", payload);
      expect(await runOf(f, payload.workflow_run.id)).toMatchObject({ ...c.expected, points: null, max: null });
    }
    // The current score stays the last run WITH a score.
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe(okRun!.id);
  });

  it("counts a pass / fail run only while the repository has no grading.yml run (2026-10-02)", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const { after } = await push(f, { "b.c": "1" });
    ci.set(after, { suite: 77, annotations: [], conclusions: ["failure"] });
    const build = runPayload(f, after, { path: ".github/workflows/build.yml", conclusion: "failure" });
    await handled("workflow_run", build);
    const fallback = await runOf(f, build.workflow_run.id);
    expect(fallback).toMatchObject({ parseStatus: "fallback", points: null });
    expect(await repoRow(f.projectId)).toMatchObject({ currentGradeRunId: fallback!.id, ciStatus: "fail" });

    // A grading.yml run, even without a score: the build no longer counts.
    server.clock.advance(MINUTE);
    const graded = runPayload(f, after);
    await handled("workflow_run", graded);
    expect((await repoRow(f.projectId)).currentGradeRunId).toBeNull();
    // A later build never displaces a score.
    const second = await push(f, { "b.c": "2" });
    scored(second.after, { title: "GRADE", message: "2/6" });
    const scoredRun = runPayload(f, second.after);
    await handled("workflow_run", scoredRun);
    server.clock.advance(MINUTE);
    await handled("workflow_run", runPayload(f, second.after, { path: ".github/workflows/build.yml" }));
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, scoredRun.workflow_run.id))!.id);
  });

  it("orders by GitHub's completion time, not by arrival", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const a = await push(f, { "c.c": "1" });
    const b = await push(f, { "c.c": "2" });
    scored(a.after, { title: "GRADE", message: "1/6" });
    scored(b.after, { title: "GRADE", message: "5/6" });
    const later = runPayload(f, b.after, { updated_at: "2026-10-02T09:00:00.000Z" });
    const earlier = runPayload(f, a.after, { updated_at: "2026-10-02T08:30:00.000Z" });
    await handled("workflow_run", later);
    await handled("workflow_run", earlier);
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, later.workflow_run.id))!.id);
  });

  it("marks a run late by the receipt of its commit, an unknown receipt late once the deadline passed (GR-14.3)", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const inTime = await push(f, { "d.c": "in time" });
    scored(inTime.after, { title: "GRADE", message: "4/6" });
    server.clock.set("2026-10-09T22:10:00.000Z"); // past the deadline
    const late = await push(f, { "d.c": "late" });
    scored(late.after, { title: "GRADE", message: "6/6" });
    const unknown = world.commit(f.fullName, "main", { "d.c": "never received" });
    scored(unknown, { title: "GRADE", message: "6/6" });

    const runInTime = runPayload(f, inTime.after);
    const runLate = runPayload(f, late.after);
    const runUnknown = runPayload(f, unknown);
    for (const r of [runInTime, runLate, runUnknown]) await handled("workflow_run", r);
    expect(await runOf(f, runInTime.workflow_run.id)).toMatchObject({ afterDeadline: false });
    expect(await runOf(f, runLate.workflow_run.id)).toMatchObject({ afterDeadline: true });
    expect(await runOf(f, runUnknown.workflow_run.id)).toMatchObject({ afterDeadline: true });
    expect((await repoRow(f.projectId)).currentGradeRunId).toBe((await runOf(f, runInTime.workflow_run.id))!.id);
  });

  it("an unknown receipt ahead of the deadline is on time", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const sha = world.commit(f.fullName, "main", { "e.c": "reconciled" });
    scored(sha, { title: "GRADE", message: "3/6" });
    const payload = runPayload(f, sha);
    await handled("workflow_run", payload);
    expect(await runOf(f, payload.workflow_run.id)).toMatchObject({ afterDeadline: false });
  });

  it("refreshes the frozen slot during the grace, not before the repository's deadline is applied", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const a = await push(f, { "g.c": "1" });
    scored(a.after, { title: "GRADE", message: "2/6" });
    await handled("workflow_run", runPayload(f, a.after));
    expect((await repoRow(f.projectId)).frozenGradeRunId).toBeNull();

    await server.app.db.update(projectRepos).set({ deadlineAppliedAt: new Date(DEADLINE) }).where(eq(projectRepos.id, f.repo.id));
    const b = await push(f, { "g.c": "2" });
    scored(b.after, { title: "GRADE", message: "5/6" });
    server.clock.advance(MINUTE);
    const run = runPayload(f, b.after);
    await handled("workflow_run", run);
    const row = await repoRow(f.projectId);
    expect(row.frozenGradeRunId).toBe((await runOf(f, run.workflow_run.id))!.id);
    expect(row.currentGradeRunId).toBe(row.frozenGradeRunId);
  });

  it("marks the repository pending while an eligible run runs", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const { after } = await push(f, { "h.c": "1" });
    await handled("workflow_run", runPayload(f, after, {}, "in_progress"));
    expect((await repoRow(f.projectId)).ciStatus).toBe("pending");
  });
});

describe("a review run (F-PROJ-11)", () => {
  const MINUTE = 60_000;
  const ago = (ms: number) => new Date(server.clock.now().getTime() - ms).toISOString();
  /** A review run, dispatched by Quiz's App and started now, unless `over` says otherwise. */
  const review = (f: Fixture, sha: string, over: Record<string, unknown> = {}) =>
    runPayload(f, sha, {
      event: "repository_dispatch",
      actor: { login: APP_BOT },
      triggering_actor: { login: APP_BOT },
      run_started_at: server.clock.now().toISOString(),
      ...over,
    });
  /** Frozen for good two minutes ago, its final review asked a minute ago (`grade_dispatches`). */
  const frozenAndAsked = async (f: Fixture, sha: string) => {
    await server.app.db.update(projectRepos).set({ frozenAt: new Date(ago(2 * MINUTE)) }).where(eq(projectRepos.id, f.repo.id));
    await server.app.db
      .insert(gradeDispatches)
      .values({ id: randomUUID(), repoId: f.repo.id, trigger: "deadline", sha, createdAt: new Date(ago(MINUTE)), dispatchedAt: new Date(ago(MINUTE)) });
  };

  it("is stored, and fills the review slot only once the freeze is definitive, parsed and successful", async () => {
    const f = await acceptedRepo();
    // The review's head may be a bot commit (a restore here): it still counts.
    await push(f, { [GRADING]: "x" });
    const botHead = head(f);
    scored(botHead, { title: "GRADE", message: "5/6" });

    const checkpoint = review(f, botHead);
    await handled("workflow_run", checkpoint);
    expect(await runOf(f, checkpoint.workflow_run.id)).toMatchObject({ kind: "review", points: 5 });
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();

    await frozenAndAsked(f, botHead);
    const failed = review(f, botHead, { conclusion: "failure" });
    await handled("workflow_run", failed);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();
    const final = review(f, botHead);
    await handled("workflow_run", final);
    const row = await repoRow(f.projectId);
    expect(row.reviewGradeRunId).toBe((await runOf(f, final.workflow_run.id))!.id);
    // Never the current score.
    expect(row.currentGradeRunId).toBeNull();
  });

  it("fills the slot only for a review Quiz's App triggered: a student's dispatch or re-run is a trace (M3-05b)", async () => {
    const f = await acceptedRepo();
    await push(f, { "src/main.c": "int main(){return 0;}" });
    const sha = head(f);
    scored(sha, { title: "GRADE", message: "6/6" });
    await frozenAndAsked(f, sha);

    const own = review(f, sha, { actor: { login: f.student.login }, triggering_actor: { login: f.student.login } });
    await handled("workflow_run", own);
    expect(await runOf(f, own.workflow_run.id)).toMatchObject({ kind: "review", points: 6 });
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();

    // The App's dispatch, re-run by the student: who re-ran it decides.
    const rerun = review(f, sha, { run_attempt: 2, triggering_actor: { login: f.student.login } });
    await handled("workflow_run", rerun);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();

    // No triggering actor at all: a person's, failing closed — the actor alone is not trusted.
    const anonymous = review(f, sha, { triggering_actor: null });
    await handled("workflow_run", anonymous);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();

    const app = review(f, sha);
    await handled("workflow_run", app);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBe((await runOf(f, app.workflow_run.id))!.id);
  });

  it("never takes for the final review a run started before the freeze or before it was asked: a checkpoint's, a pre-reopen one (M3-05b)", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    await push(f, { "src/main.c": "int main(){return 1;}" });
    const sha = head(f);
    scored(sha, { title: "GRADE", message: "4/6" });

    // Frozen, but no final review asked: a run started now is a checkpoint's (or a student's).
    await server.app.db.update(projectRepos).set({ frozenAt: new Date(ago(2 * MINUTE)) }).where(eq(projectRepos.id, f.repo.id));
    const unasked = review(f, sha);
    await handled("workflow_run", unasked);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();

    await frozenAndAsked(f, sha);
    // Started before the freeze — a checkpoint's run, or one from before a reopen — delivered after it.
    const early = review(f, sha, { run_started_at: ago(3 * MINUTE) });
    await handled("workflow_run", early);
    // Started after the freeze but before the dispatch was claimed.
    const between = review(f, sha, { run_started_at: ago(MINUTE + 30_000) });
    await handled("workflow_run", between);
    // No start time known: never.
    const unknown = review(f, sha, { run_started_at: null });
    await handled("workflow_run", unknown);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();
    expect(await runOf(f, early.workflow_run.id)).toMatchObject({ kind: "review", points: 4 });

    const final = review(f, sha);
    await handled("workflow_run", final);
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBe((await runOf(f, final.workflow_run.id))!.id);
  });

  it("never fills the slot with a run to verify: the protection suspended (M3-05b)", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    await push(f, { "src/main.c": "int main(){return 2;}" });
    const sha = head(f);
    scored(sha, { title: "GRADE", message: "6/6" });
    await frozenAndAsked(f, sha);
    await server.app.db.update(projectRepos).set({ protectionSuspendedAt: new Date(ago(MINUTE)) }).where(eq(projectRepos.id, f.repo.id));
    const run = review(f, sha);
    await handled("workflow_run", run);
    expect(await runOf(f, run.workflow_run.id)).toMatchObject({ kind: "review", toVerify: true });
    expect((await repoRow(f.projectId)).reviewGradeRunId).toBeNull();
  });
});

// ---------------------------------------------------------------- the repository's life

describe("member, repository and organization events (F-PROJ-07, F-PROJ-18)", () => {
  it("member added: the invitation is accepted", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    expect(f.repo.invitationStatus).toBe("pending");
    await handled("member", { action: "added", repository: { id: f.githubRepoId }, member: { login: f.student.login } });
    expect((await repoRow(f.projectId)).invitationStatus).toBe("accepted");
  });

  const renamedFrom = (from: string) => ({ repository: { name: { from } } });

  it("repository renamed: the name follows the id; deleted: marked once, terminal", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const first = { action: "renamed", repository: { id: f.githubRepoId, full_name: `${f.org}/renamed` }, changes: renamedFrom(f.fullName.split("/")[1]!) };
    await handled("repository", first);
    expect((await repoRow(f.projectId)).fullName).toBe(`${f.org}/renamed`);
    await handled("repository", { action: "renamed", repository: { id: f.githubRepoId, full_name: `${f.org}/again` }, changes: renamedFrom("renamed") });
    // The first rename replayed after the second: stale, nothing changes.
    await handled("repository", first);
    expect((await repoRow(f.projectId)).fullName).toBe(`${f.org}/again`);
    await server.app.db.update(projectRepos).set({ fullName: `${f.org}/renamed` }).where(eq(projectRepos.id, f.repo.id));

    server.clock.set("2026-10-04T10:00:00.000Z");
    const deleted = { action: "deleted", repository: { id: f.githubRepoId, full_name: `${f.org}/renamed` } };
    await handled("repository", deleted);
    await handled("repository", deleted);
    expect((await repoRow(f.projectId)).deletedAt?.toISOString()).toBe("2026-10-04T10:00:00.000Z");
    expect(await auditOf(f.repo.id, "project_repo.deleted")).toHaveLength(1);
    // A deleted repository's events change nothing.
    await handled("member", { action: "added", repository: { id: f.githubRepoId } });
    await handled("workflow_run", runPayload(f, head(f)));
    expect(await runs(f)).toHaveLength(0);
  });

  it("repository renamed after its organization, before the organization's event: still followed", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const name = f.fullName.split("/")[1]!;
    await handled("repository", { action: "renamed", repository: { id: f.githubRepoId, full_name: `new-owner/${name}-v2` }, changes: renamedFrom(name) });
    expect((await repoRow(f.projectId)).fullName).toBe(`new-owner/${name}-v2`);
  });

  it("repository renamed: a project's distribution follows its id too", async () => {
    const f = await acceptedRepo();
    const [project] = await server.app.db.select().from(projects).where(eq(projects.id, f.projectId));
    await handled("repository", {
      action: "renamed",
      repository: { id: project!.distributionRepoId, full_name: `${f.org}/dist-renamed` },
      changes: renamedFrom("lab-1-squashed"),
    });
    const [after] = await server.app.db.select().from(projects).where(eq(projects.id, f.projectId));
    expect(after!.distributionFullName).toBe(`${f.org}/dist-renamed`);
  });

  it("organization renamed: every name stored for its projects takes the new prefix, idempotently, nobody else's", async () => {
    const f = await acceptedRepo({ protectedFiles: [] });
    const bystander = await acceptedRepo({ protectedFiles: [] });
    const event = { action: "renamed", organization: { id: f.githubOrgId, login: "renamed-org" }, changes: { login: { from: f.org } } };
    await handled("organization", event);
    await handled("organization", event);
    // A later rename, then the first replayed: stale, nothing changes.
    await handled("organization", { action: "renamed", organization: { id: f.githubOrgId, login: "renamed-twice" }, changes: { login: { from: "renamed-org" } } });
    await handled("organization", event);
    const [twice] = await server.app.db.select().from(projects).where(eq(projects.id, f.projectId));
    expect(twice!.sourceFullName).toBe("renamed-twice/starter");
    await handled("organization", { action: "renamed", organization: { id: f.githubOrgId, login: "renamed-org" }, changes: { login: { from: "renamed-twice" } } });
    const [other] = await server.app.db.select().from(projects).where(eq(projects.id, bystander.projectId));
    expect(other).toMatchObject({ sourceFullName: `${bystander.org}/starter`, distributionFullName: bystander.distribution });
    expect((await repoRow(bystander.projectId)).fullName).toBe(bystander.fullName);
    const [project] = await server.app.db.select().from(projects).where(eq(projects.id, f.projectId));
    expect(project).toMatchObject({ sourceFullName: "renamed-org/starter", distributionFullName: "renamed-org/lab-1-squashed" });
    expect((await repoRow(f.projectId)).fullName).toBe(`renamed-org/lab-1-${f.student.login}`);
    const [org] = await server.app.db.select().from(githubOrganizations).where(eq(githubOrganizations.githubOrgId, f.githubOrgId));
    expect(org!.login).toBe("renamed-org");
  });
});

// ---------------------------------------------------------------- the rate limit

describe("GitHub's rate limit (N-PERF-07)", () => {
  it("sends the delivery again at the reset without spending a retry", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    onEvent("test_rate_limited", async () => {
      throw Object.assign(new Error("API rate limit exceeded"), {
        status: 403,
        response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } },
      });
    });
    const sent: { name: string; data: object; options: unknown }[] = [];
    const queue: JobQueue = {
      createQueue: async () => {},
      send: async (name, data, options) => void sent.push({ name, data, options }),
      work: async () => {},
      stop: async () => {},
    };
    const app = server.app as { boss?: JobQueue };
    const id = randomUUID();
    app.boss = queue;
    try {
      expect((await deliver("test_rate_limited", { hello: 1 }, id)).statusCode).toBe(200);
      sent.length = 0; // the intake's own send
      await expect(processDelivery(server.app, loadConfig({ NODE_ENV: "test", ...ENV }), id)).resolves.toBeUndefined();
    } finally {
      delete app.boss;
    }
    expect(sent).toEqual([{ name: "github.webhook", data: { deliveryId: id }, options: { startAfter: new Date(reset * 1000) } }]);
    const [row] = await server.app.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, id));
    expect(row).toMatchObject({ processedAt: null, error: expect.stringContaining("rate limit") });
  });
});
