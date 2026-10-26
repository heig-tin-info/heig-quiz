/**
 * A project's lifecycle (merge task M3-02), on a server built with Quiz's
 * App, against the fake GitHub (`github/testing.ts`) and local bare
 * repositories that git really clones and pushes to (`./testing.ts`):
 *
 * - create: the source checked in the classroom's organization, the slug and
 *   its suffixes, the distribution repository built (squash and whole), its
 *   name stepped over a non-empty repository, an empty leftover adopted, a
 *   failed build leaving no row and deleting nothing on GitHub (ADR-062);
 * - patch (F-PROJ-03), publish (the group guard, ADR-048), archive, delete
 *   (D19: the rows and the push receipts, never a repository), the
 *   classroom's deletion purging the same receipts (F-ORG-09);
 * - the Activities list (drafts in, archived out), no student card;
 * - who reaches a project: the course's staff, through their own portal
 *   session; anyone else gets the 404 of a missing one.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CSRF_COOKIE,
  ActivitySummary,
  defaultProjectGradingScale,
  ProjectActivitySummary,
  ProjectErrorCode,
  ProjectSourceDetail,
  ProjectSourceRepo,
  ProjectSummary,
  StudentClassroomPage,
} from "@quiz/contracts";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import {
  auditLog,
  courseStaff,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
  projectGroupMembers,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, orgsRoute, type Route } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
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
const NOW = "2026-10-02T08:00:00.000Z";
const IN_A_WEEK = "2026-10-09T22:00:00.000Z";
const DAY = 86_400_000;

type Headers = Record<string, string>;
let server: TestServer;
let teacher: { id: string; headers: Headers };
let colleague: { id: string; headers: Headers };
let outsider: { id: string; headers: Headers };
let student: { id: string; headers: Headers };
let nextOrg = 8000;

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

/** A classroom of `teacher`'s course (and `colleague`'s), connected to an organization holding a source `lab`. */
async function connectedClassroom(opts: { connected?: boolean } = {}) {
  const db = server.app.db;
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
  await db.insert(courseStaff).values({ courseId: seeded.courseId, userId: colleague.id });
  const n = nextOrg++;
  const login = `org-${n}`;
  world.orgIds[login] = n;
  world.source(login, "lab", {
    main: { "README.md": "# Lab", "src/main.c": "int main(){}", "criteria.yml": "x: 1", "student/src/main.c": "// todo" },
    solution: { "README.md": "# Solution" },
  });
  if (opts.connected !== false) {
    const orgId = randomUUID();
    await db.insert(githubOrganizations).values({ id: orgId, login, githubOrgId: n, installationId: n });
    await db.insert(githubClassroomLinks).values({ classroomId: seeded.classroomId, orgId, linkedBy: teacher.id, linkedAt: new Date() });
  }
  return { id: seeded.classroomId, login, courseId: seeded.courseId };
}

const base = (classroomId: string) => `/app/api/classrooms/${classroomId}/projects`;
const LAB = { name: "Lab 1", sourceRepo: "lab", deadlineAt: IN_A_WEEK };

async function create(classroomId: string, body: object = LAB, headers = teacher.headers) {
  const res = await call("POST", base(classroomId), headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return ProjectSummary.parse(res.json());
}

const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectErrorCode.parse(res.json().error)];
const rowOf = async (id: string) => (await server.app.db.select().from(projects).where(eq(projects.id, id)))[0];
const auditOf = (id: string, action: string) =>
  server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subjectId, id), eq(auditLog.action, action)));
const githubDeletes = () => gh.calls.filter((c) => c.startsWith("DELETE"));

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  setRemoteBaseForTests(`file://${world.dir}`);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => []), world.route];
  [teacher, colleague, outsider, student] = await Promise.all([
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("teacher"),
    server.signIn("student"),
  ]);
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

// ---------------------------------------------------------------- create

describe("create a project (F-PROJ-01, F-PROJ-02)", () => {
  it("builds the distribution repository, squashed, the solution left out", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { ...LAB, protectedFiles: ["criteria.yml"] });
    expect(project).toMatchObject({
      classroomId: room.id,
      name: "Lab 1",
      slug: "lab-1",
      state: "draft",
      publishMode: "manual",
      sourceStrategy: "squash",
      deadlineStrategy: "lock",
      gradingMode: "auto",
      graceMinutes: 30,
      branches: ["main"],
      protectedFiles: ["criteria.yml"],
      gradingScale: { kind: "linear", rounding: "nearest" },
      source: { fullName: `${room.login}/lab` },
      distribution: { fullName: `${room.login}/lab-1-squashed` },
      startAt: NOW,
      deadlineAt: IN_A_WEEK,
      accepted: false,
    });
    expect(project.editable).toContain("publishMode");
    const dist = `${room.login}/lab-1-squashed`;
    // One commit per branch, the `student/` overlay applied.
    expect(world.git(dist, "rev-list", "--count", "main").trim()).toBe("1");
    expect(world.git(dist, "show", "main:src/main.c")).toBe("// todo");
    expect(world.git(dist, "ls-tree", "-r", "--name-only", "main")).not.toContain("student/");
    // That commit is the API's root commit, GitHub-signed for the App (#917):
    // the App's author, GitHub's committer, no parent; the throwaway commit
    // that carried the tree is on no ref.
    expect(world.git(dist, "log", "--all", "--format=%P|%an|%cn").trim()).toBe(`|${world.botLogin}|GitHub`);
    expect(world.git(dist, "for-each-ref", "--format=%(refname)").trim()).toBe("refs/heads/main");
    const row = await rowOf(project.id);
    expect(row).toMatchObject({ orgId: expect.any(String), createdBy: teacher.id, distributionRepoId: world.ids.get(dist) });
    const audited = await auditOf(project.id, "project.create");
    expect(audited).toHaveLength(1);
    expect(audited[0]!.payload).toMatchObject({ slug: "lab-1", source: `${room.login}/lab`, distribution: dist });
  });

  it("hands out the branches asked for, with their history under `whole`", async () => {
    const room = await connectedClassroom();
    world.source(room.login, "history", { main: { "a.txt": "a" } }, 3);
    const project = await create(room.id, {
      name: "History",
      sourceRepo: "history",
      sourceStrategy: "whole",
      durationMinutes: 120,
      gradingScale: { kind: "score_is_grade" },
    });
    expect(project).toMatchObject({ sourceStrategy: "whole", durationMinutes: 120, deadlineAt: new Date(Date.parse(NOW) + 120 * 60_000).toISOString() });
    expect(project.gradingScale.kind).toBe("score_is_grade");
    expect(world.git(`${room.login}/history-squashed`, "rev-list", "--count", "main").trim()).toBe("3");
    // The source's own commits, as they are: the platform creates none.
    expect(world.apiCommits.filter((c) => c.repo === `${room.login}/history-squashed`)).toEqual([]);

    const both = await create(room.id, { ...LAB, name: "Both", branches: ["solution", "main"] });
    expect(both.branches).toEqual(["solution", "main"]);
    expect(world.git(`${room.login}/both-squashed`, "for-each-ref", "--format=%(refname:short)").split("\n").filter(Boolean).sort()).toEqual(["main", "solution"]);
  });

  it("refuses a source outside the organization, missing, or without a branch: 422 source_not_found", async () => {
    const room = await connectedClassroom();
    const missing = await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "nope" });
    expect(refusal(missing)).toEqual([422, "source_not_found"]);
    world.source(room.login, "moved", { main: { "a.txt": "a" } });
    world.foreignOwner.add(`${room.login}/moved`);
    const moved = await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "moved" });
    expect(refusal(moved)).toEqual([422, "source_not_found"]);
    // One of the platform's own distribution repositories, by its name or held by a project.
    const first = await create(room.id);
    expect(refusal(await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "lab-1-squashed" }))).toEqual([422, "source_not_found"]);
    world.source(room.login, "renamed-dist", { main: { "a.txt": "a" } });
    await server.app.db
      .update(projects)
      .set({ distributionRepoId: world.ids.get(`${room.login}/renamed-dist`)! })
      .where(eq(projects.id, first.id));
    expect(refusal(await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "renamed-dist" }))).toEqual([422, "source_not_found"]);
    await server.app.db.delete(projects).where(eq(projects.id, first.id));
    const branch = await call("POST", base(room.id), teacher.headers, { ...LAB, branches: ["main", "dev"] });
    expect(refusal(branch)).toEqual([422, "source_not_found"]);
    expect(branch.json().branches).toEqual(["dev"]);
    expect(await server.app.db.select().from(projects).where(eq(projects.classroomId, room.id))).toEqual([]);
    expect(gh.calls.filter((c) => c === `POST api.github.com/orgs/${room.login}/repos`)).toHaveLength(1);
  });

  it("suffixes a slug taken in the classroom, and its distribution repository with it", async () => {
    const room = await connectedClassroom();
    await create(room.id);
    const second = await create(room.id);
    expect([second.slug, second.distribution?.fullName]).toEqual(["lab-1-2", `${room.login}/lab-1-2-squashed`]);
  });

  it("refuses a twenty-first project of the same name: 409 duplicate_slug", async () => {
    const room = await connectedClassroom();
    const first = await create(room.id);
    const row = (await rowOf(first.id))!;
    await server.app.db
      .insert(projects)
      .values(Array.from({ length: 19 }, (_, i) => ({ ...row, id: randomUUID(), slug: `lab-1-${i + 2}`, distributionRepoId: null })));
    const res = await call("POST", base(room.id), teacher.headers, LAB);
    expect(refusal(res)).toEqual([409, "duplicate_slug"]);
  });

  it("steps over a non-empty repository of the organization to the next -squashed-N", async () => {
    const room = await connectedClassroom();
    // Another classroom's project, a year earlier, in the same organization.
    world.source(room.login, "lab-1-squashed", { main: { "old.txt": "2025" } });
    world.source(room.login, "lab-1-squashed-2", { main: { "old.txt": "2024" } });
    const project = await create(room.id);
    expect(project.distribution?.fullName).toBe(`${room.login}/lab-1-squashed-3`);
    expect(world.git(`${room.login}/lab-1-squashed`, "show", "main:old.txt")).toBe("2025");
  });

  it("on a failed build keeps no row and deletes nothing on GitHub; the next attempt adopts the empty leftover", async () => {
    const room = await connectedClassroom();
    world.refusePushes = true;
    const failed = await call("POST", base(room.id), teacher.headers, LAB);
    expect(refusal(failed)).toEqual([502, "distribution_failed"]);
    expect(await server.app.db.select().from(projects).where(eq(projects.classroomId, room.id))).toEqual([]);
    expect(world.exists(`${room.login}/lab-1-squashed`)).toBe(true);
    expect(githubDeletes()).toEqual([]);

    world.allowPushes();
    const project = await create(room.id);
    // The same slug (the row went), the same repository (empty, adopted).
    expect([project.slug, project.distribution?.fullName]).toEqual(["lab-1", `${room.login}/lab-1-squashed`]);
    expect(world.git(`${room.login}/lab-1-squashed`, "rev-list", "--count", "main").trim()).toBe("1");
    expect(githubDeletes()).toEqual([]);
  });

  it("never adopts an empty leftover another project holds, nor a public one", async () => {
    const room = await connectedClassroom();
    // An interrupted build: the row holds the empty repository it claimed.
    world.empty(room.login, "lab-1-squashed");
    const interrupted = await create(room.id, { ...LAB, name: "Other" });
    await server.app.db
      .update(projects)
      .set({ distributionRepoId: world.ids.get(`${room.login}/lab-1-squashed`)!, distributionFullName: null })
      .where(eq(projects.id, interrupted.id));
    // An empty public repository under the next name.
    world.empty(room.login, "lab-1-squashed-2");
    world.publicRepos.add(`${room.login}/lab-1-squashed-2`);
    const project = await create(room.id);
    expect(project.distribution?.fullName).toBe(`${room.login}/lab-1-squashed-3`);
    expect(world.git(`${room.login}/lab-1-squashed`, "for-each-ref").trim()).toBe("");
    expect(world.git(`${room.login}/lab-1-squashed-2`, "for-each-ref").trim()).toBe("");
  });

  it("gives two creations racing for one empty leftover two repositories", async () => {
    const one = await connectedClassroom();
    const two = await connectedClassroom();
    // Two classrooms of one organization.
    const [link] = await server.app.db.select().from(githubClassroomLinks).where(eq(githubClassroomLinks.classroomId, one.id));
    await server.app.db.update(githubClassroomLinks).set({ orgId: link!.orgId }).where(eq(githubClassroomLinks.classroomId, two.id));
    world.empty(one.login, "lab-1-squashed");
    const [a, b] = await Promise.all([create(one.id), create(two.id, { ...LAB, sourceRepo: "lab" })]);
    const names = [a.distribution!.fullName, b.distribution!.fullName].sort();
    expect(names).toEqual([`${one.login}/lab-1-squashed`, `${one.login}/lab-1-squashed-2`]);
    for (const name of names) expect(world.git(name, "rev-list", "--count", "main").trim()).toBe("1");
  });

  it("copies the group set it names (ADR-070), only in group mode and only of its classroom", async () => {
    const room = await connectedClassroom();
    const db = server.app.db;
    const set = (await call("POST", `/app/api/classrooms/${room.id}/group-sets`, teacher.headers, {})).json();
    const withGroup = (await call("POST", `/app/api/group-sets/${set.set.id}/groups`, teacher.headers, { name: "Pandas" })).json();
    const [seat] = await db.select().from(enrollments).where(eq(enrollments.classroomId, room.id));
    await call("PUT", `/app/api/group-sets/${set.set.id}/members/${seat!.id}`, teacher.headers, { groupId: withGroup.groups[0].id });
    const project = await create(room.id, { ...LAB, groupMode: true, groupSetId: set.set.id });
    expect(project.groupSetId).toBe(set.set.id);
    const members = await db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id));
    expect(members.map((m) => m.enrollmentId)).toEqual([seat!.id]);
    expect((await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers)).statusCode).toBe(200);

    const other = await connectedClassroom();
    expect(refusal(await call("POST", base(other.id), teacher.headers, { ...LAB, groupMode: true, groupSetId: set.set.id }))).toEqual([
      422,
      "unknown_group_set",
    ]);
    const res = await call("POST", base(room.id), teacher.headers, { ...LAB, groupSetId: set.set.id });
    expect([res.statusCode, res.json().error]).toEqual([400, "validation"]);
  });

  it("refuses a deadline already past, a classroom not connected, and a malformed body", async () => {
    const room = await connectedClassroom();
    const past = await call("POST", base(room.id), teacher.headers, { ...LAB, deadlineAt: "2026-10-01T00:00:00Z" });
    expect(refusal(past)).toEqual([422, "deadline_past"]);
    const startPast = { ...LAB, publishMode: "scheduled", startAt: "2026-10-01T00:00:00Z" };
    expect(refusal(await call("POST", base(room.id), teacher.headers, startPast))).toEqual([422, "start_past"]);
    const loose = await connectedClassroom({ connected: false });
    expect(refusal(await call("POST", base(loose.id), teacher.headers, LAB))).toEqual([409, "not_connected"]);
    for (const body of [
      { ...LAB, workMode: "online" },
      { ...LAB, durationMinutes: 60 },
      { ...LAB, sourceRepo: "../other" },
      { ...LAB, protectedFiles: ["../etc/passwd"] },
      { ...LAB, branches: ["-x"] },
      { ...LAB, name: "!!!" },
      { name: "Sched", sourceRepo: "lab", publishMode: "scheduled", deadlineAt: IN_A_WEEK },
    ]) {
      const res = await call("POST", base(room.id), teacher.headers, body);
      expect([res.statusCode, res.json().error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
  });
});

// ---------------------------------------------------------------- patch

describe("patch (F-PROJ-03)", () => {
  const patch = (id: string, body: object) => call("PATCH", `/app/api/projects/${id}`, teacher.headers, body);

  it("lets a draft change everything but its source", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const res = await patch(project.id, {
      name: "Lab one",
      publishMode: "scheduled",
      startAt: "2026-10-05T08:00:00Z",
      deadlineAt: IN_A_WEEK,
      graceMinutes: 10,
      gradingMode: "none",
      groupMode: true,
      gradingScale: { kind: "score_is_grade" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectSummary.parse(res.json())).toMatchObject({
      name: "Lab one",
      slug: "lab-1",
      publishMode: "scheduled",
      startAt: "2026-10-05T08:00:00.000Z",
      graceMinutes: 10,
      gradingMode: "none",
      groupMode: true,
      groupSetId: null,
    });
    expect(await auditOf(project.id, "project.update")).toHaveLength(1);
    // The source, its branches and strategy are fixed at creation.
    for (const body of [{ sourceRepo: "other" }, { branches: ["main"] }, { sourceStrategy: "whole" }]) {
      expect((await patch(project.id, body)).statusCode).toBe(400);
    }
  });

  it("decides a patch racing a publication on the row it locks", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const [patched, published] = await Promise.all([
      patch(project.id, { graceMinutes: 5 }),
      call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers),
    ]);
    expect(published.statusCode).toBe(200);
    const row = (await rowOf(project.id))!;
    if (patched.statusCode === 200) {
      // Applied while still a draft: before the publication, in the log too.
      expect(row.graceMinutes).toBe(5);
      const [update] = await auditOf(project.id, "project.update");
      const [publish] = await auditOf(project.id, "project.publish");
      expect(update!.id).toBeLessThan(publish!.id);
    } else {
      expect(refusal(patched)).toEqual([409, "not_draft"]);
      expect(row.graceMinutes).toBe(30);
    }
  });

  it("keeps a draft's dates coherent", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const dated = await patch(project.id, { durationMinutes: 90 });
    expect(ProjectSummary.parse(dated.json()).deadlineAt).toBe(new Date(Date.parse(NOW) + 90 * 60_000).toISOString());
    expect((await patch(project.id, { publishMode: "scheduled" })).statusCode).toBe(400);
    expect(refusal(await patch(project.id, { deadlineAt: "2026-10-01T00:00:00Z" }))).toEqual([422, "deadline_past"]);
  });

  it("refuses a scheduled start already past, and resets the start when back to manual (F-PROJ-03)", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    // A manual draft's stored start is its creation: switching alone would publish it at the next tick.
    expect(refusal(await patch(project.id, { publishMode: "scheduled" }))).toEqual([422, "start_past"]);
    expect(refusal(await patch(project.id, { publishMode: "scheduled", startAt: NOW, deadlineAt: IN_A_WEEK }))).toEqual([422, "start_past"]);
    expect((await rowOf(project.id))!.publishMode).toBe("manual");

    const scheduled = await patch(project.id, { publishMode: "scheduled", startAt: "2026-10-05T08:00:00Z", deadlineAt: IN_A_WEEK });
    expect(scheduled.statusCode, scheduled.body).toBe(200);
    expect(ProjectSummary.parse(scheduled.json())).toMatchObject({ publishMode: "scheduled", startAt: "2026-10-05T08:00:00.000Z" });
    // A start moved to the past is refused too.
    expect(refusal(await patch(project.id, { startAt: "2026-10-01T08:00:00Z" }))).toEqual([422, "start_past"]);

    const back = await patch(project.id, { publishMode: "manual" });
    expect(back.statusCode, back.body).toBe(200);
    expect(ProjectSummary.parse(back.json())).toMatchObject({ publishMode: "manual", startAt: NOW, deadlineAt: IN_A_WEEK });
    // The phantom start gone, an earlier deadline is no longer blocked by it.
    expect((await patch(project.id, { deadlineAt: "2026-10-04T08:00:00Z" })).statusCode).toBe(200);
  });

  it("refuses to flip a stale scheduled draft to manual: its kept deadline is past (deadline_past)", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { ...LAB, publishMode: "scheduled", startAt: "2026-10-05T08:00:00Z" });
    server.clock.set("2026-10-12T00:00:00Z");
    expect(refusal(await patch(project.id, { publishMode: "manual" }))).toEqual([422, "deadline_past"]);
    expect((await rowOf(project.id))!.publishMode).toBe("scheduled");
  });

  it("once published, opens the name, the protected files, the deadline and its strategy only", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    expect((await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers)).statusCode).toBe(200);
    const open = await patch(project.id, {
      name: "Renamed",
      protectedFiles: ["README.md"],
      deadlineAt: "2026-10-10T22:00:00Z",
      deadlineStrategy: "commit",
      // The form posts the whole of it: an unchanged value is no change.
      graceMinutes: 30,
      publishMode: "manual",
    });
    expect(open.statusCode, open.body).toBe(200);
    expect(ProjectSummary.parse(open.json()).editable).toEqual(["name", "deadlineAt", "deadlineStrategy", "protectedFiles", "testsCriterion", "identityCriterion", "buildCommand", "testCommand", "evidenceOutputs"]);
    expect(refusal(await patch(project.id, { graceMinutes: 5 }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { gradingMode: "none" }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { groupMode: true }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { publishMode: "scheduled" }))).toEqual([409, "publish_mode_frozen"]);
    expect(refusal(await patch(project.id, { durationMinutes: 60 }))).toEqual([409, "publish_mode_frozen"]);
    expect(refusal(await patch(project.id, { deadlineAt: "2026-10-02T07:00:00Z" }))).toEqual([422, "deadline_past"]);

    // Past the deadline, its strategy freezes; once applied, the deadline
    // still moves later — the reopen (M3-05a, `deadline.db.test.ts`).
    server.clock.set("2026-10-11T00:00:00Z");
    expect(refusal(await patch(project.id, { deadlineStrategy: "lock" }))).toEqual([409, "strategy_frozen"]);
    await server.app.db.update(projects).set({ state: "locked", deadlineAppliedAt: new Date("2026-10-10T22:00:30Z") }).where(eq(projects.id, project.id));
    expect(refusal(await patch(project.id, { deadlineAt: "2026-10-10T23:00:00Z" }))).toEqual([422, "deadline_past"]);
    expect((await patch(project.id, { name: "Still renamable" })).statusCode).toBe(200);
    const reopened = await patch(project.id, { deadlineAt: "2026-10-20T22:00:00Z" });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(ProjectSummary.parse(reopened.json())).toMatchObject({ state: "published", deadlineAppliedAt: null });
  });
});

// ---------------------------------------------------------------- publish

describe("publish (F-PROJ-03, ADR-048)", () => {
  const publish = (id: string) => call("POST", `/app/api/projects/${id}/publish`, teacher.headers);

  it("starts a manual project now and counts its duration from now", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { ...LAB, deadlineAt: undefined, durationMinutes: 60 });
    server.clock.set("2026-10-03T08:00:00Z");
    const res = await publish(project.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectSummary.parse(res.json())).toMatchObject({
      state: "published",
      startAt: "2026-10-03T08:00:00.000Z",
      deadlineAt: "2026-10-03T09:00:00.000Z",
    });
    expect(await auditOf(project.id, "project.publish")).toHaveLength(1);
    expect(refusal(await publish(project.id))).toEqual([409, "not_draft"]);
  });

  it("keeps a scheduled project's dates, and refuses a deadline gone by", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { name: "S", sourceRepo: "lab", publishMode: "scheduled", startAt: "2026-10-05T08:00:00Z", deadlineAt: IN_A_WEEK });
    const late = await connectedClassroom();
    const stale = await create(late.id);
    server.clock.set("2026-10-10T00:00:00Z");
    expect(refusal(await publish(stale.id))).toEqual([422, "deadline_past"]);
    server.clock.set(NOW);
    expect(ProjectSummary.parse((await publish(project.id)).json())).toMatchObject({ startAt: "2026-10-05T08:00:00.000Z", deadlineAt: IN_A_WEEK });
  });

  /** A group set of the classroom, named by the project (ADR-070): its id. */
  async function groupSet(roomId: string, projectId: string) {
    const res = await call("POST", `/app/api/classrooms/${roomId}/group-sets`, teacher.headers, {});
    expect(res.statusCode, res.body).toBe(201);
    const setId: string = res.json().set.id;
    expect((await call("PATCH", `/app/api/projects/${projectId}`, teacher.headers, { groupSetId: setId })).statusCode).toBe(200);
    return setId;
  }

  it("refuses a group project without a group set, then while a claimed student is in no group, a staff seat never counting", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { ...LAB, groupMode: true });
    expect(refusal(await publish(project.id))).toEqual([409, "no_group_set"]);
    const setId = await groupSet(room.id, project.id);
    const db = server.app.db;
    // The teacher's own staff seat (ADR-018) and an unclaimed roster line.
    await db.insert(enrollments).values([
      { id: randomUUID(), classroomId: room.id, nom: "Prof", prenom: "T", email: `t-${room.id}@x`, userId: teacher.id, claimedAt: new Date(), staff: true },
      { id: randomUUID(), classroomId: room.id, nom: "Later", prenom: "L", email: `l-${room.id}@x` },
    ]);
    const none = await publish(project.id);
    expect(none.statusCode).toBe(409);
    const [seat] = await db.select().from(enrollments).where(and(eq(enrollments.classroomId, room.id), eq(enrollments.userId, student.id)));
    expect(none.json().students).toEqual([{ enrollmentId: seat!.id, nom: seat!.nom, prenom: seat!.prenom }]);

    // Placed in the set, the student is in the project's copy of it.
    const group = await call("POST", `/app/api/group-sets/${setId}/groups`, teacher.headers, {});
    const groupId: string = group.json().groups[0].id;
    expect((await call("PUT", `/app/api/group-sets/${setId}/members/${seat!.id}`, teacher.headers, { groupId })).statusCode).toBe(200);
    expect(await db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, project.id))).toHaveLength(1);
    expect((await publish(project.id)).statusCode).toBe(200);
  });

  it("refuses a group project with no group at all", async () => {
    const room = await connectedClassroom();
    await server.app.db.delete(enrollments).where(eq(enrollments.classroomId, room.id));
    const project = await create(room.id, { ...LAB, groupMode: true });
    await groupSet(room.id, project.id);
    const res = await publish(project.id);
    expect([res.statusCode, res.json().error, res.json().students]).toEqual([409, "unassigned_students", []]);
  });

  /** Starts a creation whose push stalls, and waits until its row has claimed its repository. */
  async function stalledCreation(roomId: string) {
    world.stallPushes = true;
    const pending = call("POST", base(roomId), teacher.headers, LAB);
    let row;
    for (let i = 0; i < 400 && !row; i++) {
      [row] = await server.app.db.select().from(projects).where(and(eq(projects.classroomId, roomId), isNotNull(projects.distributionRepoId)));
      if (!row) await new Promise((r) => setTimeout(r, 25));
    }
    expect(row, "the draft claimed its repository").toBeDefined();
    return { pending, id: row!.id };
  }

  it("refuses to publish a draft whose distribution is still being built, then publishes it built", async () => {
    const room = await connectedClassroom();
    const { pending, id } = await stalledCreation(room.id);
    expect(refusal(await publish(id))).toEqual([409, "distribution_missing"]);
    const during = ProjectSummary.parse((await call("GET", `/app/api/projects/${id}`, teacher.headers)).json());
    expect([during.state, during.distribution]).toEqual(["draft", null]);
    world.release(true);
    expect((await pending).statusCode).toBe(201);
    world.allowPushes();
    expect((await publish(id)).statusCode).toBe(200);
  });

  it("keeps a draft whose build fails unpublished, and deletes it as a draft", async () => {
    const room = await connectedClassroom();
    const { pending, id } = await stalledCreation(room.id);
    expect(refusal(await publish(id))).toEqual([409, "distribution_missing"]);
    world.release(false);
    expect(refusal(await pending)).toEqual([502, "distribution_failed"]);
    world.allowPushes();
    expect(await rowOf(id)).toBeUndefined();
    expect(await auditOf(id, "project.publish")).toEqual([]);
    expect(githubDeletes()).toEqual([]);
  });

  it("refuses a project whose distribution repository is missing", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    await server.app.db.update(projects).set({ distributionRepoId: null, distributionFullName: null }).where(eq(projects.id, project.id));
    expect(refusal(await publish(project.id))).toEqual([409, "distribution_missing"]);
  });
});

// ---------------------------------------------------------------- lists, archive

describe("the lists, archive and unarchive (F-PROJ-16)", () => {
  it("lists drafts, archives out of the lists and back", async () => {
    const room = await connectedClassroom();
    const kept = await create(room.id);
    const archived = await create(room.id, { ...LAB, name: "Old" });
    const res = await call("POST", `/app/api/projects/${archived.id}/archive`, colleague.headers);
    expect(ProjectSummary.parse(res.json()).archivedAt).toBe(NOW);
    expect(await auditOf(archived.id, "project.archive")).toHaveLength(1);

    const list = (q = "") => call("GET", `${base(room.id)}${q}`, teacher.headers).then((r) => ProjectActivitySummary.array().parse(r.json()));
    expect((await list()).map((p) => p.id)).toEqual([kept.id]);
    expect((await list()).at(0)).toMatchObject({ kind: "project", title: "Lab 1", state: "draft", classroom: { id: room.id } });
    expect((await list("?archived=1")).map((p) => p.id)).toEqual([archived.id]);
    // The colleague on the staff reads the archive too.
    expect((await call("GET", `${base(room.id)}?archived=1`, colleague.headers)).json().map((p: { id: string }) => p.id)).toEqual([archived.id]);

    const activities = ActivitySummary.array().parse((await call("GET", "/app/api/activities", teacher.headers)).json());
    const mine = activities.filter((a) => a.kind === "project").map((a) => a.id);
    expect(mine).toContain(kept.id);
    expect(mine).not.toContain(archived.id);
    // The colleague sees the course's projects; another teacher none of them.
    expect(ActivitySummary.array().parse((await call("GET", "/app/api/activities", colleague.headers)).json()).map((a) => a.id)).toContain(kept.id);
    expect(ActivitySummary.array().parse((await call("GET", "/app/api/activities", outsider.headers)).json()).map((a) => a.id)).not.toContain(kept.id);

    await call("POST", `/app/api/projects/${archived.id}/unarchive`, teacher.headers);
    expect((await list()).map((p) => p.id).sort()).toEqual([kept.id, archived.id].sort());
    expect(await auditOf(archived.id, "project.unarchive")).toHaveLength(1);
  });

  it("lists no provisional date for a manual draft, the repositories for the staff only (M3-14a)", async () => {
    const room = await connectedClassroom();
    const dated = await create(room.id, { ...LAB, name: "Dated" });
    const timed = await create(room.id, { name: "Timed", sourceRepo: "lab", durationMinutes: 90 });
    const planned = await create(room.id, {
      name: "Planned",
      sourceRepo: "lab",
      publishMode: "scheduled",
      startAt: "2026-10-05T08:00:00Z",
      deadlineAt: IN_A_WEEK,
    });
    const list = async (headers: Headers = teacher.headers) =>
      ProjectActivitySummary.array().parse((await call("GET", base(room.id), headers)).json());
    const byId = async () => new Map((await list()).map((p) => [p.id, p]));
    const drafts = await byId();
    expect(drafts.get(dated.id)).toMatchObject({
      startAt: null,
      deadlineAt: IN_A_WEEK,
      source: { fullName: `${room.login}/lab` },
      distribution: { fullName: `${room.login}/dated-squashed` },
    });
    expect(drafts.get(timed.id)).toMatchObject({ startAt: null, deadlineAt: null });
    expect(drafts.get(planned.id)).toMatchObject({ startAt: "2026-10-05T08:00:00.000Z", deadlineAt: IN_A_WEEK });
    // The same projection serves the Activities union.
    const activities = ActivitySummary.array().parse((await call("GET", "/app/api/activities", teacher.headers)).json());
    expect(activities.find((a) => a.id === timed.id)).toMatchObject({ kind: "project", startAt: null, deadlineAt: null });

    // Published, the stored dates are the project's.
    expect((await call("POST", `/app/api/projects/${timed.id}/publish`, teacher.headers)).statusCode).toBe(200);
    const published = (await byId()).get(timed.id)!;
    expect(published.startAt).not.toBeNull();
    expect(published.deadlineAt).not.toBeNull();

    // Staff only (N-SEC-20): what the student reads of the published project names no repository.
    for (const url of [`/app/api/student/classrooms/${room.id}`, "/app/api/student/home"]) {
      const res = await call("GET", url, student.headers);
      expect(res.statusCode).toBe(200);
      expect(res.body, url).toContain(timed.name);
      expect(res.body, url).not.toContain(room.login);
    }
  });

  it("shows a student a project once published, never as a draft, and never its distribution (M3-09a)", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const cardsOf = async () => {
      const res = await call("GET", `/app/api/student/classrooms/${room.id}`, student.headers);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("squashed");
      const page = StudentClassroomPage.parse(res.json());
      return [...page.activities.open, ...page.activities.upcoming, ...page.activities.past].filter((c) => c.kind === "project");
    };
    expect(await cardsOf()).toEqual([]);
    await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers);
    expect((await cardsOf()).map((c) => [c.id, c.status])).toEqual([[project.id, "to_accept"]]);
  });
});

// ---------------------------------------------------------------- delete

describe("delete (D19, F-PROJ-16, F-ORG-09)", () => {
  /** A receipt of each repository a project touches, and one of an unrelated repository. */
  async function receipts(project: ProjectSummary, extra: number[] = []) {
    const db = server.app.db;
    const row = (await rowOf(project.id))!;
    const repoId = 900_000 + Math.floor(Math.random() * 90_000);
    await db.insert(projectRepos).values({ id: randomUUID(), projectId: project.id, userId: student.id, githubRepoId: repoId, fullName: "x/lab-1-alice", acceptedAt: new Date() });
    const ids = [repoId, row.distributionRepoId!, row.sourceRepoId, ...extra];
    await db.insert(pushReceipts).values(
      ids.map((githubRepoId) => ({ id: randomUUID(), githubRepoId, branch: "main", headSha: randomUUID().replace(/-/g, "").padEnd(40, "0"), receivedAt: new Date() })),
    );
    return { student: repoId, distribution: row.distributionRepoId!, source: row.sourceRepoId };
  }
  const receiptsOf = async (githubRepoId: number) =>
    (await server.app.db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, githubRepoId))).length;

  it("deletes a published project's rows and receipts, its source's only when no other project hands it out", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const sibling = await create(room.id, { ...LAB, name: "Sibling" });
    await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers);
    const unrelated = 123_456_789;
    const ids = await receipts(project, [unrelated]);
    const before = gh.calls.length;

    const res = await call("DELETE", `/app/api/projects/${project.id}`, colleague.headers);
    expect(res.statusCode).toBe(204);
    expect(await rowOf(project.id)).toBeUndefined();
    expect(await server.app.db.select().from(projectRepos).where(eq(projectRepos.projectId, project.id))).toEqual([]);
    expect([await receiptsOf(ids.student), await receiptsOf(ids.distribution)]).toEqual([0, 0]);
    // The sibling still hands the source out: its receipts stay.
    expect(await receiptsOf(ids.source)).toBe(1);
    expect(await receiptsOf(unrelated)).toBe(1);
    expect(gh.calls.slice(before)).toEqual([]);
    const [audited] = await auditOf(project.id, "project.delete");
    expect(audited!.payload).toMatchObject({ name: "Lab 1", receipts: 2 });

    await call("DELETE", `/app/api/projects/${sibling.id}`, teacher.headers);
    expect(await receiptsOf(ids.source)).toBe(0);
    expect(world.exists(`${room.login}/lab-1-squashed`)).toBe(true);
  });

  it("deleting the classroom purges its projects' receipts too, and nothing on GitHub", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const ids = await receipts(project);
    const before = gh.calls.length;
    const res = await call("DELETE", `/app/api/classrooms/${room.id}`, teacher.headers);
    expect(res.statusCode, res.body).toBe(204);
    expect(await rowOf(project.id)).toBeUndefined();
    for (const id of [ids.student, ids.distribution, ids.source]) expect(await receiptsOf(id)).toBe(0);
    expect(gh.calls.slice(before)).toEqual([]);
  });

  it("deleting the course does the same", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const ids = await receipts(project);
    expect((await call("DELETE", `/app/api/courses/${room.courseId}`, teacher.headers)).statusCode).toBe(204);
    for (const id of [ids.student, ids.distribution, ids.source]) expect(await receiptsOf(id)).toBe(0);
  });
});

// ---------------------------------------------------------------- the repository browser

describe("the organization's repository browser (M3-11)", () => {
  it("lists the sources, the distribution repositories left out, and suggests the protected files", async () => {
    const room = await connectedClassroom();
    await create(room.id);
    const list = ProjectSourceRepo.array().parse((await call("GET", `${base(room.id)}/sources`, teacher.headers)).json());
    expect(list.map((r) => r.name)).toEqual(["lab"]);
    const res = await call("GET", `${base(room.id)}/sources/lab`, teacher.headers);
    const detail = ProjectSourceDetail.parse(res.json());
    expect(detail).toMatchObject({ name: "lab", defaultBranch: "main", truncated: false, suggestedProtected: ["criteria.yml", "README.md"] });
    expect(detail.branches.sort()).toEqual(["main", "solution"]);
    expect(detail.tree).toContainEqual({ path: "src", type: "tree" });
    expect((await call("GET", `${base(room.id)}/sources/nope`, teacher.headers)).statusCode).toBe(404);
    // Resolved into another organization, or the platform's own: not a source.
    world.source(room.login, "moved", { main: { "a.txt": "a" } });
    world.foreignOwner.add(`${room.login}/moved`);
    expect((await call("GET", `${base(room.id)}/sources/moved`, teacher.headers)).statusCode).toBe(404);
    expect((await call("GET", `${base(room.id)}/sources/lab-1-squashed`, teacher.headers)).statusCode).toBe(404);
  });

  it("leaves out the repositories Quiz made for a project's students, by their id, never their name (#822)", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    // A student's repository, renamed on GitHub: no name rule would catch it.
    world.source(room.login, "renamed-by-hand", { main: { "README.md": "# Mine" } });
    // A teacher's source whose name looks like a student's: still a source.
    world.source(room.login, "lab-1-bob", { main: { "README.md": "# Lab" } });
    await server.app.db.insert(projectRepos).values({
      id: randomUUID(),
      projectId: project.id,
      userId: student.id,
      githubRepoId: world.ids.get(`${room.login}/renamed-by-hand`)!,
      fullName: `${room.login}/renamed-by-hand`,
      acceptedAt: new Date(NOW),
    });
    const list = ProjectSourceRepo.array().parse((await call("GET", `${base(room.id)}/sources`, teacher.headers)).json());
    expect(list.map((r) => r.name).sort()).toEqual(["lab", "lab-1-bob"]);
    expect((await call("GET", `${base(room.id)}/sources/renamed-by-hand`, teacher.headers)).statusCode).toBe(404);
    expect(refusal(await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "renamed-by-hand" }))).toEqual([
      422,
      "source_not_found",
    ]);
  });

  it("reads past a first page of non-sources, every page failing at once on an exhausted quota", async () => {
    const room = await connectedClassroom();
    const repo = (name: string, id: number) => ({ id, name, archived: false, private: true, default_branch: "main", pushed_at: NOW });
    let quota = true;
    const pages: (string | null)[] = [];
    const listing: Route = (url, init) => {
      if (init.method !== "GET" || url.pathname !== `/orgs/${room.login}/repos`) return undefined;
      const page = url.searchParams.get("page");
      pages.push(page);
      if (page === "1") return Response.json(Array.from({ length: 100 }, (_, i) => repo(`old-${i}-squashed`, 990_000 + i)));
      if (quota) return Response.json([repo("lab", world.ids.get(`${room.login}/lab`)!)]);
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) } },
      );
    };
    gh.routes.unshift(listing);
    try {
      const list = ProjectSourceRepo.array().parse((await call("GET", `${base(room.id)}/sources`, teacher.headers)).json());
      expect(list.map((r) => r.name)).toEqual(["lab"]);
      expect(pages).toEqual(["1", "2"]);
      // The second page carries HTTP_READ too: answered at once, never waited out for an hour.
      quota = false;
      expect((await call("GET", `${base(room.id)}/sources`, teacher.headers)).statusCode).not.toBe(200);
    } finally {
      gh.routes.splice(gh.routes.indexOf(listing), 1);
    }
  });

  it("hides and refuses a repository Quiz knows as a course the caller does not teach (ADR-100 §5)", async () => {
    const room = await connectedClassroom();
    // Another course's project (the outsider's) hands out `theirs`, a repository of the same organization.
    world.source(room.login, "theirs", { main: { "README.md": "# Theirs" } });
    const other = await seedLive(server.app.db, { teacherId: outsider.id, studentIds: [], questions: 0 });
    const [linked] = await server.app.db
      .select({ orgId: githubClassroomLinks.orgId })
      .from(githubClassroomLinks)
      .where(eq(githubClassroomLinks.classroomId, room.id));
    await server.app.db.insert(projects).values({
      id: randomUUID(),
      classroomId: other.classroomId,
      orgId: linked!.orgId,
      name: "Theirs",
      slug: "theirs",
      startAt: new Date(NOW),
      deadlineAt: new Date(IN_A_WEEK),
      sourceRepoId: world.ids.get(`${room.login}/theirs`)!,
      sourceFullName: `${room.login}/theirs`,
      branches: ["main"],
      protectedFiles: [],
      gradingScale: defaultProjectGradingScale(),
      createdBy: outsider.id,
    });
    const names = async () =>
      ProjectSourceRepo.array()
        .parse((await call("GET", `${base(room.id)}/sources`, teacher.headers)).json())
        .map((r) => r.name);
    expect(await names()).toEqual(["lab"]);
    expect((await call("GET", `${base(room.id)}/sources/theirs`, teacher.headers)).statusCode).toBe(404);
    expect(refusal(await call("POST", base(room.id), teacher.headers, { ...LAB, sourceRepo: "theirs" }))).toEqual([
      422,
      "source_not_found",
    ]);
    // A course the caller teaches too: allowed.
    await server.app.db.insert(courseStaff).values({ courseId: other.courseId, userId: teacher.id });
    expect((await names()).sort()).toEqual(["lab", "theirs"]);
    expect((await call("GET", `${base(room.id)}/sources/theirs`, teacher.headers)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------- who reaches a project

describe("who reaches a project (invariant 6)", () => {
  const sessionOf = async (userId: string, auth: Parameters<typeof createSession>[3]): Promise<Headers> => {
    const s = await createSession(server.app.db, userId, 8, auth);
    return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
  };

  it("answers anyone but the course's staff, in their own portal session, with the 404 of a missing project", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const admin = await server.signIn("admin");
    const callers: [string, Headers][] = [
      ["a student of the classroom", student.headers],
      ["a teacher of another course", outsider.headers],
      ["an admin without Super Powers", admin.headers],
      ["an impersonation session", await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null })],
      ["a teacher's impersonation", await sessionOf(teacher.id, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null })],
    ];
    const seb = await sessionOf(teacher.id, { kind: "seb", actorUserId: null, projectId: null, evaluationId: seeded.evaluationId });
    // The archive (`?archived=1`, #864's "Show archived") is behind the same 404.
    for (const url of [`/app/api/projects/${project.id}`, base(room.id), `${base(room.id)}?archived=1`, `${base(room.id)}/sources`]) {
      for (const [who, headers] of callers) {
        const res = await call("GET", url, headers);
        expect([res.statusCode, res.json().error], `${who} GET ${url}`).toEqual([404, "not_found"]);
      }
      // A `seb` session is nobody on a portal route (ADR-027).
      expect((await call("GET", url, seb)).statusCode, `seb GET ${url}`).toBe(401);
    }
    for (const [who, headers] of callers.slice(0, 3)) {
      for (const [method, url, body] of [
        ["PATCH", `/app/api/projects/${project.id}`, { name: "x" }],
        ["DELETE", `/app/api/projects/${project.id}`, undefined],
        ["POST", `/app/api/projects/${project.id}/publish`, undefined],
        ["POST", base(room.id), LAB],
      ] as const) {
        const res = await call(method, url, headers, body);
        expect(res.statusCode, `${who} ${method} ${url}`).toBe(404);
      }
    }
    expect((await rowOf(project.id))?.name).toBe("Lab 1");
    // The colleague on the staff reaches it.
    expect((await call("GET", `/app/api/projects/${project.id}`, colleague.headers)).statusCode).toBe(200);
    // A random id is the same 404.
    expect((await call("GET", `/app/api/projects/${randomUUID()}`, teacher.headers)).statusCode).toBe(404);
  });
});
