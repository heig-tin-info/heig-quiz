/**
 * Whose repository is this (ADR-048 lot 2, ADR-070 §4, N-SEC-20; merge task
 * M3-15b), ported from heig-classroom's `group-repos.ts`: the ONE place
 * that answers "which repository is this student's?" (`seatRepos`) and
 * "who reads this repository?" (`repoMembers`). A group's repository is a
 * student's through the project's copy of its set
 * (`project_group_members`), NEVER through `project_repos.user_id`, which
 * only records the member whose Accept created it — who may have moved out
 * of the group since.
 *
 * A group project may hold an individual repository too, from
 * heig-classroom's lot 1 (imported, M8-01): a live one keeps its student,
 * who is then neither shown nor invited into their group's
 * (`pickStudentRepo`, `isLiveIndividualRepo` of `@quiz/domain`). Quiz's own
 * Accept never makes one in a group project.
 */
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { isLiveIndividualRepo, pickStudentRepo } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { enrollments, githubAccounts, projectGroupMembers, projectGroups, projectRepos } from "../../db/schema.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

export type GroupRow = typeof projectGroups.$inferSelect;
export type AccountRow = typeof githubAccounts.$inferSelect;
type SeatProject = Pick<ProjectRow, "id" | "groupMode" | "classroomId">;

/** The copy group roster line `enrollmentId` is in on `projectId`, or null. */
export async function copyGroupOf(db: Db | Tx, projectId: string, enrollmentId: string): Promise<GroupRow | null> {
  const [row] = await db
    .select({ group: projectGroups })
    .from(projectGroupMembers)
    .innerJoin(projectGroups, eq(projectGroups.id, projectGroupMembers.groupId))
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, enrollmentId)))
    .limit(1);
  return row?.group ?? null;
}

/** Whether roster line `enrollmentId`'s move out of its copy group of `projectId` waits for GitHub (`departing_at`, M3-15b-2). */
export async function isDeparting(db: Db | Tx, projectId: string, enrollmentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: projectGroupMembers.id })
    .from(projectGroupMembers)
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, enrollmentId), isNotNull(projectGroupMembers.departingAt)));
  return row !== undefined;
}

/** Where a copy group's repository row is: by the partial UNIQUE (project, group). */
export const groupRepoWhere = (projectId: string, groupId: string) =>
  and(eq(projectRepos.projectId, projectId), eq(projectRepos.groupId, groupId));

/** Which repository each student seat of some projects reads: `of(projectId, enrollmentId)`, or null. */
export interface SeatRepos {
  of(projectId: string, enrollmentId: string): RepoRow | null;
}

/**
 * The repositories the student seats of `projects` read, in three reads:
 * a seat's own individual repository, or, in a group project, its copy
 * group's — `pickStudentRepo`: a live individual one wins. Staff seats read
 * none (ADR-018). `enrollmentIds` narrows the seats read.
 */
export async function seatRepos(db: Db | Tx, projects: readonly SeatProject[], enrollmentIds?: readonly string[]): Promise<SeatRepos> {
  if (projects.length === 0 || enrollmentIds?.length === 0) return { of: () => null };
  const projectIds = projects.map((p) => p.id);
  const lines = enrollmentIds === undefined ? undefined : [...enrollmentIds];
  const [repos, seats, places] = await Promise.all([
    db.select().from(projectRepos).where(inArray(projectRepos.projectId, projectIds)),
    db
      .select({ id: enrollments.id, userId: enrollments.userId })
      .from(enrollments)
      .where(
        and(
          inArray(enrollments.classroomId, [...new Set(projects.map((p) => p.classroomId))]),
          eq(enrollments.staff, false),
          lines === undefined ? undefined : inArray(enrollments.id, lines),
        ),
      ),
    db
      .select({ projectId: projectGroupMembers.projectId, enrollmentId: projectGroupMembers.enrollmentId, groupId: projectGroupMembers.groupId })
      .from(projectGroupMembers)
      .where(and(inArray(projectGroupMembers.projectId, projectIds), lines === undefined ? undefined : inArray(projectGroupMembers.enrollmentId, lines))),
  ]);
  const own = new Map(repos.filter((r) => r.groupId === null).map((r) => [`${r.projectId}:${r.userId}`, r]));
  const ofGroup = new Map(repos.filter((r) => r.groupId !== null).map((r) => [r.groupId!, r]));
  const userOf = new Map(seats.map((s) => [s.id, s.userId]));
  const groupOf = new Map(places.map((p) => [`${p.projectId}:${p.enrollmentId}`, p.groupId]));
  const grouped = new Set(projects.filter((p) => p.groupMode).map((p) => p.id));
  return {
    of(projectId, enrollmentId) {
      if (!userOf.has(enrollmentId)) return null;
      const userId = userOf.get(enrollmentId);
      const mine = userId ? own.get(`${projectId}:${userId}`) : undefined;
      const group = grouped.has(projectId) ? groupOf.get(`${projectId}:${enrollmentId}`) : undefined;
      return pickStudentRepo(mine, group === undefined ? undefined : ofGroup.get(group)) ?? null;
    },
  };
}

/** {@link seatRepos} for one seat of one project. */
export async function seatRepo(db: Db | Tx, project: SeatProject, enrollmentId: string): Promise<RepoRow | null> {
  return (await seatRepos(db, [project], [enrollmentId])).of(project.id, enrollmentId);
}

/** A reader of a repository: their roster line, its account, that account's GitHub link (null: none). */
export interface RepoMember {
  enrollmentId: string;
  userId: string;
  account: AccountRow | null;
}

/**
 * Who reads `repo` — and whom an invitation of it may reach (those with a
 * link): its student's claimed student seat, or the members of a group's
 * copy group with an account, minus a holder of a live individual
 * repository of the project, who keeps theirs, and minus a member whose
 * departure waits for GitHub (M3-15b-2: never invited again). Never the
 * group repository's creator for having created it (N-SEC-20).
 */
export async function repoMembers(db: Db | Tx, repo: RepoRow, classroomId: string): Promise<RepoMember[]> {
  const columns = { enrollmentId: enrollments.id, userId: enrollments.userId, account: githubAccounts };
  if (repo.groupId === null) {
    const rows = await db
      .select(columns)
      .from(enrollments)
      .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
      .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.userId, repo.userId), eq(enrollments.staff, false)));
    return rows.map((r) => ({ ...r, userId: r.userId! }));
  }
  const rows = await db
    .select(columns)
    .from(projectGroupMembers)
    .innerJoin(enrollments, and(eq(enrollments.id, projectGroupMembers.enrollmentId), eq(enrollments.staff, false)))
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(and(eq(projectGroupMembers.groupId, repo.groupId), isNull(projectGroupMembers.departingAt)))
    .orderBy(enrollments.id);
  const holders = new Set(
    (await db.select().from(projectRepos).where(eq(projectRepos.projectId, repo.projectId))).filter(isLiveIndividualRepo).map((r) => r.userId),
  );
  return rows.flatMap((r) => (r.userId === null || holders.has(r.userId) ? [] : [{ ...r, userId: r.userId }]));
}
