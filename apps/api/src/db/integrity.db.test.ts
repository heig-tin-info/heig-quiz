/**
 * The integrity constraints of migration 0152
 * (docs/audits/2026-11-21-database-remediation.md, Phase 3), against the
 * real migrations: a role or a state off its list, an address not
 * normalized, a grading or a group member whose denormalized parent
 * disagrees, a dangling run slot or bookmark — each refused by the database
 * itself, by name. And the deletions they must not block: a group, an item,
 * a project, a classroom, a course.
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultProjectGradingScale } from "@quiz/contracts";
import { registerForTests } from "@quiz/registry/server";

import type { Db } from "./client.js";
import {
  answers,
  attempts,
  classrooms,
  courses,
  enrollments,
  evaluationItems,
  githubOrganizations,
  gradings,
  projectGradeRuns,
  projectGroupMembers,
  projectGroups,
  projectRepos,
  projects,
  teacherGrants,
  userEmails,
  users,
} from "./schema.js";
import { testDb } from "../test/db.js";
import { fakeShort } from "../test/fakeType.js";
import { seedLive, type Seeded } from "../test/live.js";

const NOW = new Date("2026-11-21T08:00:00Z");

let db: Db;
let orgId: string;
let restore: () => void;

afterAll(() => restore());

beforeAll(async () => {
  restore = registerForTests(fakeShort);
  db = await testDb();
  orgId = randomUUID();
  await db.insert(githubOrganizations).values({ id: orgId, login: `org-${orgId.slice(0, 8)}` });
});

/** The constraint a write was refused by: drizzle wraps the driver's error in `cause`. */
async function refusedBy(write: Promise<unknown>): Promise<string | undefined> {
  try {
    await write;
  } catch (err) {
    for (let e: unknown = err; typeof e === "object" && e !== null; e = (e as { cause?: unknown }).cause) {
      const { constraint } = e as { constraint?: unknown };
      if (typeof constraint === "string") return constraint;
    }
    throw err;
  }
  return undefined;
}

async function user(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `sub-${id}`, email: `${id}@heig-vd.ch` });
  return id;
}

async function project(classroomId: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await db.insert(projects).values({
    id,
    classroomId,
    orgId,
    name: "Lab",
    slug: `lab-${id.slice(0, 8)}`,
    startAt: NOW,
    deadlineAt: NOW,
    sourceRepoId: 1,
    sourceFullName: "o/s",
    branches: ["main"],
    protectedFiles: [],
    gradingScale: defaultProjectGradingScale(),
    createdBy,
  });
  return id;
}

async function group(projectId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(projectGroups).values({ id, projectId, name: id, slug: id, position: 0 });
  return id;
}

async function enrollment(classroomId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(enrollments).values({ id, classroomId, nom: "N", prenom: "P", email: `${id}@heig-vd.ch` });
  return id;
}

/** An attempt of the student, bookmarked on the item, with one answer on it. */
async function answered(s: Seeded, studentId: string, itemId: string) {
  const attemptId = randomUUID();
  await db.insert(attempts).values({ id: attemptId, evaluationId: s.evaluationId, userId: studentId, seed: 1, lastItemId: itemId });
  const answerId = randomUUID();
  await db.insert(answers).values({ id: answerId, attemptId, itemId, payload: { text: "x" } });
  return { attemptId, answerId };
}

function grading(row: { answerId: string | null; attemptId: string; itemId: string }) {
  return db.insert(gradings).values({ id: randomUUID(), ...row, points: 1, maxPoints: 1, source: "auto", state: "validated" });
}

/** A repository of the project with a run in each of its three slots. */
async function repoWithRuns(projectId: string, userId: string, groupId: string | null) {
  const repoId = randomUUID();
  await db.insert(projectRepos).values({ id: repoId, projectId, userId, groupId, acceptedAt: NOW });
  const runId = randomUUID();
  await db.insert(projectGradeRuns).values({
    id: runId, repoId, workflowRunId: 1, headBranch: "main", headSha: "a".repeat(40), conclusion: "success", parseStatus: "ok", completedAt: NOW,
  });
  await db
    .update(projectRepos)
    .set({ currentGradeRunId: runId, frozenGradeRunId: runId, reviewGradeRunId: runId })
    .where(eq(projectRepos.id, repoId));
  return { repoId, runId };
}

describe("closed lists (3.1)", () => {
  it("refuses a role, a kind or a state off its list, by the column's own check", async () => {
    const id = randomUUID();
    expect(
      await refusedBy(db.execute(sql`INSERT INTO users (id, oidc_sub, email, role) VALUES (${id}, ${id}, 'x@heig-vd.ch', 'root')`)),
    ).toBe("users_role_ck");
    const s = await seedLive(db, { questions: 1 });
    expect(
      await refusedBy(db.execute(sql`UPDATE course_staff SET role = 'boss' WHERE course_id = ${s.courseId}`)),
    ).toBe("course_staff_role_ck");
    expect(
      await refusedBy(
        db.execute(sql`INSERT INTO attempts (id, evaluation_id, user_id, seed, state) VALUES (${randomUUID()}, ${s.evaluationId}, ${s.studentIds[0]}, 1, 'paused')`),
      ),
    ).toBe("attempts_state_ck");
  });

  it("accepts every value of the list", async () => {
    for (const role of ["student", "teacher", "admin"] as const) {
      const id = randomUUID();
      await db.insert(users).values({ id, oidcSub: id, email: `${id}@heig-vd.ch`, role });
    }
  });
});

describe("normalized addresses (3.2)", () => {
  it("refuses an address with a capital or a surrounding space, in each of the three tables", async () => {
    const s = await seedLive(db, { questions: 0, students: 0 });
    const by = s.teacherId;
    expect(
      await refusedBy(db.insert(enrollments).values({ id: randomUUID(), classroomId: s.classroomId, nom: "N", prenom: "P", email: "Ada@heig-vd.ch" })),
    ).toBe("enrollments_email_normalized_ck");
    expect(
      await refusedBy(db.insert(userEmails).values({ userId: by, email: " ada@heig-vd.ch", source: "login" })),
    ).toBe("user_emails_email_normalized_ck");
    expect(
      await refusedBy(db.insert(teacherGrants).values({ id: randomUUID(), email: "ada@heig-vd.ch ", createdBy: by })),
    ).toBe("teacher_grants_email_normalized_ck");
    await db.insert(teacherGrants).values({ id: randomUUID(), email: `ada-${by}@heig-vd.ch`, createdBy: by });
  });
});

describe("consistent parents (3.3)", () => {
  it("refuses a grading whose answer is another attempt's, and checks none of an absent answer", async () => {
    const s = await seedLive(db, { questions: 1 });
    const item = s.itemIds[0]!;
    const mine = await answered(s, s.studentIds[0]!, item);
    const theirs = await answered(s, s.studentIds[1]!, item);
    expect(
      await refusedBy(grading({ answerId: theirs.answerId, attemptId: mine.attemptId, itemId: item })),
    ).toBe("gradings_answer_attempt_item_fk");
    expect(await refusedBy(grading({ answerId: mine.answerId, attemptId: mine.attemptId, itemId: item }))).toBeUndefined();
    // F-GRADE-01: an absent answer is graded with a null `answer_id` (MATCH SIMPLE).
    expect(await refusedBy(grading({ answerId: null, attemptId: theirs.attemptId, itemId: item }))).toBeUndefined();
  });

  it("refuses a member or a repository whose group is of another project", async () => {
    const s = await seedLive(db, { questions: 0, students: 1 });
    const pid = await project(s.classroomId, s.teacherId);
    const elsewhere = await group(await project(s.classroomId, s.teacherId));
    expect(
      await refusedBy(
        db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: elsewhere, enrollmentId: await enrollment(s.classroomId) }),
      ),
    ).toBe("project_group_members_group_project_fk");
    expect(
      await refusedBy(
        db.insert(projectRepos).values({ id: randomUUID(), projectId: pid, userId: s.studentIds[0]!, groupId: elsewhere, acceptedAt: NOW }),
      ),
    ).toBe("project_repos_group_project_fk");
  });

  it("empties only the repository's group when its group goes, the project kept", async () => {
    const s = await seedLive(db, { questions: 0, students: 1 });
    const pid = await project(s.classroomId, s.teacherId);
    const gid = await group(pid);
    const { repoId } = await repoWithRuns(pid, s.studentIds[0]!, gid);
    await db.delete(projectGroups).where(eq(projectGroups.id, gid));
    const [repo] = await db.select().from(projectRepos).where(eq(projectRepos.id, repoId));
    expect(repo).toMatchObject({ projectId: pid, groupId: null });
  });
});

describe("references (3.4)", () => {
  it("refuses a run slot or a bookmark that names nothing", async () => {
    const s = await seedLive(db, { questions: 1, students: 1 });
    const pid = await project(s.classroomId, s.teacherId);
    expect(
      await refusedBy(
        db.insert(projectRepos).values({ id: randomUUID(), projectId: pid, userId: s.studentIds[0]!, acceptedAt: NOW, frozenGradeRunId: randomUUID() }),
      ),
    ).toBe("project_repos_frozen_grade_run_id_project_grade_runs_id_fk");
    expect(
      await refusedBy(db.insert(attempts).values({ id: randomUUID(), evaluationId: s.evaluationId, userId: s.studentIds[0]!, seed: 1, lastItemId: randomUUID() })),
    ).toBe("attempts_last_item_id_evaluation_items_id_fk");
  });

  it("empties a bookmark whose item goes", async () => {
    const s = await seedLive(db, { questions: 1, students: 1 });
    const attemptId = randomUUID();
    await db.insert(attempts).values({ id: attemptId, evaluationId: s.evaluationId, userId: s.studentIds[0]!, seed: 1, lastItemId: s.itemIds[0]! });
    await db.delete(evaluationItems).where(eq(evaluationItems.id, s.itemIds[0]!));
    const [attempt] = await db.select().from(attempts).where(eq(attempts.id, attemptId));
    expect(attempt?.lastItemId).toBeNull();
  });
});

describe("deletions the new keys must not block", () => {
  /** A course with a graded attempt and a group project whose repository fills its three run slots. */
  async function world() {
    const s = await seedLive(db, { questions: 1, students: 1 });
    const student = s.studentIds[0]!;
    const item = s.itemIds[0]!;
    const { attemptId, answerId } = await answered(s, student, item);
    await grading({ answerId, attemptId, itemId: item });
    const pid = await project(s.classroomId, s.teacherId);
    const gid = await group(pid);
    await db.insert(projectGroupMembers).values({ id: randomUUID(), projectId: pid, groupId: gid, enrollmentId: await enrollment(s.classroomId) });
    const { repoId } = await repoWithRuns(pid, student, gid);
    return { s, pid, repoId, attemptId };
  }

  async function count(table: string, column: string, value: string): Promise<number> {
    const { rows } = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`,
    );
    return rows[0]!.n;
  }

  it("deletes a project, its repositories and their runs in one statement", async () => {
    const { pid, repoId } = await world();
    await db.delete(projects).where(eq(projects.id, pid));
    expect(await count("project_repos", "id", repoId)).toBe(0);
    expect(await count("project_grade_runs", "repo_id", repoId)).toBe(0);
    expect(await count("project_groups", "project_id", pid)).toBe(0);
  });

  it("deletes a classroom with its evaluation's graded attempts and its projects", async () => {
    const { s, repoId, attemptId } = await world();
    await db.delete(classrooms).where(eq(classrooms.id, s.classroomId));
    expect(await count("attempts", "id", attemptId)).toBe(0);
    expect(await count("gradings", "attempt_id", attemptId)).toBe(0);
    expect(await count("project_repos", "id", repoId)).toBe(0);
  });

  it("deletes a course with everything under it", async () => {
    const { s, pid, attemptId } = await world();
    await db.delete(courses).where(eq(courses.id, s.courseId));
    expect(await count("classrooms", "course_id", s.courseId)).toBe(0);
    expect(await count("projects", "id", pid)).toBe(0);
    expect(await count("attempts", "id", attemptId)).toBe(0);
  });
});
