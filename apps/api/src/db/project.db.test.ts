/**
 * The `project` module's tables (`db/project.ts`, migration `0054_project`)
 * against the real migrations: the partial uniques that make Accept
 * idempotent (ADR-011), the other idempotency keys, and the cascades of a
 * deletion (D19, F-ORG-09, F-PROJ-16) — the project's rows go, the GitHub
 * substrate's stay.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";

import type { Db } from "./client.js";
import {
  botCommits,
  classrooms,
  courses,
  enrollments,
  githubClassroomLinks,
  githubOrganizations,
  gradeDispatches,
  projectCheckpoints,
  projectGradeRuns,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
  pushReceipts,
  reverts,
  users,
} from "./schema.js";
import { testDb } from "../test/db.js";

const PROJECT_TABLES = [
  "projects",
  "project_checkpoints",
  "project_groups",
  "project_group_members",
  "project_repos",
  "project_grade_runs",
  "bot_commits",
  "grade_dispatches",
  "reverts",
] as const;

const NOW = new Date("2026-10-01T08:00:00Z");

let db: Db;
let teacherId: string;
let courseId: string;
let orgId: string;

beforeAll(async () => {
  db = await testDb();
  teacherId = await user();
  courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation 1", code: "PRG1" });
  orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: "heig-prg1", githubOrgId: 77, installationId: 88 });
});

async function user(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `sub-${id}`, email: `${id}@heig-vd.ch` });
  return id;
}

async function classroom(): Promise<string> {
  const id = randomUUID();
  await db.insert(classrooms).values({ id, courseId, name: `C-${id.slice(0, 8)}` });
  await db.insert(githubClassroomLinks).values({ classroomId: id, orgId, linkedBy: teacherId });
  return id;
}

async function enrollment(classroomId: string, userId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.insert(enrollments).values({ id, classroomId, nom: "N", prenom: "P", email: `${id}@heig-vd.ch`, userId });
  return id;
}

async function project(classroomId: string, slug = `lab-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId,
    orgId,
    name: "Lab",
    slug,
    startAt: NOW,
    deadlineAt: new Date("2026-10-15T22:00:00Z"),
    sourceRepoId: 1001,
    sourceFullName: "heig-prg1/lab-source",
    branches: ["main"],
    protectedFiles: [".github/workflows/grading.yml"],
    gradingScale: defaultProjectGradingScale(),
    createdBy: teacherId,
  });
  return id;
}

async function group(projectId: string, name = `G-${randomUUID().slice(0, 8)}`): Promise<string> {
  const id = randomUUID();
  await db.insert(projectGroups).values({ id, projectId, name, slug: name.toLowerCase(), position: 0 });
  return id;
}

/** One acceptance's row, `ON CONFLICT DO NOTHING`, as Accept writes it. */
async function accept(projectId: string, userId: string, groupId: string | null = null) {
  return db
    .insert(projectRepos)
    .values({ id: randomUUID(), projectId, userId, groupId, acceptedAt: NOW })
    .onConflictDoNothing()
    .returning({ id: projectRepos.id });
}

const count = async (table: (typeof PROJECT_TABLES)[number], column: string, value: string) => {
  const { rows } = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`,
  );
  return rows[0]!.n;
};

describe("the idempotency of Accept (partial uniques)", () => {
  it("gives one student one individual repository per project", async () => {
    const pid = await project(await classroom());
    const student = await user();
    expect(await accept(pid, student)).toHaveLength(1);
    expect(await accept(pid, student)).toEqual([]);
    // Another project of the same student is another repository.
    expect(await accept(await project(await classroom()), student)).toHaveLength(1);
  });

  it("gives one group one repository, whoever of its members accepts", async () => {
    const pid = await project(await classroom());
    const gid = await group(pid);
    expect(await accept(pid, await user(), gid)).toHaveLength(1);
    expect(await accept(pid, await user(), gid)).toEqual([]);
  });

  it("lets a group's repository and its creator's individual one coexist", async () => {
    const pid = await project(await classroom());
    const student = await user();
    expect(await accept(pid, student)).toHaveLength(1);
    expect(await accept(pid, student, await group(pid))).toHaveLength(1);
    expect(await accept(pid, student, await group(pid))).toHaveLength(1);
    expect(await count("project_repos", "project_id", pid)).toBe(3);
  });

  it("holds a GitHub repository in one row only", async () => {
    const pid = await project(await classroom());
    const row = { projectId: pid, githubRepoId: 555_001, acceptedAt: NOW };
    await db.insert(projectRepos).values({ ...row, id: randomUUID(), userId: await user() });
    await expect(db.insert(projectRepos).values({ ...row, id: randomUUID(), userId: await user() })).rejects.toThrow();
  });

  it("refuses a repository without the time it was accepted (no default: the import carries it)", async () => {
    const pid = await project(await classroom());
    await expect(
      db.execute(sql`INSERT INTO project_repos (id, project_id, user_id) VALUES (${randomUUID()}, ${pid}, ${teacherId})`),
    ).rejects.toThrow();
  });
});

describe("the other idempotency keys", () => {
  it("keeps one slug per classroom, one name per checkpoint and group, one group per student", async () => {
    const room = await classroom();
    const pid = await project(room, "lab-1");
    await expect(project(room, "lab-1")).rejects.toThrow();
    expect(await project(await classroom(), "lab-1")).toBeTruthy();

    const checkpoint = { projectId: pid, name: "mid-term", dueAt: NOW };
    await db.insert(projectCheckpoints).values({ ...checkpoint, id: randomUUID() });
    await expect(db.insert(projectCheckpoints).values({ ...checkpoint, id: randomUUID() })).rejects.toThrow();

    await group(pid, "Alpha");
    await expect(group(pid, "Alpha")).rejects.toThrow();

    const eid = await enrollment(room);
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: await group(pid), enrollmentId: eid });
    await expect(
      db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: await group(pid), enrollmentId: eid }),
    ).rejects.toThrow();
  });

  it("captures a run once per (repository, run, attempt), and dispatches once per trigger", async () => {
    const pid = await project(await classroom());
    const [repo] = await accept(pid, await user());
    const run = {
      repoId: repo!.id,
      workflowRunId: 9_000_000_001,
      headBranch: "main",
      headSha: "a".repeat(40),
      conclusion: "success",
      parseStatus: "ok" as const,
      completedAt: NOW,
    };
    await db.insert(projectGradeRuns).values({ ...run, id: randomUUID() });
    expect(await db.insert(projectGradeRuns).values({ ...run, id: randomUUID() }).onConflictDoNothing().returning()).toEqual([]);
    expect(await db.insert(projectGradeRuns).values({ ...run, id: randomUUID(), runAttempt: 2 }).returning()).toHaveLength(1);

    const final = { repoId: repo!.id, trigger: "deadline" as const, sha: "a".repeat(40) };
    await db.insert(gradeDispatches).values({ ...final, id: randomUUID() });
    expect(await db.insert(gradeDispatches).values({ ...final, id: randomUUID() }).onConflictDoNothing().returning()).toEqual([]);
    const [checkpoint] = await db
      .insert(projectCheckpoints)
      .values({ id: randomUUID(), projectId: pid, name: "j-3", dueAt: NOW })
      .returning();
    const atCheckpoint = { ...final, trigger: "checkpoint" as const, checkpointId: checkpoint!.id };
    await db.insert(gradeDispatches).values({ ...atCheckpoint, id: randomUUID() });
    expect(await db.insert(gradeDispatches).values({ ...atCheckpoint, id: randomUUID() }).onConflictDoNothing().returning()).toEqual([]);
  });
});

describe("deletion (D19, F-ORG-09, F-PROJ-16)", () => {
  /** A project with one of each child, its repository's receipts in `github`. */
  async function world(room: string) {
    const pid = await project(room);
    const gid = await group(pid);
    const student = await user();
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: gid, enrollmentId: await enrollment(room, student) });
    await db.insert(projectCheckpoints).values({ id: randomUUID(), projectId: pid, name: "j-3", dueAt: NOW });
    const githubRepoId = Math.floor(Math.random() * 1e9);
    const [repo] = await db
      .insert(projectRepos)
      .values({ id: randomUUID(), projectId: pid, userId: student, groupId: gid, githubRepoId, acceptedAt: NOW })
      .returning();
    const sha = "b".repeat(40);
    await db.insert(projectGradeRuns).values({
      id: randomUUID(), repoId: repo!.id, workflowRunId: 1, headBranch: "main", headSha: sha, conclusion: "success", parseStatus: "ok", completedAt: NOW,
    });
    await db.insert(botCommits).values({ repoId: repo!.id, sha, kind: "deadline" });
    await db.insert(gradeDispatches).values({ id: randomUUID(), repoId: repo!.id, trigger: "deadline", sha });
    await db.insert(reverts).values({ id: randomUUID(), repoId: repo!.id, revertSha: sha, files: ["README.md"], createdAt: NOW });
    await db.insert(pushReceipts).values({ id: randomUUID(), githubRepoId, branch: "main", headSha: sha, receivedAt: NOW });
    return { pid, gid, repoId: repo!.id, githubRepoId };
  }

  async function assertGone(pid: string, repoId: string) {
    for (const table of ["projects"] as const) expect(await count(table, "id", pid)).toBe(0);
    for (const table of ["project_checkpoints", "project_groups", "project_group_members", "project_repos"] as const) {
      expect(await count(table, "project_id", pid)).toBe(0);
    }
    for (const table of ["project_grade_runs", "bot_commits", "grade_dispatches", "reverts"] as const) {
      expect(await count(table, "repo_id", repoId)).toBe(0);
    }
  }

  it("deletes a project's rows with it, and never the GitHub substrate's", async () => {
    const room = await classroom();
    const { pid, repoId, githubRepoId } = await world(room);
    await db.delete(projects).where(eq(projects.id, pid));
    await assertGone(pid, repoId);
    // The receipts are `github`'s, keyed on GitHub's id: the project service
    // purges them itself (M3-02); the schema never reaches into them.
    expect(await db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, githubRepoId))).toHaveLength(1);
    expect(await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, orgId))).toHaveLength(1);
    expect(await db.select().from(githubClassroomLinks).where(eq(githubClassroomLinks.classroomId, room))).toHaveLength(1);
  });

  it("deletes a classroom's projects with it, the organization kept", async () => {
    const room = await classroom();
    const { pid, repoId, githubRepoId } = await world(room);
    await db.delete(classrooms).where(eq(classrooms.id, room));
    await assertGone(pid, repoId);
    expect(await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, orgId))).toHaveLength(1);
    expect(await db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, githubRepoId))).toHaveLength(1);
  });

  it("keeps a group's repository when the group goes, its group set null", async () => {
    const room = await classroom();
    const { gid, repoId } = await world(room);
    await db.delete(projectGroups).where(eq(projectGroups.id, gid));
    const [repo] = await db.select().from(projectRepos).where(eq(projectRepos.id, repoId));
    expect(repo?.groupId).toBeNull();
    expect(await count("project_group_members", "group_id", gid)).toBe(0);
  });

  it("drops a membership with its roster line", async () => {
    const room = await classroom();
    const pid = await project(room);
    const eid = await enrollment(room);
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: await group(pid), enrollmentId: eid });
    await db.delete(enrollments).where(eq(enrollments.id, eid));
    expect(await count("project_group_members", "enrollment_id", eid)).toBe(0);
  });

  it("drops a checkpoint's dispatches with the checkpoint", async () => {
    const pid = await project(await classroom());
    const [repo] = await accept(pid, await user());
    const [checkpoint] = await db.insert(projectCheckpoints).values({ id: randomUUID(), projectId: pid, name: "j-3", dueAt: NOW }).returning();
    await db.insert(gradeDispatches).values({ id: randomUUID(), repoId: repo!.id, trigger: "checkpoint", checkpointId: checkpoint!.id, sha: "c".repeat(40) });
    await db.delete(projectCheckpoints).where(eq(projectCheckpoints.id, checkpoint!.id));
    expect(await count("grade_dispatches", "repo_id", repo!.id)).toBe(0);
  });

  it("refuses to delete an organization a project lives in", async () => {
    const otherOrg = randomUUID();
    await db.insert(githubOrganizations).values({ id: otherOrg, login: `org-${otherOrg.slice(0, 8)}` });
    const room = randomUUID();
    await db.insert(classrooms).values({ id: room, courseId, name: "C-org" });
    await db.insert(projects).values({
      id: randomUUID(), classroomId: room, orgId: otherOrg, name: "Lab", slug: "lab", startAt: NOW, deadlineAt: NOW,
      sourceRepoId: 1, sourceFullName: "o/s", branches: ["main"], protectedFiles: [], gradingScale: defaultProjectGradingScale(), createdBy: teacherId,
    });
    await expect(db.delete(githubOrganizations).where(eq(githubOrganizations.id, otherOrg))).rejects.toThrow();
  });
});

describe("the project schema", () => {
  it("has no column that could hold a token, a key or a secret (invariant 15)", async () => {
    const { rows } = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ${[...PROJECT_TABLES]}`);
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(PROJECT_TABLES));
    const suspicious = rows.filter((r) => /token|secret|password|credential|private|key|pem|jwt/i.test(r.column_name));
    expect(suspicious).toEqual([]);
  });
});
