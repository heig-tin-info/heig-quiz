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

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ActivitySummary,
  ProjectActivitySummary,
  ProjectRefusal,
  ProjectSourceDetail,
  ProjectSourceRepo,
  ProjectSummary,
  ProjectUnassigned,
  StudentClassroomPage,
} from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import {
  auditLog,
  courseStaff,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
  pushReceipts,
} from "../../db/schema.js";
import { setRemoteBaseForTests } from "../../github/git.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
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

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
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

const refusal = (res: { statusCode: number; json: () => unknown }) => [res.statusCode, ProjectRefusal.parse(res.json()).error];
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
    const branch = await call("POST", base(room.id), teacher.headers, { ...LAB, branches: ["main", "dev"] });
    expect(refusal(branch)).toEqual([422, "source_not_found"]);
    expect(ProjectRefusal.parse(branch.json()).branches).toEqual(["dev"]);
    expect(await server.app.db.select().from(projects).where(eq(projects.classroomId, room.id))).toEqual([]);
    expect(gh.calls.filter((c) => c === `POST api.github.com/orgs/${room.login}/repos`)).toEqual([]);
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
      .values(Array.from({ length: 19 }, (_, i) => ({ ...row, id: randomUUID(), slug: `lab-1-${i + 2}` })));
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

  it("refuses a deadline already past, a classroom not connected, and a malformed body", async () => {
    const room = await connectedClassroom();
    const past = await call("POST", base(room.id), teacher.headers, { ...LAB, deadlineAt: "2026-10-01T00:00:00Z" });
    expect(refusal(past)).toEqual([422, "deadline_past"]);
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
      groupMaxSize: 3,
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
      groupMaxSize: 3,
    });
    expect(await auditOf(project.id, "project.update")).toHaveLength(1);
    // The source, its branches and strategy are fixed at creation.
    for (const body of [{ sourceRepo: "other" }, { branches: ["main"] }, { sourceStrategy: "whole" }]) {
      expect((await patch(project.id, body)).statusCode).toBe(400);
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
    expect(ProjectSummary.parse(open.json()).editable).toEqual(["name", "deadlineAt", "deadlineStrategy", "protectedFiles"]);
    expect(refusal(await patch(project.id, { graceMinutes: 5 }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { gradingMode: "none" }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { groupMode: true }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(project.id, { publishMode: "scheduled" }))).toEqual([409, "publish_mode_frozen"]);
    expect(refusal(await patch(project.id, { durationMinutes: 60 }))).toEqual([409, "publish_mode_frozen"]);
    expect(refusal(await patch(project.id, { deadlineAt: "2026-10-02T07:00:00Z" }))).toEqual([422, "deadline_past"]);

    // Past the deadline, its strategy freezes; once applied, the deadline too (the reopen is M3-05's).
    server.clock.set("2026-10-11T00:00:00Z");
    expect(refusal(await patch(project.id, { deadlineStrategy: "lock" }))).toEqual([409, "strategy_frozen"]);
    await server.app.db.update(projects).set({ state: "locked", deadlineAppliedAt: new Date("2026-10-10T22:00:30Z") }).where(eq(projects.id, project.id));
    expect(refusal(await patch(project.id, { deadlineAt: "2026-10-20T22:00:00Z" }))).toEqual([409, "deadline_applied"]);
    expect((await patch(project.id, { name: "Still renamable" })).statusCode).toBe(200);
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

  it("refuses a group project while a claimed student is in no group, a staff seat never counting", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id, { ...LAB, groupMode: true });
    const db = server.app.db;
    // The teacher's own staff seat (ADR-018) and an unclaimed roster line.
    await db.insert(enrollments).values([
      { id: randomUUID(), classroomId: room.id, nom: "Prof", prenom: "T", email: `t-${room.id}@x`, userId: teacher.id, claimedAt: new Date(), staff: true },
      { id: randomUUID(), classroomId: room.id, nom: "Later", prenom: "L", email: `l-${room.id}@x` },
    ]);
    const none = await publish(project.id);
    expect(none.statusCode).toBe(409);
    const [seat] = await db.select().from(enrollments).where(and(eq(enrollments.classroomId, room.id), eq(enrollments.userId, student.id)));
    expect(ProjectUnassigned.parse(none.json()).students).toEqual([{ enrollmentId: seat!.id, nom: seat!.nom, prenom: seat!.prenom }]);

    const groupId = randomUUID();
    await db.insert(projectGroups).values({ id: groupId, projectId: project.id, name: "G1", slug: "g1", position: 0 });
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: project.id, groupId, enrollmentId: seat!.id });
    expect((await publish(project.id)).statusCode).toBe(200);
  });

  it("refuses a group project with no group at all", async () => {
    const room = await connectedClassroom();
    await server.app.db.delete(enrollments).where(eq(enrollments.classroomId, room.id));
    const project = await create(room.id, { ...LAB, groupMode: true });
    const res = await publish(project.id);
    expect([res.statusCode, ProjectUnassigned.parse(res.json()).students]).toEqual([409, []]);
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

  it("shows a student no project before M3-09, published or not", async () => {
    const room = await connectedClassroom();
    const project = await create(room.id);
    await call("POST", `/app/api/projects/${project.id}/publish`, teacher.headers);
    const res = await call("GET", `/app/api/student/classrooms/${room.id}`, student.headers);
    expect(res.statusCode).toBe(200);
    const page = StudentClassroomPage.parse(res.json());
    const cards = [...page.activities.open, ...page.activities.upcoming, ...page.activities.past];
    expect(cards.filter((c) => c.kind === "project")).toEqual([]);
    expect(res.body).not.toContain(project.id);
    expect(res.body).not.toContain("squashed");
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
      ["an impersonation session", await sessionOf(student.id, { kind: "impersonation", actorUserId: admin.id, evaluationId: null })],
      ["a teacher's impersonation", await sessionOf(teacher.id, { kind: "impersonation", actorUserId: admin.id, evaluationId: null })],
    ];
    const seb = await sessionOf(teacher.id, { kind: "seb", actorUserId: null, evaluationId: seeded.evaluationId });
    for (const url of [`/app/api/projects/${project.id}`, base(room.id), `${base(room.id)}/sources`]) {
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
