/**
 * *Resync with the set* and the drift (ADR-070 §4, §6 and its third
 * amendment of 2026-10-05, F-PROJ-13; merge task M3-15b-2b): a group
 * project's copy that stopped following its set — its deadline, a group's
 * repository deadline, the archive — brought back in step with it once, at
 * the staff's request, through the confirmation of §6.
 *
 * - **The drift** ({@link groupsDrifted}): the plan of the copy against the
 *   set with every stop lifted (`resyncPlan`, `@quiz/domain`) would change
 *   something the `group.sync` job does not already owe.
 * - **The resync** ({@link resyncGroups}): that plan's consequences —
 *   every repository a student loses or joins, the frozen ones named
 *   (`frozen`), and each arrival into a group without a repository while
 *   Accept is closed (R3, `acceptClosed`) — confirmed by digest like a
 *   set's write (`409 needs_confirmation`), then: what touches no
 *   repository applied in the request's transaction, the rest stored on
 *   the project (`group_resync`, a durable intent) for the job, which
 *   applies exactly those keys, stops lifted. The copy stays stopped
 *   (`stopped_at`, `groups_stopped_at` are never cleared): a set's write
 *   after it is a drift again, never applied by itself (ADR-070 §4,
 *   alternative 5).
 * - A stopped group with a repository whose set group was deleted is kept
 *   (R1): its repository and frozen score stay, its members follow the set.
 *
 * A draft's copy follows its set: there is nothing to resync (204).
 * Refused: a project that follows no set (`no_group_set`), an archived
 * project (`project_archived`), a released one (`released`), an archived
 * classroom (`classroom_archived`). The release is refused while a resync
 * is owed (`group_sync_pending`, `grades.ts`, R2).
 *
 * Lock order, a set's write's: the classroom FOR SHARE, then the job's
 * (`lockSync`): the set FOR SHARE, the project FOR UPDATE.
 */
import { eq } from "drizzle-orm";

import { consequenceDelta, consequenceKey, isEmptyPlan, syncWork } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { Db } from "../../db/client.js";
import { classrooms, projects } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { ProjectError } from "./errors.js";
import { applyPlan, copyWork, describeConsequences, frameOf, lockSync, markDepartures, type CopyWork } from "./groupCopy.js";
import type { ProjectRow } from "./views.js";

/** What a resync would do that the job does not already owe: what applies at once, and the consequences it adds. */
function resyncDelta(found: CopyWork) {
  return { now: found.resync.now, added: consequenceDelta(found.work, found.resync.consequences) };
}

/**
 * The project page's `groupsDrifted` (F-PROJ-13): a published group
 * project's copy differs from its set where it stopped following —
 * *Resync with the set* would change something. Read without locks.
 */
export async function groupsDrifted(db: Db, project: ProjectRow, now: Date): Promise<boolean> {
  if (!project.groupMode || project.state === "draft" || project.groupSetId === null) return false;
  const { now: applied, added } = resyncDelta(await copyWork(db, project.id, frameOf(project, now)));
  return !isEmptyPlan(applied) || added.length > 0;
}

export interface ResyncInput {
  confirm?: string | undefined;
  actor: AuditActor;
  userId: string;
  now: Date;
}

/**
 * `POST /app/api/projects/:id/groups/resync`: null when there is nothing to
 * resync; else the resync applied — `due` when the `group.sync` job now
 * owes it steps (the caller sends it). See the module's header.
 */
export async function resyncGroups(db: Db, projectId: string, input: ResyncInput): Promise<{ due: boolean } | null> {
  const { now } = input;
  return db.transaction(async (tx) => {
    const [named] = await tx.select({ classroomId: projects.classroomId }).from(projects).where(eq(projects.id, projectId));
    if (!named) throw new DomainError("not_found", 404, "No such project");
    const [room] = await tx.select({ archivedAt: classrooms.archivedAt }).from(classrooms).where(eq(classrooms.id, named.classroomId)).for("share");
    const { project, frame } = await lockSync(tx, projectId, now);
    if (!project) throw new DomainError("not_found", 404, "No such project");
    if (!project.groupMode || project.groupSetId === null) throw new ProjectError("no_group_set", "The project follows no group set");
    if (room && room.archivedAt !== null) throw new ProjectError("classroom_archived", "The classroom is archived: its group sets are read-only");
    // A draft's copy follows its set: nothing to resync.
    if (project.state === "draft") return null;
    if (project.archivedAt !== null) throw new ProjectError("project_archived", "An archived project's groups are not resynced");
    if (project.releasedAt !== null) throw new ProjectError("released", "A released project's groups are not resynced");

    const found = await copyWork(tx, project.id, frame);
    const { now: applied, added } = resyncDelta(found);
    if (isEmptyPlan(applied) && added.length === 0) return null;
    let confirmed: { digest: string; frozen: string[] } | null = null;
    if (added.length > 0) {
      const details = await describeConsequences(
        tx,
        added.map((c) => ({ ...c, projectId: project.id })),
      );
      if (input.confirm !== details.digest) {
        throw new ProjectError("needs_confirmation", "This resync has consequences on GitHub: confirm them", details);
      }
      const frozen = details.consequences.flatMap((c) => (c.frozen && c.repo !== null ? [c.repo] : []));
      confirmed = { digest: details.digest, frozen: [...new Set(frozen)].sort() };
    }

    // What touches no repository, at once. The consequences left are read
    // again from the copy as it now stands: an R3 arrival into a group the
    // resync just created is keyed by the copy group's new id (it was named
    // by the set's), and those applied at once are no longer owed. Each is
    // stored: every one was confirmed now or was already owed.
    if (!isEmptyPlan(applied)) await applyPlan(tx, project.id, found.copy, applied, now);
    const after = await copyWork(tx, project.id, frame);
    const keys = after.resync.consequences.map(consequenceKey);
    const owed = syncWork(after.following?.split.consequences ?? null, after.resync.consequences, keys);
    const due = owed.work.length > 0;
    await tx
      .update(projects)
      .set({ groupResync: owed.kept, groupResyncAt: now, groupResyncBy: input.userId, ...(due ? { groupSyncDueAt: now } : {}) })
      .where(eq(projects.id, project.id));
    await markDepartures(tx, project.id, owed.work, now);
    await audit(tx, {
      ...input.actor,
      action: "project.group_resync",
      subjectType: "project",
      subjectId: project.id,
      payload: {
        digest: confirmed?.digest ?? null,
        consequences: added.length,
        frozenRepos: confirmed?.frozen ?? [],
        applied: !isEmptyPlan(applied),
        deferred: owed.kept.length,
      },
    });
    return { due };
  });
}
