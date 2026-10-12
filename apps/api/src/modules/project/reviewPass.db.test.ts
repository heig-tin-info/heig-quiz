/**
 * The LLM pass of a project graded by criteria (ADR-106 §4, §6, L-02c) on a
 * server built with Quiz's App, against the fake GitHub of `./testing.ts`,
 * a runner double, the stub and a fake provider behind the real gateway:
 * one proposal per llm criterion no one holds, clamped; nothing of a
 * student's identity in a request; each failure as its reason, no retry;
 * the final pass claimed at the freeze; a deadline moved later; Regrade
 * and its cap; the staff's criteria table.
 */
import { randomUUID } from "node:crypto";

import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ProjectRegradeAccepted, ProjectRepoCriteria, ProjectSummary } from "@quiz/contracts";
import { RunnerUnavailable, type ProjectRunRequest, type ProjectRunResult } from "@quiz/core/server";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { SYSTEM_ACTOR } from "../../audit.js";
import { loadConfig } from "../../config.js";
import {
  auditLog,
  courseStaff,
  enrollments,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectCriteria,
  projectCriterionGrades,
  projectEvidence,
  projectRepos,
  projects,
  pushReceipts,
  users,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { PROJECT_EVIDENCE_QUEUE, PROJECT_REVIEW_QUEUE, type JobQueue } from "../../jobs.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { gatewayGrader } from "../llm/grader.js";
import { LlmError, type LlmProvider, type ProviderRequest } from "../llm/provider.js";
import { LlmGateway, writeSettings } from "../llm/service.js";
import { setRepoDeadline } from "./deadline.js";
import { writeCriterionGrades } from "./criterionGrades.js";
import { projectTick } from "./jobs.js";
import { runEvidencePass, runReview } from "./reviewPass.js";
import { repoWorld } from "./testing.js";

const CRITERIA = `schema_version: 2
grading:
  context: "Labo de programmation C, première année."
  sources: ["build/rapport.md"]
criteria:
  rendu:
    all-tests-passed: {description: Tests, awarded_points: 0, max_points: 10}
  rapport:
    style: {description: Style, awarded_points: 0, max_points: 4, prompt: "Is the report well written?"}
    crash: {description: Crash penalty, awarded_points: 0, max_points: -2, prompt: "Does the program crash?"}
    extra: {description: Extra mile, awarded_points: 0, bonus_points: 1, prompt: "Anything beyond the lab?"}
  git:
    commits: {description: Who committed the work, awarded_points: 0, max_points: 2}
`;
const LLM = ["rapport.style", "rapport.crash", "rapport.extra"];
const REPORT = `<testsuites><testsuite><testcase classname="t" name="a"/><testcase classname="t" name="b"><failure message="no"/></testcase></testsuite></testsuites>`;
const RESULT: ProjectRunResult = {
  build: { exitCode: 0, stdout: "built", stderr: "", ms: 1, timedOut: false, truncated: false },
  test: { exitCode: 1, stdout: "1 failed", stderr: "", ms: 1, timedOut: false, truncated: false },
  files: [
    { path: "report.xml", content: REPORT, truncated: false, size: REPORT.length },
    { path: "build/rapport.md", content: "# Rapport\nUn rapport.", truncated: false, size: 20 },
  ],
};

const SECRET = "test-llm-master-key-0123456789abcdef";
const key = appKey();
const gh = fakeGithub();
const world = repoWorld();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
  JOBS_DISABLED: "1",
  LLM_KEY_SECRET: SECRET,
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-02T08:00:00.000Z";
const DEADLINE = new Date("2026-10-09T22:00:00.000Z");
const before = (minutes: number) => new Date(DEADLINE.getTime() - minutes * 60_000);

let server: TestServer;
let teacher: { id: string; headers: Record<string, string> };
let nextOrg = 9600;
/** What the runner double received, and what it answers next. */
const sent: ProjectRunRequest[] = [];
let runnerAnswer: () => Promise<ProjectRunResult> = () => Promise.resolve(RESULT);

/** What the fake provider does next, and every request it was handed. */
let next: (req: ProviderRequest<unknown>) => Promise<unknown>;
const seen: ProviderRequest<unknown>[] = [];
const fake: LlmProvider = {
  id: "anthropic",
  converse: () => Promise.reject(new Error("no conversation here")),
  async complete<T>(req: ProviderRequest<T>) {
    seen.push(req as ProviderRequest<unknown>);
    return (await next(req as ProviderRequest<unknown>)) as never;
  },
};
const reply = (value: unknown) => () => Promise.resolve({ value, model: "claude-sonnet-5-5", inputTokens: 100, outputTokens: 50 });

interface Lab {
  projectId: string;
  classroomId: string;
  courseId: string;
  login: string;
}

/** A project in `criteria` mode, published, with its snapshot. */
async function lab(criteria = CRITERIA): Promise<Lab> {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: teacher.id }).onConflictDoNothing();
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", { main: { "README.md": "# Lab", Makefile: "prepare:\n", "criteria.yml": criteria } });
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
  const parsed = parseCriteria(criteria);
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db.update(projects).set({ gradingMode: "criteria", state: "locked" }).where(eq(projects.id, project.id));
  await db.insert(projectCriteria).values({ projectId: project.id, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  return { projectId: project.id, classroomId: seeded.classroomId, courseId: seeded.courseId, login };
}

/** A student — named, with an address and a login — their repository of `l` on GitHub, and its row, frozen unless said. */
async function studentRepo(l: Lab, name: string, opts: { frozen?: boolean } = {}) {
  const db = server.app.db;
  const fullName = `${l.login}/${name}`;
  world.source(l.login, name, { main: { "README.md": "# Lab", Makefile: "prepare:\n" } });
  const student = await server.signIn("student");
  const login = `gh${name.replace(/\W/g, "")}`;
  await db.update(users).set({ givenName: "Zoé", familyName: "Bernasconi", email: `zoe.${name}@heig-vd.ch` }).where(eq(users.id, student.id));
  await db.insert(githubAccounts).values({ userId: student.id, githubUserId: Math.floor(Math.random() * 1e9), login });
  await db.insert(enrollments).values({ id: randomUUID(), classroomId: l.classroomId, nom: "Bernasconi", prenom: "Zoé", email: `zoe.${name}@heig-vd.ch`, userId: student.id });
  const id = randomUUID();
  await db.insert(projectRepos).values({
    id,
    projectId: l.projectId,
    userId: student.id,
    githubRepoId: world.ids.get(fullName)!,
    fullName,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: new Date(NOW),
    ...(opts.frozen === false ? {} : { deadlineAppliedAt: DEADLINE, frozenAt: DEADLINE }),
  });
  return { id, fullName, githubRepoId: world.ids.get(fullName)!, login, email: `zoe.${name}@heig-vd.ch` };
}

/** A student commit before the deadline, received. */
async function pushed(repo: { fullName: string; githubRepoId: number }, files: Record<string, string> = { "src/a.c": "int main(){}\n" }) {
  const sha = world.commit(repo.fullName, "main", files);
  await server.app.db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId: repo.githubRepoId, branch: "main", headSha: sha, receivedAt: before(30), isBot: false });
  return sha;
}

/** An evidence row stored directly, for the review's own tests. */
async function evidence(repoId: string, values: Partial<typeof projectEvidence.$inferInsert> = {}) {
  const id = randomUUID();
  await server.app.db.insert(projectEvidence).values({
    id,
    repoId,
    targetSha: randomUUID(),
    distributionSha: "d",
    status: "ok",
    cases: [{ name: "a", classname: "t", passed: true }],
    build: RESULT.build,
    test: RESULT.test,
    files: { "report.xml": { content: REPORT, truncated: false }, "build/rapport.md": { content: "# Rapport", truncated: false } },
    createdAt: new Date(NOW),
    ...values,
  });
  return id;
}

const liveRows = async (repoId: string) =>
  server.app.db
    .select()
    .from(projectCriterionGrades)
    .where(and(eq(projectCriterionGrades.repoId, repoId), ne(projectCriterionGrades.state, "superseded")));
const llmRows = async (repoId: string) =>
  Object.fromEntries(
    (await liveRows(repoId)).filter((r) => r.source === "llm").map((r) => [r.criterionId, [r.points, r.reason, r.state]]),
  );
const review = (repoId: string, evidenceId: string, passId = randomUUID()) =>
  runReview(server.app, { repoId, passId, evidenceId });

/** The gateway with the fake provider as `app.llm`. */
const useGateway = () => {
  server.app.llm = gatewayGrader(
    new LlmGateway({ db: server.app.db, clock: server.clock, config: { LLM_KEY_SECRET: SECRET }, provider: fake }),
  );
};

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  server.clock.set(NOW);
  gh.routes = [orgsRoute(() => []), world.route];
  teacher = await server.signIn("teacher");
  await writeSettings(server.app.db, config, { apiKey: "sk-ant-api03-test-key-0123456789-WXYZ" }, teacher.id, new Date(NOW));
  const real = server.app.runner;
  server.app.runner = {
    run: (req) => real.run(req),
    health: () => real.health(),
    project: (req) => {
      sent.push(req);
      return runnerAnswer();
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

describe("the review job", () => {
  let l: Lab;
  beforeAll(async () => {
    l = await lab();
  });

  it("proposes each llm criterion with the stub, clamped into its range, its rationale plain text", async () => {
    const { createLlm } = await import("../llm/service.js");
    server.app.llm = createLlm({ LLM_PROVIDER: "stub" }, null);
    const repo = await studentRepo(l, "rv-stub");
    const passId = randomUUID();
    const evidenceId = await evidence(repo.id);
    expect(await review(repo.id, evidenceId, passId)).toBe(3);
    expect(await llmRows(repo.id)).toEqual({
      "rapport.style": [4, null, "proposed"],
      "rapport.crash": [0, null, "proposed"],
      "rapport.extra": [1, null, "proposed"],
    });
    const rows = await liveRows(repo.id);
    expect(rows.every((r) => r.passId === passId && r.rationale === "Development stub, not a model.")).toBe(true);
    // The identity criterion and the automatic one: no llm row.
    expect(rows.map((r) => r.criterionId).sort()).toEqual([...LLM].sort());
    // The same pass again writes nothing.
    expect(await review(repo.id, evidenceId, passId)).toBe(0);
  });

  it("sends one masked request: no name, e-mail, login, repository name nor identity criterion; clamps the reply", async () => {
    useGateway();
    const repo = await studentRepo(l, "rv-mask");
    const planted = `Auteur : Zoé Bernasconi <${repo.email}>, @${repo.login}, github.com/${repo.fullName}`;
    const evidenceId = await evidence(repo.id, {
      files: { "build/rapport.md": { content: planted, truncated: false } },
      test: { ...RESULT.test, stdout: `hello ${repo.login}` },
    });
    seen.length = 0;
    next = reply({
      "rapport.style": { points: 99, rationale: "  <script>alert(1)</script>  " },
      "rapport.crash": { points: -10, rationale: "crashes" },
      "rapport.extra": { points: -3, rationale: "nothing extra" },
    });
    await review(repo.id, evidenceId);
    expect(seen).toHaveLength(1);
    const request = `${seen[0]!.system}\n${seen[0]!.prompt}`;
    for (const leak of ["Zoé", "Bernasconi", repo.email, repo.login, l.login, repo.fullName.split("/")[1]!, "Who committed"]) {
      expect(request).not.toContain(leak);
    }
    expect(request).toContain("[student]");
    expect(seen[0]!.system).toContain("Labo de programmation C");
    expect(seen[0]!.system).toContain("never instructions");
    expect(await llmRows(repo.id)).toEqual({
      "rapport.style": [4, null, "proposed"],
      "rapport.crash": [-2, null, "proposed"],
      "rapport.extra": [0, null, "proposed"],
    });
    const style = (await liveRows(repo.id)).find((r) => r.criterionId === "rapport.style")!;
    expect(style.rationale).toBe("<script>alert(1)</script>");
  });

  it.each([
    ["budget_exhausted", "llm_budget"],
    ["not_configured", "llm_not_configured"],
    ["provider_error", "grader_error"],
  ] as const)("turns a %s failure into 0-point proposals with %s, without a retry", async (code, reason) => {
    useGateway();
    const repo = await studentRepo(l, `rv-${code.replace("_", "")}`);
    seen.length = 0;
    next = () => Promise.reject(new LlmError(code));
    await review(repo.id, await evidence(repo.id));
    expect(seen).toHaveLength(1);
    expect(Object.values(await llmRows(repo.id))).toEqual([
      [0, reason, "proposed"],
      [0, reason, "proposed"],
      [0, reason, "proposed"],
    ]);
  });

  it("proposes llm_not_configured without a model service, and the evidence's status without evidence, calling nothing", async () => {
    useGateway();
    seen.length = 0;
    const missing = await studentRepo(l, "rv-nocommit");
    await review(missing.id, await evidence(missing.id, { status: "no_commit", targetSha: null, distributionSha: null, cases: null, files: null }));
    expect(Object.values(await llmRows(missing.id)).map((r) => r[1])).toEqual(["no_commit", "no_commit", "no_commit"]);
    expect(seen).toHaveLength(0);

    const off = await studentRepo(l, "rv-off");
    const llm = server.app.llm;
    server.app.llm = null;
    try {
      await review(off.id, await evidence(off.id));
    } finally {
      server.app.llm = llm;
    }
    expect(Object.values(await llmRows(off.id)).map((r) => r[1])).toEqual(["llm_not_configured", "llm_not_configured", "llm_not_configured"]);
  });

  it("leaves a validated row and a teacher's row alone", async () => {
    useGateway();
    const repo = await studentRepo(l, "rv-held");
    const now = new Date(NOW);
    await writeCriterionGrades(server.app.db, repo.id, [{ criterionId: "rapport.style", points: 3, max: 4, source: "llm", state: "validated", passId: null }], now);
    await writeCriterionGrades(
      server.app.db,
      repo.id,
      [{ criterionId: "rapport.crash", points: 0, max: -2, source: "manual", state: "validated", passId: null, createdBy: teacher.id }],
      now,
    );
    seen.length = 0;
    next = reply({ "rapport.extra": { points: 1, rationale: "yes" } });
    await review(repo.id, await evidence(repo.id));
    expect(seen[0]!.prompt).toContain("rapport.extra");
    expect(seen[0]!.prompt).not.toContain("rapport.style");
    expect(await llmRows(repo.id)).toEqual({ "rapport.style": [3, null, "validated"], "rapport.extra": [1, null, "proposed"] });
    expect((await liveRows(repo.id)).find((r) => r.criterionId === "rapport.crash")).toMatchObject({ source: "manual", state: "validated" });
  });

  it("writes a teacher's row, in the state it carries, over any standing row of its criterion", async () => {
    const repo = await studentRepo(l, "rv-manual");
    const at = new Date(NOW);
    const manual = (criterionId: string, points: number) => ({
      criterionId,
      points,
      max: 4,
      source: "manual" as const,
      state: "proposed" as const,
      passId: null,
      createdBy: teacher.id,
    });
    const llm = (criterionId: string, state: "proposed" | "validated") => ({ criterionId, points: 1, max: 4, source: "llm" as const, state, passId: randomUUID() });
    const [proposed, validated] = await writeCriterionGrades(server.app.db, repo.id, [llm("rapport.style", "proposed"), llm("rapport.crash", "validated")], at);
    const [first] = await writeCriterionGrades(server.app.db, repo.id, [manual("rapport.extra", 1)], at);
    const written = await writeCriterionGrades(
      server.app.db,
      repo.id,
      [manual("rapport.style", 2), manual("rapport.crash", 3), { ...manual("rapport.extra", 0), state: "validated" as const }],
      at,
    );
    expect(written.map((r) => [r.criterionId, r.state, r.points, r.supersedesId])).toEqual([
      ["rapport.style", "proposed", 2, proposed!.id],
      ["rapport.crash", "proposed", 3, validated!.id],
      ["rapport.extra", "validated", 0, first!.id],
    ]);
    expect((await liveRows(repo.id)).map((r) => r.id).sort()).toEqual(written.map((r) => r.id).sort());
  });

  it("keeps a teacher's row written while the model was being asked", async () => {
    useGateway();
    const repo = await studentRepo(l, "rv-race");
    const answer = { points: 1, rationale: "model" };
    next = async () => {
      await writeCriterionGrades(
        server.app.db,
        repo.id,
        [{ criterionId: "rapport.style", points: 3, max: 4, source: "manual", state: "proposed", passId: null, createdBy: teacher.id }],
        new Date(NOW),
      );
      return reply({ "rapport.style": answer, "rapport.crash": answer, "rapport.extra": answer })();
    };
    await review(repo.id, await evidence(repo.id));
    const rows = await liveRows(repo.id);
    expect(rows.filter((r) => r.criterionId === "rapport.style")).toEqual([expect.objectContaining({ source: "manual", points: 3 })]);
    expect(rows.filter((r) => r.source === "llm").map((r) => r.criterionId).sort()).toEqual(["rapport.crash", "rapport.extra"]);
  });
});

describe("the final pass at the definitive freeze", () => {
  it("claims the deadline pass once, sends the evidence, whose review follows; an auto project claims nothing", async () => {
    const { createLlm } = await import("../llm/service.js");
    server.app.llm = createLlm({ LLM_PROVIDER: "stub" }, null);
    const l = await lab();
    const auto = await lab();
    await server.app.db.update(projects).set({ gradingMode: "auto" }).where(eq(projects.id, auto.projectId));
    const repo = await studentRepo(l, "fp-crit", { frozen: false });
    const other = await studentRepo(auto, "fp-auto", { frozen: false });
    await pushed(repo);
    for (const r of [repo, other]) {
      await server.app.db.update(projectRepos).set({ deadlineAppliedAt: DEADLINE }).where(eq(projectRepos.id, r.id));
    }
    server.clock.set(new Date(DEADLINE.getTime() + 60 * 60_000).toISOString());
    const send = vi.fn(async (_queue: string, _data: object) => {});
    const app = server.app as { boss?: JobQueue | null };
    const was = app.boss;
    app.boss = { send } as unknown as JobQueue;
    try {
      await projectTick(server.app, config);
      await projectTick(server.app, config);
    } finally {
      app.boss = was ?? null;
      server.clock.set(NOW);
    }
    const ledger = await server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, repo.id));
    expect(ledger).toEqual([expect.objectContaining({ trigger: "deadline", sha: "", dispatchedAt: expect.any(Date) })]);
    const evidenceSends = send.mock.calls.filter(([queue]) => queue === PROJECT_EVIDENCE_QUEUE);
    expect(evidenceSends).toEqual([[PROJECT_EVIDENCE_QUEUE, { repoId: repo.id, passId: ledger[0]!.id }]]);
    expect(send.mock.calls.some(([queue]) => queue === PROJECT_REVIEW_QUEUE)).toBe(false);
    expect(await server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, other.id))).toEqual([]);

    // The evidence job, without a queue, runs its review here: the auto row, then the llm rows of the pass.
    await runEvidencePass(server.app, config, evidenceSends[0]![1] as never);
    const rows = await liveRows(repo.id);
    expect(rows.find((r) => r.criterionId === "rendu.all-tests-passed")).toMatchObject({ source: "auto", points: 5 });
    expect(rows.filter((r) => r.source === "llm").map((r) => r.passId)).toEqual([ledger[0]!.id, ledger[0]!.id, ledger[0]!.id]);
  });

  it("supersedes the pass's proposals when the deadline moves later, keeps the validated rows, and nothing after the release", async () => {
    const l = await lab();
    const moved = async (name: string, released: boolean) => {
      const repo = await studentRepo(l, name);
      const now = new Date(NOW);
      await writeCriterionGrades(server.app.db, repo.id, [{ criterionId: "rapport.style", points: 2, max: 4, source: "llm", state: "proposed", passId: randomUUID() }], now);
      await writeCriterionGrades(server.app.db, repo.id, [{ criterionId: "rendu.all-tests-passed", points: 5, max: 10, source: "auto", state: "validated", passId: null }], now);
      await server.app.db.insert(gradeDispatches).values({ id: randomUUID(), repoId: repo.id, trigger: "deadline", sha: "x", createdAt: now });
      await server.app.db.update(projects).set({ releasedAt: released ? now : null }).where(eq(projects.id, l.projectId));
      await setRepoDeadline(server.app.db, l.projectId, repo.id, new Date("2026-10-20T22:00:00Z"), SYSTEM_ACTOR, now);
      return repo;
    };
    const open = await moved("mv-open", false);
    expect((await liveRows(open.id)).map((r) => [r.criterionId, r.state])).toEqual([["rendu.all-tests-passed", "validated"]]);
    expect(await server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, open.id))).toEqual([]);
    const released = await moved("mv-released", true);
    expect((await liveRows(released.id)).map((r) => r.state).sort()).toEqual(["proposed", "validated"]);
  });

  it("forgets the final passes' claims when a locked project leaves criteria, so the CI's final review can be claimed", async () => {
    const l = await lab();
    const repo = await studentRepo(l, "fp-leave");
    await server.app.db.insert(gradeDispatches).values({ id: randomUUID(), repoId: repo.id, trigger: "deadline", sha: "", createdAt: new Date(NOW) });
    const res = await server.app.inject({
      method: "PATCH",
      url: `/app/api/projects/${l.projectId}`,
      headers: teacher.headers,
      payload: { gradingMode: "auto" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await server.app.db.select().from(gradeDispatches).where(eq(gradeDispatches.repoId, repo.id))).toEqual([]);
  });
});

describe("Regrade", () => {
  const regradeUrl = (l: Lab, repoId?: string) =>
    repoId ? `/app/api/projects/${l.projectId}/repos/${repoId}/regrade` : `/app/api/projects/${l.projectId}/regrade`;

  it("answers 202 with the counts, runs the pass, audits, and refuses the fourth of the day", async () => {
    const { createLlm } = await import("../llm/service.js");
    server.app.llm = createLlm({ LLM_PROVIDER: "stub" }, null);
    const l = await lab();
    const a = await studentRepo(l, "rg-a");
    const b = await studentRepo(l, "rg-b");
    await studentRepo(l, "rg-open", { frozen: false });
    await pushed(a);
    await pushed(b);
    const assistant = await server.signIn("teacher");
    await server.app.db.insert(courseStaff).values({ courseId: l.courseId, userId: assistant.id, role: "assistant" });

    const first = await server.app.inject({ method: "POST", url: regradeUrl(l), headers: assistant.headers });
    expect(first.statusCode, first.body).toBe(202);
    expect(ProjectRegradeAccepted.parse(first.json())).toEqual({ repos: 2 });
    expect(Object.keys(await llmRows(a.id)).sort()).toEqual([...LLM].sort());
    const firstStyle = (await liveRows(a.id)).find((r) => r.criterionId === "rapport.style")!;

    const one = await server.app.inject({ method: "POST", url: regradeUrl(l, a.id), headers: teacher.headers });
    expect(one.statusCode, one.body).toBe(202);
    expect(one.json()).toEqual({ repos: 1 });
    // A new pass supersedes the proposals, keeps one live row per criterion.
    const style = (await liveRows(a.id)).filter((r) => r.criterionId === "rapport.style");
    expect(style).toHaveLength(1);
    expect(style[0]!.supersedesId).toBe(firstStyle.id);

    expect((await server.app.inject({ method: "POST", url: regradeUrl(l), headers: teacher.headers })).statusCode).toBe(202);
    const fourth = await server.app.inject({ method: "POST", url: regradeUrl(l, b.id), headers: teacher.headers });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject({ error: "regrade_limit" });

    const audits = await server.app.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "project_repo.regrade"), eq(auditLog.subjectId, l.projectId)));
    expect(audits).toEqual([
      expect.objectContaining({ actorUserId: teacher.id, subjectType: "project", payload: expect.objectContaining({ repoId: a.id }) }),
    ]);
    const projectAudits = await server.app.db.select().from(auditLog).where(and(eq(auditLog.action, "project.regrade"), eq(auditLog.subjectId, l.projectId)));
    expect(projectAudits).toHaveLength(2);

    // The next day, the cap is new.
    server.clock.set("2026-10-03T08:00:00.000Z");
    try {
      expect((await server.app.inject({ method: "POST", url: regradeUrl(l, b.id), headers: teacher.headers })).statusCode).toBe(202);
    } finally {
      server.clock.set(NOW);
    }
  });

  // No 403 to test: every staff seat is an owner or an assistant (`course_staff.role` NOT NULL), and both pass
  // `requireCourseRole("assistant")`; someone off the staff gets the loader's 404.
  it("is refused to an outsider (404), off the criteria mode, and on a repository not frozen for good", async () => {
    const l = await lab();
    const open = await studentRepo(l, "rg-x", { frozen: false });
    const outsider = await server.signIn("teacher");
    expect((await server.app.inject({ method: "POST", url: regradeUrl(l), headers: outsider.headers })).statusCode).toBe(404);
    expect((await server.app.inject({ method: "POST", url: regradeUrl(l, open.id), headers: outsider.headers })).statusCode).toBe(404);
    const notFrozen = await server.app.inject({ method: "POST", url: regradeUrl(l, open.id), headers: teacher.headers });
    expect([notFrozen.statusCode, notFrozen.json().error]).toEqual([409, "not_frozen"]);
    expect((await server.app.inject({ method: "POST", url: regradeUrl(l), headers: teacher.headers })).json()).toMatchObject({ error: "not_frozen" });
    await server.app.db.update(projects).set({ gradingMode: "auto" }).where(eq(projects.id, l.projectId));
    const off = await server.app.inject({ method: "POST", url: regradeUrl(l), headers: teacher.headers });
    expect([off.statusCode, off.json().error]).toEqual([409, "not_criteria"]);
  });
});

describe("the evidence of a pass", () => {
  it("brings back the sources outside build/ for the review; a runner out of reach still gets every criterion its reason", async () => {
    useGateway();
    const l = await lab(CRITERIA.replace('sources: ["build/rapport.md"]', 'sources: ["rendu/hello.c", "rendu/", "*.md"]'));
    const repo = await studentRepo(l, "ev-src");
    await pushed(repo);
    runnerAnswer = () =>
      Promise.resolve({ ...RESULT, files: [...RESULT.files, { path: "rendu/hello.c", content: "int hello_marker;", truncated: false, size: 17 }] });
    seen.length = 0;
    const answer = { points: 1, rationale: "ok" };
    next = reply({ "rapport.style": answer, "rapport.crash": answer, "rapport.extra": answer });
    try {
      await runEvidencePass(server.app, config, { repoId: repo.id, passId: randomUUID() });
    } finally {
      runnerAnswer = () => Promise.resolve(RESULT);
    }
    expect(sent.at(-1)!.outputs).toEqual(["rendu/hello.c", "rendu/", "report.xml", "build/"]);
    const [stored] = await server.app.db.select().from(projectEvidence).where(eq(projectEvidence.repoId, repo.id));
    expect(stored).toMatchObject({ status: "ok", reason: "sources_skipped: *.md" });

    const down = await studentRepo(l, "ev-down");
    await pushed(down);
    runnerAnswer = () => Promise.reject(new RunnerUnavailable("unreachable"));
    try {
      await runEvidencePass(server.app, config, { repoId: down.id, passId: randomUUID() });
    } finally {
      runnerAnswer = () => Promise.resolve(RESULT);
    }
    expect((await liveRows(down.id)).map((r) => [r.criterionId, r.points, r.reason]).sort()).toEqual(
      [["rendu.all-tests-passed", 0, "runner_unavailable"], ...LLM.map((id) => [id, 0, "runner_unavailable"])].sort(),
    );
  });
});


describe("the staff's criteria table", () => {
  it("lists every criterion with its current row and the evidence's summary, never its files; 404 to an outsider", async () => {
    const l = await lab();
    const repo = await studentRepo(l, "tb-a");
    await evidence(repo.id);
    await writeCriterionGrades(
      server.app.db,
      repo.id,
      [{ criterionId: "rapport.style", points: 0, max: 4, source: "llm", state: "proposed", reason: "llm_budget", rationale: "<b>x</b>", passId: randomUUID() }],
      new Date(NOW),
    );
    const url = `/app/api/projects/${l.projectId}/repos/${repo.id}/criteria`;
    const res = await server.app.inject({ method: "GET", url, headers: teacher.headers });
    expect(res.statusCode, res.body).toBe(200);
    const body = ProjectRepoCriteria.parse(res.json());
    expect(body.table.map((r) => [r.criterionId, r.state])).toEqual([
      ["rendu.all-tests-passed", "empty"],
      ["rapport.style", "proposed"],
      ["rapport.crash", "empty"],
      ["rapport.extra", "empty"],
      ["git.commits", "empty"],
    ]);
    expect(body.table[1]).toMatchObject({ source: "llm", reason: "llm_budget", rationale: "<b>x</b>", points: 0 });
    expect(body.evidence).toMatchObject({ status: "ok", casesPassed: 1, casesTotal: 1, build: { exitCode: 0, timedOut: false } });
    expect(res.body).not.toContain("# Rapport");
    expect(res.body).not.toContain("built");
    const outsider = await server.signIn("teacher");
    expect((await server.app.inject({ method: "GET", url, headers: outsider.headers })).statusCode).toBe(404);
  });
});
