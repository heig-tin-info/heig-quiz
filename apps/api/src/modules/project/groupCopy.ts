/**
 * A group project's copy of its group set (ADR-070 §4; merge task M3-15a):
 * `project_groups` and `project_group_members`, this module's tables, which
 * the `group` module never writes. It calls these, through `service.ts`,
 * inside its own transaction:
 *
 * - `followingCopies` — the projects whose copy follows a set, locked;
 * - `stepCopies` — each of them brought in step with the set, by the pure
 *   diff of `groupSyncPlan` (`@quiz/domain`).
 *
 * And the lifecycle calls `replaceGroupCopy` when a draft names a set,
 * another one, or none.
 *
 * **Lock order** — the set, then its projects in id order: a set's write
 * locks its set row FOR UPDATE, then the projects naming it here; a
 * project's patch locks the set it names FOR SHARE before its own row. A
 * project whose deadline is applied, or that is archived, in between is
 * re-read under its lock (`groups_stopped_at`) and left as it stands.
 *
 * The copy is the students' side of the set: a staff seat (ADR-018) is
 * never in it, even a line that became one after it was placed (D6).
 *
 * **A copy group with a repository** (M3-15b-1): its slug — its
 * repository's name — is fixed, its name still follows (`slugFixed`), and
 * it is never deleted here. Until the `group.sync` job (M3-15b-2) a step
 * that would take a member out of it, bring one in, or delete it throws
 * {@link RepoGroupTouched} — the set's write is then refused whole (`409
 * has_repo`), never applied without GitHub. A staff seat leaving it is no
 * GitHub change: the seat's accounts were revoked when it became one
 * (`selfEnroll`, `access.ts`). A draft holds no repository
 * (`replaceGroupCopy`).
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { groupSyncPlan, isEmptyPlan, planReachesRepoGroup, type copyFollows, type CopyState, type GroupSyncPlan, type SetState } from "@quiz/domain";

import type { Tx } from "../../db/client.js";
import { enrollments, projectGroupMembers, projectGroups, projectRepos, projects, studentGroupMembers, studentGroups } from "../../db/schema.js";

/** A set's step would reach, on GitHub, a copy group with a repository of each of `projectIds`: the group module's `409 has_repo`. */
export class RepoGroupTouched extends Error {
  constructor(readonly projectIds: readonly string[]) {
    super(`projects ${projectIds.join(", ")}: the step reaches a group with a repository`);
    this.name = "RepoGroupTouched";
  }
}

/**
 * The projects whose copy follows set `setId` — {@link copyFollows}, the rule
 * this SQL mirrors —, locked FOR UPDATE in id order (see the lock order above).
 */
export async function followingCopies(tx: Tx, setId: string): Promise<{ id: string }[]> {
  return tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.groupSetId, setId), isNull(projects.groupsStoppedAt)))
    .orderBy(asc(projects.id))
    .for("update");
}

/** The set as the copies follow it: its groups, and its students' places (never a staff seat). */
async function setState(tx: Tx, setId: string): Promise<SetState> {
  const groups = await tx
    .select({ id: studentGroups.id, name: studentGroups.name, position: studentGroups.position })
    .from(studentGroups)
    .where(eq(studentGroups.setId, setId));
  const members = await tx
    .select({ enrollmentId: studentGroupMembers.enrollmentId, groupId: studentGroupMembers.groupId })
    .from(studentGroupMembers)
    .innerJoin(enrollments, eq(enrollments.id, studentGroupMembers.enrollmentId))
    .where(and(eq(studentGroupMembers.setId, setId), eq(enrollments.staff, false)));
  return { groups, members };
}

/**
 * The copy, each group's slug fixed when GitHub holds its repository (a
 * repository id recorded: a first Accept that failed before creating it
 * freezes nothing), and the staff seats in it.
 */
async function copyState(tx: Tx, projectId: string): Promise<CopyState & { staffSeats: Set<string> }> {
  const groups = await tx
    .select({
      id: projectGroups.id,
      name: projectGroups.name,
      slug: projectGroups.slug,
      position: projectGroups.position,
      sourceGroupId: projectGroups.sourceGroupId,
      slugFixed: sql<boolean>`${projectRepos.githubRepoId} IS NOT NULL`,
    })
    .from(projectGroups)
    .leftJoin(projectRepos, eq(projectRepos.groupId, projectGroups.id))
    .where(eq(projectGroups.projectId, projectId));
  const members = await tx
    .select({ enrollmentId: projectGroupMembers.enrollmentId, groupId: projectGroupMembers.groupId, staff: enrollments.staff })
    .from(projectGroupMembers)
    .innerJoin(enrollments, eq(enrollments.id, projectGroupMembers.enrollmentId))
    .where(eq(projectGroupMembers.projectId, projectId));
  return { groups, members, staffSeats: new Set(members.filter((m) => m.staff).map((m) => m.enrollmentId)) };
}

/** A draft's copy is made and replaced freely: no group of it may hold a repository (Accept takes published projects only). */
async function assertNoGroupRepo(tx: Tx, projectId: string): Promise<void> {
  const [repo] = await tx
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, projectId), isNotNull(projectRepos.groupId)))
    .limit(1);
  if (repo) throw new Error(`project ${projectId}: a group repository exists, its copy cannot be replaced`);
}

/**
 * Applies `plan` to the copy of `projectId`, in the order that keeps its
 * UNIQUE constraints true at each statement: the orphans deleted, the
 * departures, the renames through a temporary name (a swap of two names),
 * the new groups, the arrivals and moves.
 */
async function applyPlan(tx: Tx, projectId: string, copy: CopyState, plan: GroupSyncPlan, now: Date): Promise<void> {
  if (plan.delete.length > 0) {
    await tx.delete(projectGroups).where(inArray(projectGroups.id, plan.delete));
  }
  if (plan.unplace.length > 0) {
    await tx
      .delete(projectGroupMembers)
      .where(and(eq(projectGroupMembers.projectId, projectId), inArray(projectGroupMembers.enrollmentId, plan.unplace)));
  }
  const before = new Map(copy.groups.map((g) => [g.id, g]));
  const renamed = plan.update.filter((u) => before.get(u.id)!.name !== u.name || before.get(u.id)!.slug !== u.slug);
  for (const u of renamed) {
    await tx.update(projectGroups).set({ name: `~${u.id}`, slug: `~${u.id}` }).where(eq(projectGroups.id, u.id));
  }
  for (const u of plan.update) {
    await tx.update(projectGroups).set({ name: u.name, slug: u.slug, position: u.position }).where(eq(projectGroups.id, u.id));
  }
  const bySource = new Map<string, string>();
  const deleted = new Set(plan.delete);
  for (const g of copy.groups) if (g.sourceGroupId !== null && !deleted.has(g.id)) bySource.set(g.sourceGroupId, g.id);
  if (plan.create.length > 0) {
    const rows = plan.create.map((c) => ({ id: randomUUID(), projectId, name: c.name, slug: c.slug, position: c.position, sourceGroupId: c.sourceGroupId, createdAt: now }));
    await tx.insert(projectGroups).values(rows);
    for (const r of rows) bySource.set(r.sourceGroupId, r.id);
  }
  const arrivals = plan.place.filter((p) => p.from === null);
  if (arrivals.length > 0) {
    await tx.insert(projectGroupMembers).values(
      arrivals.map((p) => ({ id: randomUUID(), projectId, groupId: bySource.get(p.sourceGroupId)!, enrollmentId: p.enrollmentId, addedAt: now })),
    );
  }
  for (const p of plan.place.filter((m) => m.from !== null)) {
    await tx
      .update(projectGroupMembers)
      .set({ groupId: bySource.get(p.sourceGroupId)!, addedAt: now })
      .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, p.enrollmentId)));
  }
}

/** The plan bringing one copy in step with `set`, and whether it reaches a group with a repository (`planReachesRepoGroup`). */
async function planCopy(tx: Tx, projectId: string, set: SetState) {
  const copy = await copyState(tx, projectId);
  const plan = groupSyncPlan(set, copy);
  return { projectId, copy, plan, reachesRepo: planReachesRepoGroup(copy, plan, copy.staffSeats) };
}

/**
 * Each copy of `copies` ({@link followingCopies}, locked by the caller)
 * brought in step with set `setId` as the caller's transaction now holds
 * it — or none, {@link RepoGroupTouched} naming EVERY project whose step
 * would reach a group with a repository. Returns the projects whose copy
 * changed (their staff's hint).
 */
export async function stepCopies(tx: Tx, setId: string, copies: readonly { id: string }[], now: Date): Promise<string[]> {
  if (copies.length === 0) return [];
  const set = await setState(tx, setId);
  const plans = [];
  for (const { id } of copies) plans.push(await planCopy(tx, id, set));
  const held = plans.filter((p) => p.reachesRepo).map((p) => p.projectId);
  if (held.length > 0) throw new RepoGroupTouched(held);
  const changed = plans.filter((p) => !isEmptyPlan(p.plan));
  for (const p of changed) await applyPlan(tx, p.projectId, p.copy, p.plan, now);
  return changed.map((p) => p.projectId);
}

/**
 * The project's copy made anew from set `setId`, or deleted when null
 * (ADR-070 §4: made when the project names the set, replaced when it names
 * another). The caller holds the project's row and the set's FOR SHARE.
 */
export async function replaceGroupCopy(tx: Tx, projectId: string, setId: string | null, now: Date): Promise<void> {
  await assertNoGroupRepo(tx, projectId);
  await tx.delete(projectGroups).where(eq(projectGroups.projectId, projectId));
  if (setId === null) return;
  const { copy, plan } = await planCopy(tx, projectId, await setState(tx, setId));
  await applyPlan(tx, projectId, copy, plan, now);
}
