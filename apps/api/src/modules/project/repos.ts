/**
 * A student's repository as GitHub's events reach it (merge task M3-04):
 * found by GitHub's immutable repository id, never by name; who hears of a
 * change to it; and its one terminal state, deleted on GitHub.
 */
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, projectRepos, projects } from "../../db/schema.js";
import { projectsChanged, repoChanged } from "./events.js";
import { repoMembers } from "./groupRepos.js";

export type RepoRow = typeof projectRepos.$inferSelect;

/** A provisioning claim older than this is taken over: the request that held it died (Accept, and a revocation's wait). */
export const PROVISION_CLAIM_STALE_MS = 5 * 60_000;

/** A first provisioning under way: the row pending, its claim fresh by the server's clock. */
export function provisioningNow(repo: Pick<RepoRow, "provisionStatus" | "provisionClaimedAt">, now: Date): boolean {
  return (
    repo.provisionStatus === "pending" &&
    repo.provisionClaimedAt !== null &&
    now.getTime() - repo.provisionClaimedAt.getTime() < PROVISION_CLAIM_STALE_MS
  );
}
type ProjectRow = typeof projects.$inferSelect;

/**
 * The STUDENT repositories of `project`: every one but those of a user who
 * now holds a staff seat of the classroom — a staff seat is never a
 * student's (ADR-018). A group's repository is its members' whoever
 * created it (`user_id`, N-SEC-20): always one. The one set the page's
 * rows and counts, and the release, read (M3-08a, M3-08b).
 */
export async function studentRepos(db: Db | Tx, project: Pick<ProjectRow, "id" | "classroomId">): Promise<RepoRow[]> {
  const staff = db
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, project.classroomId), eq(enrollments.staff, true), isNotNull(enrollments.userId)));
  return db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, project.id), or(isNotNull(projectRepos.groupId), notInArray(projectRepos.userId, staff))));
}

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
 * The accounts that read a repository: the student who accepted it or, for
 * a group's, its members of the copy (`repoMembers`) — never its creator
 * for having created it (N-SEC-20).
 */
async function repoUserIds(db: Db, ctx: RepoContext): Promise<string[]> {
  if (ctx.repo.groupId === null) return [ctx.repo.userId];
  return (await repoMembers(db, ctx.repo, ctx.project.classroomId)).map((m) => m.userId);
}

/** The hint of a change to `ctx`'s repository: its students and the course's staff, never the classroom. */
export async function hintRepo(db: Db, ctx: RepoContext): Promise<void> {
  repoChanged(ctx.courseId, await repoUserIds(db, ctx));
}

/** The staff of the projects `projectIds` hear of them (course topics only): the ticker's and the jobs' changes. */
export async function hintProjectStaff(db: Db, projectIds: readonly string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const rows = await db
    .selectDistinct({ courseId: classrooms.courseId })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(inArray(projects.id, [...new Set(projectIds)]));
  projectsChanged(rows.map((r) => r.courseId));
}

/**
 * Terminal and idempotent: the repository is gone from GitHub (F-PROJ-18).
 * Nothing retries a deleted repository, nothing is deleted here. True only
 * for the call that marked it, which audits it. `via`: GitHub's `repository`
 * event, the 404 a deadline's lock, unlock or commit met (M3-05a), a
 * review dispatch's (M3-05b), or the reconciliation's read of the repository
 * by its id (M3-06).
 */
export async function markRepoDeleted(
  db: Db,
  repoId: string,
  now: Date,
  via: "webhook" | "deadline" | "dispatch" | "reconcile",
): Promise<boolean> {
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

/**
 * A repository renamed on GitHub (F-PROJ-18), followed by its immutable id:
 * the stored names — a student's repository, and a project's source or
 * distribution repository, which the restores and the sync read by name —
 * become `fullName`, only where the stored name part is `from` (the name
 * the rename left), so a stale rename replayed after a later one changes
 * nothing. The name part only: the owner may differ, an organization
 * renamed before its own rename event was applied. The `repository.renamed`
 * webhook's path and the reconciliation's (ADR-011). True when a student's
 * repository row was renamed.
 */
export async function followRepoRename(db: Db, githubRepoId: number, fullName: string, from: string): Promise<boolean> {
  const named = (column: AnyPgColumn) => sql`split_part(${column}, '/', 2) = ${from}`;
  await db
    .update(projects)
    .set({ sourceFullName: fullName })
    .where(and(eq(projects.sourceRepoId, githubRepoId), named(projects.sourceFullName)));
  await db
    .update(projects)
    .set({ distributionFullName: fullName })
    .where(and(eq(projects.distributionRepoId, githubRepoId), named(projects.distributionFullName)));
  const renamed = await db
    .update(projectRepos)
    .set({ fullName })
    .where(and(eq(projectRepos.githubRepoId, githubRepoId), named(projectRepos.fullName)))
    .returning({ id: projectRepos.id });
  return renamed.length > 0;
}
