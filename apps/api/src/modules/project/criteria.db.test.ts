/**
 * Grading by criteria (ADR-106 §1, §2) on a server built with Quiz's App,
 * against the fake GitHub and local bare repositories (`./testing.ts`):
 *
 * - the source's `criteria.yml` read from the distribution repository's
 *   head, kept as a snapshot, classified by the project's settings, and
 *   reloaded by the staff — a file that no longer parses keeps the last
 *   snapshot and answers `409 criteria_invalid` with its errors;
 * - the mode switch: on a draft, on a locked project not released (the
 *   pilot), never on a published one, never after the release; refused
 *   with the parser's errors when the file is missing or invalid, and when
 *   the platform's build or test command needs the network; audited;
 * - the settings validated (argv without a shell, relative outputs);
 * - a sync of a project in `criteria` mode loads the file again;
 * - the routes are the project's staff's (the 404 of a missing project
 *   for anyone else).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CriteriaInvalid, ProjectCriteriaView, ProjectSummary } from "@quiz/contracts";

import { auditLog, courseStaff, githubClassroomLinks, githubOrganizations, projectCheckpoints, projectCriteria, projects } from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { repoWorld } from "./testing.js";

const LABO_00 = readFileSync(new URL("../../../../../packages/domain/fixtures/criteria/labo-00-revised.yml", import.meta.url), "utf8");
const WORKFLOW = [
  "on: [push]",
  "jobs:",
  "  grade:",
  "    uses: heig-tin-info/score/.github/workflows/grading.yml@0.7.5",
  "    with:",
  "      tests-criterion: git.commits",
  "",
].join("\n");
const LABO_00_WORKFLOW = readFileSync(new URL("../../../../../packages/domain/fixtures/criteria/labo-00-grading.yml", import.meta.url), "utf8");
const SMALL = "schema_version: 2\ncriteria:\n  tests:\n    pass: {description: Tests, awarded_points: 0, max_points: 4}\n";

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
const NOW = "2026-10-02T08:00:00.000Z";
const IN_A_WEEK = "2026-10-09T22:00:00.000Z";

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let outsider: { id: string; headers: Headers };
let nextOrg = 9100;

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

/** A draft handed out from a source `lab` holding `files`, in a classroom of `teacher`'s course. */
async function draft(files: Record<string, string>) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: teacher.id }).onConflictDoNothing();
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", { main: { "README.md": "# Lab", ...files } });
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
  await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  const res = await call("POST", `/app/api/classrooms/${seeded.classroomId}/projects`, teacher.headers, {
    name: "Labo 00",
    sourceRepo: "lab",
    deadlineAt: IN_A_WEEK,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { project: ProjectSummary.parse(res.json()), login };
}

const url = (id: string, rest = "") => `/app/api/projects/${id}${rest}`;
const snapshotOf = async (id: string) => (await server.app.db.select().from(projectCriteria).where(eq(projectCriteria.projectId, id)))[0];
const auditOf = (id: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, action)));

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), world.route];
  [teacher, outsider] = await Promise.all([server.signIn("teacher"), server.signIn("teacher")]);
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

const toCriteria = (id: string) => call("PATCH", url(id), teacher.headers, { gradingMode: "criteria" });
const rowOf = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;

describe("the criteria snapshot", () => {
  it("reloads labo 00's criteria from the distribution's head, classified by the settings", async () => {
    const { project } = await draft({ "criteria.yml": LABO_00, ".github/workflows/grading.yml": WORKFLOW });
    const empty = ProjectCriteriaView.parse((await call("GET", url(project.id, "/criteria"), teacher.headers)).json());
    expect(empty).toEqual({ snapshot: null });

    const res = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const view = ProjectCriteriaView.parse(res.json());
    expect(view.snapshot).toMatchObject({ max: 20, bonusMax: 1 });
    expect(view.snapshot!.leaves).toHaveLength(7);
    expect(view.snapshot!.sourceSha).toBe(world.git(project.distribution!.fullName, "rev-parse", "main").trim());
    // Pre-filled from the workflow's `tests-criterion` input, the setting being null.
    expect((await rowOf(project.id)).testsCriterion).toBe("git.commits");
    expect(view.snapshot!.leaves.find((l) => l.id === "git.commits")!.kind).toBe("automatic");
    expect(view.snapshot!.leaves.find((l) => l.id === "rendu.all-tests-passed")!.kind).toBe("llm");

    // A staff's choice replaces it; one that names no criterion is refused.
    const unknown = await call("PATCH", url(project.id), teacher.headers, { testsCriterion: "rendu.nope" });
    expect([unknown.statusCode, unknown.json()]).toEqual([422, expect.objectContaining({ error: "unknown_criterion", field: "testsCriterion" })]);
    const patched = await call("PATCH", url(project.id), teacher.headers, { testsCriterion: "rapport.redaction" });
    expect(patched.statusCode, patched.body).toBe(200);
    const kinds = ProjectCriteriaView.parse((await call("GET", url(project.id, "/criteria"), teacher.headers)).json()).snapshot!.leaves.map(
      (l) => [l.id, l.kind],
    );
    expect(kinds).toContainEqual(["rapport.redaction", "automatic"]);
    expect(kinds).toContainEqual(["git.commits", "llm"]);
    expect(kinds).toContainEqual(["rapport.reponses", "llm"]);

    // The identity criterion: a criterion of the snapshot, automatic even with its prompt; null again for none.
    const nope = await call("PATCH", url(project.id), teacher.headers, { identityCriterion: "git.nope" });
    expect([nope.statusCode, nope.json()]).toEqual([422, expect.objectContaining({ error: "unknown_criterion", field: "identityCriterion" })]);
    const identity = await call("PATCH", url(project.id), teacher.headers, { identityCriterion: "git.commits" });
    expect(ProjectSummary.parse(identity.json()).identityCriterion).toBe("git.commits");
    const view2 = ProjectCriteriaView.parse((await call("GET", url(project.id, "/criteria"), teacher.headers)).json());
    expect(view2.snapshot!.leaves.find((l) => l.id === "git.commits")!.kind).toBe("automatic");
    // Never a bonus nor a penalty: the check proposes positive points only.
    for (const leaf of ["bonus.proactivite", "rapport.cle-privee"]) {
      const invalid = await call("PATCH", url(project.id), teacher.headers, { identityCriterion: leaf });
      expect([invalid.statusCode, invalid.json()]).toEqual([422, expect.objectContaining({ error: "identity_criterion_invalid", field: "identityCriterion" })]);
    }
    // Never the tests criterion as well: set alone, or by moving the tests criterion onto it.
    const same = await call("PATCH", url(project.id), teacher.headers, { identityCriterion: "rapport.redaction" });
    expect([same.statusCode, same.json()]).toEqual([422, expect.objectContaining({ error: "criterion_conflict", field: "identityCriterion" })]);
    const moved = await call("PATCH", url(project.id), teacher.headers, { testsCriterion: "git.commits" });
    expect([moved.statusCode, moved.json()]).toEqual([422, expect.objectContaining({ error: "criterion_conflict", field: "identityCriterion" })]);
    await call("PATCH", url(project.id), teacher.headers, { identityCriterion: null });
    expect((await rowOf(project.id)).identityCriterion).toBeNull();
    expect((await auditOf(project.id, "project.criteria_reload")).map((a) => a.payload)).toEqual([
      expect.objectContaining({ trigger: "reload", ok: true, criteria: 7 }),
    ]);
  });

  it("classifies with the default tests criterion while the setting is null", async () => {
    const { project } = await draft({ "criteria.yml": LABO_00 });
    const view = ProjectCriteriaView.parse((await call("POST", url(project.id, "/criteria/reload"), teacher.headers)).json());
    expect((await rowOf(project.id)).testsCriterion).toBeNull();
    expect(view.snapshot!.leaves[0]).toMatchObject({ id: "rendu.all-tests-passed", kind: "automatic" });
  });

  it("keeps the last snapshot when the file no longer parses", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    expect((await call("POST", url(project.id, "/criteria/reload"), teacher.headers)).statusCode).toBe(200);
    const before = await snapshotOf(project.id);
    world.commit(project.distribution!.fullName, "main", { "criteria.yml": "schema_version: 2\ncriteria:\n  a: {description: x, awarded_points: 0, max_points: '50%'}\n" });

    const res = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(res.statusCode).toBe(409);
    expect(CriteriaInvalid.parse(res.json()).errors).toEqual([{ path: "criteria/a/max_points", code: "percent_max" }]);
    expect(await snapshotOf(project.id)).toEqual(before);
  });

  it("is the project's staff's only", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    expect((await call("GET", url(project.id, "/criteria"), outsider.headers)).statusCode).toBe(404);
    expect((await call("POST", url(project.id, "/criteria/reload"), outsider.headers)).statusCode).toBe(404);
  });
});

describe("the mode switch (ADR-106 §1)", () => {
  it("switches a draft, loads the file and audits the switch alone", async () => {
    const { project } = await draft({ "criteria.yml": LABO_00 });
    const res = await toCriteria(project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectSummary.parse(res.json()).gradingMode).toBe("criteria");
    const snapshot = await snapshotOf(project.id);
    expect(snapshot!.criteria.leaves).toHaveLength(7);
    const [audit] = await auditOf(project.id, "project.grading_mode");
    expect(audit!.payload).toEqual({ from: "auto", to: "criteria", fileSha: snapshot!.fileSha });
    expect(await auditOf(project.id, "project.criteria_reload")).toEqual([]);
  });

  it("refuses a source without a valid criteria.yml, with the errors' codes, and changes nothing", async () => {
    const { project } = await draft({});
    const missing = await toCriteria(project.id);
    expect(missing.statusCode).toBe(409);
    expect(CriteriaInvalid.parse(missing.json()).errors).toEqual([{ path: "criteria.yml", code: "missing_file" }]);

    world.commit(project.distribution!.fullName, "main", { "criteria.yml": "criteria:\n  a:\n    $desc: x\n    $points: [0, 2]\n" });
    const v1 = await toCriteria(project.id);
    expect(CriteriaInvalid.parse(v1.json()).errors).toEqual([{ path: "schema_version", code: "schema_v1" }]);
    expect((await rowOf(project.id)).gradingMode).toBe("auto");
    expect(await snapshotOf(project.id)).toBeUndefined();
    expect(await auditOf(project.id, "project.grading_mode")).toEqual([]);
  });

  it("judges the network on the platform's commands, never on the CI's workflow", async () => {
    // Labo 00's real workflow installs pytest on the CI: the default commands need nothing.
    const { project } = await draft({ "criteria.yml": LABO_00, ".github/workflows/grading.yml": LABO_00_WORKFLOW });
    const res = await toCriteria(project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await rowOf(project.id)).gradingMode).toBe("criteria");
  });

  it("refuses a switch whose build or test command needs the network, and a patch setting one", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    const pip = ["pip", "install", "pytest"];
    const inPatch = await call("PATCH", url(project.id), teacher.headers, { gradingMode: "criteria", testCommand: pip });
    expect(inPatch.statusCode).toBe(409);
    expect(CriteriaInvalid.parse(inPatch.json()).errors).toEqual([{ path: "testCommand", code: "command_needs_network" }]);

    // A setting stored before the rule: the switch reads it.
    await server.app.db.update(projects).set({ buildCommand: ["wget", "x"] }).where(eq(projects.id, project.id));
    const stored = await toCriteria(project.id);
    expect(CriteriaInvalid.parse(stored.json()).errors).toEqual([{ path: "buildCommand", code: "command_needs_network" }]);
    expect((await rowOf(project.id)).gradingMode).toBe("auto");
    expect(await snapshotOf(project.id)).toBeUndefined();

    const setting = await call("PATCH", url(project.id), teacher.headers, { testCommand: pip });
    expect([setting.statusCode, setting.json()]).toEqual([422, expect.objectContaining({ error: "command_needs_network", field: "testCommand" })]);
    expect((await rowOf(project.id)).testCommand).toBeNull();
  });

  it("refuses a snapshot leaving a checkpoint's name untagged (ADR-106 §5)", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    await server.app.db.insert(projectCheckpoints).values({ id: randomUUID(), projectId: project.id, name: "mid", dueAt: new Date(IN_A_WEEK) });
    const res = await toCriteria(project.id);
    expect([res.statusCode, res.json()]).toEqual([409, expect.objectContaining({ error: "checkpoint_untagged", checkpoints: ["mid"] })]);
    world.commit(project.distribution!.fullName, "main", {
      "criteria.yml": "schema_version: 2\ncriteria:\n  pass: {description: Tests, awarded_points: 0, max_points: 4, milestone: mid}\n",
    });
    expect((await toCriteria(project.id)).statusCode).toBe(200);
    // A reload dropping the tag is refused, and keeps the snapshot.
    world.commit(project.distribution!.fullName, "main", { "criteria.yml": SMALL });
    const reload = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(reload.json().error).toBe("checkpoint_untagged");
    expect((await snapshotOf(project.id))!.criteria.leaves[0]!.milestone).toBe("mid");
  });

  it("goes into and out of criteria on a locked project not yet released — and nothing else", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    await server.app.db.update(projects).set({ state: "locked" }).where(eq(projects.id, project.id));
    const summary = ProjectSummary.parse((await call("GET", url(project.id), teacher.headers)).json());
    expect(summary.editable).toContain("gradingMode");
    expect((await call("PATCH", url(project.id), teacher.headers, { gradingMode: "none" })).json().error).toBe("not_draft");
    expect((await toCriteria(project.id)).statusCode).toBe(200);
    expect(await snapshotOf(project.id)).toBeDefined();
    const back = await call("PATCH", url(project.id), teacher.headers, { gradingMode: "auto" });
    expect(back.statusCode, back.body).toBe(200);
    expect((await rowOf(project.id)).gradingMode).toBe("auto");
  });

  it("refuses a published project and a released one before reading the file", async () => {
    const { project } = await draft({});
    await server.app.db.update(projects).set({ state: "published" }).where(eq(projects.id, project.id));
    const published = await toCriteria(project.id);
    expect([published.statusCode, published.json().error]).toEqual([409, "not_draft"]);

    await server.app.db.update(projects).set({ state: "locked", releasedAt: new Date(NOW) }).where(eq(projects.id, project.id));
    const released = await toCriteria(project.id);
    expect([released.statusCode, released.json().error]).toEqual([409, "released"]);
    expect(ProjectSummary.parse((await call("GET", url(project.id), teacher.headers)).json()).editable).not.toContain("gradingMode");
  });
});

describe("the settings", () => {
  it("refuses a command with a shell, an output out of the repository, a criterion id with a space", async () => {
    const { project } = await draft({});
    for (const body of [
      { buildCommand: ["make prepare"] },
      { testCommand: ["pytest", "&&", "rm"] },
      { testCommand: [] },
      { evidenceOutputs: ["../secret"] },
      { evidenceOutputs: ["/etc/passwd"] },
      { testsCriterion: "a b" },
    ]) {
      expect((await call("PATCH", url(project.id), teacher.headers, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    const res = await call("PATCH", url(project.id), teacher.headers, { testCommand: ["pytest", "-x"], evidenceOutputs: ["out/", "report.xml"] });
    expect(ProjectSummary.parse(res.json())).toMatchObject({ testCommand: ["pytest", "-x"], evidenceOutputs: ["out/", "report.xml"], buildCommand: null });
  });
});

describe("a sync in criteria mode", () => {
  it("loads the file the sync handed out", async () => {
    const { project, login } = await draft({ "criteria.yml": SMALL });
    expect((await toCriteria(project.id)).statusCode).toBe(200);
    world.commit(`${login}/lab`, "main", { "criteria.yml": LABO_00 });
    const res = await call("POST", url(project.id, "/sync"), teacher.headers);
    expect(res.statusCode, res.body).toBe(202);
    expect((await snapshotOf(project.id))!.criteria.leaves).toHaveLength(7);
    expect((await auditOf(project.id, "project.criteria_reload")).map((a) => a.payload)).toEqual([
      expect.objectContaining({ trigger: "sync", ok: true }),
    ]);
  });
});
