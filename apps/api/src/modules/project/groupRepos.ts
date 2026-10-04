/**
 * Whose repository is this (ADR-048 lot 2, ADR-070 §4, N-SEC-20; merge task
 * M3-15b), ported from heig-classroom's `group-repos.ts`: the ONE place
 * that answers "which repository is this student's?" and "who is in this
 * repository's group?". A group's repository is a student's through the
 * project's copy of its set (`project_group_members`), NEVER through
 * `project_repos.user_id`, which only records the member whose Accept
 * created it — who may have moved out of the group since.
 *
 * A group project may hold an individual repository too, from
 * heig-classroom's lot 1 (imported, M8-01): a live one keeps its student,
 * who is then neither shown nor invited into their group's
 * (`isLiveIndividualRepo`, `pickStudentRepo` of `@quiz/domain`). Quiz's own
 * Accept never makes one in a group project.
 */
import { and, eq, isNull } from "drizzle-orm";

import { isLiveIndividualRepo, pickStudentRepo } from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import { enrollments, githubAccounts, projectGroupMembers, projectGroups, projectRepos } from "../../db/schema.js";
import type { RepoRow } from "./repos.js";

export type GroupRow = typeof projectGroups.$inferSelect;
type AccountRow = typeof githubAccounts.$inferSelect;

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

/** Where a copy group's repository row is: by the partial UNIQUE (project, group). */
export const groupRepoWhere = (projectId: string, groupId: string) =>
  and(eq(projectRepos.projectId, projectId), eq(projectRepos.groupId, groupId));

/** The repository row of a copy group, whatever its state, or null. */
export async function groupRepoRow(db: Db | Tx, projectId: string, groupId: string): Promise<RepoRow | null> {
  const [row] = await db.select().from(projectRepos).where(groupRepoWhere(projectId, groupId)).limit(1);
  return row ?? null;
}

/** A member of a copy group: their roster line, its account, that account's GitHub link. */
export interface GroupMember {
  enrollmentId: string;
  userId: string | null;
  account: AccountRow | null;
}

/** The members of copy group `groupId`, student seats only (a staff seat is never a member, ADR-018). */
export async function groupMembers(db: Db | Tx, groupId: string): Promise<GroupMember[]> {
  return db
    .select({ enrollmentId: enrollments.id, userId: enrollments.userId, account: githubAccounts })
    .from(projectGroupMembers)
    .innerJoin(enrollments, and(eq(enrollments.id, projectGroupMembers.enrollmentId), eq(enrollments.staff, false)))
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(eq(projectGroupMembers.groupId, groupId))
    .orderBy(enrollments.id);
}

/** The users of `projectId` who keep a live individual repository (heig-classroom's lot 1). */
export async function individualHolders(db: Db | Tx, projectId: string): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, projectId), isNull(projectRepos.groupId)));
  return new Set(rows.filter(isLiveIndividualRepo).map((r) => r.userId));
}

/**
 * The repository a student's seat reads on `project`, whatever its state,
 * or null: their own individual one, or, in a group project, their copy
 * group's (`pickStudentRepo`: a live individual one wins).
 */
export async function seatRepo(
  db: Db | Tx,
  project: { id: string; groupMode: boolean },
  seat: { enrollmentId: string; userId: string },
): Promise<RepoRow | null> {
  const [own] = await db
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, seat.userId), isNull(projectRepos.groupId)))
    .limit(1);
  if (!project.groupMode) return own ?? null;
  const group = await copyGroupOf(db, project.id, seat.enrollmentId);
  const groupRepo = group === null ? null : await groupRepoRow(db, project.id, group.id);
  return pickStudentRepo(own, groupRepo ?? undefined) ?? null;
}
