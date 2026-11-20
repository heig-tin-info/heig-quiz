/**
 * Contestations of a project's criteria (ADR-139 §13, Lot 1b) over the REAL
 * application: the routes, the guards, the one writer of the criteria, the
 * real migrations.
 *
 * The world: a locked project graded by criteria (tests /10, style /4, a
 * crash penalty of −2, an extra-mile bonus of 1, commits /2), every
 * repository frozen for good and every criterion validated, then released
 * by the owner — which opens a window of seven days. Repository A is a
 * group's (Ana and Ada), repository B Bea's alone; Cid holds a seat and no
 * repository.
 *
 * The window is compared on the DATABASE's clock (invariant 5): the test
 * clock is set to the wall clock's instant, so a release stamps an instant
 * the database's `now()` agrees with.
 */
import { randomUUID } from "node:crypto";

import { and, eq, ne, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import {
  type ApiTokenCreated,
  GradebookStaff,
  ProjectContestationResolution,
  ProjectContestations,
  ProjectStudentContestation,
  StudentProject,
} from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";

import { mintAssistToken } from "../../auth/tokens.js";
import {
  auditLog,
  classrooms,
  courseStaff,
  enrollments,
  notifications,
  projectContestations,
  projectCriteria,
  projectCriterionGrades,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { orgsRoute } from "../../github/testing.js";
import { sessionOf } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { newOrg, server, teacher, useProjectWorld, type Headers } from "../../test/projectWorld.js";
import { injectedApi } from "../mcp/service.js";
import { changeProjectContestationWindow, fileProjectContestation, resolveProjectContestation } from "./contestations.js";
import { gradeCriterion } from "./criteriaGrading.js";
import { claimRegrades } from "./ci.js";
import { writeCriterionGrades } from "./criterionGrades.js";
import { ProjectError } from "./errors.js";

const CRITERIA = `schema_version: 2
grading:
  context: "Labo"
  sources: []
criteria:
  rendu:
    all-tests-passed: {description: Tests, awarded_points: 0, max_points: 10}
  rapport:
    style: {description: Style, awarded_points: 0, max_points: 4, prompt: "Well written?"}
    crash: {description: Crash penalty, awarded_points: 0, max_points: -2, prompt: "Does it crash?"}
    extra: {description: Extra mile, awarded_points: 0, bonus_points: 1, prompt: "Beyond the lab?"}
  git:
    commits: {description: Who committed the work, awarded_points: 0, max_points: 2}
`;
/** The validated points of a repository: tests and commits below their maximum, style full, no crash, no bonus. */
const POINTS: Record<string, number> = {
  "rendu.all-tests-passed": 8,
  "rapport.style": 4,
  "rapport.crash": 0,
  "rapport.extra": 0,
  "git.commits": 1,
};
const MAX: Record<string, number> = { "rendu.all-tests-passed": 10, "rapport.style": 4, "rapport.crash": -2, "rapport.extra": 0, "git.commits": 2 };
const DAY_MS = 86_400_000;
/** An impersonation stays read-only (ADR-034: `403 impersonation_read_only`). */
const IMPERSONATION_STATUS = 403;
/** A `seb` or `kiosk` session confined to the project reads its page, and is nobody on any other route (ADR-027, ADR-089). */
const CONFINED_STATUS = 401;
const at = (iso: string) => new Date(iso);

type Actor = { id: string; headers: Headers };
let nextRepo = 71_000;

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, headers: Headers = teacher.headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
const db = () => server.app.db;

interface World {
  projectId: string;
  classroomId: string;
  courseId: string;
  ana: Actor;
  ada: Actor;
  bea: Actor;
  cid: Actor;
  repoA: string;
  repoB: string;
}

/** A frozen repository row of the project: `userId`'s own, or `groupId`'s (created by `userId`). */
async function repoRow(projectId: string, userId: string, groupId: string | null = null): Promise<string> {
  const id = randomUUID();
  const n = nextRepo++;
  await db().insert(projectRepos).values({
    id,
    projectId,
    userId,
    groupId,
    githubRepoId: n,
    fullName: `corg/lab-${n}`,
    defaultBranch: "main",
    provisionStatus: "ok",
    acceptedAt: at("2026-10-01T09:00:00Z"),
    invitationStatus: "accepted",
    rulesetId: n,
    deadlineAppliedAt: at("2026-10-09T22:00:00Z"),
    frozenAt: at("2026-10-09T22:30:00Z"),
  });
  return id;
}

/** Every criterion of `repoId` validated, at {@link POINTS} unless `over` says otherwise. */
async function validated(repoId: string, over: Record<string, number> = {}): Promise<void> {
  const points = { ...POINTS, ...over };
  await writeCriterionGrades(
    db(),
    repoId,
    Object.entries(points).map(([criterionId, p]) => ({
      criterionId,
      points: p,
      max: MAX[criterionId]!,
      source: "manual" as const,
      state: "validated" as const,
      rationale: `Rationale of ${criterionId}`,
      passId: null,
      createdBy: teacher.id,
    })),
    at("2026-10-10T08:00:00Z"),
  );
}

/** The world above, graded and validated, NOT released yet (`release` does it); `days` the window chosen. */
async function world({ days, release = true }: { days?: number; release?: boolean } = {}): Promise<World> {
  const [ana, ada, bea, cid] = await Promise.all([1, 2, 3, 4].map(() => server.signIn("student")));
  const seeded = await seedLive(db(), { teacherId: teacher.id, studentIds: [ana!.id, ada!.id, bea!.id, cid!.id], questions: 0 });
  const { n, orgId } = await newOrg("corg");
  const projectId = randomUUID();
  await db()
    .insert(projects)
    .values({
      id: projectId,
      classroomId: seeded.classroomId,
      orgId,
      name: "Lab",
      slug: `lab-${n}`,
      state: "locked",
      startAt: at("2026-10-01T08:00:00Z"),
      deadlineAt: at("2026-10-09T22:00:00Z"),
      deadlineAppliedAt: at("2026-10-09T22:00:00Z"),
      sourceRepoId: n,
      sourceFullName: `corg-${n}/starter`,
      distributionRepoId: n + 1,
      distributionFullName: `corg-${n}/lab-squashed`,
      branches: ["main"],
      protectedFiles: [],
      gradingMode: "criteria",
      groupMode: true,
      gradingScale: { kind: "linear", rounding: "nearest" },
      createdBy: teacher.id,
      ...(days === undefined ? {} : { contestationDays: days }),
    });
  const parsed = parseCriteria(CRITERIA, { version: 2 });
  if (!parsed.ok) throw new Error("the fixture does not parse");
  await db().insert(projectCriteria).values({ projectId, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
  // Ana and Ada share group G's repository; Bea, in no group, holds a repository of her own (heig-classroom's lot 1).
  const groupId = randomUUID();
  await db().insert(projectGroups).values({ id: groupId, projectId, name: "G", slug: "g", position: 0 });
  const lines = await db().select().from(enrollments).where(eq(enrollments.classroomId, seeded.classroomId));
  const lineOf = (userId: string) => lines.find((l) => l.userId === userId)!.id;
  for (const member of [ana!, ada!]) {
    await db().insert(projectGroupMembers).values({ id: randomUUID(), projectId, groupId, enrollmentId: lineOf(member.id) });
  }
  const repoA = await repoRow(projectId, ana!.id, groupId);
  const repoB = await repoRow(projectId, bea!.id);
  await validated(repoA);
  await validated(repoB, { "rapport.crash": -2 });
  const w = { projectId, classroomId: seeded.classroomId, courseId: seeded.courseId, ana: ana!, ada: ada!, bea: bea!, cid: cid!, repoA, repoB };
  if (release) await releaseOk(w);
  return w;
}

async function releaseOk(w: World) {
  const res = await call("POST", `/app/api/projects/${w.projectId}/release`);
  expect(res.statusCode, res.body).toBe(200);
}

const fileUrl = (w: World, criterionId: string) => `/app/api/student/projects/${w.projectId}/criteria/${criterionId}/contestation`;
const file = (w: World, who: Actor | Headers, criterionId: string, reason = "The tests pass on my machine.") =>
  call("POST", fileUrl(w, criterionId), "headers" in who ? (who as Actor).headers : (who as Headers), { reason });
async function filed(w: World, who: Actor, criterionId: string, reason?: string): Promise<{ id: string }> {
  const res = await file(w, who, criterionId, reason);
  expect(res.statusCode, res.body).toBe(200);
  ProjectStudentContestation.parse(res.json());
  const [row] = await db()
    .select()
    .from(projectContestations)
    .where(and(eq(projectContestations.criterionId, criterionId), eq(projectContestations.filedBy, who.id)));
  return row!;
}
const resolveUrl = (w: World, id: string) => `/app/api/projects/${w.projectId}/contestations/${id}/resolve`;
const resolve = (w: World, id: string, body: object, headers: Headers = teacher.headers) => call("POST", resolveUrl(w, id), headers, body);
const windowAct = (w: World, body: object, headers: Headers = teacher.headers) => call("PUT", `/app/api/projects/${w.projectId}/contestation-window`, headers, body);
async function studentView(w: World, who: Actor): Promise<StudentProject> {
  const res = await call("GET", `/app/api/student/projects/${w.projectId}`, who.headers);
  expect(res.statusCode, res.body).toBe(200);
  return StudentProject.parse(res.json());
}
async function staffView(w: World): Promise<ProjectContestations> {
  const res = await call("GET", `/app/api/projects/${w.projectId}/contestations`);
  expect(res.statusCode, res.body).toBe(200);
  return ProjectContestations.parse(res.json());
}
const closesAt = async (projectId: string) =>
  (await db().select({ at: projects.contestationClosesAt }).from(projects).where(eq(projects.id, projectId)))[0]!.at;
const auditOf = (subjectId: string, action: string) =>
  db().select().from(auditLog).where(and(eq(auditLog.subjectId, subjectId), eq(auditLog.action, action)));
async function assistant(w: World): Promise<Actor> {
  const actor = await server.signIn("teacher");
  await db().insert(courseStaff).values({ courseId: w.courseId, userId: actor.id, role: "assistant" });
  return actor;
}
const bells = (userId: string, kind: string) =>
  db().select().from(notifications).where(and(eq(notifications.userId, userId), sql`${notifications.payload}->>'kind' = ${kind}`));
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
};

useProjectWorld({ routes: [orgsRoute(() => [])], repos: false });

beforeEach(() => {
  // The wall clock's instant: a release's closing instant is compared on the database's `now()`.
  server.clock.set(new Date());
});

describe("the window (ADR-139 §13)", () => {
  it("is set once by the first release, seven days later, and a release again never moves it", async () => {
    const w = await world();
    const [project] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    expect((await closesAt(w.projectId))!.getTime()).toBe(project!.releasedAt!.getTime() + 7 * DAY_MS);
    const first = await closesAt(w.projectId);
    server.clock.set(new Date(Date.now() + 60_000));
    await releaseOk(w);
    const [again] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    expect(again!.releasedAt!.getTime()).toBeGreaterThan(project!.releasedAt!.getTime());
    expect(await closesAt(w.projectId)).toEqual(first);
  });

  it("follows the project's days, opens none at 0, and is no setting of a project in another mode", async () => {
    const three = await world({ days: 3 });
    const [row] = await db().select().from(projects).where(eq(projects.id, three.projectId));
    expect((await closesAt(three.projectId))!.getTime()).toBe(row!.releasedAt!.getTime() + 3 * DAY_MS);
    const none = await world({ days: 0 });
    expect(await closesAt(none.projectId)).toBeNull();
    expect((await file(none, none.bea, "rendu.all-tests-passed")).json()).toMatchObject({ error: "contestation_closed" });
    expect((await studentView(none, none.bea)).criteria!.every((c) => !c.contestable)).toBe(true);
  });

  it("takes its days by the project's patch until the first release, `released` afterwards", async () => {
    const w = await world({ release: false });
    const patch = (contestationDays: number) => call("PATCH", `/app/api/projects/${w.projectId}`, teacher.headers, { contestationDays });
    const before = await patch(5);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({ contestationDays: 5, editable: expect.arrayContaining(["contestationDays"]) });
    expect((await patch(61)).statusCode).toBe(400);
    await releaseOk(w);
    const after = await patch(9);
    expect([after.statusCode, after.json().error]).toEqual([409, "released"]);
    const [row] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    expect((await closesAt(w.projectId))!.getTime()).toBe(row!.releasedAt!.getTime() + 5 * DAY_MS);
  });

  it("is closed now or extended by the owner only, audited, on a released project", async () => {
    const w = await world();
    const helper = await assistant(w);
    expect((await windowAct(w, { action: "close" }, helper.headers)).json()).toMatchObject({ error: "owner_required" });

    const closed = await windowAct(w, { action: "close" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().closesAt).toBe(server.clock.now().toISOString());
    expect((await file(w, w.bea, "rendu.all-tests-passed")).json()).toMatchObject({ error: "contestation_closed" });

    // The instant's bounds are the domain's (`windowExtendRefusal`): one of them here.
    const past = await windowAct(w, { action: "extend", closesAt: new Date(Date.now() - 1000).toISOString() });
    expect([past.statusCode, past.json().reason]).toEqual([422, "not_future"]);
    // Extending reopens it.
    const reopened = new Date(Date.now() + 2 * DAY_MS).toISOString();
    expect((await windowAct(w, { action: "extend", closesAt: reopened })).json()).toEqual({ closesAt: reopened });
    expect((await file(w, w.bea, "rendu.all-tests-passed")).statusCode).toBe(200);
    expect((await auditOf(w.projectId, "project.contestation_window")).map((e) => e.payload)).toEqual([
      { action: "close", closesAt: closed.json().closesAt },
      { action: "extend", closesAt: reopened },
    ]);

    // An unreleased project has no window to change.
    const draft = await world({ release: false });
    expect((await windowAct(draft, { action: "close" })).json()).toMatchObject({ error: "window_unavailable" });
  });
});

describe("filing (ADR-139 §13)", () => {
  it("files once, stamped on the database's clock, the validated row in force recorded, audited without the reason", async () => {
    const w = await world();
    const res = await file(w, w.bea, "rendu.all-tests-passed", "Test 3 is flaky.");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      state: "open",
      reason: "Test 3 is flaky.",
      reply: null,
      resolvedAt: null,
      criterionId: "rendu.all-tests-passed",
      criterionDescription: "Tests",
      pointsAtFiling: 8,
      maxAtFiling: 10,
      bonusAtFiling: null,
    });
    expect(res.json()).not.toHaveProperty("filedBy");
    const [row] = await db().select().from(projectContestations).where(eq(projectContestations.repoId, w.repoB));
    const [grade] = await db()
      .select()
      .from(projectCriterionGrades)
      .where(and(eq(projectCriterionGrades.repoId, w.repoB), eq(projectCriterionGrades.criterionId, "rendu.all-tests-passed"), eq(projectCriterionGrades.state, "validated")));
    expect(row).toMatchObject({ filedBy: w.bea.id, gradeAtFilingId: grade!.id, state: "open", reply: "" });
    const [stamp] = (await db().execute(sql`select now() as "dbNow"`)).rows as { dbNow: Date }[];
    expect(Math.abs(new Date(row!.filedAt).getTime() - new Date(stamp!.dbNow).getTime())).toBeLessThan(60_000);
    const [audit] = await auditOf(row!.id, "project_contestation.file");
    expect(audit).toMatchObject({ actorUserId: w.bea.id, payload: { projectId: w.projectId, repoId: w.repoB, criterionId: "rendu.all-tests-passed" } });
    expect(JSON.stringify(audit)).not.toContain("Test 3 is flaky.");

    expect((await file(w, w.bea, "rendu.all-tests-passed")).json()).toMatchObject({ error: "contestation_exists" });
  });

  it("reads a criterion against its best value (`criterionInForce`, the domain's): a penalty that took points is contestable, a criterion at its best is not", async () => {
    const w = await world();
    expect((await file(w, w.bea, "rapport.crash")).json()).toMatchObject({ maxAtFiling: -2, pointsAtFiling: -2 });
    expect((await file(w, w.ana, "rapport.style")).json()).toMatchObject({ error: "not_contestable", reason: "full_points" });
    // An unknown criterion is a 404; a classmate with no repository gets the same 404 for any criterion, known or not.
    expect((await file(w, w.ana, "rapport.nope")).statusCode).toBe(404);
    for (const criterionId of ["rendu.all-tests-passed", "rapport.nope"]) expect((await file(w, w.cid, criterionId)).statusCode).toBe(404);
  });

  it("refuses a criterion a teacher changed since the validation: pending until validated again", async () => {
    const w = await world();
    const row = { points: 9, max: 10, source: "manual" as const, state: "proposed" as const, passId: null, createdBy: teacher.id };
    await writeCriterionGrades(db(), w.repoB, [{ criterionId: "rendu.all-tests-passed", ...row }], new Date());
    expect((await file(w, w.bea, "rendu.all-tests-passed")).json()).toMatchObject({ error: "not_contestable", reason: "pending" });
    const view = await studentView(w, w.bea);
    expect(view.criteria!.find((c) => c.criterionId === "rendu.all-tests-passed")).toMatchObject({ state: "indicative", contestable: false });
  });

  it("refuses before the release, and decides the window on the database's clock, never on the request's", async () => {
    const draft = await world({ release: false });
    expect((await file(draft, draft.bea, "rendu.all-tests-passed")).json()).toMatchObject({ error: "contestation_closed" });

    const w = await world();
    // The server's clock far ahead: the view says closed, the database's says open, and decides.
    const real = server.clock.now();
    server.clock.set(new Date(real.getTime() + 30 * DAY_MS));
    expect((await studentView(w, w.bea)).criteria!.find((c) => c.criterionId === "rendu.all-tests-passed")!.contestable).toBe(false);
    expect((await file(w, w.bea, "rendu.all-tests-passed")).statusCode).toBe(200);
    // The stored instant just passed on the database's clock: refused, whatever the server's says.
    server.clock.set(real);
    await db().update(projects).set({ contestationClosesAt: sql`now() - interval '1 second'` }).where(eq(projects.id, w.projectId));
    expect((await file(w, w.ana, "rendu.all-tests-passed")).json()).toMatchObject({ error: "contestation_closed" });
  });

  it("is a member's own portal session, with a reason; an archived classroom takes none", async () => {
    const w = await world();
    expect((await file(w, w.bea, "rendu.all-tests-passed", "   ")).statusCode).toBe(400);
    expect((await file(w, w.bea, "rendu.all-tests-passed", "x".repeat(2001))).statusCode).toBe(400);
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(db(), w.bea.id, { kind: "impersonation", actorUserId: admin.id });
    const seb = await sessionOf(db(), w.bea.id, { kind: "seb", projectId: w.projectId });
    const kiosk = await sessionOf(db(), w.bea.id, { kind: "kiosk", projectId: w.projectId });
    for (const [name, headers, status] of [
      ["impersonation", impersonation, IMPERSONATION_STATUS],
      ["seb", seb, CONFINED_STATUS],
      ["kiosk", kiosk, CONFINED_STATUS],
    ] as const) {
      expect((await file(w, headers, "rendu.all-tests-passed")).statusCode, name).toBe(status);
    }
    expect(await db().select().from(projectContestations).where(eq(projectContestations.repoId, w.repoB))).toEqual([]);
    await db().update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, w.classroomId));
    expect((await file(w, w.bea, "rendu.all-tests-passed")).statusCode).toBe(404);
  });

  it("is the group's: any member files, every member reads it, nobody files it twice, a non-member sees nothing", async () => {
    const w = await world();
    await filed(w, w.ada, "git.commits", "We committed as a pair.");
    expect((await file(w, w.ana, "git.commits")).json()).toMatchObject({ error: "contestation_exists" });
    for (const member of [w.ana, w.ada]) {
      const view = await studentView(w, member);
      expect(view.contestations).toEqual([expect.objectContaining({ criterionId: "git.commits", reason: "We committed as a pair.", state: "open" })]);
      expect(view.criteria!.find((c) => c.criterionId === "git.commits")!.contestable).toBe(false);
      expect(view.criteria!.find((c) => c.criterionId === "rendu.all-tests-passed")!.contestable).toBe(true);
      expect(view.contestationClosesAt).toBe((await closesAt(w.projectId))!.toISOString());
    }
    // Nobody is named: not the filer, not a teammate.
    expect(JSON.stringify((await studentView(w, w.ana)).contestations)).not.toContain(w.ada.id);
    expect((await studentView(w, w.bea)).contestations).toEqual([]);
  });

  it("leaves out a departing group member: no control, no contestation, no filing, no bell (`repoMembers`)", async () => {
    const w = await world();
    const row = await filed(w, w.ana, "git.commits", "Filed before Ada leaves.");
    // Ada's departure from the group confirmed, GitHub not told yet: she still reads the group's repository (`seatRepos`).
    const [line] = await db().select().from(enrollments).where(and(eq(enrollments.classroomId, w.classroomId), eq(enrollments.userId, w.ada.id)));
    await db().update(projectGroupMembers).set({ departingAt: new Date() }).where(eq(projectGroupMembers.enrollmentId, line!.id));
    const view = await studentView(w, w.ada);
    expect(view.repo).not.toBeNull();
    expect(view.contestations).toEqual([]);
    expect(view.criteria!.every((c) => !c.contestable)).toBe(true);
    expect((await file(w, w.ada, "rendu.all-tests-passed")).json()).toMatchObject({ error: "not_contestable", reason: "not_counted" });
    expect((await resolve(w, row.id, { verdict: "refused", reply: "No." })).statusCode).toBe(200);
    expect(await bells(w.ada.id, "project_contestation_resolved")).toEqual([]);
    expect(await bells(w.ana.id, "project_contestation_resolved")).toHaveLength(1);
    // The group's repository is the group's: a member reads it as before.
    expect((await studentView(w, w.ana)).contestations).toHaveLength(1);
  });

  it("tells the course's staff, folded per project", async () => {
    const w = await world();
    const helper = await assistant(w);
    await filed(w, w.bea, "rendu.all-tests-passed");
    await filed(w, w.ana, "git.commits", "Second.");
    for (const staff of [teacher, helper]) {
      const rows = (await bells(staff.id, "project_contestation_filed")).filter((n) => n.projectId === w.projectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toEqual({ kind: "project_contestation_filed", projectId: w.projectId, projectTitle: "Lab", count: 2 });
    }
    expect(await bells(w.bea.id, "project_contestation_filed")).toEqual([]);
  });
});

describe("the INSERT decides what the loaded rows only offered (invariant 5)", () => {
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e as ProjectError,
    );

  it("names its refusal: a seat that is no member, an archived classroom after the loader, a window gone from the row", async () => {
    const w = await world();
    const [project] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    const [repo] = await db().select().from(projectRepos).where(eq(projectRepos.id, w.repoB));
    const lineOf = async (userId: string) =>
      (await db().select().from(enrollments).where(and(eq(enrollments.classroomId, w.classroomId), eq(enrollments.userId, userId))))[0]!.id;
    const asBea = { id: await lineOf(w.bea.id), userId: w.bea.id };
    const input = { project: project!, repo: repo!, criterionId: "rendu.all-tests-passed", reason: "Why." };

    // Cid's seat handed Bea's repository, as a stale read would: no member (`repoMembers`, which the pre-check reads).
    const stranger = await refusal(fileProjectContestation(db(), { ...input, seat: { id: await lineOf(w.cid.id), userId: w.cid.id } }));
    expect([stranger?.code, stranger?.details]).toEqual(["not_contestable", { reason: "not_counted" }]);
    // The classroom archived after the loader.
    await db().update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, w.classroomId));
    expect((await refusal(fileProjectContestation(db(), { ...input, seat: asBea })))?.code).toBe("classroom_archived");
    expect(await db().select().from(projectContestations).where(eq(projectContestations.repoId, w.repoB))).toEqual([]);

    // A window act on a project the UPDATE finds unreleased.
    const draft = await world({ release: false });
    const [unreleased] = await db().select().from(projects).where(eq(projects.id, draft.projectId));
    const act = await refusal(changeProjectContestationWindow(db(), { ...unreleased!, releasedAt: new Date() }, { action: "close" }, new Date()));
    expect(act?.code).toBe("window_unavailable");
  });
});

describe("the hints of a contestation (N-SEC-20)", () => {
  it("tell the course's staff of a filing; an answer the staff and that repository's members — never the classroom", async () => {
    const w = await world();
    const topics: string[] = [];
    const off = subscribe((e) => {
      if (e.kind === "hint") topics.push(...e.topics);
    });
    const row = await filed(w, w.ana, "git.commits");
    await settle();
    const onFiling = [...topics];
    topics.length = 0;
    expect((await resolve(w, row.id, { verdict: "refused", reply: "The history shows one author." })).statusCode).toBe(200);
    await settle();
    off();
    const everyone = [w.ana, w.ada, w.bea, w.cid].map((s) => `user:${s.id}`);
    expect(onFiling).toContain(`course:${w.courseId}`);
    expect(onFiling.filter((t) => t.startsWith("classroom:") || everyone.includes(t))).toEqual([]);
    expect(topics).toEqual(expect.arrayContaining([`course:${w.courseId}`, `user:${w.ana.id}`, `user:${w.ada.id}`]));
    expect(topics.filter((t) => t.startsWith("classroom:") || t === `user:${w.bea.id}` || t === `user:${w.cid.id}`)).toEqual([]);
  });
});

describe("the staff's reads (ADR-139 §13)", () => {
  it("list the contestations, nameless, with the window and the open counts; the gradebook's column carries the total", async () => {
    const w = await world();
    await filed(w, w.bea, "rendu.all-tests-passed", "Reason B");
    await filed(w, w.ana, "git.commits", "Reason A");
    const view = await staffView(w);
    expect(view).toMatchObject({ applies: true, closesAt: (await closesAt(w.projectId))!.toISOString(), openByRepo: { [w.repoA]: 1, [w.repoB]: 1 } });
    expect(view.contestations.map((c) => [c.repoId, c.criterionId, c.counted, c.inSnapshot])).toEqual(
      expect.arrayContaining([
        [w.repoB, "rendu.all-tests-passed", true, true],
        [w.repoA, "git.commits", true, true],
      ]),
    );
    for (const name of [w.ana.id, w.bea.id]) expect(JSON.stringify(view)).not.toContain(name);

    const gradebook = await call("GET", `/app/api/classrooms/${w.classroomId}/gradebook`);
    expect(gradebook.statusCode, gradebook.body).toBe(200);
    expect(GradebookStaff.parse(gradebook.json()).columns.find((c) => c.activityId === w.projectId)!.openContestations).toBe(2);

    // A student, or a stranger, gets the 404 of a missing project.
    expect((await call("GET", `/app/api/projects/${w.projectId}/contestations`, w.bea.headers)).statusCode).toBe(404);
    expect((await call("GET", `/app/api/projects/${w.projectId}/contestations`, (await server.signIn("teacher")).headers)).statusCode).toBe(404);
  });
});

describe("answering (ADR-139 §13, decision 9)", () => {
  it("is the course owner's, once; a refusal carries a reply; every member is told, audited without a text", async () => {
    const w = await world();
    const row = await filed(w, w.ana, "git.commits");
    const helper = await assistant(w);
    expect((await resolve(w, row.id, { verdict: "refused", reply: "No." }, helper.headers)).json()).toMatchObject({ error: "owner_required" });
    expect((await resolve(w, row.id, { verdict: "refused" })).statusCode).toBe(400);
    expect((await resolve(w, row.id, { verdict: "refused", points: 2, reply: "x" })).statusCode).toBe(400);

    const res = await resolve(w, row.id, { verdict: "refused", reply: "The history shows one author." });
    expect(res.statusCode, res.body).toBe(200);
    const outcome = ProjectContestationResolution.parse(res.json());
    expect(outcome).toMatchObject({ contestation: { state: "refused", reply: "The history shows one author.", repoId: w.repoA }, repo: null });
    expect((await resolve(w, row.id, { verdict: "accepted" })).json()).toMatchObject({ error: "not_open" });

    for (const member of [w.ana, w.ada]) {
      expect((await bells(member.id, "project_contestation_resolved")).map((n) => n.payload)).toEqual([
        { kind: "project_contestation_resolved", projectId: w.projectId, projectTitle: "Lab" },
      ]);
      expect((await studentView(w, member)).contestations[0]).toMatchObject({ state: "refused", reply: "The history shows one author." });
    }
    expect(await bells(w.bea.id, "project_contestation_resolved")).toEqual([]);
    const [audit] = await auditOf(row.id, "project_contestation.resolve");
    expect(audit).toMatchObject({ actorUserId: teacher.id, payload: { verdict: "refused", points: false, repoId: w.repoA, criterionId: "git.commits" } });
    expect(JSON.stringify(audit)).not.toContain("one author");
  });

  it("accepts with the points unchanged, or with new points written as the teacher's criterion write: indicative until validated and released", async () => {
    const w = await world();
    const bare = await filed(w, w.bea, "rapport.crash", "It never crashed.");
    expect((await resolve(w, bare.id, { verdict: "accepted" })).json()).toMatchObject({ contestation: { state: "accepted", reply: null }, repo: null });

    const row = await filed(w, w.bea, "rendu.all-tests-passed");
    expect((await resolve(w, row.id, { verdict: "accepted", points: 10 })).statusCode).toBe(400);
    const res = await resolve(w, row.id, { verdict: "accepted", points: 10, reply: "Test 3 was wrong.", rationale: "Every test passes." });
    expect(res.statusCode, res.body).toBe(200);
    const outcome = ProjectContestationResolution.parse(res.json());
    expect(outcome.repo!.validation).toMatchObject({ validated: false, proposed: ["rendu.all-tests-passed"] });
    const [written] = await db()
      .select()
      .from(projectCriterionGrades)
      .where(and(eq(projectCriterionGrades.repoId, w.repoB), eq(projectCriterionGrades.criterionId, "rendu.all-tests-passed"), ne(projectCriterionGrades.state, "superseded")));
    expect(written).toMatchObject({ points: 10, source: "manual", state: "proposed", rationale: "Every test passes.", createdBy: teacher.id });
    const [stored] = await db().select().from(projectContestations).where(eq(projectContestations.id, row.id));
    expect(stored).toMatchObject({ state: "accepted", gradeAtResolutionId: written!.id, resolvedBy: teacher.id });
    expect((await auditOf(w.repoB, "project_repo.criterion_graded")).map((e) => e.payload)).toEqual([
      { projectId: w.projectId, criterionId: "rendu.all-tests-passed", points: 10, before: 8 },
    ]);
    // The member reads the new points as indicative; the grade waits for the owner's validation and next release.
    const view = await studentView(w, w.bea);
    expect(view.criteria!.find((c) => c.criterionId === "rendu.all-tests-passed")).toMatchObject({ points: 10, state: "indicative" });
    // The release stands as it was written: 8 + 4 − 2 + 0 + 1.
    expect(view.release).toMatchObject({ points: 11 });
  });

  it("rolls the points back when the contestation was answered meanwhile", async () => {
    const w = await world();
    const row = await filed(w, w.bea, "rendu.all-tests-passed");
    const [stale] = await db().select().from(projectContestations).where(eq(projectContestations.id, row.id));
    expect((await resolve(w, row.id, { verdict: "refused", reply: "No." })).statusCode).toBe(200);
    const [project] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    const [repo] = await db().select().from(projectRepos).where(eq(projectRepos.id, w.repoB));
    const error = await resolveProjectContestation(db(), {
      project: project!,
      contestation: stale!,
      repo: repo!,
      body: { verdict: "accepted", points: 10, reply: "Yes." },
      writer: { actor: { actorUserId: teacher.id, actorType: "user" }, userId: teacher.id, now: new Date(), owner: true },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ProjectError);
    expect((error as ProjectError).code).toBe("not_open");
    expect(
      await db()
        .select()
        .from(projectCriterionGrades)
        .where(and(eq(projectCriterionGrades.repoId, w.repoB), eq(projectCriterionGrades.source, "manual"), eq(projectCriterionGrades.points, 10))),
    ).toEqual([]);
  });

  it("only refuses a contestation whose criterion left the snapshot, which the staff and the members still read", async () => {
    const w = await world();
    const row = await filed(w, w.ana, "git.commits");
    const parsed = parseCriteria(CRITERIA.replace(/ {2}git:\n.*\n/, ""), { version: 2 });
    if (!parsed.ok) throw new Error("the reload does not parse");
    await db().update(projectCriteria).set({ criteria: parsed.criteria }).where(eq(projectCriteria.projectId, w.projectId));
    expect((await staffView(w)).contestations[0]).toMatchObject({ criterionId: "git.commits", criterionDescription: "Who committed the work", inSnapshot: false });
    expect((await resolve(w, row.id, { verdict: "accepted" })).json()).toMatchObject({ error: "criterion_removed" });
    expect((await resolve(w, row.id, { verdict: "refused", reply: "The criterion was withdrawn." })).statusCode).toBe(200);
    expect((await studentView(w, w.ada)).contestations[0]).toMatchObject({ criterionDescription: "Who committed the work", maxAtFiling: 2, state: "refused" });
  });

  it("is a contestation of the route's project: another project's is the 404 of a missing one", async () => {
    const w = await world();
    const other = await world();
    const row = await filed(other, other.bea, "rendu.all-tests-passed");
    expect((await resolve(w, row.id, { verdict: "refused", reply: "No." })).statusCode).toBe(404);
  });
});

describe("every criterion write on a released project is the owner's (ADR-139 §13, ADR-135 §9)", () => {
  it("lets an assistant grade and validate before the release, and refuses them after it: points, validations, Regrades", async () => {
    const w = await world({ release: false });
    const helper = await assistant(w);
    const points = (headers: Headers) => call("PUT", `/app/api/projects/${w.projectId}/repos/${w.repoB}/criteria/git.commits`, headers, { points: 2 });
    expect((await points(helper.headers)).statusCode).toBe(200);
    expect((await call("POST", `/app/api/projects/${w.projectId}/repos/${w.repoB}/validate`, helper.headers)).statusCode).toBe(200);
    await releaseOk(w);

    for (const [method, url, body] of [
      ["PUT", `/app/api/projects/${w.projectId}/repos/${w.repoB}/criteria/git.commits`, { points: 1 }],
      ["POST", `/app/api/projects/${w.projectId}/repos/${w.repoB}/validate`, undefined],
      ["POST", `/app/api/projects/${w.projectId}/validate`, undefined],
      ["POST", `/app/api/projects/${w.projectId}/regrade`, {}],
      ["POST", `/app/api/projects/${w.projectId}/repos/${w.repoB}/regrade`, {}],
      // A reload may take a contested criterion out of the snapshot (ADR-139 §13).
      ["POST", `/app/api/projects/${w.projectId}/criteria/reload`, undefined],
    ] as const) {
      const res = await call(method, url, helper.headers, body);
      expect([res.statusCode, res.json().error], `${method} ${url}`).toEqual([403, "owner_required"]);
    }
    expect((await points(teacher.headers)).statusCode).toBe(200);
  });

  it("reads the release again in a schema-3 Regrade's claim, under its share lock", async () => {
    const w = await world();
    const writer = { actor: { actorUserId: teacher.id, actorType: "user" as const }, userId: teacher.id, now: new Date(), owner: false };
    const claim = await claimRegrades(db(), w.projectId, [w.repoB], server.app.clock, true, writer).then(
      () => null,
      (e: unknown) => e as ProjectError,
    );
    expect(claim?.code).toBe("owner_required");
  });

  it("reads the release again under the writer's lock: a release committed after the loader is seen", async () => {
    const w = await world();
    const [project] = await db().select().from(projects).where(eq(projects.id, w.projectId));
    const [repo] = await db().select().from(projectRepos).where(eq(projectRepos.id, w.repoB));
    const writer = { actor: { actorUserId: teacher.id, actorType: "user" as const }, userId: teacher.id, now: new Date(), owner: false };
    // As the loader read it: not released.
    const error = await gradeCriterion(db(), { ...project!, releasedAt: null }, repo!, "git.commits", { points: 2 }, writer).then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as ProjectError).code).toBe("owner_required");
  });
});

describe("the members' exit (invariant 4, N-SEC-20, 05 §5.7)", () => {
  const REASON = "Sentinel-reason-7f3a: my partner wrote half of it.";
  const REPLY = "Sentinel-reply-91bc: the log says otherwise.";

  it("carries a contestation in its repository's student payload only", async () => {
    const w = await world();
    const row = await filed(w, w.ana, "git.commits", REASON);
    expect((await resolve(w, row.id, { verdict: "refused", reply: REPLY })).statusCode).toBe(200);

    // The group reads it, on the project page and in their personal data export.
    for (const member of [w.ana, w.ada]) {
      const page = await call("GET", `/app/api/student/projects/${w.projectId}`, member.headers);
      expect(page.body).toContain(REASON);
      expect(page.body).toContain(REPLY);
      expect((await call("GET", "/app/api/me/export", member.headers)).body).toContain(REASON);
      // Nowhere else: their home, their classroom, their grades, their bells.
      for (const url of ["/app/api/student/home", `/app/api/student/classrooms/${w.classroomId}`, "/app/api/student/results", "/app/api/notifications"]) {
        const res = await call("GET", url, member.headers);
        expect(res.statusCode, `${url} ${res.body}`).toBe(200);
        expect(res.body, url).not.toContain(REASON);
        expect(res.body, url).not.toContain(REPLY);
      }
    }

    // Bea (another repository) and Cid (none) — by their own session and by an impersonation — never see it.
    const admin = await server.signIn("admin");
    const urls: [string, number][] = [
      [`/app/api/student/projects/${w.projectId}`, 200],
      ["/app/api/student/home", 200],
      [`/app/api/student/classrooms/${w.classroomId}`, 200],
      [`/app/api/student/classrooms/${w.classroomId}/gradebook`, 200],
      ["/app/api/student/results", 200],
      ["/app/api/notifications", 200],
      [`/app/api/projects/${w.projectId}/contestations`, 404],
      [`/app/api/projects/${w.projectId}/grading`, 404],
    ];
    for (const who of [w.bea, w.cid]) {
      const impersonation = await sessionOf(db(), who.id, { kind: "impersonation", actorUserId: admin.id });
      for (const [name, headers, list] of [
        ["own", who.headers, [...urls, ["/app/api/me/export", 200]]],
        ["impersonation", impersonation, urls],
      ] as const) {
        for (const [url, status] of list) {
          const res = await call("GET", url, headers);
          expect(res.statusCode, `${who.id} ${name} ${url} ${res.body}`).toBe(status);
          expect(res.body, `${name} ${url}`).not.toContain(REASON);
          expect(res.body, `${name} ${url}`).not.toContain(REPLY);
          expect(res.body, `${name} ${url}`).not.toMatch(/"(filedAt|resolvedAt|criterionDescription)"/);
        }
      }
    }
    expect((await studentView(w, w.bea)).contestations).toEqual([]);
  });

  it("never reaches an MCP client nor the help assistant: the grading tools carry no contestation, and the staff's route takes no token", async () => {
    const w = await world();
    const row = await filed(w, w.ana, "git.commits", REASON);
    expect((await resolve(w, row.id, { verdict: "refused", reply: REPLY })).statusCode).toBe(200);
    const tokenRes = await call("POST", "/app/api/me/tokens", teacher.headers, { name: "mcp", scope: "quiz" });
    const token = (tokenRes.json() as ApiTokenCreated).token;
    let rpcId = 0;
    const tool = async (name: string, args: object) => {
      const res = await server.app.inject({
        method: "POST",
        url: "/app/api/mcp",
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } },
      });
      const { result } = res.json() as { result: { isError: boolean; content: { text: string }[] } };
      expect(result.isError, result.content[0]!.text).toBe(false);
      return result.content[0]!.text;
    };
    for (const text of [
      await tool("get_project_grading", { projectId: w.projectId }),
      await tool("get_project_grading", { projectId: w.projectId, repoId: w.repoA }),
      await tool("grade_criterion", { projectId: w.projectId, repoId: w.repoA, criterionId: "rendu.all-tests-passed", points: 9 }),
    ]) {
      expect(text).not.toContain(REASON);
      expect(text).not.toContain(REPLY);
      expect(text).not.toMatch(/contestation|filedAt|resolvedAt/i);
    }
    // An MCP token (scope `quiz`) is refused the route; a full API token, the only personal token that reaches project routes, finds no project (ADR-113).
    expect((await call("GET", `/app/api/projects/${w.projectId}/contestations`, { authorization: `Bearer ${token}` })).statusCode).toBe(403);
    const api = ((await call("POST", "/app/api/me/tokens", teacher.headers, { name: "api", scope: "api" })).json() as ApiTokenCreated).token;
    expect((await call("GET", `/app/api/projects/${w.projectId}/contestations`, { authorization: `Bearer ${api}` })).statusCode).toBe(404);
    const assist = await mintAssistToken(db(), teacher.id, server.app.clock.now());
    const helper = injectedApi(server.app, `Bearer ${assist.token}`, "http://web.test");
    const refused = await helper.get(`/projects/${w.projectId}/contestations`).then(
      () => null,
      (e: unknown) => e as { status: number },
    );
    expect(refused?.status).toBe(404);
  });

  it("is deleted with its repository", async () => {
    const w = await world();
    await filed(w, w.bea, "rendu.all-tests-passed");
    await db().delete(projectRepos).where(eq(projectRepos.id, w.repoB));
    expect(await db().select().from(projectContestations)).not.toContainEqual(expect.objectContaining({ repoId: w.repoB }));
  });
});
