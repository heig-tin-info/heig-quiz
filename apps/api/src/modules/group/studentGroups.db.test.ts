/**
 * Groups formed by the students (ADR-070 §8 as amended 2026-10-05, F-PROJ-22;
 * merge task M3-17), through their routes, on a server built WITHOUT Quiz's
 * App and WITH the development login (so that an impersonation's write
 * reaches the loader instead of the auth plugin's `403`):
 *
 * - the staff open a set until a date (a maximum size required), close it,
 *   reopen it; an archived classroom's set cannot be opened;
 * - a student creates a group (named by default in their language) and is
 *   moved in, joins a group below the maximum, leaves theirs, renames
 *   theirs; each write audited as theirs (`self`);
 * - the refusals: a closed set, a frozen one (a repository in a project's
 *   copy, a stopped one included), a full group (two joins racing for the
 *   last seat), an archived classroom; an impersonation, a teacher in the
 *   student view, a staff seat, a stranger, a `seb` or `kiosk` session, a
 *   token: the 404 of a missing set (or the session guard's 401);
 * - the student view, the module's one exit (N-SEC-20): searched in every
 *   response to a student, an impersonation and a teacher in the student
 *   view for a second classroom's set, a closed set no project names,
 *   another group's members after closing, e-mails, GitHub logins and
 *   roster line ids;
 * - the hints: the classroom's claimed students' `user:` topics while the
 *   set reaches them, never `classroom:`;
 * - a draft project's copy stepped by a student's join; the Activities row
 *   and the Groups tab (`hasGroups`).
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CSRF_COOKIE,
  defaultProjectGradingScale,
  GroupErrorCode,
  GroupSetDetail,
  GroupSetSummary,
  StudentClassroomPage,
  StudentGroupSets,
  StudentHome,
  type SessionKind,
} from "@quiz/contracts";

import { SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import {
  auditLog,
  classrooms,
  enrollments,
  githubAccounts,
  githubOrganizations,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
  users,
} from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { studentHome } from "../activity/service.js";

type Headers = Record<string, string>;
type Who = { id: string; headers: Headers };
type Res = { statusCode: number; body: string; json: () => unknown };
let server: TestServer;
let teacher: Who;

const NOW = "2026-10-05T10:00:00.000Z";
const LATER = "2026-10-08T22:00:00.000Z";

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
const staff = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) => call(method, url, teacher.headers, payload);
const refusal = (res: Res) => [res.statusCode, GroupErrorCode.parse((res.json() as { error: unknown }).error)];

/** Every body a student-side caller received: searched for what must never reach one. */
let studentBodies: string[] = [];

async function sessionOf(userId: string, auth: { kind: SessionKind; actorUserId?: string; evaluationId?: string }): Promise<Headers> {
  const s = await createSession(server.app.db, userId, 8, {
    kind: auth.kind,
    actorUserId: auth.actorUserId ?? null,
    evaluationId: auth.evaluationId ?? null,
    projectId: null,
  });
  return { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
}

interface Room {
  id: string;
  courseId: string;
  evaluationId: string;
  students: Who[];
  /** Each student's roster line, in the order of `students`. */
  lines: string[];
  names: string[];
  emails: string[];
  unclaimed: { id: string; name: string };
}

/** A classroom of `teacher`'s course: `n` claimed students named after `tag`, one unclaimed line, a staff seat for the teacher. */
async function classroom(tag: string, n = 4): Promise<Room> {
  const db = server.app.db;
  const students = await Promise.all(Array.from({ length: n }, () => server.signIn("student")));
  const seeded = await seedLive(db, { teacherId: teacher.id, studentIds: students.map((s) => s.id), questions: 0 });
  const lines: string[] = [];
  const names: string[] = [];
  const emails: string[] = [];
  for (const [i, s] of students.entries()) {
    const [line] = await db
      .update(enrollments)
      .set({ nom: `Nom${tag}${i}`, prenom: `Prenom${tag}${i}` })
      .where(and(eq(enrollments.classroomId, seeded.classroomId), eq(enrollments.userId, s.id)))
      .returning();
    lines.push(line!.id);
    names.push(`Nom${tag}${i}`);
    emails.push(line!.email);
  }
  const unclaimed = randomUUID();
  await db.insert(enrollments).values({ id: unclaimed, classroomId: seeded.classroomId, nom: `Libre${tag}`, prenom: "Zed", email: `libre-${tag}@heig.test` });
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: seeded.classroomId,
    nom: `Prof${tag}`,
    prenom: "Staff",
    email: `prof-${tag}-${randomUUID().slice(0, 6)}@heig.test`,
    userId: teacher.id,
    claimedAt: new Date(NOW),
    staff: true,
  });
  return {
    id: seeded.classroomId,
    courseId: seeded.courseId,
    evaluationId: seeded.evaluationId,
    students,
    lines,
    names,
    emails,
    unclaimed: { id: unclaimed, name: `Libre${tag}` },
  };
}

async function detailOk(res: Res): Promise<GroupSetDetail> {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return GroupSetDetail.parse(res.json());
}

/** A set of `room`, opened to its students until `LATER` with a maximum of `max` (null: left closed). */
async function newSet(room: Room, name: string, max: number | null = 2): Promise<GroupSetDetail> {
  const created = await detailOk(await staff("POST", `/app/api/classrooms/${room.id}/group-sets`, { name }));
  if (max === null) return created;
  return detailOk(await staff("PATCH", `/app/api/group-sets/${created.set.id}`, { maxSize: max, openUntil: LATER }));
}

/** A student-side answer, kept for the leak search. */
async function asStudent(res: Res, status = 200): Promise<Res> {
  studentBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(status);
  return res;
}
const view = async (room: Room, headers: Headers) =>
  StudentGroupSets.parse((await asStudent(await call("GET", `/app/api/classrooms/${room.id}/group-sets/student`, headers))).json()).sets;
const setOf = async (room: Room, headers: Headers, setId: string) => (await view(room, headers)).find((s) => s.set.id === setId);
const create = (setId: string, who: Who, payload: object = {}) => call("POST", `/app/api/group-sets/${setId}/student/groups`, who.headers, payload);
const join = (setId: string, who: Who, groupId: string) => call("PUT", `/app/api/group-sets/${setId}/student/membership`, who.headers, { groupId });
const leave = (setId: string, who: Who) => call("DELETE", `/app/api/group-sets/${setId}/student/membership`, who.headers);
const rename = (setId: string, who: Who, groupId: string, name: string) =>
  call("PATCH", `/app/api/group-sets/${setId}/student/groups/${groupId}`, who.headers, { name });
/** A write's answer (the classroom's sets as the writer reads them): set `setId` of it. */
const answer = async (res: Res, setId: string, status = 200) => {
  const list = StudentGroupSets.parse((await asStudent(res, status)).json());
  expect(Date.parse(list.serverNow)).toBe(server.clock.now().getTime());
  return list.sets.find((s) => s.set.id === setId)!;
};

/** A project row of `room` naming `setId` (the project module's routes are not registered here). */
async function projectNaming(room: Room, setId: string, opts: { state?: "draft" | "published" | "locked"; stopped?: boolean; archived?: boolean } = {}) {
  const db = server.app.db;
  const orgId = randomUUID();
  const n = Math.floor(Math.random() * 1e9);
  await db.insert(githubOrganizations).values({ id: orgId, login: `org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId: room.id,
    orgId,
    name: `Lab ${n}`,
    slug: `lab-${n}`,
    startAt: new Date(NOW),
    deadlineAt: new Date(LATER),
    sourceRepoId: n,
    sourceFullName: `org-${n}/lab`,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    groupMode: true,
    groupSetId: setId,
    state: opts.state ?? "published",
    archivedAt: opts.archived ? new Date(NOW) : null,
    groupsStoppedAt: opts.stopped ? new Date(NOW) : null,
    createdBy: teacher.id,
  });
  return id;
}

/** A repository on a copy group of `projectId`: the set's groups freeze for its students. */
async function repoIn(projectId: string, userId: string, stopped = false) {
  const db = server.app.db;
  const groupId = randomUUID();
  await db.insert(projectGroups).values({ id: groupId, projectId, name: "Copy", slug: `copy-${groupId.slice(0, 6)}`, position: 0, stoppedAt: stopped ? new Date(NOW) : null });
  await db.insert(projectRepos).values({
    id: randomUUID(),
    projectId,
    userId,
    groupId,
    githubRepoId: Math.floor(Math.random() * 1e9),
    fullName: `org/copy-${groupId.slice(0, 6)}`,
    provisionStatus: "ok",
    acceptedAt: new Date(NOW),
  });
}

beforeAll(async () => {
  server = await testServer({ AUTH_DEV_LOGIN: "1" });
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
  studentBodies = [];
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------- the staff open a set

describe("the staff open a set to its students (F-PROJ-22)", () => {
  it("opens with a maximum size until a date, closes, reopens; an archived classroom's set stays closed", async () => {
    const room = await classroom("O");
    const created = await detailOk(await staff("POST", `/app/api/classrooms/${room.id}/group-sets`, { name: "Labo" }));
    const id = created.set.id;
    expect(created.set).toMatchObject({ openUntil: null, open: false });

    expect(refusal(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: LATER }))).toEqual([422, "max_size_required"]);
    const opened = await detailOk(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: LATER, maxSize: 3 }));
    expect(opened.set).toMatchObject({ openUntil: LATER, open: true, maxSize: 3 });
    const list = GroupSetSummary.array().parse((await staff("GET", `/app/api/classrooms/${room.id}/group-sets`)).json());
    expect(list[0]).toMatchObject({ openUntil: LATER, open: true });
    // Clearing the maximum while open: refused; a date already past leaves it closed.
    expect(refusal(await staff("PATCH", `/app/api/group-sets/${id}`, { maxSize: null }))).toEqual([422, "max_size_required"]);
    const past = await detailOk(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: "2026-10-01T00:00:00.000Z", maxSize: null }));
    expect(past.set).toMatchObject({ open: false, maxSize: null });
    const reopened = await detailOk(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: LATER, maxSize: 2 }));
    expect(reopened.set.open).toBe(true);
    const closed = await detailOk(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: null }));
    expect(closed.set).toMatchObject({ openUntil: null, open: false, maxSize: 2 });
    // A duplicate is born closed.
    const copy = await detailOk(await staff("POST", `/app/api/group-sets/${reopened.set.id}/duplicate`));
    expect(copy.set.open).toBe(false);

    await server.app.db.update(classrooms).set({ archivedAt: new Date(NOW) }).where(eq(classrooms.id, room.id));
    expect(refusal(await staff("PATCH", `/app/api/group-sets/${id}`, { openUntil: LATER }))).toEqual([409, "classroom_archived"]);
    const audits = await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, id)).orderBy(auditLog.id);
    expect(audits.filter((a) => a.action === "group_set.update").map((a) => (a.payload as { openUntil?: unknown }).openUntil)).toEqual([
      LATER,
      "2026-10-01T00:00:00.000Z",
      LATER,
      null,
    ]);
  });
});

// ---------------------------------------------------------------- a student forms a group

describe("a student forms their group (F-PROJ-22)", () => {
  it("creates (moved in), joins below the maximum, leaves, renames their own; each audited as theirs", async () => {
    const room = await classroom("F");
    const [ana, ben, cleo, dan] = room.students as [Who, Who, Who, Who];
    await server.app.db.update(users).set({ locale: "fr" }).where(eq(users.id, dan.id));
    const set = await newSet(room, "Projet", 2);
    const id = set.set.id;

    const first = await answer(await create(id, ana), id, 201);
    const g1 = first.groups.find((g) => g.name === "Group 1")!;
    expect(first).toMatchObject({ writable: true, myGroupId: g1.id, set: { open: true, maxSize: 2 } });
    expect(g1.members).toEqual([{ nom: room.names[0], prenom: "PrenomF0" }]);
    expect(first.unplaced!.map((s) => s.nom)).toEqual([...room.names.slice(1), room.unclaimed.name].sort());

    const second = await answer(await join(id, ben, g1.id), id);
    expect(second.groups[0]).toMatchObject({ id: g1.id, size: 2 });
    expect(refusal(await join(id, cleo, g1.id))).toEqual([409, "group_full"]);

    // Named by the student, in French by default.
    const fr = await answer(await create(id, dan), id, 201);
    expect(fr.groups.map((g) => g.name)).toEqual(["Group 1", "Groupe 1"]);
    const named = await answer(await create(id, cleo, { name: "Les As" }), id, 201);
    expect(named.groups.map((g) => g.name)).toEqual(["Group 1", "Groupe 1", "Les As"]);
    expect(refusal(await create(id, ben, { name: "Les As" }))).toEqual([409, "duplicate_name"]);

    expect((await answer(await leave(id, ben), id)).myGroupId).toBeNull();
    expect((await answer(await leave(id, ben), id)).myGroupId).toBeNull(); // nothing to leave: unchanged
    // Only their own group is theirs to rename.
    expect((await rename(id, ben, g1.id, "Volé")).statusCode).toBe(404);
    expect(refusal(await rename(id, ana, g1.id, "Les As"))).toEqual([409, "duplicate_name"]);
    const renamed = await answer(await rename(id, ana, g1.id, "Alpha"), id);
    expect(renamed.groups.find((g) => g.id === g1.id)?.name).toBe("Alpha");
    // Ana leaves her group: emptied, it stays; she creates another one, moved out of nothing.
    const emptied = await answer(await leave(id, ana), id);
    expect(emptied.groups.find((g) => g.id === g1.id)).toMatchObject({ size: 0, members: [] });

    const audits = await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, id)).orderBy(auditLog.id);
    const byAna = audits.filter((a) => a.actorUserId === ana.id);
    expect(byAna.map((a) => a.action)).toEqual(["group.create", "group.rename", "group.member_move"]);
    for (const a of byAna) expect(a.payload).toMatchObject({ self: true, enrollmentId: room.lines[0] });
    expect(audits.filter((a) => a.actorUserId === ben.id).map((a) => a.action)).toEqual(["group.member_move", "group.member_move"]);

    // The staff see the students' groups, and keep every right: a group above the maximum stays, full to the students.
    const detail = await detailOk(await staff("GET", `/app/api/group-sets/${id}`));
    const alpha = detail.groups.find((g) => g.name === "Alpha")!;
    for (const line of room.lines.slice(0, 3)) await detailOk(await staff("PUT", `/app/api/group-sets/${id}/members/${line}`, { groupId: alpha.id }));
    expect(refusal(await join(id, dan, alpha.id))).toEqual([409, "group_full"]);
  });

  it("serialises two joins racing for a group's last seat: one in, one full", async () => {
    const room = await classroom("R");
    const [ana, ben, cleo] = room.students as [Who, Who, Who];
    const set = await newSet(room, "Course", 2);
    const g = (await answer(await create(set.set.id, ana), set.set.id, 201)).groups[0]!;
    const results = await Promise.all([join(set.set.id, ben, g.id), join(set.set.id, cleo, g.id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(GroupErrorCode.parse((results.find((r) => r.statusCode === 409)!.json() as { error: unknown }).error)).toBe("group_full");
    const detail = await detailOk(await staff("GET", `/app/api/group-sets/${set.set.id}`));
    expect(detail.groups[0]!.members).toHaveLength(2);
  });

  it("steps a draft project's copy with a student's write", async () => {
    const room = await classroom("D");
    const [ana] = room.students as [Who];
    const set = await newSet(room, "Brouillon", 3);
    const draft = await projectNaming(room, set.set.id, { state: "draft" });
    await answer(await create(set.set.id, ana, { name: "Équipe A" }), set.set.id, 201);
    const copy = await server.app.db.select().from(projectGroups).where(eq(projectGroups.projectId, draft));
    expect(copy.map((g) => g.name)).toEqual(["Équipe A"]);
    const members = await server.app.db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, draft));
    expect(members.map((m) => [m.groupId, m.enrollmentId])).toEqual([[copy[0]!.id, room.lines[0]]]);
  });
});

// ---------------------------------------------------------------- refusals

describe("what a student may not do (F-PROJ-22, invariant 6)", () => {
  it("refuses once the set is closed: no grace; a closed set no project names is the 404 of a missing one", async () => {
    const room = await classroom("C");
    const [ana, ben] = room.students as [Who, Who];
    const used = await newSet(room, "Utilisée", 2);
    const unused = await newSet(room, "Libre", 2);
    await projectNaming(room, used.set.id);
    const g = (await answer(await create(used.set.id, ana), used.set.id, 201)).groups[0]!;
    server.clock.set(LATER); // open_until reached exactly: closed
    expect(refusal(await join(used.set.id, ben, g.id))).toEqual([409, "set_closed"]);
    expect(refusal(await create(used.set.id, ben))).toEqual([409, "set_closed"]);
    expect(refusal(await leave(used.set.id, ana))).toEqual([409, "set_closed"]);
    expect((await create(unused.set.id, ben)).statusCode).toBe(404);
    const views = await view(room, ana.headers);
    expect(views.map((s) => s.set.id)).toEqual([used.set.id]);
    expect(views[0]).toMatchObject({ writable: false, myGroupId: g.id, set: { open: false } });
    expect(views[0]!.unplaced).toBeUndefined();
  });

  it("refuses a frozen set: a repository in any project's copy, a stopped one included; never needs_confirmation", async () => {
    for (const stopped of [false, true]) {
      const room = await classroom(stopped ? "S" : "Z");
      const [ana, ben] = room.students as [Who, Who];
      const set = await newSet(room, "Gelée", 3);
      const g = (await answer(await create(set.set.id, ana), set.set.id, 201)).groups[0]!;
      const project = await projectNaming(room, set.set.id, stopped ? { state: "locked", stopped: true, archived: true } : {});
      await repoIn(project, ana.id, stopped);
      expect(refusal(await join(set.set.id, ben, g.id))).toEqual([409, "set_frozen"]);
      expect(refusal(await leave(set.set.id, ana))).toEqual([409, "set_frozen"]);
      expect(refusal(await rename(set.set.id, ana, g.id, "Autre"))).toEqual([409, "set_frozen"]);
      expect(refusal(await create(set.set.id, ben))).toEqual([409, "set_frozen"]);
      expect(await setOf(room, ana.headers, set.set.id)).toMatchObject({ writable: false, set: { open: true } });
      // A frozen set invites nobody: no Activities row.
      const home = StudentHome.parse((await asStudent(await call("GET", "/app/api/student/home", ana.headers))).json());
      expect(home.groupSets).toEqual([]);
    }
  });

  it("refuses an archived classroom's set", async () => {
    const room = await classroom("A");
    const [ana] = room.students as [Who];
    const set = await newSet(room, "Archivée", 2);
    await projectNaming(room, set.set.id);
    await server.app.db.update(classrooms).set({ archivedAt: new Date(NOW) }).where(eq(classrooms.id, room.id));
    expect(refusal(await create(set.set.id, ana))).toEqual([409, "classroom_archived"]);
    expect(await setOf(room, ana.headers, set.set.id)).toMatchObject({ writable: false, set: { open: false } });
  });

  it("answers an impersonation, a teacher in the student view, a staff seat, a stranger, a token, a seb or kiosk session as nobody", async () => {
    const room = await classroom("I");
    const [ana] = room.students as [Who];
    const set = await newSet(room, "Ouverte", 2);
    const g = (await answer(await create(set.set.id, ana), set.set.id, 201)).groups[0]!;
    const admin = await server.signIn("admin");
    const stranger = await server.signIn("student");
    const impersonation = await sessionOf(ana.id, { kind: "impersonation", actorUserId: admin.id });
    const { token } = await createApiToken(server.app.db, ana.id, { name: "t", expiresInDays: null });
    const bearer = { authorization: `Bearer ${token}` };
    const seb = await sessionOf(ana.id, { kind: "seb", evaluationId: room.evaluationId });
    const kiosk = await sessionOf(ana.id, { kind: "kiosk", evaluationId: room.evaluationId });

    // Reads: the impersonation reads as Ana, the teacher in the student view as a student without a group, a token as Ana; none writes.
    expect(await setOf(room, impersonation, set.set.id)).toMatchObject({ writable: false, myGroupId: g.id });
    expect(await setOf(room, teacher.headers, set.set.id)).toMatchObject({ writable: false, myGroupId: null });
    expect(await setOf(room, bearer, set.set.id)).toMatchObject({ writable: false, myGroupId: g.id });
    expect((await call("GET", `/app/api/classrooms/${room.id}/group-sets/student`, stranger.headers)).statusCode).toBe(404);

    for (const [who, headers, status] of [
      ["impersonation (development)", impersonation, 404],
      ["teacher on a staff seat", teacher.headers, 404],
      ["stranger", stranger.headers, 404],
      ["token", bearer, 404],
      ["seb", seb, 401],
      ["kiosk", kiosk, 401],
    ] as const) {
      for (const res of [
        await call("POST", `/app/api/group-sets/${set.set.id}/student/groups`, headers, {}),
        await call("PUT", `/app/api/group-sets/${set.set.id}/student/membership`, headers, { groupId: g.id }),
        await call("DELETE", `/app/api/group-sets/${set.set.id}/student/membership`, headers),
        await call("PATCH", `/app/api/group-sets/${set.set.id}/student/groups/${g.id}`, headers, { name: "Pris" }),
      ]) {
        studentBodies.push(res.body);
        expect(res.statusCode, who).toBe(status);
      }
      if (status === 401) {
        expect((await call("GET", `/app/api/classrooms/${room.id}/group-sets/student`, headers)).statusCode, who).toBe(401);
      }
    }
    const detail = await detailOk(await staff("GET", `/app/api/group-sets/${set.set.id}`));
    expect(detail.groups.map((x) => [x.name, x.members.length])).toEqual([["Group 1", 1]]);
  });
});

describe("an impersonation outside development (ADR-034)", () => {
  it("is refused every write by the auth plugin, 403 impersonation_read_only, and reads read-only", async () => {
    const prod = await testServer();
    try {
      prod.clock.set(NOW);
      const db = prod.app.db;
      const prof = await prod.signIn("teacher");
      const ana = await prod.signIn("student");
      const admin = await prod.signIn("admin");
      const seeded = await seedLive(db, { teacherId: prof.id, studentIds: [ana.id], questions: 0 });
      const created = await prod.app.inject({ method: "POST", url: `/app/api/classrooms/${seeded.classroomId}/group-sets`, headers: prof.headers, payload: {} });
      const setId = GroupSetDetail.parse(created.json()).set.id;
      await prod.app.inject({ method: "PATCH", url: `/app/api/group-sets/${setId}`, headers: prof.headers, payload: { openUntil: LATER, maxSize: 2 } });
      const s = await createSession(db, ana.id, 8, { kind: "impersonation", actorUserId: admin.id, projectId: null, evaluationId: null });
      const impersonation = { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf };
      const write = await prod.app.inject({ method: "POST", url: `/app/api/group-sets/${setId}/student/groups`, headers: impersonation, payload: {} });
      expect([write.statusCode, (write.json() as { error: string }).error]).toEqual([403, "impersonation_read_only"]);
      const read = await prod.app.inject({ method: "GET", url: `/app/api/classrooms/${seeded.classroomId}/group-sets/student`, headers: impersonation });
      expect(StudentGroupSets.parse(read.json()).sets[0]).toMatchObject({ writable: false });
    } finally {
      await prod.close();
    }
  });
});

// ---------------------------------------------------------------- the student view

describe("the student view, the group module's one exit (N-SEC-20)", () => {
  it("never shows another classroom's set, a closed unused set, another group's members after closing, e-mails, logins, line ids", async () => {
    const room = await classroom("V");
    const other = await classroom("W");
    const [ana, ben, cleo] = room.students as [Who, Who, Who];
    await server.app.db.insert(githubAccounts).values({ userId: ben.id, githubUserId: 990_001, login: "ben-secret-login" });

    const unused = await newSet(room, "SecretUnusedSet", null);
    const unusedGroup = (await detailOk(await staff("POST", `/app/api/group-sets/${unused.set.id}/groups`, { name: "SecretUnusedGroup" }))).groups[0]!;
    await detailOk(await staff("PUT", `/app/api/group-sets/${unused.set.id}/members/${room.lines[1]}`, { groupId: unusedGroup.id }));
    await newSet(other, "SecretOtherClassroomSet", 2);
    const set = await newSet(room, "Projet final", 2);
    const mine = (await answer(await create(set.set.id, ana, { name: "Mine" }), set.set.id, 201)).groups[0]!;
    await answer(await create(set.set.id, ben, { name: "SecretOtherGroup" }), set.set.id, 201);
    await answer(await join(set.set.id, cleo, mine.id), set.set.id);

    // While open: every group and its members' names, the students in no group, nothing else.
    const open = (await setOf(room, ana.headers, set.set.id))!;
    expect(open.groups.map((g) => [g.name, g.size])).toEqual([["Mine", 2], ["SecretOtherGroup", 1]]);
    expect(open.unplaced!.map((s) => s.nom)).toEqual([room.names[3], room.unclaimed.name].sort());
    expect((await view(room, ana.headers)).map((s) => s.set.name)).toEqual(["Projet final"]);

    // Closed, and named by a published project: their own group alone.
    await detailOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}`, { openUntil: null }));
    await projectNaming(room, set.set.id);
    const admin = await server.signIn("admin");
    const impersonation = await sessionOf(ana.id, { kind: "impersonation", actorUserId: admin.id });
    const closedBodies: string[] = [];
    for (const headers of [ana.headers, impersonation, teacher.headers]) {
      const before = studentBodies.length;
      const sets = await view(room, headers);
      closedBodies.push(...studentBodies.slice(before));
      expect(sets.map((s) => s.set.name)).toEqual(["Projet final"]);
      expect(sets[0]!.unplaced).toBeUndefined();
    }
    const closed = (await setOf(room, ana.headers, set.set.id))!;
    expect(closed.groups).toEqual([{ id: mine.id, name: "Mine", size: 2, members: [{ nom: room.names[0], prenom: "PrenomV0" }, { nom: room.names[2], prenom: "PrenomV2" }] }]);
    expect((await setOf(room, teacher.headers, set.set.id))!.groups).toEqual([]);
    // Their pages too: the home and the classroom page.
    await asStudent(await call("GET", "/app/api/student/home", ana.headers));
    await asStudent(await call("GET", `/app/api/student/classrooms/${room.id}`, ana.headers));

    for (const body of closedBodies) {
      for (const secret of ["SecretOtherGroup", room.names[1]!, room.names[3]!, room.unclaimed.name]) expect(body).not.toContain(secret);
    }
    const lines = await server.app.db.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.classroomId, room.id));
    for (const body of studentBodies) {
      for (const secret of [
        "SecretUnusedSet",
        "SecretUnusedGroup",
        "SecretOtherClassroomSet",
        ...other.names,
        "ben-secret-login",
        "@heig.test",
        "claimed",
        "enrollmentId",
        "usedBy",
        ...lines.map((l) => l.id),
      ]) {
        expect(body).not.toContain(secret);
      }
    }
  });
});

// ---------------------------------------------------------------- hints

describe("the hints of a set (ADR-070 §9)", () => {
  it("go to the classroom's claimed students while the set reaches them, never to classroom:", async () => {
    const room = await classroom("H");
    const [ana] = room.students as [Who];
    const closed = await newSet(room, "Fermée", null);
    const set = await newSet(room, "Ouverte", 2);
    const capture = async (act: () => Promise<unknown>) => {
      const topics: string[] = [];
      const off = subscribe((e) => {
        if (e.kind === "hint" && e.type === "groups") topics.push(...e.topics);
      });
      await act();
      off();
      return topics;
    };
    const students = room.students.map((s) => `user:${s.id}`);
    const onJoin = await capture(() => create(set.set.id, ana));
    expect(onJoin).toEqual(expect.arrayContaining([`course:${room.courseId}`, ...students]));
    expect(onJoin).not.toContain(`user:${teacher.id}`);
    expect(onJoin.some((t) => t.startsWith("classroom:"))).toBe(false);
    // A set no student reads: the staff alone.
    expect(await capture(() => staff("POST", `/app/api/group-sets/${closed.set.id}/groups`, {}))).toEqual([`course:${room.courseId}`]);
    // Closing an open set: the students re-read (it leaves their tab).
    expect(await capture(() => staff("PATCH", `/app/api/group-sets/${set.set.id}`, { openUntil: null }))).toEqual(
      expect.arrayContaining(students),
    );
  });
});

// ---------------------------------------------------------------- Activities and the tab

describe("the Activities row and the Groups tab (S1, S3)", () => {
  it("lists an open set in Open now and draws the tab; a closed set a project names keeps the tab, not the row", async () => {
    const room = await classroom("T");
    const [ana] = room.students as [Who];
    const page = async () => StudentClassroomPage.parse((await asStudent(await call("GET", `/app/api/student/classrooms/${room.id}`, ana.headers))).json());
    expect(await page()).toMatchObject({ hasGroups: false, activities: { groupSets: [] } });

    const set = await newSet(room, "Semestre", 3);
    await answer(await create(set.set.id, ana, { name: "Nous" }), set.set.id, 201);
    const card = { id: set.set.id, classroomId: room.id, name: "Semestre", openUntil: LATER, myGroup: "Nous" };
    expect(await page()).toMatchObject({ hasGroups: true, activities: { groupSets: [card] } });
    const home = StudentHome.parse((await asStudent(await call("GET", "/app/api/student/home", ana.headers))).json());
    expect(home.groupSets).toEqual([expect.objectContaining(card)]);
    // A teacher in the student view, on their staff seat (ADR-018), forms no group: no row.
    const asTeacher = StudentClassroomPage.parse((await asStudent(await call("GET", `/app/api/student/classrooms/${room.id}`, teacher.headers))).json());
    expect(asTeacher).toMatchObject({ hasGroups: true, activities: { groupSets: [] } });

    // A confined session's home lists no set (its exam leads nowhere else).
    const caller = { id: ana.id, role: "student" as const, reach: "seats" as const };
    const confined = await studentHome(server.app.db, caller, { kind: "seb", actorUserId: null, projectId: null, evaluationId: room.evaluationId }, server.clock.now());
    expect(confined.groupSets).toEqual([]);

    await detailOk(await staff("PATCH", `/app/api/group-sets/${set.set.id}`, { openUntil: null }));
    expect(await page()).toMatchObject({ hasGroups: false, activities: { groupSets: [] } });
    await projectNaming(room, set.set.id);
    expect(await page()).toMatchObject({ hasGroups: true, activities: { groupSets: [] } });
  });
});
