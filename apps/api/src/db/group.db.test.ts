/**
 * The `group` module's tables (`db/group.ts`, migration `0063_group_sets`)
 * against the real migrations (ADR-070): a student in at most one group of
 * a set, a member's group always of its set, the names unique in a set,
 * and the cascades — a classroom takes its sets, a roster line leaves every
 * set and every copy, a set group deleted leaves its copies without a
 * source, a set deleted leaves its projects without one.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import type { Db } from "./client.js";
import {
  classrooms,
  courses,
  enrollments,
  githubOrganizations,
  groupSets,
  projectGroupMembers,
  projectGroups,
  projects,
  studentGroupMembers,
  studentGroups,
  users,
} from "./schema.js";
import { testDb } from "../test/db.js";

const NOW = new Date("2026-10-04T08:00:00Z");

let db: Db;
let teacherId: string;
let courseId: string;
let orgId: string;

beforeAll(async () => {
  db = await testDb();
  teacherId = randomUUID();
  await db.insert(users).values({ id: teacherId, oidcSub: `sub-${teacherId}`, email: `${teacherId}@heig-vd.ch` });
  courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation 1", code: "PRG1" });
  orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: "heig-prg1", githubOrgId: 77, installationId: 88 });
});

async function classroom(): Promise<string> {
  const id = randomUUID();
  await db.insert(classrooms).values({ id, courseId, name: `C-${id.slice(0, 8)}` });
  return id;
}

async function enrollment(classroomId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(enrollments).values({ id, classroomId, nom: "N", prenom: "P", email: `${id}@heig-vd.ch` });
  return id;
}

async function set(classroomId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(groupSets).values({ id, classroomId, name: "Groups", createdBy: teacherId, createdAt: NOW });
  return id;
}

async function group(setId: string, name = `G-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await db.insert(studentGroups).values({ id, setId, name, position: 0, createdAt: NOW });
  return id;
}

const member = (setId: string, groupId: string, enrollmentId: string) =>
  db.insert(studentGroupMembers).values({ id: randomUUID(), setId, groupId, enrollmentId, addedAt: NOW });

async function project(classroomId: string, groupSetId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId,
    orgId,
    name: "Lab",
    slug: `lab-${id.slice(0, 8)}`,
    startAt: NOW,
    deadlineAt: new Date("2026-10-15T22:00:00Z"),
    sourceRepoId: 1001,
    sourceFullName: "heig-prg1/lab-source",
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    groupMode: true,
    groupSetId,
    createdBy: teacherId,
  });
  return id;
}

describe("group sets' tables (ADR-070)", () => {
  it("keeps a student in at most one group of a set, and a group's name unique in its set", async () => {
    const room = await classroom();
    const s = await set(room);
    const [g1, g2] = [await group(s, "A"), await group(s, "B")];
    const e = await enrollment(room);
    await member(s, g1, e);
    await expect(member(s, g2, e)).rejects.toThrow();
    await expect(group(s, "A")).rejects.toThrow();
    // Another set takes the same name and the same student.
    const other = await set(room);
    await member(other, await group(other, "A"), e);
  });

  it("refuses a member whose group is of another set", async () => {
    const room = await classroom();
    const [s1, s2] = [await set(room), await set(room)];
    const foreign = await group(s2);
    await expect(member(s1, foreign, await enrollment(room))).rejects.toThrow();
  });

  it("takes the sets with their classroom, and a roster line out of every set and copy", async () => {
    const room = await classroom();
    const s = await set(room);
    const g = await group(s);
    const e = await enrollment(room);
    await member(s, g, e);
    const pid = await project(room, s);
    const copyGroup = randomUUID();
    await db.insert(projectGroups).values({ id: copyGroup, projectId: pid, name: "A", slug: "a", position: 0, sourceGroupId: g });
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: copyGroup, enrollmentId: e });

    await db.delete(enrollments).where(eq(enrollments.id, e));
    expect(await db.select().from(studentGroupMembers).where(eq(studentGroupMembers.setId, s))).toEqual([]);
    expect(await db.select().from(projectGroupMembers).where(eq(projectGroupMembers.projectId, pid))).toEqual([]);

    await db.delete(classrooms).where(eq(classrooms.id, room));
    expect(await db.select().from(groupSets).where(eq(groupSets.id, s))).toEqual([]);
    expect(await db.select().from(studentGroups).where(eq(studentGroups.id, g))).toEqual([]);
  });

  it("leaves a copy group without its source, and a project without its set, when they are deleted", async () => {
    const room = await classroom();
    const s = await set(room);
    const g = await group(s);
    const e = await enrollment(room);
    await member(s, g, e);
    const pid = await project(room, s);
    const copyGroup = randomUUID();
    await db.insert(projectGroups).values({ id: copyGroup, projectId: pid, name: "A", slug: "a", position: 0, sourceGroupId: g });

    await db.delete(studentGroups).where(eq(studentGroups.id, g));
    expect(await db.select().from(studentGroupMembers).where(eq(studentGroupMembers.setId, s))).toEqual([]);
    const [copy] = await db.select().from(projectGroups).where(eq(projectGroups.id, copyGroup));
    expect(copy!.sourceGroupId).toBeNull();

    await db.delete(groupSets).where(eq(groupSets.id, s));
    const [row] = await db.select().from(projects).where(eq(projects.id, pid));
    expect(row!.groupSetId).toBeNull();
    expect(await db.select().from(projectGroups).where(eq(projectGroups.projectId, pid))).toHaveLength(1);
  });
});
