/**
 * The evidence run (ADR-106 §3, L-02b) on a server built with Quiz's App,
 * against the fake GitHub and its local bare repositories (`./testing.ts`)
 * and a runner double: the target commit, the tarball through `codeload`
 * (its token nowhere), the overlay and the stripped root, the no-evidence
 * statuses, the `auto` rows and their supersede chain, the reuse of an
 * `ok` evidence, the deletion with the project, the retention.
 */
import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProjectSummary } from "@quiz/contracts";
import { RunnerBusy, RunnerUnavailable, type ProjectRunRefusal, type ProjectRunRequest, type ProjectRunResult } from "@quiz/core/server";
import { readTar } from "@quiz/core/tar";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { loadConfig } from "../../config.js";
import {
  courseStaff,
  githubClassroomLinks,
  githubOrganizations,
  projectCriteria,
  projectCriterionGrades,
  projectEvidence,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, CODELOAD_HOST, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { BUSY_ATTEMPTS_MAX, purgeEvidenceFiles, runEvidence, TarballUnavailable } from "./evidence.js";
import { CODELOAD_TOKEN, repoWorld } from "./testing.js";

const CRITERIA = `schema_version: 2
criteria:
  rendu:
    all-tests-passed: {description: Tests, awarded_points: 0, max_points: 10}
    parse: {description: Parsing, awarded_points: 0, max_points: 4, test: "tests/test_lab.py::test_parse"}
    other: {description: Other, awarded_points: 0, max_points: 2, test: test_other}
    crash: {description: Crash penalty, awarded_points: 0, max_points: -2, test: test_x}
  rapport:
    style: {description: Style, awarded_points: 0, max_points: 2, prompt: "Is the code readable?"}
`;
const PROTECTED = "tests/test_lab.py";
const DIST_TEST = "def test_parse():\n    assert parse('') == []\n";
const REPORT = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="4">
<testcase classname="tests.test_lab" name="test_parse" time="0.01"/>
<testcase classname="tests.test_lab" name="test_parse_empty"><failure message="assert [1] == []">x</failure></testcase>
<testcase classname="tests.test_lab" name="test_other"/>
<testcase classname="tests.test_lab" name="test_x"><error message="boom"/></testcase>
</testsuite></testsuites>`;
const RESULT: ProjectRunResult = {
  build: { exitCode: 0, stdout: "built", stderr: "", ms: 900, timedOut: false, truncated: false },
  test: { exitCode: 1, stdout: "2 failed, 2 passed", stderr: "", ms: 1500, timedOut: false, truncated: false },
  files: [
    { path: "report.xml", content: REPORT, truncated: false, size: REPORT.length },
    { path: "build/main", binary: true, size: 18_000 },
  ],
};

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
let nextOrg = 9400;
/** What the runner double received, and what it answers. */
const sent: ProjectRunRequest[] = [];
let answer: () => Promise<ProjectRunResult | ProjectRunRefusal> = () => Promise.resolve(RESULT);

interface Lab {
  projectId: string;
  login: string;
  distribution: string;
}

/** A project in `criteria` mode, published from a source whose `tests/test_lab.py` is protected. */
async function lab(): Promise<Lab> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: teacher.id }).onConflictDoNothing();
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", { main: { "README.md": "# Lab", Makefile: "prepare:\n", [PROTECTED]: DIST_TEST, "criteria.yml": CRITERIA } });
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
  const parsed = parseCriteria(CRITERIA);
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db.update(projects).set({ gradingMode: "criteria", protectedFiles: [PROTECTED] }).where(eq(projects.id, project.id));
  await db.insert(projectCriteria).values({ projectId: project.id, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  return { projectId: project.id, login, distribution: project.distribution!.fullName };
}

/** A student's repository of `lab`, a copy of the distribution on GitHub (unless `onGithub` is false), and its row. */
async function studentRepo(l: Lab, name: string, onGithub = true) {
  const fullName = `${l.login}/${name}`;
  if (onGithub) world.source(l.login, name, { main: { "README.md": "# Lab", Makefile: "prepare:\n", [PROTECTED]: DIST_TEST } });
  else world.ids.set(fullName, nextOrg * 100 + name.length);
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

async function receipt(repo: { githubRepoId: number }, headSha: string, receivedAt: Date, isBot = false) {
  await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: repo.githubRepoId, branch: "main", headSha, receivedAt, isBot });
}

const evidenceOf = async (repoId: string) =>
  server.app.db.select().from(projectEvidence).where(eq(projectEvidence.repoId, repoId)).orderBy(projectEvidence.createdAt);
const liveRows = async (repoId: string) =>
  server.app.db
    .select()
    .from(projectCriterionGrades)
    .where(and(eq(projectCriterionGrades.repoId, repoId), ne(projectCriterionGrades.state, "superseded")));
const pointsOf = async (repoId: string) =>
  Object.fromEntries((await liveRows(repoId)).map((r) => [r.criterionId, [r.points, r.max, r.reason]]));
/** The archive the runner received last, path → text. */
const lastArchive = () => {
  const tar = Buffer.from(sent.at(-1)!.archive, "base64");
  return new Map(readTar(tar).map((e) => [e.path, Buffer.from(e.data).toString("utf8")]));
};

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  server.clock.set(NOW);
  gh.routes = [orgsRoute(() => []), world.route];
  teacher = await server.signIn("teacher");
  const real = server.app.runner;
  server.app.runner = {
    run: (req) => real.run(req),
    health: () => real.health(),
    project: (req) => {
      sent.push(req);
      return answer();
    },
  };
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  setRemoteBaseForTests(null);
  world.remove();
  key.remove();
});

describe("the evidence of a repository", () => {
  let l: Lab;
  beforeAll(async () => {
    l = await lab();
  });

  it("tests the last student commit before the deadline, the distribution's protected file in place of the student's", async () => {
    const repo = await studentRepo(l, "lab-alice");
    const target = world.commit(repo.fullName, "main", { [PROTECTED]: "def test_parse():\n    pass\n", "src/parse.py": "def parse(s): return []\n" });
    const restore = world.commit(repo.fullName, "main", { [PROTECTED]: DIST_TEST });
    const late = world.commit(repo.fullName, "main", { "src/late.py": "x = 1\n" });
    await receipt(repo, target, before(60));
    await receipt(repo, restore, before(30), true);
    await receipt(repo, late, new Date(DEADLINE.getTime() + 1000));

    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "ok", rows: 3 });

    const [evidence] = await evidenceOf(repo.id);
    expect(evidence).toMatchObject({
      targetSha: target,
      distributionSha: world.git(l.distribution, "rev-parse", "main").trim(),
      status: "ok",
      reason: null,
    });
    expect(evidence!.cases).toHaveLength(4);
    // Text outputs only: the binary is not kept.
    expect(Object.keys(evidence!.files!)).toEqual(["report.xml"]);

    expect(sent.at(-1)).toMatchObject({
      image: "lab-c",
      commands: { build: ["make", "prepare"], test: ["pytest", "--junitxml=report.xml", "-q"] },
      outputs: ["report.xml", "build/"],
    });
    const archive = lastArchive();
    expect(archive.get(PROTECTED)).toBe(DIST_TEST);
    expect(archive.get("src/parse.py")).toBe("def parse(s): return []\n");
    expect(archive.has("src/late.py")).toBe(false);
    // The top-level `<owner>-<repo>-<sha>/` is gone: no path names the student's repository.
    for (const path of archive.keys()) expect(path).not.toContain("lab-alice");
    expect(JSON.stringify(evidence)).not.toContain("lab-alice");

    // The tests criterion: 2 of 4 cases; a `test:` leaf: 1 of its 2, or its one; the llm criterion and the penalty: no row.
    expect(await pointsOf(repo.id)).toEqual({
      "rendu.all-tests-passed": [5, 10, null],
      "rendu.parse": [2, 4, null],
      "rendu.other": [2, 2, null],
    });
  });

  it("reuses an ok evidence of the same commits, and supersedes only the proposals of a new one", async () => {
    const repo = await studentRepo(l, "lab-bob");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/parse.py": "def parse(s): return []\n" }), before(10));
    await runEvidence(server.app, config, repo.id);
    const calls = sent.length;
    const first = await liveRows(repo.id);

    // The same commits: no new run, no new row.
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "ok", rows: 0 });
    expect(sent.length).toBe(calls);
    expect((await liveRows(repo.id)).map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());

    // A teacher validated one criterion.
    const parse = first.find((r) => r.criterionId === "rendu.parse")!;
    await server.app.db.update(projectCriterionGrades).set({ state: "validated" }).where(eq(projectCriterionGrades.id, parse.id));

    // The distribution moves: a new evidence, the proposals superseded, the validated row untouched.
    world.commit(l.distribution, "main", { "NOTES.md": "v2" });
    answer = () => Promise.resolve({ ...RESULT, files: [{ path: "report.xml", content: REPORT.replace(/<failure[^>]*>x<\/failure>/, ""), truncated: false, size: 1 }] });
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "ok", rows: 2 });
    answer = () => Promise.resolve(RESULT);
    expect(sent.length).toBe(calls + 1);
    expect(await evidenceOf(repo.id)).toHaveLength(2);

    const now = await liveRows(repo.id);
    const tests = now.find((r) => r.criterionId === "rendu.all-tests-passed")!;
    expect(tests).toMatchObject({ points: 7.5, state: "proposed", source: "auto" });
    expect(tests.supersedesId).toBe(first.find((r) => r.criterionId === "rendu.all-tests-passed")!.id);
    expect(now.find((r) => r.id === parse.id)).toMatchObject({ state: "validated", points: 2 });
    expect(now).toHaveLength(3);
  });

  it("gives the automatic criteria 0 with no_commit when the student pushed nothing by the deadline", async () => {
    const repo = await studentRepo(l, "lab-carol");
    await receipt(repo, world.commit(repo.fullName, "main", { "README.md": "deadline" }), before(5), true);
    const calls = sent.length;
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "no_commit", rows: 3 });
    expect(sent.length).toBe(calls);
    expect(await evidenceOf(repo.id)).toEqual([expect.objectContaining({ status: "no_commit", targetSha: null, distributionSha: null })]);
    expect(await pointsOf(repo.id)).toEqual({
      "rendu.all-tests-passed": [0, 10, "no_commit"],
      "rendu.parse": [0, 4, "no_commit"],
      "rendu.other": [0, 2, "no_commit"],
    });
  });

  it("refuses a tarball over the cap without running it: archive_too_large", async () => {
    const repo = await studentRepo(l, "lab-dan");
    await receipt(repo, world.commit(repo.fullName, "main", { "data.bin": "x" }), before(5));
    world.oversized.set(repo.fullName, 21 * 1024 * 1024);
    const calls = sent.length;
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "archive_too_large", rows: 3 });
    expect(sent.length).toBe(calls);
    expect((await pointsOf(repo.id))["rendu.all-tests-passed"]).toEqual([0, 10, "archive_too_large"]);
  });

  it("skips a repository deleted on GitHub: repo_missing", async () => {
    const repo = await studentRepo(l, "lab-erin", false);
    await receipt(repo, "a".repeat(40), before(5));
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "repo_missing", rows: 3 });
    expect((await pointsOf(repo.id))["rendu.parse"]).toEqual([0, 4, "repo_missing"]);
  });

  it("waits for a busy runner, and gives up past the bound", async () => {
    const repo = await studentRepo(l, "lab-busy");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/b.py": "1\n" }), before(5));
    // One 429 with no delay to honour, then the run: the evidence is ok and the request was sent twice.
    let calls = 0;
    answer = () => (++calls === 1 ? Promise.reject(new RunnerBusy(0)) : Promise.resolve(RESULT));
    const sentBefore = sent.length;
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "ok" });
    expect(sent.length - sentBefore).toBe(2);
    // Busy at every attempt: sent BUSY_ATTEMPTS_MAX times, then stored as timed_out / runner_busy, never a throw.
    const other = await studentRepo(l, "lab-busier");
    await receipt(other, world.commit(other.fullName, "main", { "src/b.py": "1\n" }), before(5));
    answer = () => Promise.reject(new RunnerBusy(0));
    const otherBefore = sent.length;
    expect(await runEvidence(server.app, config, other.id)).toMatchObject({ status: "timed_out" });
    expect(sent.length - otherBefore).toBe(BUSY_ATTEMPTS_MAX);
    expect((await evidenceOf(other.id))[0]!.reason).toBe("runner_busy");
    answer = () => Promise.resolve(RESULT);
  });

  it("never resends a run the client gave up on (its timeout, no Retry-After)", async () => {
    const repo = await studentRepo(l, "lab-slow");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/b.py": "1\n" }), before(5));
    answer = () => Promise.reject(new RunnerBusy(null));
    const sentBefore = sent.length;
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "timed_out" });
    expect(sent.length - sentBefore).toBe(1);
    expect((await evidenceOf(repo.id))[0]!.reason).toBe("runner_busy");
    answer = () => Promise.resolve(RESULT);
  });

  it("records the runner refusing the archive, or unreachable, as the criteria's reason", async () => {
    const repo = await studentRepo(l, "lab-gus");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/b.py": "1\n" }), before(5));
    answer = () => Promise.resolve({ refused: "archive_refused", entries: ["src/x: dot_segment"] });
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "refused" });
    expect((await evidenceOf(repo.id))[0]!.reason).toBe("archive_refused: src/x: dot_segment");

    answer = () => Promise.reject(new RunnerUnavailable("unreachable"));
    expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "runner_unavailable" });
    answer = () => Promise.resolve(RESULT);
    // A failed evidence is replaced, never reused: one row for these commits.
    expect(await evidenceOf(repo.id)).toEqual([expect.objectContaining({ status: "runner_unavailable", reason: "unreachable" })]);
    expect((await pointsOf(repo.id))["rendu.all-tests-passed"]).toEqual([0, 10, "runner_unavailable"]);
  });

  it("never lets the codeload URL's token into a row, a runner request or an error", async () => {
    const repo = await studentRepo(l, "lab-hal");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/c.py": "1\n" }), before(5));
    const routes = gh.routes;
    gh.routes = [
      (url) => {
        if (url.host === CODELOAD_HOST) throw new Error(`socket hang up on ${url.href}`);
        return undefined;
      },
      ...routes,
    ];
    try {
      // GitHub's failure is stored, not thrown: the pass's review still follows (ADR-106 §4).
      expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "github_unavailable", rows: 3 });
    } finally {
      gh.routes = routes;
    }
    const [stored] = await evidenceOf(repo.id);
    expect(stored).toMatchObject({ status: "github_unavailable", reason: expect.stringContaining("socket hang up on <url>") });
    expect((await pointsOf(repo.id))["rendu.all-tests-passed"]).toEqual([0, 10, "github_unavailable"]);
    // The error itself, where one is still thrown, never carries the token either.
    const err = new TarballUnavailable(`socket hang up on https://${CODELOAD_HOST}/x?token=${CODELOAD_TOKEN}`);
    expect(err.message).toContain("token=***");
    expect(`${err.message} ${err.stack}`).not.toContain(CODELOAD_TOKEN);
    const everything = JSON.stringify([await server.app.db.select().from(projectEvidence), await server.app.db.select().from(projectCriterionGrades), sent]);
    expect(everything).not.toContain(CODELOAD_TOKEN);
    expect(everything).not.toContain(CODELOAD_HOST);
  });

  it("follows a redirect to codeload only", async () => {
    const repo = await studentRepo(l, "lab-jo");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/e.py": "1\n" }), before(5));
    const routes = gh.routes;
    gh.routes = [
      (url) =>
        url.host === "api.github.com" && url.pathname.includes("/tarball/")
          ? new Response(null, { status: 302, headers: { location: "https://evil.example/archive.tar.gz?token=x" } })
          : undefined,
      ...routes,
    ];
    try {
      expect(await runEvidence(server.app, config, repo.id)).toMatchObject({ status: "github_unavailable" });
    } finally {
      gh.routes = routes;
    }
    expect(gh.calls.some((c) => c.includes("evil.example"))).toBe(false);
    expect(await evidenceOf(repo.id)).toEqual([expect.objectContaining({ status: "github_unavailable", reason: expect.stringContaining("evil.example") })]);
  });

  it("deletes the evidence and the rows with the project", async () => {
    const other = await lab();
    const repo = await studentRepo(other, "lab-ivy");
    await receipt(repo, world.commit(repo.fullName, "main", { "src/d.py": "1\n" }), before(5));
    await runEvidence(server.app, config, repo.id);
    await server.app.db.delete(projects).where(eq(projects.id, other.projectId));
    expect(await evidenceOf(repo.id)).toEqual([]);
    expect(await liveRows(repo.id)).toEqual([]);
  });
});

describe("the evidence files' retention (N-DATA-03)", () => {
  it("drops the files and the outputs six months after the release, keeping the cases and the status", async () => {
    const released = async (at: string) => {
      const l = await lab();
      const repo = await studentRepo(l, "lab-kim");
      await receipt(repo, world.commit(repo.fullName, "main", { "src/f.py": "1\n" }), before(5));
      await runEvidence(server.app, config, repo.id);
      await server.app.db.update(projects).set({ releasedAt: new Date(at) }).where(eq(projects.id, l.projectId));
      return repo;
    };
    const old = await released("2026-03-01T00:00:00Z");
    const recent = await released("2026-09-01T00:00:00Z");
    expect(await purgeEvidenceFiles(server.app.db, new Date(NOW))).toBe(1);
    const [purged] = await evidenceOf(old.id);
    expect(purged).toMatchObject({ status: "ok", files: null, test: expect.objectContaining({ stdout: "", stderr: "", exitCode: 1 }) });
    expect(purged!.cases).toHaveLength(4);
    expect((await evidenceOf(recent.id))[0]!.files).not.toBeNull();
    expect(await purgeEvidenceFiles(server.app.db, new Date(NOW))).toBe(0);
  });
});
