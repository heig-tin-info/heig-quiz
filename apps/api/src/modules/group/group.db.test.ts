/**
 * A classroom's group sets (ADR-070, merge task M3-15a), through their
 * routes, on a server built WITHOUT Quiz's App (the module needs none):
 *
 * - sets: the list and its counts, a creation named after now in the
 *   creator's language, a rename, a duplicate (staff seats left out), a
 *   deletion refused while a project that is not archived names the set;
 * - groups: "Group k" with the first free k, a name unique in its set, a
 *   rename, a deletion that leaves its students in no group;
 * - a student's place: in, moved, out; never a staff seat, never a line of
 *   another classroom, never a group of another set;
 * - the random formation: balanced, the groups already formed untouched,
 *   staff seats never drawn, `nobody_to_place`, `size_out_of_range`;
 * - an archived classroom's sets read-only (`409 classroom_archived` on
 *   every write, the reads served);
 * - who reaches a set: the course's staff, through their own portal
 *   session; anyone else gets the 404 of a missing one; every write audited.
 *
 * A project's copy of its set is `project/groupCopy.db.test.ts`'s.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale, GroupErrorCode, GroupSetDetail, GroupSetSummary } from "@quiz/contracts";

import { CSRF_COOKIE, SESSION_COOKIE, createSession } from "../../auth/session.js";
import { createApiToken } from "../../auth/tokens.js";
import { auditLog, classrooms, courseStaff, enrollments, githubOrganizations, groupSets, projects, users } from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";

type Headers = Record<string, string>;
type Who = { id: string; headers: Headers };
let server: TestServer;
let teacher: Who;
let francophone: Who;

const NOW = "2026-10-04T12:05:00.000Z";

const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, headers: Headers = teacher.headers, payload?: object) =>
  server.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });

const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, GroupErrorCode.parse(res.json().error)];

/** A classroom of `teacher`'s course (and `francophone`'s) with `students` claimed students. */
async function classroom(students = 4) {
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, students, questions: 0 });
  await server.app.db.insert(courseStaff).values({ courseId: seeded.courseId, userId: francophone.id });
  const lines = await server.app.db.select().from(enrollments).where(eq(enrollments.classroomId, seeded.classroomId)).orderBy(enrollments.nom);
  return { id: seeded.classroomId, courseId: seeded.courseId, lines: lines.map((l) => l.id) };
}

async function newSet(roomId: string, body: object = {}, headers = teacher.headers): Promise<GroupSetDetail> {
  const res = await call("POST", `/app/api/classrooms/${roomId}/group-sets`, headers, body);
  expect(res.statusCode, res.body).toBe(201);
  return GroupSetDetail.parse(res.json());
}

async function ok(res: { statusCode: number; body: string; json: () => unknown }): Promise<GroupSetDetail> {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return GroupSetDetail.parse(res.json());
}

const addGroup = async (setId: string, body: object = {}) => ok(await call("POST", `/app/api/group-sets/${setId}/groups`, teacher.headers, body));
const place = async (setId: string, eid: string, groupId: string | null) =>
  ok(await call("PUT", `/app/api/group-sets/${setId}/members/${eid}`, teacher.headers, { groupId }));
const auditOf = (subjectId: string) =>
  server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, subjectId)).orderBy(auditLog.id);

/** A project row naming `setId` (the project module's routes are not registered here). */
async function projectNaming(roomId: string, setId: string, archived = false): Promise<string> {
  const db = server.app.db;
  const orgId = randomUUID();
  const n = Math.floor(Math.random() * 1e9);
  await db.insert(githubOrganizations).values({ id: orgId, login: `org-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId: roomId,
    orgId,
    name: `Lab ${n}`,
    slug: `lab-${n}`,
    startAt: new Date(NOW),
    deadlineAt: new Date("2026-10-20T22:00:00Z"),
    sourceRepoId: n,
    sourceFullName: `org-${n}/lab`,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    groupMode: true,
    groupSetId: setId,
    archivedAt: archived ? new Date(NOW) : null,
    groupsStoppedAt: archived ? new Date(NOW) : null,
    createdBy: teacher.id,
  });
  return id;
}

beforeAll(async () => {
  server = await testServer();
  server.clock.set(NOW);
  teacher = await server.signIn("teacher");
  francophone = await server.signIn("teacher");
  await server.app.db.update(users).set({ locale: "fr" }).where(eq(users.id, francophone.id));
});

afterAll(async () => {
  await server.close();
});

// ---------------------------------------------------------------- sets

describe("a classroom's group sets (ADR-070 §2)", () => {
  it("creates a set named after now in the creator's language, lists it with its counts", async () => {
    const room = await classroom(3);
    expect((await call("GET", `/app/api/classrooms/${room.id}/group-sets`)).json()).toEqual([]);
    const en = await newSet(room.id);
    expect(en.set).toMatchObject({ name: "Groups of 2026-10-04 14:05", maxSize: null, readOnly: false, classroomId: room.id });
    expect(en.unplaced.map((s) => s.enrollmentId)).toEqual(room.lines);
    expect(en.unplaced[0]).toMatchObject({ claimed: true });
    const fr = await newSet(room.id, {}, francophone.headers);
    expect(fr.set.name).toBe("Groupes du 04.10.2026 14:05");
    const named = await newSet(room.id, { name: "Labo 1", maxSize: 3 });
    expect(named.set).toMatchObject({ name: "Labo 1", maxSize: 3 });

    const group = (await addGroup(named.set.id)).groups[0]!;
    await place(named.set.id, room.lines[0]!, group.id);
    const list = GroupSetSummary.array().parse((await call("GET", `/app/api/classrooms/${room.id}/group-sets`)).json());
    // Created at the same instant here: the oldest first, then by id.
    expect(list.map((s) => [s.name, s.groups, s.placed, s.unplaced]).sort()).toEqual([
      ["Groupes du 04.10.2026 14:05", 0, 0, 3],
      ["Groups of 2026-10-04 14:05", 0, 0, 3],
      ["Labo 1", 1, 1, 2],
    ]);
    expect((await auditOf(named.set.id)).map((a) => a.action)).toEqual(["group_set.create", "group.create", "group.member_move"]);
  });

  it("renames a set and changes its maximum size", async () => {
    const room = await classroom(1);
    const set = await newSet(room.id);
    const renamed = await ok(await call("PATCH", `/app/api/group-sets/${set.set.id}`, teacher.headers, { name: "Semestre", maxSize: 4 }));
    expect(renamed.set).toMatchObject({ name: "Semestre", maxSize: 4 });
    const cleared = await ok(await call("PATCH", `/app/api/group-sets/${set.set.id}`, teacher.headers, { maxSize: null }));
    expect(cleared.set.maxSize).toBeNull();
    for (const body of [{}, { name: "!!!" }, { maxSize: 0 }, { other: 1 }]) {
      expect((await call("PATCH", `/app/api/group-sets/${set.set.id}`, teacher.headers, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("duplicates a set with its groups and members, staff seats left out", async () => {
    const room = await classroom(2);
    const set = await newSet(room.id, { name: "Labo", maxSize: 2 });
    const [g1] = (await addGroup(set.set.id, { name: "Pandas" })).groups;
    await place(set.set.id, room.lines[0]!, g1!.id);
    await place(set.set.id, room.lines[1]!, g1!.id);
    // The second line becomes a staff seat (a teacher's self-enroll, ADR-018).
    await server.app.db.update(enrollments).set({ staff: true }).where(eq(enrollments.id, room.lines[1]!));
    const res = await call("POST", `/app/api/group-sets/${set.set.id}/duplicate`, francophone.headers);
    expect(res.statusCode, res.body).toBe(201);
    const copy = GroupSetDetail.parse(res.json());
    expect(copy.set).toMatchObject({ name: "Labo (copie)", maxSize: 2 });
    expect(copy.set.id).not.toBe(set.set.id);
    expect(copy.groups.map((g) => [g.name, g.members.map((m) => m.enrollmentId)])).toEqual([["Pandas", [room.lines[0]]]]);
    expect(copy.groups[0]!.id).not.toBe(g1!.id);
    // The staff seat is no student of either set.
    const original = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${set.set.id}`)).json());
    expect(original.groups[0]!.members.map((m) => m.enrollmentId)).toEqual([room.lines[0]]);
    expect(original.unplaced).toEqual([]);
    expect((await auditOf(copy.set.id)).map((a) => [a.action, (a.payload as { from: string }).from])).toEqual([["group_set.duplicate", set.set.id]]);
  });

  it("refuses to delete a set a project that is not archived names, and deletes one only archived projects name", async () => {
    const room = await classroom(1);
    const set = await newSet(room.id);
    const live = await projectNaming(room.id, set.set.id);
    const old = await projectNaming(room.id, set.set.id, true);
    const detail = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${set.set.id}`)).json());
    expect(detail.usedBy.map((u) => [u.id, u.archived, u.follows])).toEqual([
      [live, false, true],
      [old, true, false],
    ]);
    const refused = await call("DELETE", `/app/api/group-sets/${set.set.id}`);
    expect(refusal(refused)).toEqual([409, "set_in_use"]);
    expect(refused.json().projects).toEqual([{ id: live, name: expect.any(String) }]);

    await server.app.db.update(projects).set({ archivedAt: new Date(NOW) }).where(eq(projects.id, live));
    expect((await call("DELETE", `/app/api/group-sets/${set.set.id}`)).statusCode).toBe(204);
    expect((await call("GET", `/app/api/group-sets/${set.set.id}`)).statusCode).toBe(404);
    const [row] = await server.app.db.select().from(projects).where(eq(projects.id, old));
    expect(row!.groupSetId).toBeNull();
    expect((await auditOf(set.set.id)).map((a) => a.action)).toContain("group_set.delete");
  });
});

// ---------------------------------------------------------------- groups and places

describe("groups by hand (ADR-070 §3)", () => {
  it("names a group with the first free k, refuses a name taken in the set, renames and deletes", async () => {
    const room = await classroom(2);
    const set = await newSet(room.id);
    await addGroup(set.set.id);
    let detail = await addGroup(set.set.id);
    expect(detail.groups.map((g) => [g.name, g.position])).toEqual([["Group 1", 0], ["Group 2", 1]]);
    const [g1, g2] = detail.groups;
    expect(refusal(await call("POST", `/app/api/group-sets/${set.set.id}/groups`, teacher.headers, { name: "Group 2" }))).toEqual([409, "duplicate_name"]);
    expect(refusal(await call("PATCH", `/app/api/group-sets/${set.set.id}/groups/${g1!.id}`, teacher.headers, { name: "Group 2" }))).toEqual([
      409,
      "duplicate_name",
    ]);
    detail = await ok(await call("PATCH", `/app/api/group-sets/${set.set.id}/groups/${g1!.id}`, teacher.headers, { name: "Les Pandas" }));
    expect(detail.groups.map((g) => g.name)).toEqual(["Les Pandas", "Group 2"]);
    // "Group 1" is free again.
    detail = await addGroup(set.set.id);
    expect(detail.groups.map((g) => [g.name, g.position])).toEqual([["Les Pandas", 0], ["Group 2", 1], ["Group 1", 2]]);

    await place(set.set.id, room.lines[0]!, g2!.id);
    detail = await ok(await call("DELETE", `/app/api/group-sets/${set.set.id}/groups/${g2!.id}`));
    expect(detail.groups.map((g) => g.name)).toEqual(["Les Pandas", "Group 1"]);
    expect(detail.unplaced.map((s) => s.enrollmentId)).toEqual(room.lines);
    expect((await auditOf(set.set.id)).map((a) => a.action)).toEqual([
      "group_set.create",
      "group.create",
      "group.create",
      "group.rename",
      "group.create",
      "group.member_move",
      "group.delete",
    ]);
  });

  it("places, moves and takes a student out, idempotently", async () => {
    const room = await classroom(2);
    const set = await newSet(room.id);
    await addGroup(set.set.id);
    const [g1, g2] = (await addGroup(set.set.id)).groups;
    const eid = room.lines[0]!;
    let detail = await place(set.set.id, eid, g1!.id);
    expect(detail.groups[0]!.members.map((m) => m.enrollmentId)).toEqual([eid]);
    detail = await place(set.set.id, eid, g2!.id);
    expect(detail.groups.map((g) => g.members.length)).toEqual([0, 1]);
    await place(set.set.id, eid, g2!.id);
    detail = await place(set.set.id, eid, null);
    expect(detail.unplaced.map((s) => s.enrollmentId)).toEqual(room.lines);
    const moves = (await auditOf(set.set.id)).filter((a) => a.action === "group.member_move").map((a) => a.payload);
    expect(moves).toEqual([
      { enrollmentId: eid, from: null, to: g1!.id, copies: [], deferred: [] },
      { enrollmentId: eid, from: g1!.id, to: g2!.id, copies: [], deferred: [] },
      { enrollmentId: eid, from: g2!.id, to: null, copies: [], deferred: [] },
    ]);
  });

  it("never places a staff seat, a line of another classroom, nor into a group of another set", async () => {
    const room = await classroom(1);
    const set = await newSet(room.id);
    const [group] = (await addGroup(set.set.id)).groups;
    const seat = randomUUID();
    await server.app.db.insert(enrollments).values({
      id: seat,
      classroomId: room.id,
      nom: "Prof",
      prenom: "T",
      email: `t-${seat}@x`,
      userId: teacher.id,
      claimedAt: new Date(),
      staff: true,
    });
    const unclaimed = randomUUID();
    await server.app.db.insert(enrollments).values({ id: unclaimed, classroomId: room.id, nom: "Zed", prenom: "Later", email: `l-${unclaimed}@x` });
    const elsewhere = (await classroom(1)).lines[0]!;
    const otherSet = await newSet(room.id);
    const [foreign] = (await addGroup(otherSet.set.id)).groups;

    const detail = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${set.set.id}`)).json());
    expect(detail.unplaced.map((s) => [s.enrollmentId, s.claimed])).toEqual([
      [room.lines[0], true],
      [unclaimed, false],
    ]);
    for (const [eid, groupId] of [
      [seat, group!.id],
      [elsewhere, group!.id],
      [room.lines[0]!, foreign!.id],
      [randomUUID(), group!.id],
    ]) {
      const res = await call("PUT", `/app/api/group-sets/${set.set.id}/members/${eid}`, teacher.headers, { groupId });
      expect([res.statusCode, res.json().error]).toEqual([404, "not_found"]);
    }
    for (const [method, url] of [
      ["PATCH", `/app/api/group-sets/${set.set.id}/groups/${foreign!.id}`],
      ["DELETE", `/app/api/group-sets/${set.set.id}/groups/${foreign!.id}`],
    ] as const) {
      expect((await call(method, url, teacher.headers, method === "PATCH" ? { name: "X" } : undefined)).statusCode).toBe(404);
    }
    // An unclaimed line is placed like any student.
    expect((await place(set.set.id, unclaimed, group!.id)).groups[0]!.members.map((m) => m.claimed)).toEqual([false]);
  });
});

describe("the random formation (ADR-070 §3)", () => {
  it("cuts the students in no group into balanced new groups, never touching the formed ones nor drawing a staff seat", async () => {
    const room = await classroom(8);
    const set = await newSet(room.id);
    const [formed] = (await addGroup(set.set.id, { name: "Formed" })).groups;
    await place(set.set.id, room.lines[0]!, formed!.id);
    // A placed line turned staff: neither counted nor drawn.
    await server.app.db.update(enrollments).set({ staff: true }).where(eq(enrollments.id, room.lines[7]!));
    // 6 students left, by 4 with the remainder in larger groups: one group of 6.
    const res = await call("POST", `/app/api/group-sets/${set.set.id}/random`, teacher.headers, { size: 4, remainder: "larger" });
    let detail = await ok(res);
    expect(detail.groups.map((g) => [g.name, g.members.length])).toEqual([["Formed", 1], ["Group 1", 6]]);
    expect(detail.groups[0]!.members.map((m) => m.enrollmentId)).toEqual([room.lines[0]]);
    expect(new Set(detail.groups.flatMap((g) => g.members.map((m) => m.enrollmentId)))).toEqual(new Set(room.lines.slice(0, 7)));
    expect(detail.unplaced).toEqual([]);
    expect(refusal(await call("POST", `/app/api/group-sets/${set.set.id}/random`, teacher.headers, { size: 2, remainder: "smaller" }))).toEqual([
      409,
      "nobody_to_place",
    ]);

    // The group of 6 broken up: by 4, the remainder in smaller groups — 3 and 3.
    detail = await ok(await call("DELETE", `/app/api/group-sets/${set.set.id}/groups/${detail.groups[1]!.id}`));
    expect(refusal(await call("POST", `/app/api/group-sets/${set.set.id}/random`, teacher.headers, { size: 7, remainder: "smaller" }))).toEqual([
      422,
      "size_out_of_range",
    ]);
    detail = await ok(await call("POST", `/app/api/group-sets/${set.set.id}/random`, teacher.headers, { size: 4, remainder: "smaller" }));
    expect(detail.groups.map((g) => [g.name, g.members.length])).toEqual([["Formed", 1], ["Group 1", 3], ["Group 2", 3]]);
    const [entry] = (await auditOf(set.set.id)).filter((a) => a.action === "group.random_form").slice(-1);
    expect(entry!.payload).toMatchObject({ size: 4, remainder: "smaller", placed: 6, copies: [] });
    for (const body of [{ size: 0, remainder: "smaller" }, { size: 2, remainder: "even" }, { size: 2 }]) {
      expect((await call("POST", `/app/api/group-sets/${set.set.id}/random`, teacher.headers, body)).statusCode).toBe(400);
    }
  });
});

// ---------------------------------------------------------------- archived, access

describe("an archived classroom's sets (ADR-070 §2)", () => {
  it("serves the reads and refuses every write with classroom_archived", async () => {
    const room = await classroom(1);
    const set = await newSet(room.id);
    const [group] = (await addGroup(set.set.id)).groups;
    await server.app.db.update(classrooms).set({ archivedAt: new Date(NOW) }).where(eq(classrooms.id, room.id));
    const detail = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${set.set.id}`)).json());
    expect(detail.set.readOnly).toBe(true);
    expect((await call("GET", `/app/api/classrooms/${room.id}/group-sets`)).statusCode).toBe(200);
    const writes: [("POST" | "PATCH" | "PUT" | "DELETE"), string, object | undefined][] = [
      ["POST", `/app/api/classrooms/${room.id}/group-sets`, {}],
      ["PATCH", `/app/api/group-sets/${set.set.id}`, { name: "X" }],
      ["POST", `/app/api/group-sets/${set.set.id}/duplicate`, undefined],
      ["DELETE", `/app/api/group-sets/${set.set.id}`, undefined],
      ["POST", `/app/api/group-sets/${set.set.id}/groups`, {}],
      ["PATCH", `/app/api/group-sets/${set.set.id}/groups/${group!.id}`, { name: "Y" }],
      ["DELETE", `/app/api/group-sets/${set.set.id}/groups/${group!.id}`, undefined],
      ["PUT", `/app/api/group-sets/${set.set.id}/members/${room.lines[0]}`, { groupId: group!.id }],
      ["POST", `/app/api/group-sets/${set.set.id}/random`, { size: 1, remainder: "smaller" }],
    ];
    for (const [method, url, body] of writes) {
      expect(refusal(await call(method, url, teacher.headers, body)), `${method} ${url}`).toEqual([409, "classroom_archived"]);
    }
    expect((await server.app.db.select().from(groupSets).where(eq(groupSets.classroomId, room.id))).map((s) => s.name)).toEqual([set.set.name]);
  });
});

describe("staff only (invariant 6)", () => {
  it("answers a student, another teacher, an impersonation and a token as nobody", async () => {
    const room = await classroom(1);
    const set = await newSet(room.id);
    const [group] = (await addGroup(set.set.id)).groups;
    const [line] = await server.app.db.select().from(enrollments).where(and(eq(enrollments.classroomId, room.id)));
    const [student] = await server.app.db.select().from(users).where(eq(users.id, line!.userId!));
    const studentSession = await createSession(server.app.db, student!.id, 8);
    const stranger = await server.signIn("teacher");
    const { token } = await createApiToken(server.app.db, teacher.id, { name: "t", expiresInDays: null });
    const s = await createSession(server.app.db, teacher.id, 8, {
      kind: "impersonation",
      actorUserId: (await server.signIn("admin")).id,
      evaluationId: null,
      projectId: null,
    });
    const callers: [string, Headers][] = [
      ["student", { cookie: `${SESSION_COOKIE}=${studentSession.token}; ${CSRF_COOKIE}=${studentSession.csrf}`, "x-csrf-token": studentSession.csrf }],
      ["stranger", stranger.headers],
      ["impersonation", { cookie: `${SESSION_COOKIE}=${s.token}; ${CSRF_COOKIE}=${s.csrf}`, "x-csrf-token": s.csrf }],
      ["token", { authorization: `Bearer ${token}` }],
    ];
    const urls: ["GET" | "POST" | "PATCH" | "PUT" | "DELETE", string, object | undefined][] = [
      ["GET", `/app/api/classrooms/${room.id}/group-sets`, undefined],
      ["POST", `/app/api/classrooms/${room.id}/group-sets`, {}],
      ["GET", `/app/api/group-sets/${set.set.id}`, undefined],
      ["PATCH", `/app/api/group-sets/${set.set.id}`, { name: "X" }],
      ["DELETE", `/app/api/group-sets/${set.set.id}`, undefined],
      ["POST", `/app/api/group-sets/${set.set.id}/duplicate`, undefined],
      ["POST", `/app/api/group-sets/${set.set.id}/groups`, {}],
      ["PATCH", `/app/api/group-sets/${set.set.id}/groups/${group!.id}`, { name: "Y" }],
      ["DELETE", `/app/api/group-sets/${set.set.id}/groups/${group!.id}`, undefined],
      ["PUT", `/app/api/group-sets/${set.set.id}/members/${line!.id}`, { groupId: group!.id }],
      ["POST", `/app/api/group-sets/${set.set.id}/random`, { size: 1, remainder: "smaller" }],
    ];
    for (const [method, url, body] of urls) {
      for (const [who, headers] of callers) {
        const res = await call(method, url, headers, body);
        // An impersonation writes nothing anywhere (ADR-034), before any loader.
        const expected = who === "impersonation" && method !== "GET" ? [403, "impersonation_read_only"] : [404, "not_found"];
        expect([res.statusCode, res.json().error], `${who} ${method} ${url}`).toEqual(expected);
      }
    }
    const after = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${set.set.id}`)).json());
    expect([after.set.name, after.groups.length, after.groups[0]!.members]).toEqual([set.set.name, 1, []]);
  });
});
