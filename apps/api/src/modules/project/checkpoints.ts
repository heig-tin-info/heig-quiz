/**
 * A project's review checkpoints, authored by its staff (F-PROJ-11; merge
 * task M3-05b), ported from heig-classroom's
 * `modules/assignments/milestones.ts`. A checkpoint is a name — the tag of
 * `criteria.yml`'s `milestone:` entries — and a date, absolute or J−n of the
 * project's deadline (`checkpointDueAt`, calendar days in Europe/Zurich,
 * re-resolved by `rescheduleCheckpoints` while not dispatched). Its
 * dispatch is `review.ts`'s; on a project graded by criteria it is a
 * milestone, whose pass is `milestone.ts`'s (ADR-106 §5).
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import type { ReviewCheckpoint, ReviewCheckpointCreate } from "@quiz/contracts";
import { checkpointDueAt, checkpointRefusal, untaggedCheckpoints } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { isoOrNull } from "../../clock.js";
import type { Db } from "../../db/client.js";
import { gradeDispatches, projectCheckpoints, projectCriteria, projects } from "../../db/schema.js";
import { ProjectError } from "./errors.js";

type CheckpointRow = typeof projectCheckpoints.$inferSelect;

function view(row: CheckpointRow): ReviewCheckpoint {
  return {
    id: row.id,
    name: row.name,
    dueAt: row.dueAt.toISOString(),
    offsetDays: row.offsetDays,
    dispatchedAt: isoOrNull(row.dispatchedAt),
  };
}

/** `GET /app/api/projects/:id/checkpoints`: the project's checkpoints, the earliest first. */
export async function listCheckpoints(db: Db, projectId: string): Promise<ReviewCheckpoint[]> {
  const rows = await db
    .select()
    .from(projectCheckpoints)
    .where(eq(projectCheckpoints.projectId, projectId))
    .orderBy(asc(projectCheckpoints.dueAt), asc(projectCheckpoints.name));
  return rows.map(view);
}

/**
 * `POST /app/api/projects/:id/checkpoints`: the date resolved against the
 * project's deadline as it stands (read under the project's row lock, so a
 * deadline moving at the same time comes first or re-resolves it), ahead of
 * now (`422 due_past`) and before the deadline (`422 due_after_deadline`);
 * a name already taken on the project is `409 duplicate_checkpoint`; on a
 * project graded by criteria, a name that tags no criterion of its
 * snapshot is `409 checkpoint_untagged` (ADR-106 §5). Audited
 * `project_checkpoint.create`.
 */
export async function createCheckpoint(
  db: Db,
  projectId: string,
  body: ReviewCheckpointCreate,
  actor: AuditActor,
  now: Date,
): Promise<ReviewCheckpoint> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    const deadline = project!.deadlineAt;
    const dueAt = body.offsetDays !== undefined ? checkpointDueAt(deadline, body.offsetDays) : new Date(body.dueAt!);
    const refusal = checkpointRefusal(dueAt, deadline, now);
    if (refusal) {
      throw new ProjectError(
        refusal,
        refusal === "due_past" ? "The checkpoint's date has passed" : "A checkpoint must come before the project's deadline",
      );
    }
    if (project!.gradingMode === "criteria") {
      const [snapshot] = await tx.select({ criteria: projectCriteria.criteria }).from(projectCriteria).where(eq(projectCriteria.projectId, projectId));
      if (snapshot && untaggedCheckpoints([body.name], snapshot.criteria.leaves).length > 0) {
        throw new ProjectError("checkpoint_untagged", "A checkpoint's name tags no criterion", { checkpoints: [body.name] });
      }
    }
    const [row] = await tx
      .insert(projectCheckpoints)
      .values({ id: randomUUID(), projectId, name: body.name, dueAt, offsetDays: body.offsetDays ?? null, createdAt: now })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ProjectError("duplicate_checkpoint", `A checkpoint “${body.name}” already exists on this project`);
    await audit(tx, {
      ...actor,
      action: "project_checkpoint.create",
      subjectType: "project_checkpoint",
      subjectId: row.id,
      payload: { projectId, name: row.name, dueAt: row.dueAt.toISOString(), offsetDays: row.offsetDays },
    });
    return view(row);
  });
}

/**
 * `DELETE /app/api/projects/:id/checkpoints/:cid`: refused once a dispatch
 * of it was claimed for any repository (`409 checkpoint_dispatched`): the
 * ledger keeps what was asked of GitHub — and a milestone's pass, claimed
 * the same way, is what locks rows (ADR-106 §5; the deferred foreign key of
 * `locked_by_checkpoint_id` is the backstop). The checkpoint's row lock
 * orders this against the dispatch job's claim, which reads it under a
 * share lock, and the milestone's, which takes it.
 * A void checkpoint (after a deadline moved earlier) is deletable. False
 * when the project has no such checkpoint. Audited `project_checkpoint.delete`.
 */
export async function deleteCheckpoint(db: Db, projectId: string, checkpointId: string, actor: AuditActor): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(projectCheckpoints)
      .where(and(eq(projectCheckpoints.id, checkpointId), eq(projectCheckpoints.projectId, projectId)))
      .for("update");
    if (!row) return false;
    const [claimed] = await tx
      .select({ id: gradeDispatches.id })
      .from(gradeDispatches)
      .where(eq(gradeDispatches.checkpointId, row.id))
      .limit(1);
    if (claimed) throw new ProjectError("checkpoint_dispatched", "The checkpoint's review was already asked of a repository");
    await tx.delete(projectCheckpoints).where(eq(projectCheckpoints.id, row.id));
    await audit(tx, {
      ...actor,
      action: "project_checkpoint.delete",
      subjectType: "project_checkpoint",
      subjectId: row.id,
      payload: { projectId, name: row.name, dueAt: row.dueAt.toISOString(), offsetDays: row.offsetDays },
    });
    return true;
  });
}
