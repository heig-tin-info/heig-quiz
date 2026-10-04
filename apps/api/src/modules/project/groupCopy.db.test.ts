/**
 * A group project's copy of its group set (ADR-070 §4, §7; merge task
 * M3-15a), on a server built with Quiz's App; the project rows are written
 * as a built draft, the sets through their routes:
 *
 * - the draft's PATCH names a set (the copy made), another (replaced), none
 *   or leaves group mode (deleted); `unknown_group_set`, the 400 out of
 *   group mode, `not_draft` once published;
 * - publication: `no_group_set` by hand and by the ticker, the copy what
 *   `unassigned_students` reads;
 * - the copies of a draft and of a published project follow a move, a
 *   rename (a slug that clashes disambiguated), a new group, a deletion, a
 *   random formation, and a line turned staff seat;
 * - the copy stops at the deadline applied and at the archive, and follows
 *   again neither after a reopen nor after an unarchive;
 * - a student leaving the roster leaves every set and every copy.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultProjectGradingScale, GroupSetDetail, ProjectErrorCode, ProjectSummary } from "@quiz/contracts";

import { loadConfig } from "../../config.js";
import { auditLog, enrollments, githubOrganizations, projectGroupMembers, projectGroups, projects } from "../../db/schema.js";
import { appKey, fakeGithub, orgsRoute } from "../../github/testing.js";
import { testServer, type TestServer } from "../../test/http.js";
import { seedLive } from "../../test/live.js";
import { projectTick } from "./jobs.js";

const key = appKey();
const gh = fakeGithub();
const ENV = {
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_PATH: key.pem,
  GITHUB_APP_SLUG: "quiz-test",
  GITHUB_WEBHOOK_SECRET: "w".repeat(40),
};
const config = loadConfig({ NODE_ENV: "test", ...ENV });
const NOW = "2026-10-04T08:00:00.000Z";
const DEADLINE = "2026-10-09T22:00:00.000Z";

type Headers = Record<string, string>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
let server: TestServer;
let teacher: { id: string; headers: Headers };
let nextOrg = 52_000;

const call = (method: Method, url: string, payload?: object) =>
  server.app.inject({ method, url, headers: teacher.headers, ...(payload === undefined ? {} : { payload }) });
const refusal = (res: { statusCode: number; json: () => { error: unknown } }) => [res.statusCode, ProjectErrorCode.parse(res.json().error)];

interface Room {
  id: string;
  lines: string[];
}

/** A classroom of `teacher`'s course with `students` claimed students, in the roster's order. */
async function classroom(students = 4): Promise<Room> {
  const seeded = await seedLive(server.app.db, { teacherId: teacher.id, students, questions: 0 });
  const lines = await server.app.db.select().from(enrollments).where(eq(enrollments.classroomId, seeded.classroomId)).orderBy(enrollments.nom);
  return { id: seeded.classroomId, lines: lines.map((l) => l.id) };
}

/** A built draft of the classroom (as M3-02's creation leaves it), in group mode unless told otherwise. */
async function project(room: Room, over: Partial<typeof projects.$inferInsert> = {}): Promise<string> {
  const db = server.app.db;
  const n = nextOrg++;
  const orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `gorg-${n}`, githubOrgId: n, installationId: n });
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId: room.id,
    orgId,
    name: `Lab ${n}`,
    slug: `lab-${n}`,
    startAt: new Date(NOW),
    deadlineAt: new Date(DEADLINE),
    sourceRepoId: n,
    sourceFullName: `gorg-${n}/starter`,
    distributionRepoId: n + 1,
    distributionFullName: `gorg-${n}/lab-squashed`,
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    groupMode: true,
    createdBy: teacher.id,
    ...over,
  });
  return id;
}

async function ok(res: { statusCode: number; body: string; json: () => unknown }): Promise<GroupSetDetail> {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return GroupSetDetail.parse(res.json());
}

/**
 * A set of the room with `groups`: each a name and the indexes of the
 * room's lines in it.
 */
async function groupSet(room: Room, groups: [string, number[]][]): Promise<GroupSetDetail> {
  let detail = await ok(await call("POST", `/app/api/classrooms/${room.id}/group-sets`, {}));
  for (const [name, members] of groups) {
    detail = await ok(await call("POST", `/app/api/group-sets/${detail.set.id}/groups`, { name }));
    const group = detail.groups.find((g) => g.name === name)!;
    for (const i of members) detail = await ok(await call("PUT", `/app/api/group-sets/${detail.set.id}/members/${room.lines[i]}`, { groupId: group.id }));
  }
  return detail;
}

const patch = (projectId: string, body: object) => call("PATCH", `/app/api/projects/${projectId}`, body);
const publish = (projectId: string) => call("POST", `/app/api/projects/${projectId}/publish`);

/** The project's copy: its groups in order, each with its name, slug, source and members (line indexes). */
async function copyOf(projectId: string, room: Room) {
  const db = server.app.db;
  const groups = await db.select().from(projectGroups).where(eq(projectGroups.projectId, projectId)).orderBy(asc(projectGroups.position));
  const members = await db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, projectId));
  return groups.map((g) => ({
    name: g.name,
    slug: g.slug,
    source: g.sourceGroupId,
    members: members
      .filter((m) => m.groupId === g.id)
      .map((m) => room.lines.indexOf(m.enrollmentId))
      .sort(),
  }));
}

/** The set as its copies should read it. */
async function setOf(setId: string, room: Room) {
  const detail = GroupSetDetail.parse((await call("GET", `/app/api/group-sets/${setId}`)).json());
  return detail.groups.map((g) => ({ name: g.name, source: g.id, members: g.members.map((m) => room.lines.indexOf(m.enrollmentId)).sort() }));
}

const inStep = async (projectId: string, setId: string, room: Room) =>
  expect((await copyOf(projectId, room)).map(({ slug: _slug, ...g }) => g)).toEqual(await setOf(setId, room));

const lastCopies = async (setId: string) => {
  const rows = await server.app.db.select().from(auditLog).where(eq(auditLog.subjectId, setId)).orderBy(asc(auditLog.id));
  return [...((rows.at(-1)!.payload as { copies: string[] }).copies)].sort();
};

const tick = () => projectTick(server.app, config);

beforeAll(async () => {
  vi.stubGlobal("fetch", gh.fetch);
  server = await testServer(ENV);
  gh.routes = [orgsRoute(() => [])];
  teacher = await server.signIn("teacher");
});

beforeEach(() => {
  server.clock.set(NOW);
});

afterAll(async () => {
  await server.close();
  vi.unstubAllGlobals();
  key.remove();
});

describe("a draft names its group set (ADR-070 §4, §7)", () => {
  it("makes the copy, replaces it with another set's, and deletes it out of group mode", async () => {
    const room = await classroom(4);
    const a = await groupSet(room, [["Group 2!", [0, 1]], ["Group 2", [2]]]);
    const pid = await project(room);
    const named = await patch(pid, { groupSetId: a.set.id });
    expect(named.statusCode, named.body).toBe(200);
    expect(ProjectSummary.parse(named.json()).groupSetId).toBe(a.set.id);
    // A slug that clashes in the copy is disambiguated.
    expect(await copyOf(pid, room)).toEqual([
      { name: "Group 2!", slug: "group-2", source: a.groups[0]!.id, members: [0, 1] },
      { name: "Group 2", slug: "group-2-2", source: a.groups[1]!.id, members: [2] },
    ]);

    const b = await groupSet(room, [["Pandas", [0, 1, 2, 3]]]);
    expect((await patch(pid, { groupSetId: b.set.id })).statusCode).toBe(200);
    expect(await copyOf(pid, room)).toEqual([{ name: "Pandas", slug: "pandas", source: b.groups[0]!.id, members: [0, 1, 2, 3] }]);

    const off = await patch(pid, { groupMode: false });
    expect(ProjectSummary.parse(off.json())).toMatchObject({ groupMode: false, groupSetId: null });
    expect(await copyOf(pid, room)).toEqual([]);
    // Back in group mode, then a set named and taken away.
    expect((await patch(pid, { groupMode: true, groupSetId: a.set.id })).statusCode).toBe(200);
    expect(await copyOf(pid, room)).toHaveLength(2);
    expect((await patch(pid, { groupSetId: null })).statusCode).toBe(200);
    expect(await copyOf(pid, room)).toEqual([]);
  });

  it("refuses a set of another classroom, a set out of group mode, and any change once published", async () => {
    const room = await classroom(2);
    const set = await groupSet(room, [["A", [0, 1]]]);
    const foreign = await groupSet(await classroom(1), []);
    const pid = await project(room);
    expect(refusal(await patch(pid, { groupSetId: foreign.set.id }))).toEqual([422, "unknown_group_set"]);
    expect(refusal(await patch(pid, { groupSetId: randomUUID() }))).toEqual([422, "unknown_group_set"]);
    const solo = await project(room, { groupMode: false });
    const res = await patch(solo, { groupSetId: set.set.id });
    expect([res.statusCode, res.json().error]).toEqual([400, "validation"]);
    expect((await patch(solo, { groupMode: true, groupSetId: set.set.id })).statusCode).toBe(200);

    expect((await publish(solo)).statusCode).toBe(200);
    expect(refusal(await patch(solo, { groupSetId: null }))).toEqual([409, "not_draft"]);
    expect(refusal(await patch(solo, { groupMode: false }))).toEqual([409, "not_draft"]);
    // The form posts the whole of it: the same set is no change.
    expect((await patch(solo, { groupSetId: set.set.id, name: "Renamed" })).statusCode).toBe(200);
  });
});

describe("publication (ADR-070 §7)", () => {
  it("refuses a group project without a set by hand, and the ticker leaves it a draft; the copy is what the guard reads", async () => {
    const room = await classroom(3);
    const pid = await project(room, { publishMode: "scheduled", startAt: new Date("2026-10-04T07:00:00Z") });
    expect(refusal(await publish(pid))).toEqual([409, "no_group_set"]);
    await tick();
    const [draft] = await server.app.db.select().from(projects).where(eq(projects.id, pid));
    expect(draft!.state).toBe("draft");

    const set = await groupSet(room, [["A", [0, 1]]]);
    expect((await patch(pid, { groupSetId: set.set.id })).statusCode).toBe(200);
    const left = await publish(pid);
    expect(refusal(left)).toEqual([409, "unassigned_students"]);
    expect(left.json().students.map((s: { enrollmentId: string }) => s.enrollmentId)).toEqual([room.lines[2]]);
    // Placed in the set, the student reaches the copy; the ticker publishes.
    await ok(await call("PUT", `/app/api/group-sets/${set.set.id}/members/${room.lines[2]}`, { groupId: set.groups[0]!.id }));
    await tick();
    const [published] = await server.app.db.select().from(projects).where(eq(projects.id, pid));
    expect(published!.state).toBe("published");
  });
});

describe("the copies follow their set (ADR-070 §4)", () => {
  it("keeps a draft's copy and a published project's in step with every write of the set", async () => {
    const room = await classroom(6);
    const set = await groupSet(room, [["A", [0, 1, 2]], ["B", [3, 4, 5]]]);
    const draft = await project(room);
    const live = await project(room);
    for (const pid of [draft, live]) expect((await patch(pid, { groupSetId: set.set.id })).statusCode).toBe(200);
    expect((await publish(live)).statusCode).toBe(200);
    const both = [draft, live].sort();
    const setId = set.set.id;
    const [a, b] = set.groups;

    const writes: [Method, string, object | undefined][] = [
      // A move, a departure, a rename, a new group, a deletion, a random formation.
      ["PUT", `/app/api/group-sets/${setId}/members/${room.lines[0]}`, { groupId: b!.id }],
      ["PUT", `/app/api/group-sets/${setId}/members/${room.lines[1]}`, { groupId: null }],
      ["PATCH", `/app/api/group-sets/${setId}/groups/${a!.id}`, { name: "Les Pandas" }],
      ["POST", `/app/api/group-sets/${setId}/groups`, { name: "C" }],
      ["DELETE", `/app/api/group-sets/${setId}/groups/${b!.id}`, undefined],
      ["POST", `/app/api/group-sets/${setId}/random`, { size: 2, remainder: "larger" }],
    ];
    for (const [method, url, body] of writes) {
      await ok(await call(method, url, body));
      for (const pid of both) await inStep(pid, setId, room);
      expect(await lastCopies(setId), `${method} ${url}`).toEqual(both);
    }
    expect((await copyOf(live, room)).map((g) => g.slug)).toEqual(["les-pandas", "c", "group-1", "group-2"]);

    // A set write that changes nothing of the students' places names no copy.
    await ok(await call("PATCH", `/app/api/group-sets/${setId}`, { maxSize: 3 }));
    expect(await lastCopies(setId)).toEqual([]);

    // A placed line that becomes a staff seat leaves the copies at the next step.
    const [first] = (await setOf(setId, room)).filter((g) => g.members.length > 0);
    const turned = room.lines[first!.members[0]!]!;
    await server.app.db.update(enrollments).set({ staff: true }).where(eq(enrollments.id, turned));
    await ok(await call("POST", `/app/api/group-sets/${setId}/groups`, {}));
    for (const pid of both) {
      const rows = await server.app.db.select().from(projectGroupMembers).where(and(eq(projectGroupMembers.projectId, pid), eq(projectGroupMembers.enrollmentId, turned)));
      expect(rows).toEqual([]);
    }
  });

  it("stops a copy at the deadline applied and at the archive, for good", async () => {
    const room = await classroom(4);
    const set = await groupSet(room, [["A", [0, 1]], ["B", [2, 3]]]);
    const setId = set.set.id;
    const [a, b] = set.groups;
    const due = await project(room);
    const draft = await project(room);
    for (const pid of [due, draft]) expect((await patch(pid, { groupSetId: setId })).statusCode).toBe(200);
    expect((await publish(due)).statusCode).toBe(200);

    server.clock.set("2026-10-10T00:00:00Z");
    await tick();
    const [locked] = await server.app.db.select().from(projects).where(eq(projects.id, due));
    expect([locked!.state, locked!.groupsStoppedAt?.toISOString()]).toEqual(["locked", "2026-10-10T00:00:00.000Z"]);
    const frozen = await copyOf(due, room);
    await ok(await call("PUT", `/app/api/group-sets/${setId}/members/${room.lines[0]}`, { groupId: b!.id }));
    expect(await copyOf(due, room)).toEqual(frozen);
    await inStep(draft, setId, room);
    expect(await lastCopies(setId)).toEqual([draft]);

    // A reopen does not make it follow again (ADR-070 §4, alternative 5).
    const reopened = await patch(due, { deadlineAt: "2026-10-20T22:00:00Z" });
    expect(ProjectSummary.parse(reopened.json()).state).toBe("published");
    await ok(await call("PATCH", `/app/api/group-sets/${setId}/groups/${a!.id}`, { name: "Renamed" }));
    expect(await copyOf(due, room)).toEqual(frozen);
    const [still] = await server.app.db.select().from(projects).where(eq(projects.id, due));
    expect(still!.groupsStoppedAt?.toISOString()).toBe("2026-10-10T00:00:00.000Z");

    // The archive stops the draft's copy; an unarchive does not restart it.
    expect((await call("POST", `/app/api/projects/${draft}/archive`)).statusCode).toBe(200);
    expect((await call("POST", `/app/api/projects/${draft}/unarchive`)).statusCode).toBe(200);
    const kept = await copyOf(draft, room);
    await ok(await call("PUT", `/app/api/group-sets/${setId}/members/${room.lines[1]}`, { groupId: null }));
    expect(await copyOf(draft, room)).toEqual(kept);
    expect(await lastCopies(setId)).toEqual([]);

    // A deleted set group: the stopped copies keep theirs, without a source.
    await ok(await call("DELETE", `/app/api/group-sets/${setId}/groups/${b!.id}`));
    expect((await copyOf(due, room)).map((g) => [g.name, g.source])).toEqual([
      ["A", a!.id],
      ["B", null],
    ]);
    expect((await call("DELETE", `/app/api/group-sets/${setId}`)).statusCode).toBe(409);
  });

  it("takes a student who leaves the roster out of every set and every copy, stopped ones too", async () => {
    const room = await classroom(3);
    const set = await groupSet(room, [["A", [0, 1, 2]]]);
    const stopped = await project(room);
    expect((await patch(stopped, { groupSetId: set.set.id })).statusCode).toBe(200);
    await server.app.db.update(projects).set({ groupsStoppedAt: new Date(NOW) }).where(eq(projects.id, stopped));
    const res = await call("DELETE", `/app/api/classrooms/${room.id}/roster/${room.lines[1]}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await setOf(set.set.id, room))[0]!.members).toEqual([0, 2]);
    expect((await copyOf(stopped, room))[0]!.members).toEqual([0, 2]);
  });
});
