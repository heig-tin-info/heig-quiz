/**
 * The passes of a project graded by criteria, claimed in the
 * `grade_dispatches` ledger ({@link claimPasses}: the final pass at a
 * repository's definitive freeze, `jobs.ts`, ADR-106 §6), and its
 * milestones (§5, L-02d): a review checkpoint of such a project is a
 * milestone, its name the `milestone:` tag of the criteria it grades.
 *
 * - **The claim** ({@link claimMilestonePasses}, the ticker's, invariant 5:
 *   no HTTP): at the checkpoint's date, one `checkpoint` row of the ledger
 *   (the checkpoint's id, the existing unique index: at most once) per live
 *   repository whose deadline has not come (`CHECKPOINT_TARGET`, as the
 *   CI's dispatch) and which was accepted by then — a repository accepted
 *   after the checkpoint keeps its tagged criteria for the final pass. The
 *   checkpoint is marked dispatched in the same transaction; the caller
 *   sends each claim to `project.evidence` — or, for a schema-3 snapshot,
 *   to `project.ci`, whose job sends the `quiz-grade` dispatch (`ci.ts`,
 *   ADR-119 §6). The ticker itself never calls GitHub; the
 *   `grade-milestone` dispatch is the `auto` mode's alone (`review.ts`).
 * - **The pass** ({@link passScope}): the evidence at the last student push
 *   received by the checkpoint's date (`collectEvidence`), then its review,
 *   both on the tagged criteria only, their rows written locked
 *   (`locked_by_checkpoint_id`, `locked_at`): the final pass and a Regrade
 *   leave them alone (`heldCriteria`). No commit by the date: 0-point rows,
 *   reason `no_commit`, locked all the same.
 *
 * An edge left as it is: a milestone job running after the final pass and a
 * validation (a queue backed up past the deadline) proposes nothing on the
 * tagged criteria already validated — they stay held, and unlocked.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, asc, eq, exists, inArray, lte, sql } from "drizzle-orm";

import { passLeaves, type CriteriaLeaf } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { Db, Tx } from "../../db/client.js";
import { gradeDispatches, projectCheckpoints, projectCriteria, projectRepos, projects } from "../../db/schema.js";
import type { EvidenceJob } from "./evidence.js";
import { CHECKPOINT_TARGET, checkpointDue } from "./review.js";

/**
 * A pass claimed and to send: `project.evidence`'s data, the ledger row its
 * id; `ci` for a project whose snapshot is schema 3 — its pass is the CI's
 * graded run, sent to `project.ci` (`ci.ts`, ADR-119 §6).
 */
export type ClaimedPass = EvidenceJob & { passId: string; ci: boolean };

/**
 * One pass per repository claimed in the ledger, in the caller's
 * transaction (`ON CONFLICT DO NOTHING`: at most once): the final pass
 * (`trigger = 'deadline'`) or a milestone's (`checkpoint`, its id). An empty
 * sha: the evidence job (or the CI's dispatch) chooses the target commit.
 * A repository of a project whose snapshot is schema 3 gets its pass's
 * nonce with the claim (`ciNonce`, ADR-119 §6). The passes claimed.
 */
export async function claimPasses(tx: Tx, repoIds: readonly string[], now: Date, checkpointId?: string): Promise<ClaimedPass[]> {
  if (repoIds.length === 0) return [];
  const ci = new Set(
    (
      await tx
        .select({ id: projectRepos.id })
        .from(projectRepos)
        .innerJoin(projectCriteria, eq(projectCriteria.projectId, projectRepos.projectId))
        .where(and(inArray(projectRepos.id, [...repoIds]), CI_SNAPSHOT))
    ).map((r) => r.id),
  );
  const claims = await tx
    .insert(gradeDispatches)
    .values(
      repoIds.map((repoId) => ({
        id: randomUUID(),
        repoId,
        trigger: checkpointId === undefined ? ("deadline" as const) : ("checkpoint" as const),
        checkpointId: checkpointId ?? null,
        sha: "",
        nonce: ci.has(repoId) ? ciNonce() : null,
        createdAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: gradeDispatches.id, repoId: gradeDispatches.repoId, nonce: gradeDispatches.nonce });
  return claims.map((c) => ({ repoId: c.repoId, passId: c.id, checkpointId, ci: c.nonce !== null }));
}

/** A snapshot of schema 3 (ADR-119 §11), over `project_criteria`: its pass is the CI's. */
export const CI_SNAPSHOT = sql`(${projectCriteria.criteria}->>'schemaVersion') = '3'`;

/** A CI pass's nonce: 128 random bits, in hex (ADR-119 §6, choice e). */
export const ciNonce = (): string => randomBytes(16).toString("hex");

/** What a pass grades: its criteria, the date of its target commit (null: the effective deadline), its checkpoint's name, and the lock of its rows. */
export interface PassScope<L> {
  leaves: L[];
  dueAt: Date | null;
  /** A milestone pass's tag (its checkpoint's name), null for the final pass or a Regrade. */
  milestone: string | null;
  lock(now: Date): { lockedByCheckpointId?: string; lockedAt?: Date };
}

/**
 * The scope of a pass over `leaves`: every criterion, unlocked, for the
 * final pass or a Regrade; for a milestone (`checkpointId`), the criteria
 * its name tags, at its date, their rows locked. Null when the checkpoint
 * is gone.
 */
export async function passScope<L extends Pick<CriteriaLeaf, "milestone">>(
  db: Db | Tx,
  projectId: string,
  leaves: readonly L[],
  checkpointId?: string,
): Promise<PassScope<L> | null> {
  if (checkpointId === undefined) return { leaves: [...leaves], dueAt: null, milestone: null, lock: () => ({}) };
  const [checkpoint] = await db
    .select({ name: projectCheckpoints.name, dueAt: projectCheckpoints.dueAt })
    .from(projectCheckpoints)
    .where(and(eq(projectCheckpoints.id, checkpointId), eq(projectCheckpoints.projectId, projectId)));
  if (!checkpoint) return null;
  return {
    leaves: passLeaves(leaves, checkpoint.name),
    dueAt: checkpoint.dueAt,
    milestone: checkpoint.name,
    lock: (now) => ({ lockedByCheckpointId: checkpointId, lockedAt: now }),
  };
}

/**
 * The ticker's claim of every milestone pass due: the projects concerned
 * under a share lock (a deadline moved meanwhile comes first, and a
 * checkpoint it voids no longer fires), their checkpoints due under an
 * update lock (of two ticks, one claims; a deletion waits), each one's
 * repositories claimed ({@link claimPasses}), the checkpoint marked
 * dispatched and — a schema-2 project's — audited
 * `project.checkpoint_dispatched` (`payload.passes`; a schema-3 project's
 * dispatch audits each repository, `ci.ts`). The passes claimed.
 */
export async function claimMilestonePasses(db: Db, now: Date): Promise<ClaimedPass[]> {
  return db.transaction(async (tx) => {
    const due = checkpointDue(now, "criteria");
    const projectIds = (
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(exists(tx.select({ id: projectCheckpoints.id }).from(projectCheckpoints).where(and(eq(projectCheckpoints.projectId, projects.id), due))))
        .orderBy(asc(projects.id))
        .for("share")
    ).map((p) => p.id);
    if (projectIds.length === 0) return [];
    const checkpoints = await tx
      .select({ id: projectCheckpoints.id, projectId: projectCheckpoints.projectId, name: projectCheckpoints.name, dueAt: projectCheckpoints.dueAt })
      .from(projectCheckpoints)
      .innerJoin(projects, eq(projects.id, projectCheckpoints.projectId))
      .where(and(inArray(projectCheckpoints.projectId, projectIds), due))
      .orderBy(asc(projectCheckpoints.id))
      .for("update", { of: projectCheckpoints });
    const passes: ClaimedPass[] = [];
    for (const checkpoint of checkpoints) {
      const repos = await tx
        .select({ id: projectRepos.id })
        .from(projectRepos)
        .innerJoin(projects, eq(projects.id, projectRepos.projectId))
        .where(and(eq(projectRepos.projectId, checkpoint.projectId), CHECKPOINT_TARGET, lte(projectRepos.acceptedAt, checkpoint.dueAt)));
      const claimed = await claimPasses(
        tx,
        repos.map((r) => r.id),
        now,
        checkpoint.id,
      );
      await tx.update(projectCheckpoints).set({ dispatchedAt: now }).where(eq(projectCheckpoints.id, checkpoint.id));
      // A schema-3 project's milestone is audited per repository by its dispatch (`ci.ts`), not here.
      if (!claimed.some((p) => p.ci)) {
        await audit(tx, {
          ...SYSTEM_ACTOR,
          action: "project.checkpoint_dispatched",
          subjectType: "project",
          subjectId: checkpoint.projectId,
          payload: { checkpointId: checkpoint.id, name: checkpoint.name, passes: claimed.length },
        });
      }
      passes.push(...claimed);
    }
    return passes;
  });
}
