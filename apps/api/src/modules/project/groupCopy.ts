/**
 * A group project's copy of its group set (ADR-070 §4; merge tasks M3-15a,
 * M3-15b-2): `project_groups` and `project_group_members`, this module's
 * tables, which the `group` module never writes. It calls these, through
 * `service.ts`, inside its own transaction:
 *
 * - `followingCopies` — the projects whose copy follows a set, locked;
 * - `copiesBefore` — their copies and the consequences already waiting
 *   for GitHub, read before the write;
 * - `stepCopies` — each of them brought in step with the set, by the pure
 *   diff of `groupSyncPlan` (`@quiz/domain`), as far as it needs no GitHub.
 *
 * And the lifecycle calls `replaceGroupCopy` when a draft names a set,
 * another one, or none; the ticker and the archive call `stopGroups`; the
 * `group.sync` job (`groupSync.ts`) the steps of a move that waits for
 * GitHub (`syncSteps`, `beginDeparture`, `completeDeparture`,
 * `completeArrival`, `beginStrayRevocation`, `settleSync`); the project
 * page reads `reposWithAccessToRevoke` ({@link STRAY_GRANT}); *Resync with
 * the set* (`groupResync.ts`) the copy's work with its stops lifted
 * (`copyWork`).
 *
 * **Lock order** — the set, then its projects in id order, then a copy's
 * member rows: a set's write locks its set row FOR UPDATE, then the
 * projects naming it here; the job locks the set FOR SHARE, then its
 * project FOR UPDATE; a project's patch locks the set it names FOR SHARE
 * before its own row; the ticker locks projects only. A project whose
 * deadline is applied, or that is archived, in between is re-read under its
 * lock (`groups_stopped_at`) and left as it stands.
 *
 * The copy is the students' side of the set: a staff seat (ADR-018) is
 * never in it, even a line that became one after it was placed (D6).
 *
 * **Each group follows until its own stop** (`stopped_at`, the amendment of
 * 2026-10-05): the first of its repository's deadline applied and its
 * project's groups stopped. A stopped group keeps its name and its members;
 * a move with one stopped end is held.
 *
 * **A copy group with a repository** (M3-15b-1) has its slug — its
 * repository's name — fixed, its name still follows (`slugFixed`), and it is
 * never deleted here: a set's write that would delete it is refused whole
 * ({@link RepoGroupTouched}, `409 has_repo`). A move out of it, or into it,
 * is the `group.sync` job's (M3-15b-2): the set's write applies the rest,
 * marks the departures (`departing_at`, which `recordGrant` honours) and
 * the project due; its consequences on GitHub must have been confirmed
 * ({@link ConfirmationNeeded}, `409 needs_confirmation`). A staff seat
 * leaving it is no GitHub change: the seat's accounts were revoked when it
 * became one (`selfEnroll`, `access.ts`). A draft holds no repository
 * (`replaceGroupCopy`).
 *
 * **A confirmed resync** (M3-15b-2b) stores its consequences' keys on the
 * project (`group_resync`): the job applies them with the copy's stops
 * lifted, frozen groups included (`syncWork`, `@quiz/domain`), and their
 * departure marks survive a stop and a set's write ({@link RESYNC_DEPARTURE}).
 */
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, exists, inArray, isNotNull, isNull, notInArray, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { GroupConsequence, GroupConsequences } from "@quiz/contracts";
import {
  consequenceDelta,
  consequenceKey,
  copyFollows,
  groupSyncPlan,
  isEmptyPlan,
  resyncPlan,
  splitPlan,
  syncWork,
  type CopyState,
  type GroupSyncPlan,
  type PlanConsequence,
  type ResyncPlan,
  type SetState,
  type SyncStep,
  deadlinePassed,
} from "@quiz/domain";

import type { Db, Tx } from "../../db/client.js";
import {
  enrollments,
  groupSets,
  projectGroupMembers,
  projectGroups,
  projectRepoAccess,
  projectRepos,
  projects,
  studentGroupMembers,
  studentGroups,
} from "../../db/schema.js";
import { assertNoLiveGrant, type GrantRow } from "./access.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** A set's write would delete a copy group with a repository of each of `projectIds`: the group module's `409 has_repo`. */
export class RepoGroupTouched extends Error {
  constructor(readonly projectIds: readonly string[]) {
    super(`projects ${projectIds.join(", ")}: the step deletes a group with a repository`);
    this.name = "RepoGroupTouched";
  }
}

/** A set's write adds GitHub consequences its request did not confirm: the group module's `409 needs_confirmation`. */
export class ConfirmationNeeded extends Error {
  constructor(readonly details: GroupConsequences) {
    super(`${details.consequences.length} GitHub consequence(s) to confirm`);
    this.name = "ConfirmationNeeded";
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
async function setState(tx: Db | Tx, setId: string): Promise<SetState> {
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
 * A copy group has a repository on GitHub, or soon will: its row exists —
 * from the first Accept's claim on, so that no member moves while it is
 * provisioned (the members it invites are read after it) — unless that
 * Accept failed before GitHub made the repository (`error`, no id: nothing
 * to freeze). Over `project_groups` left-joined to its `project_repos` row.
 */
const HAS_REPO = sql<boolean>`(${projectRepos.id} IS NOT NULL AND (${projectRepos.provisionStatus} <> 'error' OR ${projectRepos.githubRepoId} IS NOT NULL))`;

/**
 * A set's groups are frozen to its students (F-PROJ-22, M3-17): a group of a
 * copy of it — any project naming it, stopped copies and archived projects
 * included — has a repository ({@link HAS_REPO}). As an `EXISTS` over
 * `setId` (a column of the outer query, or an id), so a read takes it as a
 * column; the students' writes are refused on it before any step, so none
 * ever reaches `needs_confirmation`.
 */
export function setFrozen(db: Db | Tx, setId: AnyColumn | string): SQL {
  return exists(
    db
      .select({ id: projectRepos.id })
      .from(projects)
      .innerJoin(projectGroups, eq(projectGroups.projectId, projects.id))
      .innerJoin(projectRepos, eq(projectRepos.groupId, projectGroups.id))
      .where(and(eq(projects.groupSetId, setId), HAS_REPO)),
  );
}

export type Copy = CopyState & { staffSeats: Set<string> };

/** The copy: each group's slug fixed once it has a repository ({@link HAS_REPO}), its stop; and the staff seats in it. */
async function copyState(tx: Db | Tx, projectId: string): Promise<Copy> {
  const groups = await tx
    .select({
      id: projectGroups.id,
      name: projectGroups.name,
      slug: projectGroups.slug,
      position: projectGroups.position,
      sourceGroupId: projectGroups.sourceGroupId,
      slugFixed: HAS_REPO,
      stopped: sql<boolean>`(${projectGroups.stoppedAt} IS NOT NULL)`,
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
export async function applyPlan(tx: Tx, projectId: string, copy: CopyState, plan: GroupSyncPlan, now: Date): Promise<void> {
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

/** One copy's plan against `set`, split between now and the job (`splitPlan`). */
function planOf(projectId: string, copy: Copy, set: SetState) {
  const plan = groupSyncPlan(set, copy);
  return { projectId, copy, plan, split: splitPlan(copy, plan, copy.staffSeats) };
}

const CLEARED = { departingAt: null } as const;

/**
 * A member row's departure is one a confirmed resync owes (M3-15b-2b): its
 * `lose` key is in its project's `group_resync`. Its mark is the job's to
 * clear — never a stop's (a repository's deadline applied mid-resync) nor
 * a set's write's. The SQL twin of `consequenceKey` (`@quiz/domain`),
 * whose format is persisted: the two change together, with a migration.
 */
const RESYNC_DEPARTURE = sql`EXISTS (SELECT 1 FROM ${projects} WHERE ${projects.id} = ${projectGroupMembers.projectId}
  AND ${projects.groupResync} @> jsonb_build_array(${projectGroupMembers.groupId}::text || ':' || ${projectGroupMembers.enrollmentId}::text || ':lose'))`;

/**
 * The departures `consequences` name marked on their member rows
 * (`departing_at`, kept from its first marking), and every other mark of
 * the project's copy cleared — the set put that student back, or a stop
 * holds them — but a resync's ({@link RESYNC_DEPARTURE}).
 */
export async function markDepartures(tx: Tx, projectId: string, consequences: readonly PlanConsequence[], now: Date): Promise<void> {
  const leaving = consequences.filter((c) => c.kind === "lose").map((c) => c.enrollmentId);
  const ofProject = eq(projectGroupMembers.projectId, projectId);
  if (leaving.length > 0) {
    await tx
      .update(projectGroupMembers)
      .set({ departingAt: now })
      .where(and(ofProject, inArray(projectGroupMembers.enrollmentId, leaving), isNull(projectGroupMembers.departingAt)));
  }
  await tx
    .update(projectGroupMembers)
    .set(CLEARED)
    .where(
      and(
        ofProject,
        isNotNull(projectGroupMembers.departingAt),
        leaving.length > 0 ? notInArray(projectGroupMembers.enrollmentId, leaving) : undefined,
        sql`NOT ${RESYNC_DEPARTURE}`,
      ),
    );
}

// ---------------------------------------------------------------- a set's write

/** The following copies as a set's write found them, and their consequences already waiting for GitHub. */
export interface CopiesBefore {
  copies: Map<string, Copy>;
  waiting: Map<string, PlanConsequence[]>;
}

/** Read under the set's lock, BEFORE the write: what {@link stepCopies} compares the write's consequences with. */
export async function copiesBefore(tx: Tx, setId: string, following: readonly { id: string }[]): Promise<CopiesBefore> {
  const before: CopiesBefore = { copies: new Map(), waiting: new Map() };
  if (following.length === 0) return before;
  const set = await setState(tx, setId);
  for (const { id } of following) {
    const copy = await copyState(tx, id);
    before.copies.set(id, copy);
    before.waiting.set(id, planOf(id, copy, set).split.consequences);
  }
  return before;
}

/**
 * The consequences named for the staff, in a canonical order, and their
 * digest (SHA-256 of that order's keys, `project:group:line:kind`): each
 * `frozen` when its copy group stopped; a resync's R3 arrival
 * (`acceptClosed`) with no repository — a group whose provisioning failed
 * before GitHub made one has none, its row's name notwithstanding — and,
 * into a group the resync creates, named after the set's group.
 */
export async function describeConsequences(tx: Tx, added: (PlanConsequence & { projectId: string })[]): Promise<GroupConsequences> {
  const ids = [...new Set(added.map((c) => c.groupId))];
  const copied = await tx
    .select({ id: projectGroups.id, name: projectGroups.name, repo: projectRepos.fullName, stoppedAt: projectGroups.stoppedAt })
    .from(projectGroups)
    .leftJoin(projectRepos, eq(projectRepos.groupId, projectGroups.id))
    .where(inArray(projectGroups.id, ids));
  const groupOf = new Map<string, { name: string; repo: string | null; stoppedAt: Date | null }>(copied.map((g) => [g.id, g]));
  const fresh = ids.filter((id) => !groupOf.has(id));
  if (fresh.length > 0) {
    const ofSet = await tx.select({ id: studentGroups.id, name: studentGroups.name }).from(studentGroups).where(inArray(studentGroups.id, fresh));
    for (const g of ofSet) groupOf.set(g.id, { name: g.name, repo: null, stoppedAt: null });
  }
  const named = await tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(inArray(projects.id, [...new Set(added.map((c) => c.projectId))]));
  const projectOf = new Map(named.map((p) => [p.id, p.name]));
  const lines = await tx
    .select({ id: enrollments.id, nom: enrollments.nom, prenom: enrollments.prenom })
    .from(enrollments)
    .where(inArray(enrollments.id, [...new Set(added.map((c) => c.enrollmentId))]));
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const keyed = added.map((c) => ({ c, key: `${c.projectId}:${consequenceKey(c)}` })).sort((a, b) => (a.key < b.key ? -1 : 1));
  const consequences = keyed.map(({ c }): GroupConsequence => {
    const group = groupOf.get(c.groupId)!;
    const line = lineOf.get(c.enrollmentId)!;
    return {
      projectId: c.projectId,
      projectName: projectOf.get(c.projectId)!,
      groupId: c.groupId,
      groupName: group.name,
      repo: c.acceptClosed ? null : group.repo,
      enrollmentId: c.enrollmentId,
      nom: line.nom,
      prenom: line.prenom,
      kind: c.kind,
      frozen: group.stoppedAt !== null,
      acceptClosed: c.acceptClosed === true,
    };
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(keyed.map((k) => k.key)))
    .digest("hex");
  return { consequences, digest };
}

/** What a set's write did to the copies: the projects whose copy changed, and those whose moves now wait for the job. */
export interface Stepped {
  changed: string[];
  due: string[];
}

/**
 * Each copy of `before` brought in step with set `setId` as the caller's
 * transaction now holds it, as far as it needs no GitHub; the moves out of
 * or into a group with a repository left to the `group.sync` job, their
 * departures marked and the project due (`group_sync_due_at`). Refused
 * whole by {@link RepoGroupTouched} (a group with a repository deleted, in
 * any copy) or {@link ConfirmationNeeded} (the consequences the write ADDS
 * to those already waiting, unless `confirm` is their digest).
 */
export async function stepCopies(tx: Tx, setId: string, before: CopiesBefore, opts: { now: Date; confirm?: string | undefined }): Promise<Stepped> {
  if (before.copies.size === 0) return { changed: [], due: [] };
  const set = await setState(tx, setId);
  const plans = [...before.copies].map(([id, copy]) => planOf(id, copy, set));
  const held = plans.filter((p) => p.split.repoGroupsDeleted.length > 0).map((p) => p.projectId);
  if (held.length > 0) throw new RepoGroupTouched(held);
  const added = plans.flatMap((p) =>
    consequenceDelta(before.waiting.get(p.projectId)!, p.split.consequences).map((c) => ({ ...c, projectId: p.projectId })),
  );
  if (added.length > 0) {
    const details = await describeConsequences(tx, added);
    if (opts.confirm !== details.digest) throw new ConfirmationNeeded(details);
  }
  const stepped: Stepped = { changed: [], due: [] };
  for (const p of plans) {
    if (!isEmptyPlan(p.split.now)) {
      await applyPlan(tx, p.projectId, p.copy, p.split.now, opts.now);
      stepped.changed.push(p.projectId);
    }
    await markDepartures(tx, p.projectId, p.split.consequences, opts.now);
    if (p.split.consequences.length > 0) {
      await tx.update(projects).set({ groupSyncDueAt: opts.now }).where(eq(projects.id, p.projectId));
      stepped.due.push(p.projectId);
    }
  }
  return stepped;
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
  const copy = await copyState(tx, projectId);
  await applyPlan(tx, projectId, copy, groupSyncPlan(await setState(tx, setId), copy), now);
}

// ---------------------------------------------------------------- the stops

/**
 * The copy groups of `projectIds`, or the groups `groupIds`, stop following,
 * for good (the amendment of 2026-10-05): written in the transaction of the
 * deadline applied (a repository's, or the project's) or of the archive,
 * under the project's row lock. Their pending departures are dropped: a
 * stopped group keeps its members — unless the
 * `group.sync` job already marked one's revocation, whose departure then
 * completes (`completeDeparture`), or a confirmed resync owes it
 * ({@link RESYNC_DEPARTURE}): a resync lifts the stops.
 */
export async function stopGroups(tx: Tx, which: { projectIds: readonly string[] } | { groupIds: readonly string[] }, now: Date): Promise<void> {
  const where = "projectIds" in which ? inArray(projectGroups.projectId, [...which.projectIds]) : inArray(projectGroups.id, [...which.groupIds]);
  const stopped = await tx
    .update(projectGroups)
    .set({ stoppedAt: now })
    .where(and(where, isNull(projectGroups.stoppedAt)))
    .returning({ id: projectGroups.id });
  if (stopped.length === 0) return;
  await tx
    .update(projectGroupMembers)
    .set(CLEARED)
    .where(
      and(
        inArray(
          projectGroupMembers.groupId,
          stopped.map((g) => g.id),
        ),
        isNotNull(projectGroupMembers.departingAt),
        sql`NOT ${RESYNC_DEPARTURE}`,
      ),
    );
}

/**
 * The projects `ids` stop following their sets, for good (ADR-070 §4): the
 * deadline applied, or the archive — `groups_stopped_at` kept from its
 * first writing (a reopen or an unarchive never clears it), every group of
 * their copies stopped with them.
 */
export async function stopProjects(tx: Tx, ids: readonly string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx
    .update(projects)
    .set({ groupsStoppedAt: sql`coalesce(${projects.groupsStoppedAt}, ${now.toISOString()}::timestamptz)` })
    .where(inArray(projects.id, [...ids]));
  await stopGroups(tx, { projectIds: ids }, now);
}

// ---------------------------------------------------------------- stray grants

/**
 * A **stray grant** (M3-15b-2): an account not revoked (live, or its
 * revocation unconfirmed) on a GROUP repository whose roster line is not a
 * non-departing member of that repository's copy group — a departure the
 * job has not completed, or an access GitHub kept when an invitation could
 * not be taken back. Over `project_repo_access` joined to its
 * `project_repos` row. The `group.sync` job revokes them; the project page
 * flags their repository *access to revoke*.
 */
export const STRAY_GRANT = sql`(${projectRepoAccess.revokedAt} IS NULL AND ${projectRepos.groupId} IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ${projectGroupMembers} WHERE ${projectGroupMembers.groupId} = ${projectRepos.groupId}
    AND ${projectGroupMembers.enrollmentId} = ${projectRepoAccess.enrollmentId} AND ${projectGroupMembers.departingAt} IS NULL))`;

/** The stray grants of the project, with their repositories. */
async function strayGrants(db: Db | Tx, projectId: string) {
  return db
    .select({ grant: projectRepoAccess, repo: projectRepos })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .where(and(eq(projectRepos.projectId, projectId), STRAY_GRANT));
}

/**
 * The project's repositories flagged *access to revoke* (F-PROJ-13): a
 * stray grant on it — a departure not revoked yet, or one GitHub refused.
 */
export async function reposWithAccessToRevoke(db: Db | Tx, projectId: string): Promise<Set<string>> {
  return new Set((await strayGrants(db, projectId)).map((r) => r.repo.id));
}

// ---------------------------------------------------------------- the copy's work (`group.sync`, *Resync*)

/** What the copy's work is read with: the set it names, whether it follows, the resync's stored keys, whether Accept is closed. */
export interface WorkFrame {
  setId: string | null;
  follows: boolean;
  stored: readonly string[];
  acceptClosed: boolean;
}

/** The frame a project's row gives the copy's work: Accept closed is its deadline passed (R3). */
export const frameOf = (project: ProjectRow, now: Date): WorkFrame => ({
  setId: project.groupSetId,
  follows: project.groupSetId !== null && copyFollows(project),
  stored: project.groupResync,
  acceptClosed: deadlinePassed(project, now),
});

/** The copy's work ({@link copyWork}). */
export interface CopyWork {
  copy: Copy;
  /** The following copy's own plan, split; null once it stopped. */
  following: ReturnType<typeof planOf> | null;
  /** The plan with every stop lifted (`resyncPlan`): what a resync would do; against no group when the project names no set. */
  resync: ResyncPlan;
  /** What the job owes: the following copy's moves and the stored resync's (`syncWork`). */
  work: SyncStep[];
  /** The stored keys still owed. */
  kept: string[];
}

/**
 * The copy of `projectId` against its set, as {@link WorkFrame} says to read
 * it: the moves a following copy waits for, the plan with its stops lifted,
 * and the work the `group.sync` job owes. A stored resync is void once the
 * project names no set (only an archived one may lose it).
 */
export async function copyWork(db: Db | Tx, projectId: string, at: WorkFrame): Promise<CopyWork> {
  const copy = await copyState(db, projectId);
  const set = at.setId === null ? { groups: [], members: [] } : await setState(db, at.setId);
  const following = at.follows ? planOf(projectId, copy, set) : null;
  const resync = resyncPlan(set, copy, copy.staffSeats, at.acceptClosed);
  const { work, kept } = syncWork(following?.split.consequences ?? null, at.setId === null ? [] : resync.consequences, at.stored);
  return { copy, following, resync, work, kept };
}

// ---------------------------------------------------------------- the job's steps (`groupSync.ts`)

/**
 * The frame on one project: its set FOR SHARE (a set's write waits), then
 * the project FOR UPDATE — the order of a set's write; the job's, and a
 * resync's after its classroom. The project's row, and its frame
 * ({@link frameOf}); none for a project gone.
 */
export async function lockSync(tx: Tx, projectId: string, now: Date): Promise<{ project: ProjectRow | null; frame: WorkFrame }> {
  const [named] = await tx.select({ setId: projects.groupSetId }).from(projects).where(eq(projects.id, projectId));
  if (named?.setId) await tx.select({ id: groupSets.id }).from(groupSets).where(eq(groupSets.id, named.setId)).for("share");
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
  if (!project) return { project: null, frame: { setId: null, follows: false, stored: [], acceptClosed: false } };
  return { project, frame: frameOf(project, now) };
}

/** The copy's work under the job's locks, with its frame. */
async function jobWork(tx: Tx, projectId: string, now: Date): Promise<CopyWork & { frame: WorkFrame }> {
  const { frame } = await lockSync(tx, projectId, now);
  return { ...(await copyWork(tx, projectId, frame)), frame };
}

/** Whether the work owes, as a confirmed resync's, the departure of `enrollmentId` from copy group `groupId` (stops lifted). */
const owesResyncDeparture = (work: readonly SyncStep[], groupId: string, enrollmentId: string): boolean =>
  work.some((c) => c.resync && c.kind === "lose" && c.groupId === groupId && c.enrollmentId === enrollmentId);

/**
 * The job's work written back under its locks: the stored keys no longer
 * owed dropped, the departures marked as the work now says (the set's write
 * or the resync marked them; a stop dropped some).
 */
async function writeWork(tx: Tx, projectId: string, found: CopyWork & { frame: WorkFrame }, now: Date): Promise<void> {
  if (found.kept.length !== found.frame.stored.length) await tx.update(projects).set({ groupResync: found.kept }).where(eq(projects.id, projectId));
  await markDepartures(tx, projectId, found.work, now);
}

/** The project's work waiting for GitHub, as its job finds it. */
export interface SyncSteps {
  /** A student leaving copy group `groupId`, which has a repository (for another group, or for none); `resync` when a confirmed resync owes it. */
  departures: SyncStep[];
  /** A student joining copy group `groupId` — with a repository, or none (a resync's R3) — from no group or from a group without one. */
  arrivals: SyncStep[];
  /** The stray grants no departure covers (an invitation's failed take-back): revoked as they stand. */
  strays: { grantId: string; repoId: string }[];
}

/** What the job has to do, read under its locks ({@link writeWork}). */
export async function syncSteps(db: Db, projectId: string, now: Date): Promise<SyncSteps> {
  return db.transaction(async (tx) => {
    const found = await jobWork(tx, projectId, now);
    await writeWork(tx, projectId, found, now);
    const departures = found.work.filter((c) => c.kind === "lose");
    const leaving = new Set(departures.map((d) => d.enrollmentId));
    const covered = new Set(departures.map((d) => `${d.groupId}:${d.enrollmentId}`));
    return {
      departures,
      arrivals: found.work.filter((c) => c.kind === "join" && !leaving.has(c.enrollmentId)),
      strays: (await strayGrants(tx, projectId))
        .filter(({ grant, repo }) => !covered.has(`${repo.groupId}:${grant.enrollmentId}`))
        .map(({ grant, repo }) => ({ grantId: grant.id, repoId: repo.id })),
    };
  });
}

/**
 * Whether work is left once a pass of the job is done, under its locks — a
 * move waiting, a resync's step, or a stray grant: none clears the
 * project's due mark and its failures; work left keeps it — after a failed
 * pass, from `retryAt(failures)` on (the capped backoff), its failures
 * counted.
 */
export async function settleSync(db: Db, projectId: string, now: Date, retryAt: ((failures: number) => Date) | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await jobWork(tx, projectId, now);
    await writeWork(tx, projectId, found, now);
    const waiting = found.work.length > 0 || (await strayGrants(tx, projectId)).length > 0;
    if (!waiting) {
      await tx.update(projects).set({ groupSyncDueAt: null, groupSyncFailures: 0 }).where(eq(projects.id, projectId));
    } else if (retryAt !== null) {
      const [row] = await tx.select({ failures: projects.groupSyncFailures }).from(projects).where(eq(projects.id, projectId));
      const failures = row!.failures + 1;
      await tx.update(projects).set({ groupSyncDueAt: retryAt(failures), groupSyncFailures: failures }).where(eq(projects.id, projectId));
    } else {
      await tx.update(projects).set({ groupSyncDueAt: now }).where(eq(projects.id, projectId));
    }
    return waiting;
  });
}

/** The member row of `enrollmentId` in the copy, locked FOR UPDATE, with its group's source and stop. */
async function memberForUpdate(tx: Tx, projectId: string, enrollmentId: string) {
  const [row] = await tx
    .select({ member: projectGroupMembers, sourceGroupId: projectGroups.sourceGroupId, stoppedAt: projectGroups.stoppedAt })
    .from(projectGroupMembers)
    .innerJoin(projectGroups, eq(projectGroups.id, projectGroupMembers.groupId))
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, enrollmentId)))
    .for("update", { of: projectGroupMembers });
  return row ?? null;
}

/**
 * The first step of a departure from copy group `groupId`, whose
 * repository is `repoId`: under the job's locks and the member row FOR
 * UPDATE, only while the student still departs from that group and it has
 * not stopped — or the work owes it as a confirmed resync's, stops lifted
 * ({@link owesResyncDeparture}) —, then their grants there not revoked yet are marked `revoking_at` in the
 * same transaction, and returned for GitHub. Otherwise `held`: a stop or
 * the set's write came first, nothing is revoked and the copy is left as it
 * stands.
 */
export async function beginDeparture(db: Db, projectId: string, enrollmentId: string, groupId: string, repoId: string, now: Date): Promise<GrantRow[] | "held"> {
  return db.transaction(async (tx) => {
    const { work } = await jobWork(tx, projectId, now);
    const row = await memberForUpdate(tx, projectId, enrollmentId);
    if (!row || row.member.groupId !== groupId || row.member.departingAt === null) return "held";
    if (row.stoppedAt !== null && !owesResyncDeparture(work, groupId, enrollmentId)) return "held";
    return tx
      .update(projectRepoAccess)
      .set({ revokingAt: now })
      .where(and(eq(projectRepoAccess.repoId, repoId), eq(projectRepoAccess.enrollmentId, enrollmentId), isNull(projectRepoAccess.revokedAt)))
      .returning();
  });
}

/** A stray grant, still stray under the job's locks, marked `revoking_at` with its repository; null when it no longer is. */
export async function beginStrayRevocation(db: Db, projectId: string, grantId: string, now: Date): Promise<{ grant: GrantRow; repo: RepoRow } | null> {
  return db.transaction(async (tx) => {
    await lockSync(tx, projectId, now);
    const [found] = await tx
      .select({ grant: projectRepoAccess, repo: projectRepos })
      .from(projectRepoAccess)
      .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
      .where(and(eq(projectRepoAccess.id, grantId), STRAY_GRANT))
      .for("update", { of: projectRepoAccess });
    if (!found) return null;
    await tx.update(projectRepoAccess).set({ revokingAt: now }).where(eq(projectRepoAccess.id, grantId));
    return { grant: { ...found.grant, revokingAt: now }, repo: found.repo };
  });
}

/**
 * How a departure ended: `moved` into copy group `to` (whose repository, if
 * any, is then invited on); `left` the copy; `kept` in its group, the set
 * having put the student back (their access, revoked meanwhile, is then
 * given again); `gone` — the row is no longer there (the roster line
 * removed) or no longer in that group.
 */
export type Departure = { outcome: "moved"; to: string } | { outcome: "left" } | { outcome: "kept" } | { outcome: "gone" };

/**
 * The last step of a departure from copy group `groupId`, once GitHub
 * revoked the student's access to its repository `repoId`: under the job's
 * locks and the member row FOR UPDATE, refused (`RevokeFailed`) while
 * an account of the line there is not revoked — recorded since, or made
 * live again —, then decided from the plan of the copy against the set as
 * they now stand, every group counted as following (the access is gone:
 * the copy never claims one GitHub no longer gives): no step for the
 * student — in step, `kept`; a place into a copy group that truly follows
 * — `moved`; otherwise (no group, a stopped target, the project stopped) —
 * `left`. A departure a confirmed resync owes ({@link owesResyncDeparture})
 * counts its target as following (M3-15b-2b: a frozen A→B move ends
 * `moved`), as far as the resync confirmed it: an arrival the plan names as
 * a consequence — into a group with a repository, or one without while
 * Accept is closed (R3) — only if it is owed too.
 */
export async function completeDeparture(db: Db, projectId: string, enrollmentId: string, groupId: string, repoId: string, now: Date): Promise<Departure> {
  return db.transaction(async (tx): Promise<Departure> => {
    const { frame } = await lockSync(tx, projectId, now);
    const row = await memberForUpdate(tx, projectId, enrollmentId);
    if (!row || row.member.groupId !== groupId) return { outcome: "gone" };
    await assertNoLiveGrant(tx, enrollmentId, repoId);
    const { copy, resync, work } = await copyWork(tx, projectId, frame);
    const step = resync.plan.place.find((p) => p.enrollmentId === enrollmentId);
    if (!step && !resync.plan.unplace.includes(enrollmentId)) {
      await tx.update(projectGroupMembers).set(CLEARED).where(eq(projectGroupMembers.id, row.member.id));
      return { outcome: "kept" };
    }
    const resynced = owesResyncDeparture(work, groupId, enrollmentId);
    const to = step && copy.groups.find((g) => g.sourceGroupId === step.sourceGroupId && (resynced || !g.stopped));
    const owed = new Set(work.map(consequenceKey));
    // The arrival the plan names as a consequence, if any, must be owed too.
    const confirmed = (target: string) => {
      const join = resync.consequences.find((c) => c.kind === "join" && c.groupId === target && c.enrollmentId === enrollmentId);
      return join === undefined || owed.has(consequenceKey(join));
    };
    if (to && (resynced ? confirmed(to.id) : frame.follows)) {
      await tx.update(projectGroupMembers).set({ groupId: to.id, addedAt: now, ...CLEARED }).where(eq(projectGroupMembers.id, row.member.id));
      return { outcome: "moved", to: to.id };
    }
    await tx.delete(projectGroupMembers).where(eq(projectGroupMembers.id, row.member.id));
    return { outcome: "left" };
  });
}

/**
 * An arrival into copy group `groupId` (with a repository, or none for a
 * resync's R3), written before its invitation: under the job's locks, only
 * while the job still owes it, from no group or from a group without a
 * repository (a departure comes first). Whether it was written.
 */
export async function completeArrival(db: Db, projectId: string, enrollmentId: string, groupId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { work } = await jobWork(tx, projectId, now);
    const arriving = work.some((c) => c.kind === "join" && c.groupId === groupId && c.enrollmentId === enrollmentId);
    const leaving = work.some((c) => c.kind === "lose" && c.enrollmentId === enrollmentId);
    if (!arriving || leaving) return false;
    const row = await memberForUpdate(tx, projectId, enrollmentId);
    if (row) {
      await tx.update(projectGroupMembers).set({ groupId, addedAt: now, ...CLEARED }).where(eq(projectGroupMembers.id, row.member.id));
    } else {
      await tx.insert(projectGroupMembers).values({ id: randomUUID(), projectId, groupId, enrollmentId, addedAt: now });
    }
    return true;
  });
}
