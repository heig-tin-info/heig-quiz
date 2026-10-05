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
 * GitHub (`syncSteps`, `completeDeparture`, `completeArrival`,
 * `settleSync`).
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
 */
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from "drizzle-orm";

import type { GroupConsequence, GroupConsequences } from "@quiz/contracts";
import {
  consequenceDelta,
  groupSyncPlan,
  isEmptyPlan,
  splitPlan,
  type copyFollows,
  type CopyState,
  type DeferredSteps,
  type GroupSyncPlan,
  type PlanConsequence,
  type SetState,
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
import { RevokeFailed } from "./access.js";

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
 * A copy group has a repository on GitHub, or soon will: its row exists —
 * from the first Accept's claim on, so that no member moves while it is
 * provisioned (the members it invites are read after it) — unless that
 * Accept failed before GitHub made the repository (`error`, no id: nothing
 * to freeze). Over `project_groups` left-joined to its `project_repos` row.
 */
const HAS_REPO = sql<boolean>`(${projectRepos.id} IS NOT NULL AND (${projectRepos.provisionStatus} <> 'error' OR ${projectRepos.githubRepoId} IS NOT NULL))`;

type Copy = CopyState & { staffSeats: Set<string> };

/** The copy: each group's slug fixed once it has a repository ({@link HAS_REPO}), its stop; and the staff seats in it. */
async function copyState(tx: Tx, projectId: string): Promise<Copy> {
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

/** One copy's plan against `set`, split between now and the job (`splitPlan`). */
function planOf(projectId: string, copy: Copy, set: SetState) {
  const plan = groupSyncPlan(set, copy);
  return { projectId, copy, plan, split: splitPlan(copy, plan, copy.staffSeats) };
}

/** No move waits for GitHub. */
const nothingDeferred = (later: DeferredSteps): boolean => later.place.length === 0 && later.unplace.length === 0;

const CLEARED = { departingAt: null, revokeFailedAt: null, revokeFailedReason: null } as const;

/**
 * The departures `consequences` name marked on their member rows
 * (`departing_at`, kept from its first marking), and every other mark of
 * the project's copy cleared with its *access to revoke*: the set put that
 * student back, or a stop holds them.
 */
async function markDepartures(tx: Tx, projectId: string, consequences: readonly PlanConsequence[], now: Date): Promise<void> {
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

/** The consequences named for the staff, in a canonical order, and their digest (SHA-256 of that order's keys). */
async function describeConsequences(tx: Tx, added: (PlanConsequence & { projectId: string })[]): Promise<GroupConsequences> {
  const groups = await tx
    .select({ id: projectGroups.id, name: projectGroups.name, projectName: projects.name, repo: projectRepos.fullName })
    .from(projectGroups)
    .innerJoin(projects, eq(projects.id, projectGroups.projectId))
    .leftJoin(projectRepos, eq(projectRepos.groupId, projectGroups.id))
    .where(inArray(projectGroups.id, [...new Set(added.map((c) => c.groupId))]));
  const lines = await tx
    .select({ id: enrollments.id, nom: enrollments.nom, prenom: enrollments.prenom })
    .from(enrollments)
    .where(inArray(enrollments.id, [...new Set(added.map((c) => c.enrollmentId))]));
  const groupOf = new Map(groups.map((g) => [g.id, g]));
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  const keyed = added.map((c) => ({ c, key: [c.projectId, c.groupId, c.enrollmentId, c.kind] })).sort((a, b) => (a.key.join(" ") < b.key.join(" ") ? -1 : 1));
  const consequences = keyed.map(({ c }): GroupConsequence => {
    const group = groupOf.get(c.groupId)!;
    const line = lineOf.get(c.enrollmentId)!;
    return {
      projectId: c.projectId,
      projectName: group.projectName,
      groupId: c.groupId,
      groupName: group.name,
      repo: group.repo,
      enrollmentId: c.enrollmentId,
      nom: line.nom,
      prenom: line.prenom,
      kind: c.kind,
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
    if (!nothingDeferred(p.split.later)) {
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
 * The copy groups `where` selects stop following, for good (the amendment
 * of 2026-10-05): written in the transaction of the deadline applied (a
 * repository's, or the project's) or of the archive, under the project's
 * row lock. Their pending departures are dropped with their *access to
 * revoke*: a stopped group keeps its members — unless the `group.sync` job
 * already revoked one, whose departure then completes
 * (`completeDeparture`).
 */
export async function stopGroups(tx: Tx, where: SQL | undefined, now: Date): Promise<void> {
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
      ),
    );
}

// ---------------------------------------------------------------- the job's steps (`groupSync.ts`)

/**
 * The job's frame on one project: its set FOR SHARE (a set's write waits),
 * then the project FOR UPDATE — the order of a set's write. The set the
 * project follows, or null when it no longer follows (its groups stopped,
 * or no set).
 */
async function lockSync(tx: Tx, projectId: string): Promise<string | null> {
  const [named] = await tx.select({ setId: projects.groupSetId }).from(projects).where(eq(projects.id, projectId));
  if (named?.setId) await tx.select({ id: groupSets.id }).from(groupSets).where(eq(groupSets.id, named.setId)).for("share");
  const [project] = await tx
    .select({ setId: projects.groupSetId, groupsStoppedAt: projects.groupsStoppedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  return project?.setId && project.groupsStoppedAt === null ? project.setId : null;
}

/** The project's moves waiting for GitHub, as its job finds them. */
export interface SyncSteps {
  /** A student leaving copy group `groupId`, which has a repository (for another group, or for none). */
  departures: { enrollmentId: string; groupId: string }[];
  /** A student joining the copy group of `sourceGroupId`, which has a repository, from no group or from a group without one. */
  arrivals: { enrollmentId: string; sourceGroupId: string }[];
}

/** The plan of the copy against its set, under the job's locks; null when it no longer follows. */
async function syncPlan(tx: Tx, projectId: string) {
  const setId = await lockSync(tx, projectId);
  if (setId === null) return null;
  return planOf(projectId, await copyState(tx, projectId), await setState(tx, setId));
}

/**
 * What the job has to do, read under its locks, the departures marked as
 * the plan now says (the set's write marked them; a stop dropped some).
 */
export async function syncSteps(db: Db, projectId: string, now: Date): Promise<SyncSteps> {
  return db.transaction(async (tx) => {
    const found = await syncPlan(tx, projectId);
    if (found === null) return { departures: [], arrivals: [] };
    const { copy, split } = found;
    await markDepartures(tx, projectId, split.consequences, now);
    const groupOf = new Map(copy.members.map((m) => [m.enrollmentId, m.groupId]));
    const leaving = new Set(split.consequences.filter((c) => c.kind === "lose").map((c) => c.enrollmentId));
    return {
      departures: [...leaving].map((enrollmentId) => ({ enrollmentId, groupId: groupOf.get(enrollmentId)! })),
      arrivals: split.later.place.filter((p) => !leaving.has(p.enrollmentId)).map(({ enrollmentId, sourceGroupId }) => ({ enrollmentId, sourceGroupId })),
    };
  });
}

/**
 * Whether work is left once a pass of the job is done, under its locks:
 * nothing waiting clears the project's due mark and its failures; work
 * left keeps it — after a failed pass, from `retryAt(failures)` on (the
 * capped backoff), its failures counted.
 */
export async function settleSync(db: Db, projectId: string, now: Date, retryAt: ((failures: number) => Date) | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await syncPlan(tx, projectId);
    if (found !== null) await markDepartures(tx, projectId, found.split.consequences, now);
    const waiting = found !== null && !nothingDeferred(found.split.later);
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

/** The set group the student is in (never a staff seat), and the copy group following it when it follows. */
async function placeInSet(tx: Tx, projectId: string, setId: string | null, enrollmentId: string) {
  const [placed] =
    setId === null
      ? []
      : await tx
          .select({ groupId: studentGroupMembers.groupId })
          .from(studentGroupMembers)
          .innerJoin(enrollments, and(eq(enrollments.id, studentGroupMembers.enrollmentId), eq(enrollments.staff, false)))
          .where(and(eq(studentGroupMembers.setId, setId), eq(studentGroupMembers.enrollmentId, enrollmentId)));
  if (!placed) return { sourceGroupId: null, target: null };
  const [target] = await tx
    .select({ id: projectGroups.id, stoppedAt: projectGroups.stoppedAt })
    .from(projectGroups)
    .where(and(eq(projectGroups.projectId, projectId), eq(projectGroups.sourceGroupId, placed.groupId)));
  return { sourceGroupId: placed.groupId, target: target && target.stoppedAt === null ? target.id : null };
}

/** The member row of `enrollmentId` in the copy, locked FOR UPDATE, with its group's source and whether that group has a repository. */
async function memberForUpdate(tx: Tx, projectId: string, enrollmentId: string) {
  const [row] = await tx
    .select({ member: projectGroupMembers, sourceGroupId: projectGroups.sourceGroupId, hasRepo: HAS_REPO })
    .from(projectGroupMembers)
    .innerJoin(projectGroups, eq(projectGroups.id, projectGroupMembers.groupId))
    .leftJoin(projectRepos, eq(projectRepos.groupId, projectGroups.id))
    .where(and(eq(projectGroupMembers.projectId, projectId), eq(projectGroupMembers.enrollmentId, enrollmentId)))
    .for("update", { of: projectGroupMembers });
  return row ?? null;
}

/** The set the project names, read under the job's locks. */
async function namedSet(tx: Tx, projectId: string): Promise<string | null> {
  const [project] = await tx.select({ setId: projects.groupSetId }).from(projects).where(eq(projects.id, projectId));
  return project?.setId ?? null;
}

/**
 * How a departure ended: `moved` into copy group `to` (whose repository, if
 * any, is then invited on); `left` the copy (the set has the student in no
 * group, or in one whose copy does not follow); `kept` in its group, the set
 * having put the student back (their access, revoked meanwhile, is then
 * given again); `gone` — the row is no longer there (the roster line
 * removed) or no longer in that group.
 */
export type Departure = { outcome: "moved"; to: string } | { outcome: "left" } | { outcome: "kept" } | { outcome: "gone" };

/**
 * The last step of a departure from copy group `groupId`, once GitHub
 * revoked the student's access to its repository `repoId`: under the job's
 * locks and the member row FOR UPDATE, refused ({@link RevokeFailed}) while
 * an account of the line on that repository is live — recorded since the
 * revocation read them —, then the row moved where the set now has the
 * student, or out of the copy. A stop that landed after the revocation does
 * not hold it: the copy never claims an access GitHub no longer gives; only
 * the arrival is then skipped.
 */
export async function completeDeparture(db: Db, projectId: string, enrollmentId: string, groupId: string, repoId: string, now: Date): Promise<Departure> {
  return db.transaction(async (tx): Promise<Departure> => {
    const follows = (await lockSync(tx, projectId)) !== null;
    const row = await memberForUpdate(tx, projectId, enrollmentId);
    if (!row || row.member.groupId !== groupId) return { outcome: "gone" };
    const place = await placeInSet(tx, projectId, await namedSet(tx, projectId), enrollmentId);
    if (place.sourceGroupId !== null && place.sourceGroupId === row.sourceGroupId) {
      await tx.update(projectGroupMembers).set(CLEARED).where(eq(projectGroupMembers.id, row.member.id));
      return { outcome: "kept" };
    }
    const [live] = await tx
      .select({ repo: projectRepos.fullName })
      .from(projectRepoAccess)
      .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
      .where(and(eq(projectRepoAccess.repoId, repoId), eq(projectRepoAccess.enrollmentId, enrollmentId), isNull(projectRepoAccess.revokedAt)));
    if (live) throw new RevokeFailed(live.repo);
    if (follows && place.target !== null) {
      await tx.update(projectGroupMembers).set({ groupId: place.target, addedAt: now, ...CLEARED }).where(eq(projectGroupMembers.id, row.member.id));
      return { outcome: "moved", to: place.target };
    }
    await tx.delete(projectGroupMembers).where(eq(projectGroupMembers.id, row.member.id));
    return { outcome: "left" };
  });
}

/**
 * An arrival into the copy group following set group `sourceGroupId`
 * (which has a repository), written before its invitation: under the job's
 * locks, only while the set still places the student there, that group
 * follows and the student is in no group with a repository (that is a
 * departure, which comes first). The copy group, or null when nothing was
 * written.
 */
export async function completeArrival(db: Db, projectId: string, enrollmentId: string, sourceGroupId: string, now: Date): Promise<string | null> {
  return db.transaction(async (tx) => {
    const setId = await lockSync(tx, projectId);
    if (setId === null) return null;
    const place = await placeInSet(tx, projectId, setId, enrollmentId);
    if (place.sourceGroupId !== sourceGroupId || place.target === null) return null;
    const row = await memberForUpdate(tx, projectId, enrollmentId);
    if (row?.member.groupId === place.target) return place.target;
    if (row?.hasRepo) return null;
    if (row) {
      await tx.update(projectGroupMembers).set({ groupId: place.target, addedAt: now, ...CLEARED }).where(eq(projectGroupMembers.id, row.member.id));
    } else {
      await tx.insert(projectGroupMembers).values({ id: randomUUID(), projectId, groupId: place.target, enrollmentId, addedAt: now });
    }
    return place.target;
  });
}

/** *Access to revoke* on the member row of a departure GitHub refused, while it still departs from `groupId`. */
export async function flagRevokeFailed(db: Db, projectId: string, enrollmentId: string, groupId: string, reason: string, now: Date): Promise<void> {
  await db
    .update(projectGroupMembers)
    .set({ revokeFailedAt: now, revokeFailedReason: reason.slice(0, 300) })
    .where(
      and(
        eq(projectGroupMembers.projectId, projectId),
        eq(projectGroupMembers.enrollmentId, enrollmentId),
        eq(projectGroupMembers.groupId, groupId),
        isNotNull(projectGroupMembers.departingAt),
      ),
    );
}

/** The copy groups a member the set moved out still reaches, GitHub having refused their revocation: the page's *access to revoke*. */
export async function groupsWithAccessToRevoke(db: Db | Tx, projectId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ groupId: projectGroupMembers.groupId })
    .from(projectGroupMembers)
    .where(and(eq(projectGroupMembers.projectId, projectId), isNotNull(projectGroupMembers.revokeFailedAt)));
  return new Set(rows.map((r) => r.groupId));
}
