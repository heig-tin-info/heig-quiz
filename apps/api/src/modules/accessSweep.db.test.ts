/**
 * Invariant 6 over EVERY staff route of an object, in one sweep: the routes
 * under `/courses/:id`, `/classrooms/:id`, `/evaluations/:id`, `/pools/:id`,
 * `/questions/:id` and `/group-sets/:id`, and, on a server with Quiz's GitHub App, those under
 * `/courses/:id`, `/classrooms/:id` and `/projects/:id` again (the App adds
 * its own) — as Fastify's route tree lists them, so a route added tomorrow
 * is swept without anybody remembering to. One route of those families is
 * not a staff route (`NOT_STAFF`): revoking a course's grant of an
 * organization is an admin's with Super Powers, refused to every teacher
 * with the role's 403 (`github.db.test.ts` holds it).
 *
 * - A teacher off the staff gets the 404 of a missing object: the same
 *   status and the same body as for an id that does not exist.
 * - A student gets, on a real object, exactly what they get on a missing
 *   one: the role's 403 on a staff route, a 404 where a student branch
 *   exists — never a sign that the object is there.
 * - Enrolled in the classroom, a student gets the same, except on the
 *   routes a student of that classroom sits through (`STUDENT_ROUTES`).
 *
 * Every inner id of a swept URL is real (`world()`), and the same URLs never
 * answer their owner a 404: no route passes for an id nobody holds.
 *
 * Each call carries an empty body: the scope is refused before the body is
 * read (`teacherRoute`, `modules/http.ts`), which `evaluation.db.test.ts`
 * checks refusal by refusal. What this sweep cannot see — an item of
 * ANOTHER evaluation, a pool linked to someone else's course, a grading of
 * another attempt — stays with the tests of each module.
 *
 * The routes under `/admin/` belong to a role, not to an object: the last
 * sweep holds that they answer no session 401 and anyone but an admin the
 * refusal of the role, whatever the id. Its server runs the kiosk stations
 * (`KIOSK_ATTESTATION=mock`), whose administration routes answer the 404.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GroupSetDetail } from "@quiz/contracts";
import { parseCriteria } from "@quiz/domain/criteriaParse";
import { registerForTests } from "@quiz/registry/server";

import {
  attempts,
  courseConditions,
  courseStaff,
  enrollments,
  evaluations,
  journalPageRevisions,
  paperSheets,
  poolMembers,
  projectCheckpoints,
  projectCriteria,
  projectRepos,
  projects,
  questionReports,
} from "../db/schema.js";
import { json, orgsRoute, type FakeOrg, type Route } from "../github/testing.js";
import { fakeShort } from "../test/fakeType.js";
import { routesOf, testServer, type Method, type TestServer } from "../test/http.js";
import { seedLive } from "../test/live.js";
import { linkClassroom, newOrg, server as projectServer, useProjectWorld } from "../test/projectWorld.js";
import * as evaluationService from "./evaluation/service.js";
import { sha256Of, writeAsset } from "./pool/assets.js";

type Who = Awaited<ReturnType<TestServer["signIn"]>>;

/** The routes a student enrolled in the classroom legitimately reaches. */
const STUDENT_ROUTES = new Set([
  "POST /app/api/evaluations/:id/attempt",
  "POST /app/api/evaluations/:id/attempt/start",
  "POST /app/api/evaluations/:id/retake",
  // ADR-122: practice after the due date (refused 409 before it, never 404).
  "POST /app/api/evaluations/:id/practice",
  "POST /app/api/evaluations/:id/practice/start",
  // The journal's reads: a student of the classroom reads its journal (F-JRN-12).
  "GET /app/api/classrooms/:id/journal",
  "GET /app/api/classrooms/:id/journal/pages*",
  // The group sets that reach the students, through the student branch (F-PROJ-22, M3-17).
  "GET /app/api/classrooms/:id/group-sets/student",
]);

/**
 * Routes whose owner is not the course's teacher, so the owner check below
 * asks someone else, or nobody:
 * - the student routes: the enrolled student;
 * - acting as a student (ADR-034): an admin with Super Powers (ADR-054);
 * - the `.seb` download: a student seated in an exam that requires SEB, in
 *   a state `seb.db.test.ts` builds — here every caller gets the 404, and
 *   the sweeps below only hold that a real evaluation answers like a
 *   missing one.
 */
const IMPERSONATION = "POST /app/api/classrooms/:id/roster/:eid/impersonation";
const SEB_DOWNLOAD = "GET /app/api/evaluations/:id/seb";
/** The one route of a swept family that is no staff route (see the header). */
const NOT_STAFF = new Set(["DELETE /app/api/courses/:id/github/grants/:orgId"]);

/** A world: the owner's objects, and a REAL value for every inner parameter of a swept path. */
interface World {
  /** The object each family names; the poll routes act on a poll (`polls`). */
  ids: Record<string, string>;
  /** By name, or `<family>:<name>` where two families name different things alike (`:cid`). */
  params: Record<string, string>;
}

/** One server swept: its route families, its callers and its worlds. */
interface Sweep {
  server: TestServer;
  /** The swept families: `/app/api/<family>/:id…`. */
  families: readonly string[];
  owner: Who;
  stranger: Who;
  outsider: Who;
  enrolled: Who;
  /** The world the refusals are swept on: nothing in it is written, every call being refused. */
  shared: World;
  /** A world of its own, for a write: no delete takes a later route's object away. */
  world: () => Promise<World>;
}

/** The swept routes of a server, with their URL in a world: on its object, or on a missing one. */
function sweptRoutes(s: Sweep) {
  const families = new RegExp(`^/app/api/(${s.families.join("|")})/:id(/|$)`);
  return routesOf(s.server.app.printRoutes({ commonPrefix: false })).flatMap(({ method, path }) => {
    const found = families.exec(path)?.[1];
    // Two wildcard routes under one node (the journal's `assets/*` and
    // `revisions/*`) print as `/journal*`, their segments lost: no URL can be
    // rebuilt from it, and the journal's own tests sweep both
    // (`writes.db.test.ts`, "who may write"; `journal.db.test.ts`).
    // The students' routes of a set (`/group-sets/:id/student/…`, F-PROJ-22)
    // are no staff routes: body first, then the student's own seat
    // (`studentGroupSet`); `studentGroups.db.test.ts` holds their refusals.
    if (!found || path.endsWith("/journal*") || path.includes("/group-sets/:id/student/") || NOT_STAFF.has(`${method} ${path}`)) return [];
    // A poll route on an exam is a 404 for its mode, whoever asks.
    const family = path.startsWith("/app/api/evaluations/:id/poll") ? "polls" : found;
    const url = (w: World, id: string) =>
      path.replace(/:(\w+)/g, (_, name: string) => {
        if (name === "id") return id;
        const value = w.params[`${found}:${name}`] ?? w.params[name];
        // A new inner parameter needs a real value in `world()`.
        if (value === undefined) throw new Error(`${method} ${path}: no value for :${name}`);
        return value;
      })
        // The one wildcard swept, `pages*`: a page every world's journal has.
        .replace(/\*$/, "/README.md");
    return [
      {
        method,
        path,
        name: `${method} ${path}`,
        real: (w: World) => url(w, w.ids[family]!),
        missing: (w: World) => url(w, randomUUID()),
      },
    ];
  });
}

const call = (server: TestServer, method: Method, url: string, who?: Who) =>
  server.app.inject({
    method,
    url,
    ...(who === undefined ? {} : { headers: who.headers }),
    ...(method === "GET" ? {} : { payload: {} }),
  });

/** What a caller learns from a reply: its status and its body. */
const seen = async (server: TestServer, method: Method, url: string, who?: Who) => {
  const res = await call(server, method, url, who);
  return { status: res.statusCode, body: res.body };
};

/** The three sweeps of invariant 6 over a server's families. */
function sweepStaffRoutes(sweep: () => Sweep) {
  it("sweeps the routes of every family, each of which its owner reaches", async () => {
    const s = sweep();
    const routes = sweptRoutes(s);
    for (const family of s.families) {
      expect(routes.filter((r) => r.path.startsWith(`/app/api/${family}/`)).length, family).toBeGreaterThan(3);
    }
    // No route passes the sweeps below only because an id is unknown: with
    // the same ids, the owner is never answered a 404. A write gets a world
    // of its own, so that no delete takes a later route's object away.
    const admin = await s.server.signInWithSuperPowers();
    const unreached: string[] = [];
    for (const { method, name, real } of routes) {
      if (name === SEB_DOWNLOAD) continue;
      const w = method === "GET" ? s.shared : await s.world();
      // A draft is the staff's alone (audit 2026-10-10, §6): the enrolled
      // student enters an evaluation from `scheduled` on.
      if (STUDENT_ROUTES.has(name) && name.includes("/evaluations/")) {
        await s.server.app.db.update(evaluations).set({ state: "scheduled" }).where(eq(evaluations.id, w.ids.evaluations!));
      }
      const who = STUDENT_ROUTES.has(name) ? s.enrolled : name === IMPERSONATION ? admin : s.owner;
      const res = await call(s.server, method, real(w), who);
      if (res.statusCode === 404) unreached.push(`${name} ${res.body}`);
    }
    expect(unreached).toEqual([]);
  });

  it("answers a teacher off the staff the 404 of a missing object", async () => {
    const s = sweep();
    for (const { method, name, real, missing } of sweptRoutes(s)) {
      const offStaff = await seen(s.server, method, real(s.shared), s.stranger);
      expect(offStaff, name).toEqual({ status: 404, body: JSON.stringify({ error: "not_found" }) });
      expect(offStaff, name).toEqual(await seen(s.server, method, missing(s.shared), s.stranger));
    }
  });

  it("answers a student what a missing object gets, enrolled or not", async () => {
    const s = sweep();
    for (const { method, name, real, missing } of sweptRoutes(s)) {
      const asOutsider = await seen(s.server, method, real(s.shared), s.outsider);
      expect([403, 404], name).toContain(asOutsider.status);
      expect(asOutsider, name).toEqual(await seen(s.server, method, missing(s.shared), s.outsider));
      if (STUDENT_ROUTES.has(name)) continue;
      expect(await seen(s.server, method, real(s.shared), s.enrolled), name).toEqual(asOutsider);
    }
  });
}

/** The callers of a sweep, signed in on `server`. */
async function callers(server: TestServer) {
  return {
    owner: await server.signIn("teacher"),
    stranger: await server.signIn("teacher"),
    outsider: await server.signIn("student"),
    enrolled: await server.signIn("student"),
  };
}

let restore: () => void;
let main: Sweep;

/**
 * The owner's objects, and a REAL value for every inner parameter of a
 * swept path: a route refused off the staff is then refused for its scope,
 * never for an inner id nobody holds.
 */
async function world(server: TestServer, owner: Who, enrolled: Who): Promise<World> {
  const db = server.app.db;
  const seed = await seedLive(db, { teacherId: owner.id, studentIds: [enrolled.id] });
  // A colleague on the course's staff and on the pool: the `:uid` of a staff
  // seat, the `:userId` of a pool member.
  const colleague = await server.signIn("teacher");
  await db.insert(courseStaff).values({ courseId: seed.courseId, userId: colleague.id });
  await db.insert(poolMembers).values({ poolId: seed.poolId, userId: colleague.id, role: "reader" });
  const [entry] = await db.select().from(enrollments).where(eq(enrollments.classroomId, seed.classroomId));
  // A poll of the owner's, for the poll routes (an exam turned poll,
  // as `evaluation.db.test.ts` makes one: a poll is refused items).
  const poll = await seedLive(db, { teacherId: owner.id, studentIds: [enrolled.id], questions: 1 });
  await db.update(evaluations).set({ mode: "poll" }).where(eq(evaluations.id, poll.evaluationId));
  // A Quiz-mode journal (ADR-057), through its route: its home page and that page's revision.
  const journal = await server.app.inject({
    method: "POST",
    url: `/app/api/classrooms/${seed.classroomId}/journal`,
    headers: owner.headers,
    payload: { mode: "quiz" },
  });
  expect(journal.statusCode, journal.body).toBe(201);
  const [revision] = await db
    .select({ id: journalPageRevisions.id })
    .from(journalPageRevisions)
    .where(eq(journalPageRevisions.classroomId, seed.classroomId));
  // A closed exam of the classroom: the gradebook's column (`kind`, `activityId`), which a draft has none of.
  const graded = await evaluationService.createEvaluation(db, { classroomId: seed.classroomId, title: "Graded", mode: "exam", createdBy: owner.id });
  await db.update(evaluations).set({ state: "closed" }).where(eq(evaluations.id, graded.id));
  // An entry of the course's catalog of conditions (F-ORG-16): the `:cid`.
  const conditionId = randomUUID();
  await db.insert(courseConditions).values({ id: conditionId, courseId: seed.courseId, kind: "info", text: "Swept", position: 0 });
  // A report on the pool's question (issue #680): the `:reportId` of its resolution.
  const reportId = randomUUID();
  await db.insert(questionReports).values({ id: reportId, questionId: seed.questionIds[0]!, reporterId: owner.id, message: "Swept" });
  const attemptId = randomUUID();
  await db.insert(attempts).values({ id: attemptId, evaluationId: seed.evaluationId, userId: enrolled.id, seed: 1 });
  // A paper sheet with its scan (ADR-125): the `…/paper` and `…/paper/scan` routes of the attempt.
  const scan = Buffer.from("%PDF-1.4\n%%EOF\n", "latin1");
  const sha = sha256Of(scan);
  await writeAsset(server.assetsDir, `paper/${attemptId}/${sha}.pdf`, scan);
  await db.insert(paperSheets).values({
    attemptId,
    examDate: "2026-11-02",
    enteredBy: owner.id,
    scanMime: "application/pdf",
    scanBytes: scan.length,
    scanSha256: sha,
    scanUploadedAt: new Date(),
    scanUploadedBy: owner.id,
  });
  // A group set of the classroom with one group: the `:gid`.
  const set = await server.app.inject({ method: "POST", url: `/app/api/classrooms/${seed.classroomId}/group-sets`, headers: owner.headers, payload: {} });
  expect(set.statusCode, set.body).toBe(201);
  const setId = GroupSetDetail.parse(set.json()).set.id;
  const group = await server.app.inject({ method: "POST", url: `/app/api/group-sets/${setId}/groups`, headers: owner.headers, payload: {} });
  expect(group.statusCode, group.body).toBeLessThan(300);
  const gid = GroupSetDetail.parse(group.json()).groups[0]!.id;
  return {
    ids: {
      courses: seed.courseId,
      classrooms: seed.classroomId,
      evaluations: seed.evaluationId,
      pools: seed.poolId,
      questions: seed.questionIds[0]!,
      polls: poll.evaluationId,
      "group-sets": setId,
    },
    params: {
      itemId: seed.itemIds[0]!,
      uid: colleague.id,
      userId: colleague.id,
      eid: entry!.id,
      attemptId,
      number: "1",
      revisionId: revision!.id,
      kind: "evaluation",
      activityId: graded.id,
      cid: conditionId,
      reportId,
      gid,
    },
  };
}

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  const server = await testServer({ KIOSK_ATTESTATION: "mock" });
  const who = await callers(server);
  main = {
    server,
    families: ["courses", "classrooms", "evaluations", "pools", "questions", "group-sets"],
    ...who,
    shared: await world(server, who.owner, who.enrolled),
    world: () => world(server, who.owner, who.enrolled),
  };
});

afterAll(async () => {
  await main.server.close();
  restore();
});

describe("every staff route of an object (invariant 6)", () => {
  sweepStaffRoutes(() => main);
});

/** A `criteria.yml` of schema 3 (ADR-106): the `:criterionId` of the swept routes is `code.tests`. */
const CRITERIA = [
  "schema_version: 3",
  "criteria:",
  "  code:",
  "    tests: {description: Tests, max_points: 10, command: [make, test]}",
  "",
].join("\n");

/**
 * The routes of a project, and the App's own under a classroom and a course,
 * exist only with Quiz's GitHub App configured (M1-02): a server of their
 * own, the project world's (`test/projectWorld.ts`), against the fake GitHub.
 */
describe("every staff route of a project, and of the App (invariant 6, N-SEC-20)", () => {
  const orgs: FakeOrg[] = [];
  let hub: Sweep;
  /** `GET /repos/{org}/template` and its branches: the `:repo` of a source, a real repository of the organization. */
  const templateRoute: Route = (url, init) => {
    const m = /^\/repos\/([^/]+)\/template(\/branches)?$/.exec(url.pathname);
    const org = m && orgs.find((o) => o.login === m[1]);
    if (url.host !== "api.github.com" || init.method !== "GET" || !org) return undefined;
    if (m![2]) return json([{ name: "main" }]);
    return json({ id: 9_000_000 + org.githubOrgId, name: "template", owner: { id: org.githubOrgId, login: org.login }, default_branch: "main" });
  };
  useProjectWorld({ routes: [orgsRoute(() => orgs), templateRoute], repos: false, teacher: false });

  /**
   * The world of the other families, its classroom connected to an
   * organization with Quiz's App, and a project of it: published, graded by
   * criteria, with a repository, a checkpoint and its criteria.
   */
  async function projectWorld(server: TestServer, owner: Who, enrolled: Who): Promise<World> {
    const db = server.app.db;
    const base = await world(server, owner, enrolled);
    const classroomId = base.ids.classrooms!;
    const { n, login, orgId } = await newOrg("sweep");
    orgs.push({ githubOrgId: n, login, installationId: n, selection: "all", plan: "team", exists: true });
    await linkClassroom(classroomId, orgId, owner.id);
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      classroomId,
      orgId,
      name: "Swept lab",
      slug: `lab-${n}`,
      state: "published",
      startAt: new Date("2026-10-01T08:00:00Z"),
      deadlineAt: new Date("2026-12-01T22:00:00Z"),
      sourceRepoId: n + 1,
      sourceFullName: `${login}/starter`,
      distributionRepoId: n + 2,
      distributionFullName: `${login}/lab-squashed`,
      branches: ["main"],
      protectedFiles: [],
      gradingMode: "criteria",
      gradingScale: { kind: "linear", rounding: "nearest" },
      createdBy: owner.id,
    });
    const parsed = parseCriteria(CRITERIA, { version: 3 });
    if (!parsed.ok) throw new Error("the fixture does not parse");
    await db.insert(projectCriteria).values({ projectId, fileSha: "f", sourceSha: "s", criteria: parsed.criteria, loadedAt: new Date() });
    const repoId = randomUUID();
    await db.insert(projectRepos).values({
      id: repoId,
      projectId,
      userId: enrolled.id,
      githubRepoId: n + 3,
      fullName: `${login}/lab-${n}-repo`,
      defaultBranch: "main",
      provisionStatus: "ok",
      acceptedAt: new Date("2026-10-01T09:00:00Z"),
      invitationStatus: "accepted",
    });
    const checkpointId = randomUUID();
    await db.insert(projectCheckpoints).values({ id: checkpointId, projectId, name: "m1", dueAt: new Date("2026-11-20T22:00:00Z") });
    return {
      ids: { ...base.ids, projects: projectId },
      params: { ...base.params, rid: repoId, "projects:cid": checkpointId, criterionId: "code.tests", repo: "template" },
    };
  }

  beforeAll(async () => {
    const server = projectServer;
    const who = await callers(server);
    hub = {
      server,
      families: ["courses", "classrooms", "projects"],
      ...who,
      shared: await projectWorld(server, who.owner, who.enrolled),
      world: () => projectWorld(server, who.owner, who.enrolled),
    };
  });

  sweepStaffRoutes(() => hub);
});

/** The administration routes whose refusal is the 404 of a missing entity (`adminGuard(app, { hidden: true })`): the kiosk stations. */
const HIDDEN_ADMIN = /^\/app\/api\/admin\/kiosk-devices(\/|$)/;

/** An administration route's inner parameters: any value, the role being refused before anything is read. */
const anyParams = (path: string) => path.replace(/:(\w+)/g, () => randomUUID());

describe("every administration route (the admin's alone)", () => {
  it("answers no session 401, and anyone but an admin the refusal of the role", async () => {
    const { server } = main;
    const routes = routesOf(server.app.printRoutes({ commonPrefix: false })).filter(({ path }) => path.startsWith("/app/api/admin/"));
    expect(routes.length).toBeGreaterThan(10);
    // The kiosk stations are on: the hidden branch below is walked, not assumed.
    expect(routes.filter(({ path }) => HIDDEN_ADMIN.test(path)).length).toBeGreaterThan(0);
    const teacher = await server.signIn("teacher");
    const student = await server.signIn("student");
    const admin = await server.signIn("admin");
    for (const { method, path } of routes) {
      const name = `${method} ${path}`;
      const url = anyParams(path);
      expect((await seen(server, method, url)).status, name).toBe(401);
      const asTeacher = await seen(server, method, url, teacher);
      // The role's 403, or the 404 of a missing entity where the route
      // names one a non-admin could otherwise reach (`adminGuard`'s `hidden`).
      expect(asTeacher, name).toEqual(
        HIDDEN_ADMIN.test(path)
          ? { status: 404, body: JSON.stringify({ error: "not_found" }) }
          : { status: 403, body: JSON.stringify({ error: "forbidden" }) },
      );
      expect(await seen(server, method, anyParams(path), teacher), name).toEqual(asTeacher);
      expect(await seen(server, method, url, student), name).toEqual(asTeacher);
      // And the admin passes the guard.
      expect([401, 403], name).not.toContain((await call(server, method, url, admin)).statusCode);
    }
  });
});
