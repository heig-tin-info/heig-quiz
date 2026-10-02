/**
 * A project's deadline, its rules and what moving it does (F-PROJ-03,
 * F-PROJ-09, F-PROJ-11; merge task M3-05a, ADR-064), ported from
 * heig-classroom's `deadline.ts` and the reopen of its
 * `modules/assignments/lifecycle.ts` (sync point `ab98cc0`). The ticker's
 * claims and the `project.deadline` job that apply it are `jobs.ts`.
 *
 * **Everything is per repository, on its EFFECTIVE deadline**: the staff's
 * individual extension (`project_repos.deadline_at`, D13 as amended
 * 2026-10-02) or the project's — `effectiveDeadline` of `@quiz/domain`, and
 * {@link EFFECTIVE_DEADLINE} its SQL twin: the lock or the commit, a late
 * receipt, the provisional and the definitive freeze. The project itself is
 * `locked` once ITS deadline is applied; a repository with a later one stays
 * open, and is applied, locked and frozen at its own.
 *
 * **What GitHub should hold** ({@link WANTS_LOCK}) is the staff's hand
 * (`staff_lock`), or else the deadline's lock (`deadline_applied_at` set,
 * strategy `lock`); **what it holds** is `locked_at`, written by the job
 * after the call, as the fact it is. Nothing here calls GitHub: a change of
 * either side is work the job finds ({@link NEEDS_WORK}).
 *
 * **Moving a deadline** ({@link effectiveDeadlineMoved}): the runs of the
 * repositories concerned requalified against their new effective deadline
 * and their score reselected; a repository whose deadline was applied and
 * now lies ahead is REOPENED — its freeze, its review and its deadline
 * commit forgotten, the staff's hand dropped — and its lock lifted by the
 * next job. Teacher scores and a release are kept, as in heig-classroom.
 */
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import type { ProjectRepoDeadlineState } from "@quiz/contracts";
import { checkpointDueAt, deadlineWantsLock, effectiveDeadline, receivedLate, reopens } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { gradeDispatches, projectCheckpoints, projectGradeRuns, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { ProjectError } from "./errors.js";
import { refreshScoreSelection } from "./grading.js";
import type { RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** The instant `at` as a timestamp parameter. */
export const ts = (at: Date): SQL => sql`${at.toISOString()}::timestamptz`;

// ---------------------------------------------------------------- the rules, in SQL

/** `effectiveDeadline` of `@quiz/domain`, over a `project_repos` row joined to its project. */
export const EFFECTIVE_DEADLINE = sql`coalesce(${projectRepos.deadlineAt}, ${projects.deadlineAt})`;

/**
 * A repository that takes deadline work: GitHub holds it for the project
 * (provisioned, not deleted), and its project is not archived — an archived
 * project takes no new work (#476). Over a `project_repos` row joined to
 * its project; {@link isLive} is its TypeScript twin.
 */
export const LIVE = and(
  isNull(projectRepos.deletedAt),
  eq(projectRepos.provisionStatus, "ok"),
  isNotNull(projectRepos.fullName),
  isNotNull(projectRepos.githubRepoId),
  isNull(projects.archivedAt),
)!;

/** {@link LIVE}, for a row already read. */
export function isLive(repo: RepoRow, project: ProjectRow): boolean {
  return (
    repo.deletedAt === null &&
    repo.provisionStatus === "ok" &&
    repo.fullName !== null &&
    repo.githubRepoId !== null &&
    project.archivedAt === null
  );
}

/** The SQL twin of `deadlineWantsLock` (`@quiz/domain`), for the scans only. */
export const WANTS_LOCK = sql<boolean>`coalesce(${projectRepos.staffLock}, ${projectRepos.deadlineAppliedAt} IS NOT NULL AND ${projects.deadlineStrategy} = 'lock')`;

/** The deadline commit is due: strategy `commit`, applied, not pushed yet, the repository writable. */
export const COMMIT_DUE = sql<boolean>`(${projects.deadlineStrategy} = 'commit' AND ${projectRepos.deadlineAppliedAt} IS NOT NULL
  AND ${projectRepos.deadlineCommittedAt} IS NULL AND ${projectRepos.archivedAt} IS NULL)`;

/** GitHub work is left on a repository: what it holds is not what it should, or a commit is due. */
export const NEEDS_WORK = sql`(${WANTS_LOCK} <> (${projectRepos.lockedAt} IS NOT NULL) OR ${COMMIT_DUE})`;


// ---------------------------------------------------------------- a deadline moved

/** The receipt of each run's head, the earliest, for the requalification. */
async function runsWithReceipts(tx: Tx, repoIds: string[]) {
  return tx
    .select({
      id: projectGradeRuns.id,
      repoId: projectGradeRuns.repoId,
      afterDeadline: projectGradeRuns.afterDeadline,
      receivedAt: sql<Date | null>`(SELECT min(${pushReceipts.receivedAt}) FROM ${pushReceipts}
        WHERE ${pushReceipts.githubRepoId} = ${projectRepos.githubRepoId} AND ${pushReceipts.headSha} = ${projectGradeRuns.headSha})`.mapWith(
        pushReceipts.receivedAt,
      ),
    })
    .from(projectGradeRuns)
    .innerJoin(projectRepos, eq(projectRepos.id, projectGradeRuns.repoId))
    .where(inArray(projectGradeRuns.repoId, repoIds));
}

/**
 * The effective deadline of `repoIds` (of `project`, as it now stands)
 * moved — the project's, for the repositories that follow it, or a
 * repository's own. In the caller's transaction:
 *
 * - a repository whose deadline was applied and now lies ahead is
 *   REOPENED: `deadline_applied_at`, `frozen_at`, the frozen and review
 *   slots, the deadline commit's mark and the staff's hand cleared, its
 *   `deadline` dispatches forgotten (F-PROJ-09); its lock is lifted by the
 *   next `project.deadline` job (`requestDeadlineWork`, the caller's);
 * - the staff's unlock of the others no longer holds either (it held until
 *   the deadline moved);
 * - every run's `after_deadline` requalified against the new effective
 *   deadline (`receivedLate`, the ingestion's rule), and the score
 *   reselected where it may have changed: a repository reopened (its
 *   frozen slot emptied) or one whose runs flipped.
 *
 * Teacher scores and a release are kept. The repositories reopened.
 */
export async function effectiveDeadlineMoved(tx: Tx, project: ProjectRow, repoIds: string[], now: Date): Promise<string[]> {
  if (repoIds.length === 0) return [];
  const repos = await tx.select().from(projectRepos).where(inArray(projectRepos.id, repoIds));
  const reopened = repos.filter((r) => reopens(r.deadlineAppliedAt, effectiveDeadline(r, project), now)).map((r) => r.id);
  if (reopened.length > 0) {
    await tx
      .update(projectRepos)
      .set({
        deadlineAppliedAt: null,
        frozenAt: null,
        frozenGradeRunId: null,
        reviewGradeRunId: null,
        deadlineCommittedAt: null,
        staffLock: null,
      })
      .where(inArray(projectRepos.id, reopened));
    await tx
      .delete(gradeDispatches)
      .where(and(inArray(gradeDispatches.repoId, reopened), eq(gradeDispatches.trigger, "deadline")));
  }
  await tx
    .update(projectRepos)
    .set({ staffLock: null })
    .where(and(inArray(projectRepos.id, repoIds), eq(projectRepos.staffLock, false)));

  const deadlines = new Map(repos.map((r) => [r.id, effectiveDeadline(r, project)]));
  const flips = { late: [] as string[], onTime: [] as string[] };
  const reselect = new Set(reopened);
  for (const run of await runsWithReceipts(tx, repoIds)) {
    const late = receivedLate(run.receivedAt, deadlines.get(run.repoId)!, now);
    if (late === run.afterDeadline) continue;
    (late ? flips.late : flips.onTime).push(run.id);
    reselect.add(run.repoId);
  }
  for (const [ids, afterDeadline] of [[flips.late, true], [flips.onTime, false]] as const) {
    if (ids.length > 0) await tx.update(projectGradeRuns).set({ afterDeadline }).where(inArray(projectGradeRuns.id, ids));
  }
  for (const repo of repos) if (reselect.has(repo.id)) await refreshScoreSelection(tx, { repo });
  return reopened;
}

/**
 * The J−n review checkpoints not yet dispatched follow a moved deadline
 * (F-PROJ-11): `checkpointDueAt`, calendar days in the school's zone, the
 * one rule of `@quiz/domain` — computed here, never in SQL.
 */
export async function rescheduleCheckpoints(tx: Tx, projectId: string, deadlineAt: Date): Promise<void> {
  const due = await tx
    .select({ id: projectCheckpoints.id, offsetDays: projectCheckpoints.offsetDays })
    .from(projectCheckpoints)
    .where(
      and(
        eq(projectCheckpoints.projectId, projectId),
        isNull(projectCheckpoints.dispatchedAt),
        isNotNull(projectCheckpoints.offsetDays),
      ),
    );
  for (const c of due) {
    await tx
      .update(projectCheckpoints)
      .set({ dueAt: checkpointDueAt(deadlineAt, c.offsetDays!) })
      .where(eq(projectCheckpoints.id, c.id));
  }
}

/**
 * The project's deadline moved by a patch, in the caller's transaction on
 * the row it locked: its checkpoints, the reminder re-armed (M3-09), and
 * the repositories that follow it ({@link effectiveDeadlineMoved}). A
 * deadline already applied moved later REOPENS the project (F-PROJ-09):
 * `published` again, its final review undone, audited
 * `project.deadline_reopened`. (A publication counting its duration moves
 * a draft's deadline: no repository yet, only `rescheduleCheckpoints`.)
 * The updated row.
 */
export async function projectDeadlineMoved(
  tx: Tx,
  before: ProjectRow,
  deadlineAt: Date,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRow> {
  const reopen = reopens(before.deadlineAppliedAt, deadlineAt, now);
  const [row] = await tx
    .update(projects)
    .set({
      deadlineAt,
      reminderSentAt: null,
      ...(reopen ? { state: "published" as const, deadlineAppliedAt: null, reviewDispatchedAt: null } : {}),
    })
    .where(eq(projects.id, before.id))
    .returning();
  await rescheduleCheckpoints(tx, before.id, deadlineAt);
  const following = await tx
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(and(eq(projectRepos.projectId, before.id), isNull(projectRepos.deadlineAt)));
  const repos = await effectiveDeadlineMoved(
    tx,
    row!,
    following.map((r) => r.id),
    now,
  );
  if (reopen) {
    await audit(tx, {
      ...actor,
      action: "project.deadline_reopened",
      subjectType: "project",
      subjectId: before.id,
      payload: { deadlineAt: deadlineAt.toISOString(), previous: before.deadlineAt.toISOString(), repos: repos.length },
    });
  }
  return row!;
}

// ---------------------------------------------------------------- one repository, by its staff

/** The repository's deadline and lock as they stand, for its staff (`ProjectRepoDeadlineState`). */
export async function repoDeadline(db: Db, repoId: string): Promise<ProjectRepoDeadlineState> {
  const [row] = await db
    .select({ repo: projectRepos, project: projects })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(eq(projectRepos.id, repoId));
  const { repo, project } = row!;
  return {
    id: repo.id,
    fullName: repo.fullName,
    deadlineAt: isoOrNull(repo.deadlineAt),
    effectiveDeadlineAt: effectiveDeadline(repo, project).toISOString(),
    deadlineAppliedAt: isoOrNull(repo.deadlineAppliedAt),
    frozenAt: isoOrNull(repo.frozenAt),
    locked: repo.lockedAt !== null,
    archived: repo.archivedAt !== null,
    staffLock: repo.staffLock,
  };
}

/**
 * The repository `repoId` of `projectId`, both locked for the transaction
 * (the project first, as every writer of both takes them), refused when
 * it takes no deadline work ({@link isLive}).
 */
async function liveRepoForUpdate(tx: Tx, projectId: string, repoId: string): Promise<{ repo: RepoRow; project: ProjectRow }> {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
  const [repo] = await tx
    .select()
    .from(projectRepos)
    .where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, projectId)))
    .for("update");
  if (!project || !repo || !isLive(repo, project)) {
    throw new ProjectError("repo_unavailable", "The repository is not provisioned, was deleted on GitHub, or its project is archived");
  }
  return { repo, project };
}

/**
 * `PUT /app/api/projects/:id/repos/:rid/deadline` (D13 as amended): the
 * repository's own deadline, ahead of now (`422 deadline_past`), or null for
 * the project's again; its runs requalified and, moved later after it was
 * applied, the repository reopened. Audited `project_repo.deadline_set`.
 * The caller asks for the deadline work (`requestDeadlineWork`).
 */
export async function setRepoDeadline(
  db: Db,
  projectId: string,
  repoId: string,
  deadlineAt: Date | null,
  actor: AuditActor,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { repo, project } = await liveRepoForUpdate(tx, projectId, repoId);
    if (deadlineAt !== null && deadlineAt.getTime() <= now.getTime()) {
      throw new ProjectError("deadline_past", "The deadline has passed");
    }
    if ((repo.deadlineAt?.getTime() ?? null) === (deadlineAt?.getTime() ?? null)) return;
    await tx.update(projectRepos).set({ deadlineAt }).where(eq(projectRepos.id, repo.id));
    const reopened = await effectiveDeadlineMoved(tx, project, [repo.id], now);
    await audit(tx, {
      ...actor,
      action: "project_repo.deadline_set",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { deadlineAt: deadlineAt?.toISOString() ?? null, previous: isoOrNull(repo.deadlineAt), reopened: reopened.length > 0 },
    });
  });
}

/**
 * `POST /app/api/projects/:id/repos/:rid/{lock,unlock}` (F-PROJ-09): the
 * staff's hand on the lock, kept only where it differs from what the
 * deadline would hold — an unlock after the deadline is an exemption no
 * resumed deadline pass overrides (until the repository's deadline moves),
 * an unlock before it leaves the deadline to lock it when it comes.
 * Audited `project_repo.lock` / `unlock`; the caller asks for the deadline
 * work, which makes GitHub hold it.
 */
export async function setStaffLock(db: Db, projectId: string, repoId: string, locked: boolean, actor: AuditActor): Promise<void> {
  await db.transaction(async (tx) => {
    const { repo, project } = await liveRepoForUpdate(tx, projectId, repoId);
    const byDeadline = deadlineWantsLock({ staffLock: null, deadlineAppliedAt: repo.deadlineAppliedAt }, project.deadlineStrategy);
    const staffLock = locked === byDeadline ? null : locked;
    await tx.update(projectRepos).set({ staffLock }).where(eq(projectRepos.id, repo.id));
    await audit(tx, {
      ...actor,
      action: locked ? "project_repo.lock" : "project_repo.unlock",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { staffLock },
    });
  });
}

