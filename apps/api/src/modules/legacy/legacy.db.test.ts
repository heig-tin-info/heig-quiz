/**
 * The legacy URL resolver (merge task M8-02, docs/merge/06 §6.6) over the
 * real application: one fixed 302, one fixed 410 and the entity rows, each asserting the
 * status and the `Location` the Caddy fragment hands over to; then who
 * reaches a target (invariant 6): an entity off the caller's reach, one the
 * import never carried, and one that never existed answer ALIKE, for every
 * kind of caller.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiToken } from "../../auth/tokens.js";
import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { defaultProjectGradingScale } from "@quiz/contracts";
import { avatars, classrooms, githubOrganizations, groupSets, importIdMap, projects } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

let server: TestServer;
let teacher: Awaited<ReturnType<TestServer["signIn"]>>;
let student: Awaited<ReturnType<TestServer["signIn"]>>;
let stranger: Awaited<ReturnType<TestServer["signIn"]>>;
/** A student who is not seated in the classroom. */
let outsider: Awaited<ReturnType<TestServer["signIn"]>>;

const old = { classroom: randomUUID(), assignment: randomUUID(), draft: randomUUID(), user: randomUUID(), unmapped: randomUUID() };
let classroomId: string;
let projectId: string;
let draftId: string;
let setId: string;

const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers });
const location = (res: { headers: Record<string, unknown> }) => res.headers.location;

const nextOrg = { n: 9000 };
async function project(over: Partial<typeof projects.$inferInsert>, room: string = classroomId): Promise<string> {
  const db = server.app.db;
  const n = nextOrg.n++;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `lorg-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId: room,
    orgId,
    name: `Lab ${n}`,
    slug: `lab-${n}`,
    startAt: new Date(0),
    deadlineAt: new Date(2e12),
    sourceRepoId: n,
    sourceFullName: `lorg-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `lorg-${n}/lab-squashed`,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    createdBy: teacher.id,
    ...over,
  });
  return id;
}

beforeAll(async () => {
  server = await testServer();
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
  stranger = await server.signIn("teacher");
  outsider = await server.signIn("student");
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
  classroomId = seeded.classroomId;
  const db = server.app.db;
  setId = randomUUID();
  await db.insert(groupSets).values({ id: setId, classroomId, name: "Teams", createdBy: teacher.id, createdAt: new Date() });
  projectId = await project({ state: "published", groupSetId: setId });
  draftId = await project({ state: "draft" });
  await db.insert(avatars).values({ userId: student.id, data: Buffer.from("x"), contentType: "image/png" });
  const map = (sourceTable: string, sourceId: string, targetId: string) => ({ sourceTable, sourceId, targetId, how: "merged" });
  await db.insert(importIdMap).values([
    map("classrooms", old.classroom, classroomId),
    map("assignments", old.assignment, projectId),
    map("assignments", old.draft, draftId),
    map("users", old.user, student.id),
  ]);
});
afterAll(async () => server.close());

const L = "/legacy/classroom";

describe("every row of §6.6, as the Caddy fragment hands it over", () => {
  // The table of rows is the domain test's; here, one 302 and one 410 over HTTP.
  it.each([
    ["a redirect", "/app/auth/github/callback", 302, "/settings"],
    // The fragment sends `/` as `/legacy/classroom/`: the wildcard is empty.
    ["the root", "/", 302, "/"],
    ["a dead API", "/app/api/classrooms", 410, undefined],
  ] as const)("%s, whoever asks", async (_row, path, status, to) => {
    for (const headers of [{}, teacher.headers]) {
      const res = await get(`${L}${path}`, headers);
      expect(res.statusCode).toBe(status);
      if (to) expect(location(res)).toBe(to);
      else expect(res.json()).toEqual({ error: "moved", to: "/" });
    }
  });

  it("a query string does not change a fixed row", async () => {
    const res = await get(`${L}/app/email/unsub?u=1&sig=abc`);
    expect([res.statusCode, location(res)]).toEqual([302, "/settings"]);
  });

  // The rows that point at an entity, as the staff of its course reach them.
  const ENTITY = (): [string, string, string][] => [
    ["/classrooms/:id", `/classrooms/${old.classroom}`, `/classrooms/${classroomId}`],
    ["/classrooms/:id/assignments/:aid", `/classrooms/${old.classroom}/assignments/${old.assignment}`, `/projects/${projectId}`],
    ["/classrooms/:id/assignments/:aid/groups", `/classrooms/${old.classroom}/assignments/${old.assignment}/groups`, `/classrooms/${classroomId}/groups/${setId}`],
    ["/classrooms/:cid/journal", `/classrooms/${old.classroom}/journal`, `/classrooms/${classroomId}/journal`],
    ["/classrooms/:cid/journal/<path>", `/classrooms/${old.classroom}/journal/10-semaine%201/%C3%A9t%C3%A9.md`, `/classrooms/${classroomId}/journal/10-semaine%201/%C3%A9t%C3%A9.md`],
    ["/app/codespace/start/:aid", `/app/codespace/start/${old.assignment}`, `/projects/${projectId}`],
    ["/app/api/users/:uid/avatar", `/app/api/users/${old.user}/avatar`, `/app/api/users/${student.id}/avatar`],
  ];

  it("each entity row, as a member of the staff", async () => {
    for (const [row, path, to] of ENTITY()) {
      if (row.includes("avatar")) continue; // the staff of the student's course sees the picture: below
      const res = await get(`${L}${path}`, teacher.headers);
      expect([row, res.statusCode, location(res)]).toEqual([row, 302, to]);
    }
  });

  it("each entity row, as a seated student, lands on a page they read", async () => {
    const expected: Record<string, string> = {
      "/classrooms/:id/assignments/:aid/groups": `/projects/${projectId}`,
    };
    for (const [row, path, to] of ENTITY()) {
      const res = await get(`${L}${path}`, student.headers);
      expect([row, res.statusCode, location(res)]).toEqual([row, 302, expected[row] ?? to]);
    }
  });

  it("the avatar: the staff of the person's course sees it; a stranger's request is a 410", async () => {
    const path = `${L}/app/api/users/${old.user}/avatar`;
    expect(location(await get(path, teacher.headers))).toBe(`/app/api/users/${student.id}/avatar`);
    for (const headers of [stranger.headers, outsider.headers, {}]) {
      const res = await get(path, headers);
      expect([res.statusCode, res.json()]).toEqual([410, { error: "moved", to: "/" }]);
    }
    // Unmapped, malformed, no picture: 410 alike.
    for (const p of [`/app/api/users/${old.unmapped}/avatar`, "/app/api/users/nope/avatar", `/app/api/users/${old.user}/avatar`]) {
      const res = await get(`${L}${p}`, p.includes(old.user) ? outsider.headers : teacher.headers);
      expect(res.statusCode).toBe(410);
    }
  });

  it("a project without a set sends the staff to the classroom's group sets", async () => {
    const bare = await project({ state: "published" });
    await server.app.db.insert(importIdMap).values({ sourceTable: "assignments", sourceId: bare, targetId: bare, how: "created" });
    const res = await get(`${L}/classrooms/${old.classroom}/assignments/${bare}/groups`, teacher.headers);
    expect(location(res)).toBe(`/classrooms/${classroomId}/groups`);
  });

  it("a journal path never climbs out of the journal", async () => {
    const res = await get(`${L}/classrooms/${old.classroom}/journal/a/..%2F..%2Fb`, teacher.headers);
    expect(location(res)).toBe(`/classrooms/${classroomId}/journal`);
    const dot = await get(`${L}/classrooms/${old.classroom}/journal/.github/x.md`, teacher.headers);
    expect(location(dot)).toBe(`/classrooms/${classroomId}/journal`);
  });
});

describe("who reaches a target (invariant 6)", () => {
  const targets = () => [
    `${L}/classrooms/${old.classroom}`,
    `${L}/classrooms/${old.classroom}/assignments/${old.assignment}`,
    `${L}/classrooms/${old.classroom}/assignments/${old.assignment}/groups`,
    `${L}/classrooms/${old.classroom}/journal/README.md`,
    `${L}/app/codespace/start/${old.assignment}`,
  ];
  const missing = (url: string) =>
    url.replace(old.classroom, randomUUID()).replace(old.assignment, randomUUID());

  it("a stranger and a student off the seat get the 404 of a missing entity, the body of it", async () => {
    for (const headers of [stranger.headers, outsider.headers]) {
      for (const url of targets()) {
        const real = await get(url, headers);
        const gone = missing(url);
        const absent = await get(gone, headers);
        // The default 404 names the route asked: compare what is left of it.
        const bare = (body: string, u: string) => body.replace(u, "");
        expect([url, real.statusCode, bare(real.body, url)]).toEqual([url, 404, bare(absent.body, gone)]);
        expect(absent.statusCode).toBe(404);
      }
    }
  });

  it("an id the import never carried, and a malformed one, are the same 404", async () => {
    for (const path of [`/classrooms/${old.unmapped}`, "/classrooms/nope", `/classrooms/${old.classroom}/assignments/${old.unmapped}`, "/app/codespace/start/nope"]) {
      const res = await get(`${L}${path}`, teacher.headers);
      expect([path, res.statusCode]).toEqual([path, 404]);
    }
  });

  it("a draft project is the staff's only: a student gets the 404", async () => {
    const path = `${L}/classrooms/${old.classroom}/assignments/${old.draft}`;
    expect(location(await get(path, teacher.headers))).toBe(`/projects/${draftId}`);
    expect((await get(path, student.headers)).statusCode).toBe(404);
  });

  it("a student of an archived classroom still reaches the project page the link lands on", async () => {
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const [oldRoom, oldAssignment] = [randomUUID(), randomUUID()];
    const p = await project({ state: "published" }, seeded.classroomId);
    await server.app.db.update(classrooms).set({ archivedAt: new Date() }).where(eq(classrooms.id, seeded.classroomId));
    await server.app.db.insert(importIdMap).values([
      { sourceTable: "classrooms", sourceId: oldRoom, targetId: seeded.classroomId, how: "merged" },
      { sourceTable: "assignments", sourceId: oldAssignment, targetId: p, how: "created" },
    ]);
    const res = await get(`${L}/classrooms/${oldRoom}/assignments/${oldAssignment}`, student.headers);
    expect([res.statusCode, location(res)]).toEqual([302, `/projects/${p}`]);
  });

  it("the path's classroom must be one the import carried; the access to the project is what protects it", async () => {
    for (const tail of ["", "/groups"]) {
      const unmapped = await get(`${L}/classrooms/${old.unmapped}/assignments/${old.assignment}${tail}`, teacher.headers);
      const absent = await get(`${L}/classrooms/${old.classroom}/assignments/${randomUUID()}${tail}`, teacher.headers);
      expect([unmapped.statusCode, absent.statusCode]).toEqual([404, 404]);
      // A stranger gets the 404 whatever the classroom of the path.
      const off = await get(`${L}/classrooms/${old.classroom}/assignments/${old.assignment}${tail}`, stranger.headers);
      expect(off.statusCode).toBe(404);
    }
  });

  it("after a remap of the classroom (its projects stay where they are), the assignment links still resolve", async () => {
    const [moved, kept] = [randomUUID(), randomUUID()];
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const target = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    const p = await project({ state: "published" }, seeded.classroomId);
    await server.app.db.insert(importIdMap).values([
      { sourceTable: "classrooms", sourceId: moved, targetId: seeded.classroomId, how: "merged" },
      { sourceTable: "assignments", sourceId: kept, targetId: p, how: "created" },
    ]);
    // The mapping file now sends the old classroom to another Quiz classroom.
    await server.app.db.update(importIdMap).set({ targetId: target.classroomId }).where(eq(importIdMap.sourceId, moved));
    for (const headers of [teacher.headers, student.headers]) {
      const res = await get(`${L}/classrooms/${moved}/assignments/${kept}`, headers);
      expect([res.statusCode, location(res)]).toEqual([302, `/projects/${p}`]);
    }
  });

  it("the student never gets the staff's groups page", async () => {
    const res = await get(`${L}/classrooms/${old.classroom}/assignments/${old.assignment}/groups`, student.headers);
    expect(location(res)).not.toContain("/groups");
  });

  it("an impersonation is nobody a target is shown to; a token is read only on the JSON API, so it is nobody here", async () => {
    const admin = await server.signIn("admin");
    const s = await createSession(server.app.db, teacher.id, 8, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null });
    const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
    expect((await get(`${L}/classrooms/${old.classroom}`, impersonation)).statusCode).toBe(404);
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "t", expiresInDays: null });
    const res = await get(`${L}/classrooms/${old.classroom}`, { authorization: `Bearer ${token}` });
    expect(location(res)).toContain("/app/auth/login?next=");
  });

  it("identity-dependent answers are never cached", async () => {
    for (const [url, headers] of [
      [`${L}/classrooms/${old.classroom}`, teacher.headers],
      [`${L}/classrooms/${old.classroom}`, stranger.headers],
      [`${L}/classrooms/${old.classroom}`, {}],
      [`${L}/app/api/users/${old.user}/avatar`, stranger.headers],
      [`${L}/app/api/users/${old.user}/avatar`, teacher.headers],
    ] as const) {
      expect([url, (await get(url, headers)).headers["cache-control"]]).toEqual([url, "no-store"]);
    }
  });

  it("a seb and a kiosk session are nobody here: the login, like no session", async () => {
    const seeded = await seedLive(server.app.db, { teacherId: teacher.id, studentIds: [student.id], questions: 0 });
    for (const kind of ["seb", "kiosk"] as const) {
      const s = await createSession(server.app.db, student.id, 8, { kind, actorUserId: null, projectId: null, evaluationId: seeded.evaluationId });
      const headers = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
      const url = `${L}/classrooms/${old.classroom}`;
      const res = await get(url, headers);
      expect([kind, res.statusCode, location(res)]).toEqual([kind, 302, `/app/auth/login?next=${encodeURIComponent(url)}`]);
    }
  });

  it("a URL too long for the login's stash is sent to the login without its way back", async () => {
    const res = await get(`${L}/classrooms/${old.classroom}/journal/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}/${"d".repeat(90)}/${"e".repeat(90)}/${"f".repeat(90)}/${"g".repeat(90)}/${"h".repeat(90)}/${"i".repeat(90)}/${"j".repeat(90)}/${"k".repeat(90)}/${"l".repeat(90)}/${"m".repeat(90)}/${"n".repeat(90)}/${"o".repeat(90)}/${"p".repeat(90)}.md`);
    expect([res.statusCode, location(res)]).toEqual([302, "/app/auth/login"]);
  });

  it("nobody signed in is sent to the login that comes back to the same URL, real entity or not", async () => {
    for (const url of targets()) {
      const gone = missing(url);
      const real = await get(url);
      const absent = await get(gone);
      expect(real.statusCode).toBe(302);
      expect(String(location(real))).toBe(`/app/auth/login?next=${encodeURIComponent(url)}`);
      expect(absent.statusCode).toBe(302);
      expect(String(location(absent))).toBe(`/app/auth/login?next=${encodeURIComponent(gone)}`);
    }
  });

  it("an admin without Super Powers is not the staff either; with them, they are", async () => {
    const admin = await server.signIn("admin");
    expect((await get(`${L}/classrooms/${old.classroom}`, admin.headers)).statusCode).toBe(404);
    const powers = await server.signInWithSuperPowers();
    expect(location(await get(`${L}/classrooms/${old.classroom}`, powers.headers))).toBe(`/classrooms/${classroomId}`);
  });
});

describe("a refusal for a navigation is the SPA's own not-found page", () => {
  it("serves the same page for a missing and for an unreachable target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>spa</title>");
    const spa = await testServer({ STATIC_DIR: dir });
    try {
      const stranger2 = await spa.signIn("teacher");
      const [real, absent] = await Promise.all([
        spa.app.inject({ method: "GET", url: `${L}/classrooms/${old.classroom}`, headers: stranger2.headers }),
        spa.app.inject({ method: "GET", url: `${L}/classrooms/${randomUUID()}`, headers: stranger2.headers }),
      ]);
      expect([real.statusCode, real.headers["content-type"]]).toEqual([absent.statusCode, absent.headers["content-type"]]);
      expect(real.body).toBe(absent.body);
      expect(real.body).toContain("<title>spa</title>");
    } finally {
      await spa.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
