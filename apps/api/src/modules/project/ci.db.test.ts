/**
 * The CI's evidence of a schema-3 project (ADR-119 §6, card L-06b) on a
 * server built with Quiz's App, against the fake GitHub and its local bare
 * repositories (`./testing.ts`), a fake `repository_dispatch` endpoint and
 * a fake artifact store (the API's listing and redirect, the signed blob):
 *
 * - the dispatch: the target commit, the nonce, the pass, at most once; a
 *   milestone's tag; an archived repository not dispatched
 *   (`ci_unavailable`); no commit (`no_commit`); the pace per installation;
 * - the intake: a run by another actor, a re-run, a wrong nonce, another
 *   workflow or event is not accepted; a changed `criteria.yml` or
 *   protected file at the target, or a changed `grading.yml` at the run's
 *   head, is `ci_tampered` (audited); the artifact mapped onto the
 *   automatic criteria (`no_result` for a missing one), never a review nor
 *   a score; a missing or refused artifact is `no_result`; the blob URL's
 *   `sig=` in no row, audit nor error;
 * - the 24 h on the server's clock; a Regrade dispatching anew with a new
 *   nonce, the old one retired;
 * - a schema-2 snapshot still on the runner, a schema-3 one never.
 */
import { randomUUID } from "node:crypto";

import { zipSync } from "fflate";
import { and, eq, ne } from "drizzle-orm";
import type { Octokit } from "octokit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProjectSummary } from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { SYSTEM_ACTOR } from "../../audit.js";
import { loadConfig } from "../../config.js";
import {
  auditLog,
  courseStaff,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectCheckpoints,
  projectCiResults,
  projectCriteria,
  projectCriterionGrades,
  projectEvidence,
  projectGradeRuns,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { ArtifactUnavailable } from "../../github/artifact.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, BLOB_HOST, fakeGithub, json, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import type { JobQueue } from "../../jobs.js";
import { DISPATCH_PACE_MS, expireCiPasses, intakeGradedRun, RESULT_WAIT_MS, reserveSlot, runCiDispatch, sendCiPasses } from "./ci.js";
import { runEvidence } from "./evidence.js";
import { completedRun, ingestCompletedRun, type CompletedRun } from "./grading.js";
import { claimPasses } from "./milestone.js";
import { regrade } from "./regrade.js";
import { repoContext } from "./repos.js";
import { repoWorld } from "./testing.js";

const CRITERIA = [
  "schema_version: 3",
  "criteria:",
  "  code:",
  "    format: {description: Format, max_points: 1, command: [make, format-check]}",
  "    tests: {description: Tests, max_points: 10, command: [make, test], milestone: mid}",
  "    crash: {description: Crash penalty, max_points: -2, command: [make, crash]}",
  "  rapport:",
  "    style: {description: Style, max_points: 2, prompt: Is the code readable?}",
  "  bonus:",
  "    extra: {description: Extra, bonus_points: 1, command: [make, extra]}",
  "",
].join("\n");
const WORKFLOW = "name: grading\non: [repository_dispatch]\njobs:\n  grading:\n    uses: heig-tin-info/score/.github/workflows/run.yml@abc\n";
const CHECK = "#!/bin/sh\nexit 0\n";
const FILES = { "README.md": "# Lab", "criteria.yml": CRITERIA, ".github/workflows/grading.yml": WORKFLOW, "tests/check.sh": CHECK };
const SIG = "SIGSECRET0123456789abcdef";

const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
  JOBS_DISABLED: "1",
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = new Date("2026-10-09T22:00:00.000Z");
const before = (minutes: number) => new Date(DEADLINE.getTime() - minutes * 60_000);

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let nextOrg = 9600;

/** The dispatches GitHub received, and the repositories that refuse one (a status). */
const dispatched: { fullName: string; body: { event_type: string; client_payload: Record<string, unknown> } }[] = [];
const refusing = new Map<string, number>();
/** Each run's artifacts as the listing answers them, and each artifact's zip. */
const artifacts = new Map<number, { id: number; name: string; expired: boolean; size_in_bytes: number }[]>();
const zips = new Map<number, Uint8Array | number>();
let nextArtifact = 1;

const ciRoute: Route = (url, req) => {
  let m: RegExpExecArray | null;
  if (url.host === BLOB_HOST && (m = /^\/artifacts\/(\d+)\.zip$/.exec(url.pathname))) {
    if (url.searchParams.get("sig") !== SIG) return json({ message: "AuthenticationFailed" }, 403);
    const zip = zips.get(Number(m[1]));
    return typeof zip === "number" || zip === undefined ? new Response("boom", { status: zip ?? 404 }) : new Response(zip, { status: 200 });
  }
  if (url.host !== "api.github.com") return undefined;
  if (req.method === "POST" && (m = /^\/repos\/([^/]+\/[^/]+)\/dispatches$/.exec(url.pathname))) {
    const status = world.archived.has(m[1]!) ? 403 : refusing.get(m[1]!);
    if (status !== undefined) return json({ message: "refused" }, status);
    dispatched.push({ fullName: m[1]!, body: JSON.parse(String(req.body)) });
    return new Response(null, { status: 204 });
  }
  if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts$/.exec(url.pathname))) {
    const list = artifacts.get(Number(m[1])) ?? [];
    return json({ total_count: list.length, artifacts: list });
  }
  if (req.method === "GET" && (m = /^\/repos\/[^/]+\/[^/]+\/actions\/artifacts\/(\d+)\/zip$/.exec(url.pathname))) {
    const location = `https://${BLOB_HOST}/artifacts/${m[1]}.zip?sv=2021&se=2026-10-10T00%3A00%3A00Z&sp=r&sig=${SIG}`;
    return new Response(null, { status: 302, headers: { location } });
  }
  return undefined;
};

/** A run's `results` artifact: the zip of `results` (a JSON value, or raw bytes), or a status the blob store answers. */
function upload(runId: number, results: unknown, opts: { name?: string; zip?: Uint8Array; status?: number } = {}) {
  const id = nextArtifact++;
  const zip = opts.zip ?? zipSync({ "results.json": new TextEncoder().encode(JSON.stringify(results)) });
  artifacts.set(runId, [{ id, name: opts.name ?? "results", expired: false, size_in_bytes: zip.length }]);
  zips.set(id, opts.status ?? zip);
}

interface Lab {
  projectId: string;
  login: string;
  installationId: number;
  distribution: string;
}

/** A project graded by criteria on a schema-3 snapshot (the switch's), `tests` protected. */
async function lab(version: 2 | 3 = 3): Promise<Lab> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: teacher.id }).onConflictDoNothing();
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", { main: FILES });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const res = await server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${seeded.classroomId}/projects`,
    headers: teacher.headers,
    payload: { name: "Labo", sourceRepo: "lab", deadlineAt: DEADLINE.toISOString() },
  });
  expect(res.statusCode, res.body).toBe(201);
  const project = ProjectSummary.parse(res.json());
  const text = version === 3 ? CRITERIA : "schema_version: 2\ncriteria:\n  rendu:\n    all-tests-passed: {description: Tests, awarded_points: 0, max_points: 10}\n";
  const parsed = parseCriteria(text, { version });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db.update(projects).set({ gradingMode: "criteria", protectedFiles: ["tests"] }).where(eq(projects.id, project.id));
  await db.insert(projectCriteria).values({ projectId: project.id, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  return { projectId: project.id, login, installationId: n, distribution: project.distribution!.fullName };
}

/** A student's repository: a copy of the source's files on GitHub, its row. */
async function studentRepo(l: Lab, name: string) {
  const fullName = `${l.login}/${name}`;
  world.source(l.login, name, { main: FILES });
  const id = randomUUID();
  await server.app.db.insert(projectRepos).values({
    id,
    projectId: l.projectId,
    userId: (await server.signIn("student")).id,
    githubRepoId: world.ids.get(fullName)!,
    fullName,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: new Date(NOW),
  });
  return { id, fullName, githubRepoId: world.ids.get(fullName)! };
}

/** A student's commit received before the deadline: the pass's target. */
async function work(repo: { fullName: string; githubRepoId: number }, files: Record<string, string> = { "src/main.c": "int main(){}\n" }, at = before(30)) {
  const sha = world.commit(repo.fullName, "main", files);
  await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: repo.githubRepoId, branch: "main", headSha: sha, receivedAt: at, isBot: false });
  return sha;
}

/** The final pass claimed, as the ticker claims it at the freeze. */
async function claimFinal(repoId: string, checkpointId?: string) {
  const [pass] = await server.app.db.transaction((tx) => claimPasses(tx, [repoId], server.clock.now(), checkpointId));
  return pass!;
}

const passRow = async (id: string) => (await server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.id, id)))[0]!;
const rowsOf = async (repoId: string) =>
  Object.fromEntries(
    (
      await server.app.db
        .select()
        .from(projectCriterionGrades)
        .where(and(eq(projectCriterionGrades.repoId, repoId), ne(projectCriterionGrades.state, "superseded")))
    ).map((r) => [r.criterionId, [r.points, r.reason, r.rationale]]),
  );
const octokitOf = async (l: Lab): Promise<Octokit> => (await installationClient(config, l.installationId)).octokit;

/** The graded run GitHub reports for a pass: the App's dispatch of grading.yml, its first attempt, the nonce in its name. */
function gradedRun(nonce: string, headSha: string, more: Partial<CompletedRun> = {}): CompletedRun {
  return {
    workflowRunId: 5000 + nextArtifact,
    runAttempt: 1,
    headBranch: "main",
    headSha,
    conclusion: "success",
    path: ".github/workflows/grading.yml",
    event: "repository_dispatch",
    title: `grading ${nonce}`,
    triggeredBy: "app",
    checkSuiteId: null,
    startedAt: new Date(NOW),
    completedAt: new Date(NOW),
    ...more,
  };
}

/** A pass dispatched on the repository's target, as the job leaves it. */
async function dispatchedPass(l: Lab, name: string) {
  const repo = await studentRepo(l, name);
  const target = await work(repo);
  const pass = await claimFinal(repo.id);
  expect(await runCiDispatch(server.app, config, { passId: pass.passId })).toBe("dispatched");
  const row = await passRow(pass.passId);
  const ctx = (await repoContext(server.app.db, repo.githubRepoId))!;
  return { repo, target, pass: row, ctx };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  server.clock.set(NOW);
  gh.routes = [orgsRoute(() => []), ciRoute, world.route];
  teacher = await server.signIn("teacher");
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("the dispatch", () => {
  let l: Lab;
  beforeAll(async () => {
    l = await lab();
  });

  it("sends quiz-grade at the last student commit before the deadline, with the pass's nonce, at most once", async () => {
    const repo = await studentRepo(l, "lab-alice");
    const target = await work(repo);
    await work(repo, { "src/late.c": "x" }, new Date(DEADLINE.getTime() + 60_000));
    const pass = await claimFinal(repo.id);
    expect(pass.ci).toBe(true);
    const claimed = await passRow(pass.passId);
    expect(claimed.nonce).toMatch(/^[0-9a-f]{32}$/);

    expect(await runCiDispatch(server.app, config, { passId: pass.passId })).toBe("dispatched");
    expect(dispatched.at(-1)).toEqual({
      fullName: repo.fullName,
      body: { event_type: "quiz-grade", client_payload: { sha: target, nonce: claimed.nonce, pass: "final" } },
    });
    expect(await passRow(pass.passId)).toMatchObject({ sha: target, dispatchedAt: new Date(NOW), settledAt: null });
    const [entry] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, l.projectId), eq(auditLog.action, "project.review_dispatched")));
    expect(entry!.payload).toMatchObject({ repoId: repo.id, passId: pass.passId, sha: target, outcome: "dispatched" });

    // Never sent twice.
    const count = dispatched.length;
    expect(await runCiDispatch(server.app, config, { passId: pass.passId })).toBe("none");
    expect(dispatched.length).toBe(count);
  });

  it("sends a milestone's pass at the checkpoint's date, with its tag", async () => {
    const repo = await studentRepo(l, "lab-mila");
    const early = await work(repo, { "src/a.c": "a" }, new Date("2026-10-04T08:00:00Z"));
    await work(repo, { "src/b.c": "b" }, new Date("2026-10-06T08:00:00Z"));
    const checkpointId = randomUUID();
    await server.app.db.insert(projectCheckpoints).values({ id: checkpointId, projectId: l.projectId, name: "mid", dueAt: new Date("2026-10-05T08:00:00Z") });
    const pass = await claimFinal(repo.id, checkpointId);
    expect(await runCiDispatch(server.app, config, { passId: pass.passId })).toBe("dispatched");
    expect(dispatched.at(-1)!.body.client_payload).toMatchObject({ sha: early, pass: "milestone", milestone: "mid" });
  });

  it("dispatches nothing to an archived repository, nor without a commit: the reasons ci_unavailable and no_commit", async () => {
    const archived = await studentRepo(l, "lab-arch");
    await work(archived);
    await server.app.db.update(projectRepos).set({ archivedAt: new Date(NOW), lockedAt: new Date(NOW) }).where(eq(projectRepos.id, archived.id));
    const count = dispatched.length;
    const a = await claimFinal(archived.id);
    expect(await runCiDispatch(server.app, config, { passId: a.passId })).toBe("settled");
    expect(dispatched.length).toBe(count);
    expect(await rowsOf(archived.id)).toEqual({
      "code.format": [0, "ci_unavailable", null],
      "code.tests": [0, "ci_unavailable", null],
      "code.crash": [0, "ci_unavailable", null],
      "bonus.extra": [0, "ci_unavailable", null],
    });

    const empty = await studentRepo(l, "lab-empty");
    const e = await claimFinal(empty.id);
    expect(await runCiDispatch(server.app, config, { passId: e.passId })).toBe("settled");
    expect(Object.values(await rowsOf(empty.id)).map((r) => r[1])).toEqual(["no_commit", "no_commit", "no_commit", "no_commit"]);

    // GitHub refusing the dispatch (Actions off): ci_unavailable too.
    const off = await studentRepo(l, "lab-off");
    await work(off);
    refusing.set(off.fullName, 422);
    const o = await claimFinal(off.id);
    expect(await runCiDispatch(server.app, config, { passId: o.passId })).toBe("settled");
    expect((await rowsOf(off.id))["code.format"]).toEqual([0, "ci_unavailable", null]);
  });

  it("paces the dispatches: one every 15 s per installation", async () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const slots = [await reserveSlot(server.app.db, 77_001, now), await reserveSlot(server.app.db, 77_001, now), await reserveSlot(server.app.db, 77_001, now)];
    expect(slots.map((s) => s.getTime() - now.getTime())).toEqual([0, DISPATCH_PACE_MS, 2 * DISPATCH_PACE_MS]);
    expect((await reserveSlot(server.app.db, 77_002, now)).getTime()).toBe(now.getTime());
    // Once the pace has passed, the next is at once.
    const later = new Date(now.getTime() + 10 * DISPATCH_PACE_MS);
    expect((await reserveSlot(server.app.db, 77_001, later)).getTime()).toBe(later.getTime());
  });

  it("queues the passes on project.ci, each at its installation's next slot, calling GitHub for none", async () => {
    const repos = [await studentRepo(l, "lab-q1"), await studentRepo(l, "lab-q2"), await studentRepo(l, "lab-q3")];
    const passes = await server.app.db.transaction((tx) => claimPasses(tx, repos.map((r) => r.id), server.clock.now()));
    const sent: { name: string; data: object; options: unknown }[] = [];
    const queue: JobQueue = {
      createQueue: async () => {},
      send: async (name, data, options) => void sent.push({ name, data, options }),
      work: async () => {},
      stop: async () => {},
    };
    const app = server.app as { boss?: JobQueue };
    const count = dispatched.length;
    app.boss = queue;
    try {
      await sendCiPasses(server.app, config, passes.map((p) => p.passId));
    } finally {
      delete app.boss;
    }
    expect(dispatched.length).toBe(count);
    expect(sent.map((s) => s.name)).toEqual(["project.ci", "project.ci", "project.ci"]);
    const at = (s: (typeof sent)[number]) => (s.options as { startAfter?: Date } | undefined)?.startAfter?.getTime() ?? new Date(NOW).getTime();
    expect(sent.map((s) => at(s) - new Date(NOW).getTime())).toEqual([0, DISPATCH_PACE_MS, 2 * DISPATCH_PACE_MS]);
    expect(sent.map((s) => (s.data as { passId: string }).passId).sort()).toEqual(passes.map((p) => p.passId).sort());
  });
});

describe("the intake", () => {
  let l: Lab;
  beforeAll(async () => {
    l = await lab();
  });

  it("accepts the run it asked for, reads its artifact onto the automatic criteria, never as a review nor a score", async () => {
    const { repo, target, pass, ctx } = await dispatchedPass(l, "lab-bob");
    const run = gradedRun(pass.nonce!, target);
    upload(run.workflowRunId, {
      $schema: 42,
      criteria: {
        "code.format": { score: "1/1", log: "formatted" },
        "code.tests": { score: " 7.5 / 10 ", log: "7 passed" },
        "code.crash": { score: "0/1" },
        "bonus.extra": { score: "1/0" },
        "rapport.style": { score: "2/2" },
        "not.a-criterion": { score: "1/1" },
      },
    });
    // Through the one ingestion path, as the webhook and the reconciliation call it.
    expect(await ingestCompletedRun(server.app, await octokitOf(l), ctx, run)).toBeNull();

    expect(await rowsOf(repo.id)).toEqual({
      "code.format": [1, null, "1/1"],
      "code.tests": [7.5, null, "7.5/10"],
      // A penalty failed costs its whole value.
      "code.crash": [-2, null, "0/1"],
      // A malformed entry is a missing result; an llm criterion is never read from the file.
      "bonus.extra": [0, "no_result", null],
    });
    expect((await passRow(pass.id)).settledAt).toEqual(new Date(NOW));
    const [stored] = await server.app.db.select().from(projectCiResults).where(eq(projectCiResults.passId, pass.id));
    expect(stored).toMatchObject({ repoId: repo.id, workflowRunId: run.workflowRunId });
    expect(stored!.results.criteria["code.tests"]).toEqual({ score: " 7.5 / 10 ", log: "7 passed" });

    // Never a grade run: neither the review slot nor the GRADE one.
    expect(await server.app.db.select().from(projectGradeRuns).where(eq(projectGradeRuns.repoId, repo.id))).toEqual([]);
    const [row] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, repo.id));
    expect([row!.reviewGradeRunId, row!.currentGradeRunId]).toEqual([null, null]);

    // The blob URL's signature nowhere: not in a row, not in the audit; fetched without credentials nor a further redirect.
    const blob = gh.calls.findIndex((c) => c.startsWith(`GET ${BLOB_HOST}`));
    expect(blob).toBeGreaterThanOrEqual(0);
    expect(gh.inits[blob]).toMatchObject({ redirect: "error" });
    expect(JSON.stringify(gh.inits[blob]!.headers ?? {})).not.toMatch(/authorization/i);
    const everything = JSON.stringify([
      await server.app.db.select().from(gradeDispatches),
      await server.app.db.select().from(projectCiResults),
      await server.app.db.select().from(projectCriterionGrades),
      await server.app.db.select().from(auditLog),
    ]);
    expect(everything).not.toContain(SIG);

    // Settled: the same run again changes nothing.
    expect(await intakeGradedRun(server.app, await octokitOf(l), ctx, run)).toBe("ignored");
  });

  it("accepts no other run: another actor, a re-run, a wrong nonce, another workflow or event", async () => {
    const { repo, target, pass, ctx } = await dispatchedPass(l, "lab-carol");
    const octokit = await octokitOf(l);
    for (const variant of [
      { triggeredBy: "person" as const },
      { triggeredBy: "workflow" as const },
      { runAttempt: 2 },
      { title: `grading ${"0".repeat(32)}` },
      { title: "grading" },
      { path: ".github/workflows/own.yml" },
      { event: "workflow_dispatch" },
      { event: "push" },
    ]) {
      const run = gradedRun(pass.nonce!, target, variant);
      upload(run.workflowRunId, { criteria: { "code.format": { score: "1/1" } } });
      expect(await intakeGradedRun(server.app, octokit, ctx, run), JSON.stringify(variant)).toBe("ignored");
    }
    expect(await rowsOf(repo.id)).toEqual({});
    expect((await passRow(pass.id)).settledAt).toBeNull();
  });

  it("gives ci_tampered for a changed criteria.yml or protected file at the target, audited with the paths", async () => {
    const octokit = await octokitOf(l);
    for (const [name, files, paths] of [
      ["lab-dave", { "criteria.yml": CRITERIA.replace("max_points: 10", "max_points: 100") }, ["criteria.yml"]],
      ["lab-erin", { "tests/check.sh": "exit 0\n" }, ["tests/check.sh"]],
      // A file added under a protected directory makes the trees differ.
      ["lab-fred", { "tests/extra.sh": "echo 1/1\n" }, ["tests/extra.sh"]],
    ] as const) {
      const repo = await studentRepo(l, name);
      const target = await work(repo, { "src/main.c": "int main(){}\n", ...files });
      const pass = await claimFinal(repo.id);
      await runCiDispatch(server.app, config, { passId: pass.passId });
      const nonce = (await passRow(pass.passId)).nonce!;
      const run = gradedRun(nonce, target);
      upload(run.workflowRunId, { criteria: { "code.format": { score: "1/1" } } });
      const ctx = (await repoContext(server.app.db, repo.githubRepoId))!;
      expect(await intakeGradedRun(server.app, octokit, ctx, run), name).toBe("ci_tampered");
      expect(Object.values(await rowsOf(repo.id)).map((r) => r[1])).toEqual(["ci_tampered", "ci_tampered", "ci_tampered", "ci_tampered"]);
      const [entry] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, repo.id), eq(auditLog.action, "project_repo.ci_tampered")));
      expect(entry!.payload).toMatchObject({ projectId: l.projectId, passId: pass.passId, workflowRunId: run.workflowRunId, target: paths, head: [] });
    }
  });

  it("gives ci_tampered for a changed grading.yml at the run's head, the target clean", async () => {
    const { repo, target, pass, ctx } = await dispatchedPass(l, "lab-gina");
    // A later push moved the default branch's head, which GitHub ran.
    const head = world.commit(repo.fullName, "main", { ".github/workflows/grading.yml": `${WORKFLOW}# mine\n` });
    const run = gradedRun(pass.nonce!, head);
    upload(run.workflowRunId, { criteria: { "code.format": { score: "1/1" } } });
    expect(await intakeGradedRun(server.app, await octokitOf(l), ctx, run)).toBe("ci_tampered");
    const [entry] = await server.app.db.select().from(auditLog).where(and(eq(auditLog.subjectId, repo.id), eq(auditLog.action, "project_repo.ci_tampered")));
    expect(entry!.payload).toMatchObject({ target: [], head: [".github/workflows/grading.yml"] });
    expect(target).not.toBe(head);
  });

  it("gives no_result for a run without its artifact, or whose artifact is refused", async () => {
    const octokit = await octokitOf(l);
    const cases: [string, (runId: number) => void][] = [
      ["absent", () => undefined],
      ["misnamed", (runId) => upload(runId, { criteria: {} }, { name: "result" })],
      ["two entries", (runId) => upload(runId, null, { zip: zipSync({ "results.json": new Uint8Array([123, 125]), "x.txt": new Uint8Array([1]) }) })],
      ["traversal", (runId) => upload(runId, null, { zip: zipSync({ "../results.json": new TextEncoder().encode("{}") }) })],
      ["not json", (runId) => upload(runId, null, { zip: zipSync({ "results.json": new TextEncoder().encode("1/1") }) })],
      ["no criteria", (runId) => upload(runId, { results: {} })],
    ];
    for (const [label, arrange] of cases) {
      const { repo, target, pass, ctx } = await dispatchedPass(l, `lab-nr-${label.replace(/\s/g, "")}`);
      const run = gradedRun(pass.nonce!, target);
      arrange(run.workflowRunId);
      expect(await intakeGradedRun(server.app, octokit, ctx, run), label).toBe("no_result");
      expect(Object.values(await rowsOf(repo.id)).map((r) => r[1]), label).toEqual(["no_result", "no_result", "no_result", "no_result"]);
    }
  });

  it("throws without the blob URL when the store fails, and leaves the pass waiting", async () => {
    const { pass, target, ctx } = await dispatchedPass(l, "lab-hugo");
    const run = gradedRun(pass.nonce!, target);
    upload(run.workflowRunId, { criteria: {} }, { status: 500 });
    const err = await intakeGradedRun(server.app, await octokitOf(l), ctx, run).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArtifactUnavailable);
    expect(String((err as Error).message)).not.toContain(SIG);
    expect(String((err as Error).message)).not.toContain(BLOB_HOST);
    expect((await passRow(pass.id)).settledAt).toBeNull();
  });

  it("maps the webhook's run, its name included", () => {
    const run = completedRun(
      config,
      { id: 9, head_sha: "abc", path: ".github/workflows/grading.yml", event: "repository_dispatch", display_title: "grading n0nce", triggering_actor: { login: "quiz-test[bot]" } },
      new Date(NOW),
    );
    expect(run).toMatchObject({ title: "grading n0nce", triggeredBy: "app", runAttempt: 1 });
  });
});

describe("the 24 h and a Regrade", () => {
  let l: Lab;
  beforeAll(async () => {
    l = await lab();
  });

  it("settles a pass without an accepted run 24 h after its dispatch: no_result (the server's clock)", async () => {
    const { repo, pass } = await dispatchedPass(l, "lab-ivy");
    server.clock.set(new Date(new Date(NOW).getTime() + RESULT_WAIT_MS - 1000));
    expect(await expireCiPasses(server.app, server.clock.now())).toBe(0);
    expect(await rowsOf(repo.id)).toEqual({});
    server.clock.set(new Date(new Date(NOW).getTime() + RESULT_WAIT_MS + 1000));
    // This pass, and any other left waiting by the tests above.
    expect(await expireCiPasses(server.app, server.clock.now())).toBeGreaterThanOrEqual(1);
    expect(Object.values(await rowsOf(repo.id)).map((r) => r[1])).toEqual(["no_result", "no_result", "no_result", "no_result"]);
    expect((await passRow(pass.id)).settledAt).not.toBeNull();
    server.clock.set(NOW);
  });

  it("always dispatches a Regrade anew with a new nonce, retiring the old one", async () => {
    const { repo, target, pass, ctx } = await dispatchedPass(l, "lab-jack");
    await server.app.db.update(projectRepos).set({ deadlineAppliedAt: new Date(NOW), frozenAt: new Date(NOW) }).where(eq(projectRepos.id, repo.id));
    const [project] = await server.app.db.select().from(projects).where(eq(projects.id, l.projectId));
    const [row] = await server.app.db.select().from(projectRepos).where(eq(projectRepos.id, repo.id));
    const count = dispatched.length;
    expect(await regrade(server.app, config, project!, row!, SYSTEM_ACTOR, server.clock.now())).toEqual({ repos: 1 });
    expect(dispatched.length).toBe(count + 1);
    const sent = dispatched.at(-1)!.body.client_payload;
    expect(sent).toMatchObject({ sha: target, pass: "final" });
    expect(sent.nonce).not.toBe(pass.nonce);
    expect((await passRow(pass.id)).retiredAt).not.toBeNull();

    const octokit = await octokitOf(l);
    // The retired nonce's run is not accepted; the new one's is.
    const old = gradedRun(pass.nonce!, target);
    upload(old.workflowRunId, { criteria: { "code.format": { score: "0/1" } } });
    expect(await intakeGradedRun(server.app, octokit, ctx, old)).toBe("ignored");
    const fresh = gradedRun(String(sent.nonce), target);
    upload(fresh.workflowRunId, { criteria: { "code.format": { score: "1/1" }, "code.tests": { score: "10/10" }, "code.crash": { score: "1/1" }, "bonus.extra": { score: "1/1" } } });
    expect(await intakeGradedRun(server.app, octokit, ctx, fresh)).toBe("accepted");
    expect(await rowsOf(repo.id)).toEqual({
      "code.format": [1, null, "1/1"],
      "code.tests": [10, null, "10/10"],
      "code.crash": [0, null, "1/1"],
      "bonus.extra": [1, null, "1/1"],
    });
  });
});

describe("the two paths (ADR-119 §11)", () => {
  it("never runs a schema-3 snapshot on the runner, nor proposes an auto row from JUnit", async () => {
    const l = await lab();
    const repo = await studentRepo(l, "lab-kim");
    await work(repo);
    const calls: unknown[] = [];
    const real = server.app.runner;
    server.app.runner = {
      run: (req) => real.run(req),
      health: () => real.health(),
      project: (req) => {
        calls.push(req);
        return Promise.reject(new Error("never"));
      },
    };
    try {
      expect(await runEvidence(server.app, config, repo.id)).toBeNull();
    } finally {
      server.app.runner = real;
    }
    expect(calls).toEqual([]);
    expect(await server.app.db.select().from(projectEvidence).where(eq(projectEvidence.repoId, repo.id))).toEqual([]);
    expect(await rowsOf(repo.id)).toEqual({});
  });

  it("claims a schema-2 snapshot's pass for the runner, without a nonce: the CI's dispatch ignores it", async () => {
    const l = await lab(2);
    const repo = await studentRepo(l, "lab-lou");
    const pass = await claimFinal(repo.id);
    expect(pass.ci).toBe(false);
    expect((await passRow(pass.passId)).nonce).toBeNull();
    expect(await runCiDispatch(server.app, config, { passId: pass.passId })).toBe("none");
  });
});
