/**
 * Grading by criteria (ADR-106 §1, §2) on a server built with Quiz's App,
 * against the fake GitHub and local bare repositories (`./testing.ts`):
 *
 * - the source's `criteria.yml` read from the distribution repository's
 *   head, kept as a snapshot, classified by the project's settings (a
 *   schema-2 snapshot) or by the file alone (schema 3), and reloaded by the
 *   staff — a file that no longer parses keeps the last snapshot and
 *   answers `409 criteria_invalid` with its errors; a file of another
 *   schema version than the snapshot's, `422 schema_version_fixed`
 *   (ADR-119 §3, §11); a new snapshot is schema 3;
 * - the mode switch: on a draft, on a locked project not released (the
 *   pilot), never on a published one, never after the release; refused
 *   with the parser's errors when the file is missing or invalid (a
 *   schema-2 file included: a new snapshot is schema 3); the network is
 *   never judged at the switch (the CI runs the commands); audited;
 * - the settings validated (argv without a shell, relative outputs);
 * - a sync of a project in `criteria` mode loads the file again;
 * - the routes are the project's staff's (the 404 of a missing project
 *   for anyone else).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CriteriaInvalid, ProjectCriteriaView, ProjectSummary, SchemaVersionFixed } from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

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
const SMALL = "schema_version: 2\ncriteria:\n  tests:\n    pass: {description: Tests, awarded_points: 0, max_points: 4}\n";
const SMALL3 = "schema_version: 3\ncriteria:\n  tests:\n    pass: {description: Tests, max_points: 4, command: [make, test]}\n";
/** A schema-3 lab: automatic (a positive, a penalty, a bonus), llm and teacher-only criteria. */
const LAB3 = [
  "schema_version: 3",
  "criteria:",
  "  code:",
  "    format: {description: Format, max_points: 1, command: [make, format-check]}",
  "    tests: {description: Tests, max_points: 10, command: [make, test], prompt: Are the tests meaningful?}",
  "    crash: {description: Crash penalty, max_points: -2, command: [make, crash]}",
  "  rapport:",
  "    style: {description: Style, max_points: 2, prompt: Is the code readable?}",
  "  git:",
  "    commits: {description: Commits, max_points: 2}",
  "  bonus:",
  "    extra: {description: Extra, bonus_points: 1, command: [make, extra]}",
  "",
].join("\n");

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

/** A schema-2 snapshot stored as one taken before schema 3 (ADR-119 §11): a reload then parses at schema 2. */
async function holdV2(projectId: string): Promise<void> {
  const parsed = parseCriteria(SMALL, { version: 2 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await server.app.db.insert(projectCriteria).values({ projectId, fileSha: "old", sourceSha: "old", criteria: parsed.criteria, loadedAt: new Date(NOW) });
}
const rowOf = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0]!;

describe("the criteria snapshot", () => {
  it("reloads labo 00's criteria into a schema-2 snapshot, classified by the settings", async () => {
    const { project } = await draft({ "criteria.yml": LABO_00, ".github/workflows/grading.yml": WORKFLOW });
    const empty = ProjectCriteriaView.parse((await call("GET", url(project.id, "/criteria"), teacher.headers)).json());
    expect(empty).toEqual({ snapshot: null });
    await holdV2(project.id);

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
    await holdV2(project.id);
    const view = ProjectCriteriaView.parse((await call("POST", url(project.id, "/criteria/reload"), teacher.headers)).json());
    expect((await rowOf(project.id)).testsCriterion).toBeNull();
    expect(view.snapshot!.leaves[0]).toMatchObject({ id: "rendu.all-tests-passed", kind: "automatic" });
  });

  it("takes a new snapshot at schema 3, classified by the file alone", async () => {
    const { project } = await draft({ "criteria.yml": LAB3 });
    // The settings name criteria of the file: schema 3 reads none of them.
    await server.app.db.update(projects).set({ testsCriterion: "git.commits", identityCriterion: "rapport.style" }).where(eq(projects.id, project.id));
    const res = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(res.statusCode, res.body).toBe(200);
    const kinds = Object.fromEntries(ProjectCriteriaView.parse(res.json()).snapshot!.leaves.map((l) => [l.id, l.kind]));
    expect(kinds).toEqual({
      "code.format": "automatic",
      "code.tests": "automatic",
      "code.crash": "automatic",
      "rapport.style": "llm",
      "git.commits": "teacher",
      "bonus.extra": "automatic",
    });
    expect((await snapshotOf(project.id))!.criteria.schemaVersion).toBe(3);
    // A schema-2 file offered for a new snapshot: one error naming 3.
    const fresh = await draft({ "criteria.yml": SMALL });
    const refused = await call("POST", url(fresh.project.id, "/criteria/reload"), teacher.headers);
    expect([refused.statusCode, CriteriaInvalid.parse(refused.json()).errors]).toEqual([
      409,
      [{ path: "schema_version", code: "schema_version", params: { expected: 3 } }],
    ]);
  });

  it("keeps the last snapshot when the file no longer parses", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    await holdV2(project.id);
    expect((await call("POST", url(project.id, "/criteria/reload"), teacher.headers)).statusCode).toBe(200);
    const before = await snapshotOf(project.id);
    world.commit(project.distribution!.fullName, "main", { "criteria.yml": "schema_version: 2\ncriteria:\n  a: {description: x, awarded_points: 0, max_points: '50%'}\n" });

    const res = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(res.statusCode).toBe(409);
    expect(CriteriaInvalid.parse(res.json()).errors).toEqual([{ path: "criteria/a/max_points", code: "percent_max" }]);
    expect(await snapshotOf(project.id)).toEqual(before);
  });

  it("fixes a snapshot's schema version: the other version is refused 422 schema_version_fixed, keeping it (ADR-119 §3)", async () => {
    // A schema-2 snapshot offered a schema-3 file.
    const v2 = await draft({ "criteria.yml": SMALL });
    await holdV2(v2.project.id);
    expect((await call("POST", url(v2.project.id, "/criteria/reload"), teacher.headers)).statusCode).toBe(200);
    const before2 = await snapshotOf(v2.project.id);
    world.commit(v2.project.distribution!.fullName, "main", { "criteria.yml": SMALL3 });
    const into2 = await call("POST", url(v2.project.id, "/criteria/reload"), teacher.headers);
    expect([into2.statusCode, SchemaVersionFixed.parse(into2.json()).expected]).toEqual([422, 2]);
    expect(await snapshotOf(v2.project.id)).toEqual(before2);

    // A schema-3 snapshot offered a schema-2 file.
    const v3 = await draft({ "criteria.yml": SMALL3 });
    expect((await call("POST", url(v3.project.id, "/criteria/reload"), teacher.headers)).statusCode).toBe(200);
    const before3 = await snapshotOf(v3.project.id);
    world.commit(v3.project.distribution!.fullName, "main", { "criteria.yml": SMALL });
    const into3 = await call("POST", url(v3.project.id, "/criteria/reload"), teacher.headers);
    expect([into3.statusCode, SchemaVersionFixed.parse(into3.json()).expected]).toEqual([422, 3]);
    expect(await snapshotOf(v3.project.id)).toEqual(before3);
    expect((await auditOf(v3.project.id, "project.criteria_reload")).map((a) => a.payload)).toEqual([
      expect.objectContaining({ trigger: "reload", ok: true }),
      expect.objectContaining({ trigger: "reload", ok: false }),
    ]);
  });

  it("is the project's staff's only", async () => {
    const { project } = await draft({ "criteria.yml": SMALL });
    expect((await call("GET", url(project.id, "/criteria"), outsider.headers)).statusCode).toBe(404);
    expect((await call("POST", url(project.id, "/criteria/reload"), outsider.headers)).statusCode).toBe(404);
  });
});

describe("the mode switch (ADR-106 §1)", () => {
  it("switches a draft, loads the file as a schema-3 snapshot and audits the switch alone", async () => {
    const { project } = await draft({ "criteria.yml": LAB3 });
    const res = await toCriteria(project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectSummary.parse(res.json()).gradingMode).toBe("criteria");
    const snapshot = await snapshotOf(project.id);
    expect(snapshot!.criteria.leaves).toHaveLength(6);
    expect(snapshot!.criteria.schemaVersion).toBe(3);
    // The switch protects the workflows and the criteria (ADR-119 §9, choice k).
    expect(ProjectSummary.parse(res.json()).protectedFiles).toEqual([".github/workflows", "criteria.yml"]);
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
    expect(CriteriaInvalid.parse(v1.json()).errors).toEqual([{ path: "schema_version", code: "schema_v1", params: { expected: 3 } }]);
    // A schema-2 file: a new snapshot is schema 3 (ADR-119 §3).
    world.commit(project.distribution!.fullName, "main", { "criteria.yml": SMALL });
    const v2 = await toCriteria(project.id);
    expect(CriteriaInvalid.parse(v2.json()).errors).toEqual([{ path: "schema_version", code: "schema_version", params: { expected: 3 } }]);
    expect((await rowOf(project.id)).gradingMode).toBe("auto");
    expect(await snapshotOf(project.id)).toBeUndefined();
    expect(await auditOf(project.id, "project.grading_mode")).toEqual([]);
  });

  it("never judges the network at the switch: a schema-3 snapshot's commands run in the CI (ADR-119 §1)", async () => {
    const { project } = await draft({ "criteria.yml": SMALL3 });
    const pip = ["pip", "install", "pytest"];
    // A runner setting stored before: a schema-3 snapshot never runs it.
    await server.app.db.update(projects).set({ buildCommand: ["wget", "x"] }).where(eq(projects.id, project.id));
    const res = await toCriteria(project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await rowOf(project.id)).gradingMode).toBe("criteria");

    // The runner's setting itself is still refused (ADR-106 §1, until L-06g removes it).
    const setting = await call("PATCH", url(project.id), teacher.headers, { testCommand: pip });
    expect([setting.statusCode, setting.json()]).toEqual([422, expect.objectContaining({ error: "command_needs_network", field: "testCommand" })]);
    expect((await rowOf(project.id)).testCommand).toBeNull();
  });

  it("refuses a snapshot leaving a checkpoint's name untagged (ADR-106 §5)", async () => {
    const { project } = await draft({ "criteria.yml": SMALL3 });
    await server.app.db.insert(projectCheckpoints).values({ id: randomUUID(), projectId: project.id, name: "mid", dueAt: new Date(IN_A_WEEK) });
    const res = await toCriteria(project.id);
    expect([res.statusCode, res.json()]).toEqual([409, expect.objectContaining({ error: "checkpoint_untagged", checkpoints: ["mid"] })]);
    world.commit(project.distribution!.fullName, "main", {
      "criteria.yml": "schema_version: 3\ncriteria:\n  pass: {description: Tests, max_points: 4, milestone: mid}\n",
    });
    expect((await toCriteria(project.id)).statusCode).toBe(200);
    // A reload dropping the tag is refused, and keeps the snapshot.
    world.commit(project.distribution!.fullName, "main", { "criteria.yml": SMALL3 });
    const reload = await call("POST", url(project.id, "/criteria/reload"), teacher.headers);
    expect(reload.json().error).toBe("checkpoint_untagged");
    expect((await snapshotOf(project.id))!.criteria.leaves[0]!.milestone).toBe("mid");
  });

  it("goes into and out of criteria on a locked project not yet released — and nothing else", async () => {
    const { project } = await draft({ "criteria.yml": SMALL3 });
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
  it("loads the file the sync handed out, at the snapshot's version", async () => {
    const { project, login } = await draft({ "criteria.yml": SMALL3 });
    expect((await toCriteria(project.id)).statusCode).toBe(200);
    world.commit(`${login}/lab`, "main", { "criteria.yml": LAB3 });
    const res = await call("POST", url(project.id, "/sync"), teacher.headers);
    expect(res.statusCode, res.body).toBe(202);
    expect((await snapshotOf(project.id))!.criteria.leaves).toHaveLength(6);
    expect((await auditOf(project.id, "project.criteria_reload")).map((a) => a.payload)).toEqual([
      expect.objectContaining({ trigger: "sync", ok: true }),
    ]);
  });
});
