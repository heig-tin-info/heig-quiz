/**
 * A student's repository as GitHub's events reach it (merge task M3-04):
 * found by GitHub's immutable repository id, never by name; who hears of a
 * change to it; and its one terminal state, deleted on GitHub.
 */
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, projectGroupMembers, projectRepos, projects } from "../../db/schema.js";
import { repoChanged } from "./events.js";

export type RepoRow = typeof projectRepos.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** A project repository with what its events need: its project and the course of its staff. */
export interface RepoContext {
  repo: RepoRow;
  project: ProjectRow;
  courseId: string;
}

/** The project repository GitHub knows by `githubRepoId`, or null: not a student's repository. */
export async function repoContext(db: Db, githubRepoId: number): Promise<RepoContext | null> {
  const [row] = await db
    .select({ repo: projectRepos, project: projects, courseId: classrooms.courseId })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(eq(projectRepos.githubRepoId, githubRepoId))
    .limit(1);
  return row ?? null;
}

/**
 * The receipt tracker of the intake (`onReceipt`, ADR-012): a push on a
 * student's or a group's repository gets its receipt before the 200. One
 * indexed read (`project_repos.github_repo_id` is unique).
 */
export async function tracksRepo(tx: Tx, githubRepoId: number): Promise<boolean> {
  const [row] = await tx
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(eq(projectRepos.githubRepoId, githubRepoId))
    .limit(1);
  return row !== undefined;
}

/**
 * The accounts that read a repository: the student who accepted it and, for
 * a group's, every member with an account (ADR-048). Who else of the group
 * also holds an individual repository is M3-15's to refine.
 */
async function repoUserIds(db: Db, repo: RepoRow): Promise<string[]> {
  if (repo.groupId === null) return [repo.userId];
  const members = await db
    .select({ userId: enrollments.userId })
    .from(projectGroupMembers)
    .innerJoin(enrollments, eq(enrollments.id, projectGroupMembers.enrollmentId))
    .where(and(eq(projectGroupMembers.groupId, repo.groupId), isNotNull(enrollments.userId)));
  return [repo.userId, ...members.map((m) => m.userId!)];
}

/** The hint of a change to `ctx`'s repository: its students and the course's staff, never the classroom. */
export async function hintRepo(db: Db, ctx: RepoContext): Promise<void> {
  repoChanged(ctx.courseId, await repoUserIds(db, ctx.repo));
}

/**
 * Terminal and idempotent: the repository is gone from GitHub (F-PROJ-18).
 * Nothing retries a deleted repository, nothing is deleted here. True only
 * for the call that marked it, which audits it. `via`: GitHub's `repository`
 * event, or the 404 a deadline's lock, unlock or commit met (M3-05a).
 */
export async function markRepoDeleted(db: Db, repoId: string, now: Date, via: "webhook" | "deadline"): Promise<boolean> {
  const marked = await db
    .update(projectRepos)
    .set({ deletedAt: now })
    .where(and(eq(projectRepos.id, repoId), isNull(projectRepos.deletedAt)))
    .returning({ id: projectRepos.id });
  if (marked.length === 0) return false;
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: "project_repo.deleted",
    subjectType: "project_repo",
    subjectId: repoId,
    payload: { via },
  });
  return true;
}
