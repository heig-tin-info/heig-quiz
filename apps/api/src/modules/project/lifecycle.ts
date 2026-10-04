/**
 * A project's lifecycle (F-PROJ-01 to F-PROJ-03, F-PROJ-16; merge task
 * M3-02), ported from heig-classroom's `modules/assignments/lifecycle.ts`
 * (sync point `ab98cc0`): create with its distribution repository, patch,
 * publish, archive, unarchive, delete. Every write is audited here, so the
 * ticker's scheduled publication (M3-05) audits through the same function.
 *
 * **Creation never deletes anything on GitHub** (ADR-062): the draft row is
 * inserted first, which reserves the slug; the distribution repository is
 * created or adopted and CLAIMED by the row (`distribution_repo_id`, under a
 * partial UNIQUE) before anything is pushed to it; then it is built, and
 * only then does the row get its name (`distribution_full_name`): the BUILT
 * mark, without which the draft is not published (`distribution_missing`).
 * A failed build deletes the ROW only and answers `502 distribution_failed`;
 * an empty private leftover is adopted by the next attempt, anything else
 * stepped over to the next `-squashed-N`.
 *
 * The request that creates a project waits for the build (seconds): the git
 * runner is asynchronous, so the event loop never does.
 */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { defaultProjectGradingScale, type ProjectCreate, type ProjectPatch } from "@quiz/contracts";
import { PROJECT_PATCH_FIELDS, projectFieldRefusal, repoName, SLUG_MAX, slugify, type ProjectPatchField } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { enrollments, groupSets, projectGroupMembers, projectGroups, projects } from "../../db/schema.js";
import { githubStatus, type InstallationClient } from "../../github/app.js";
import { createSquashedRepo } from "../../github/squash.js";
import { purgeProjectReceipts, type InstalledOrg } from "../github/service.js";
import { DomainError } from "../http.js";
import { projectDeadlineMoved, rescheduleCheckpoints, ts } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { replaceGroupCopy } from "./groupCopy.js";
import { classroomClient, fetchSource, type Source } from "./sources.js";
import type { ProjectRow } from "./views.js";

/**
 * A slug is reused with `-2` … `-20` (heig-classroom cbcc780), and so is the
 * distribution repository's name, `<slug>-squashed-2` … `-20`: one
 * organization serves a course year after year and nothing is ever deleted
 * there (ADR-062), so heig-classroom's five would run out.
 */
export const MAX_SUFFIX = 20;

const notFound = () => new DomainError("not_found", 404, "No such project");

// ---------------------------------------------------------------- create

export interface CreateInput {
  classroomId: string;
  body: ProjectCreate;
  /** `created_by`: the account that asked. */
  userId: string;
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
}

/**
 * The source ({@link fetchSource}) and the branches to hand out, every one
 * of which it must hold: `422 source_not_found` otherwise (F-PROJ-01).
 */
async function readSource(
  db: Db,
  client: InstallationClient,
  org: InstalledOrg,
  name: string,
  asked: string[] | undefined,
): Promise<{ source: Source; branches: string[] }> {
  const source = await fetchSource(db, client, org, name);
  if (!source) throw new ProjectError("source_not_found", `${name} is not a source of ${org.login}`);
  const branches = asked ?? [source.defaultBranch];
  const missing = branches.filter((b) => !source.branches.includes(b));
  if (missing.length > 0) {
    throw new ProjectError("source_not_found", `${source.fullName} has no branch ${missing.join(", ")}`, { branches: missing });
  }
  return { source, branches };
}

/** The draft's dates: a manual publication starts at its publication, and counts its duration from there. */
function draftDates(body: ProjectCreate, now: Date): { startAt: Date; deadlineAt: Date } {
  if (body.publishMode === "scheduled") return { startAt: new Date(body.startAt!), deadlineAt: new Date(body.deadlineAt!) };
  return {
    startAt: now,
    deadlineAt:
      body.durationMinutes !== undefined ? new Date(now.getTime() + body.durationMinutes * 60_000) : new Date(body.deadlineAt!),
  };
}

/**
 * Inserts the draft under the first free slug of its name: the UNIQUE
 * (classroom, slug) decides, so two creations racing never take the same
 * one. The row reserves the slug while the distribution is built.
 */
async function reserveDraft(db: Db, values: Omit<typeof projects.$inferInsert, "id" | "slug">, name: string): Promise<ProjectRow> {
  const base = slugify(name);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const slug = n === 1 ? base : `${base.slice(0, SLUG_MAX - 3).replace(/-+$/, "")}-${n}`;
    const [row] = await db
      .insert(projects)
      .values({ ...values, id: randomUUID(), slug })
      .onConflictDoNothing({ target: [projects.classroomId, projects.slug] })
      .returning();
    if (row) return row;
  }
  throw new ProjectError("duplicate_slug", `Too many projects named "${base}" in this classroom`);
}

/**
 * The draft takes the repository for itself, before anything is pushed: false
 * when another project holds it already (the partial UNIQUE decides, so two
 * creations racing for one empty leftover never both get it). The id only:
 * the name is written once the build is done.
 */
function claimFor(db: Db, draft: ProjectRow) {
  return async (repo: { repoId: number }): Promise<boolean> => {
    try {
      const [row] = await db
        .update(projects)
        .set({ distributionRepoId: repo.repoId })
        .where(eq(projects.id, draft.id))
        .returning({ id: projects.id });
      // Deleted by its staff while it was being built: stop, push nothing.
      if (!row) throw notFound();
      return true;
    } catch (err) {
      if (isUniqueViolation(err, "projects_distribution_repo_uq")) return false;
      throw err;
    }
  };
}

/**
 * The distribution repository (F-PROJ-02), under the first name the App may
 * create or adopt and the draft may claim: a name held by a non-empty or a
 * public repository, or by another project, steps to the next suffix.
 */
async function buildDistribution(
  db: Db,
  client: InstallationClient,
  org: InstalledOrg,
  draft: ProjectRow,
  source: Source,
): Promise<{ repoId: number; fullName: string }> {
  for (let n = 1; ; n++) {
    try {
      return await createSquashedRepo({
        octokit: client.octokit,
        token: client.token,
        org: org.login,
        sourceRepo: source.name,
        targetRepo: repoName(`${draft.slug}-squashed`, n === 1 ? undefined : String(n)),
        strategy: draft.sourceStrategy,
        branches: draft.branches,
        claim: claimFor(db, draft),
      });
    } catch (err) {
      if (githubStatus(err) !== 422 || n >= MAX_SUFFIX) throw err;
    }
  }
}

/**
 * `POST /app/api/classrooms/:id/projects` (F-PROJ-01, F-PROJ-02): a draft
 * with its distribution repository. Refused before anything is written:
 * `not_connected`, `app_not_installed`, `source_not_found`,
 * `deadline_past`, `unknown_group_set`, `duplicate_slug`; after:
 * `distribution_failed`, the row deleted and nothing on GitHub. A group
 * set named is copied as soon as the row exists (ADR-070 §4), so the set's
 * writes keep the copy in step while the distribution is built.
 */
export async function createProject(db: Db, config: AppConfig, input: CreateInput): Promise<ProjectRow> {
  const { body, now } = input;
  const dates = draftDates(body, now);
  if (dates.deadlineAt.getTime() <= now.getTime()) throw new ProjectError("deadline_past", "The deadline has passed");
  const groupSetId = body.groupSetId ?? null;
  if (groupSetId !== null && !(await setOfClassroom(db, groupSetId, input.classroomId))) throw unknownGroupSet();
  const { org, client } = await classroomClient(db, config, input.classroomId);
  const { source, branches } = await readSource(db, client, org, body.sourceRepo, body.branches);

  const draft = await reserveDraft(
    db,
    {
      classroomId: input.classroomId,
      orgId: org.id,
      name: body.name,
      ...dates,
      graceMinutes: body.graceMinutes,
      sourceRepoId: source.id,
      sourceFullName: source.fullName,
      sourceStrategy: body.sourceStrategy,
      deadlineStrategy: body.deadlineStrategy,
      gradingMode: body.gradingMode,
      publishMode: body.publishMode,
      durationMinutes: body.durationMinutes ?? null,
      groupMode: body.groupMode,
      groupSetId,
      branches,
      protectedFiles: body.protectedFiles,
      gradingScale: body.gradingScale ?? defaultProjectGradingScale(),
      createdBy: input.userId,
      createdAt: now,
    },
    body.name,
  );
  if (groupSetId !== null) {
    await db.transaction(async (tx) => {
      await lockSet(tx, groupSetId);
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, draft.id)).for("update");
      await replaceGroupCopy(tx, draft.id, groupSetId, now);
    });
  }

  let built: { repoId: number; fullName: string };
  try {
    built = await buildDistribution(db, client, org, draft, source);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    input.log.error({ err, project: draft.id, source: source.fullName }, "building a distribution repository failed");
    // The row only, which frees the repository it claimed: nothing is ever
    // deleted on GitHub (ADR-062). Still an unbuilt draft, which nothing can
    // have published (`distribution_missing`): the condition says so.
    await db
      .delete(projects)
      .where(and(eq(projects.id, draft.id), eq(projects.state, "draft"), isNull(projects.distributionFullName)));
    throw new ProjectError("distribution_failed", "Building the distribution repository failed: try again");
  }
  const [row] = await db
    .update(projects)
    .set({ distributionFullName: built.fullName })
    .where(eq(projects.id, draft.id))
    .returning();
  // Deleted by its staff while it was being built: the repository stays.
  if (!row) throw notFound();
  await audit(db, {
    ...input.actor,
    action: "project.create",
    subjectType: "project",
    subjectId: draft.id,
    payload: { slug: draft.slug, source: source.fullName, distribution: built.fullName },
  });
  return row;
}

// ---------------------------------------------------------------- the group set (ADR-070)

const unknownGroupSet = () => new ProjectError("unknown_group_set", "No such group set in the project's classroom");

/** True when `setId` is a group set of classroom `classroomId`. */
async function setOfClassroom(db: Db | Tx, setId: string, classroomId: string): Promise<boolean> {
  const [set] = await db
    .select({ id: groupSets.id })
    .from(groupSets)
    .where(and(eq(groupSets.id, setId), eq(groupSets.classroomId, classroomId)));
  return set !== undefined;
}

/**
 * The set a project is about to name, locked FOR SHARE BEFORE the project's
 * row: the order of the set's own writes (`groupCopy.ts`), so that a write
 * of the set waits for the copy it must step, or the copy for the write.
 */
async function lockSet(tx: Tx, setId: string): Promise<{ classroomId: string } | undefined> {
  const [set] = await tx.select({ classroomId: groupSets.classroomId }).from(groupSets).where(eq(groupSets.id, setId)).for("share");
  return set;
}

// ---------------------------------------------------------------- patch

/** The patch's values as the row's, dates as dates. */
function asColumns(body: ProjectPatch): Partial<Record<ProjectPatchField, unknown>> {
  const out: Partial<Record<ProjectPatchField, unknown>> = {};
  for (const field of PROJECT_PATCH_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    out[field] = (field === "startAt" || field === "deadlineAt") && typeof value === "string" ? new Date(value) : value;
  }
  return out;
}

/**
 * `PATCH /app/api/projects/:pid` (F-PROJ-03), on the row read FOR UPDATE in
 * its transaction, so a publication running at the same time is either seen
 * or waited for: a field whose value changes must be open
 * (`projectFieldRefusal`), a moved deadline must lie ahead (`deadline_past`);
 * a draft's dates stay coherent (a duration only with a manual publication,
 * the deadline after the start). A moved deadline takes its J−n checkpoints
 * and the runs of the repositories following it along, and one already
 * applied reopens the project (`projectDeadlineMoved`, M3-05a): the route
 * then asks for the deadline work, which lifts the locks.
 *
 * The group set (ADR-070 §4, §7): only in group mode (400), one of the
 * project's classroom (`422 unknown_group_set`); naming it makes the copy,
 * naming another replaces it, and leaving group mode clears it and deletes
 * the copy.
 */
export async function patchProject(
  db: Db,
  projectId: string,
  body: ProjectPatch,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRow> {
  return db.transaction(async (tx) => {
    const askedSet = body.groupSetId ? await lockSet(tx, body.groupSetId) : undefined;
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFound();
    const changed: Partial<Record<ProjectPatchField, unknown>> = {};
    for (const [field, value] of Object.entries(asColumns(body)) as [ProjectPatchField, unknown][]) {
      if (isDeepStrictEqual(value, project[field])) continue;
      const refusal = projectFieldRefusal(project, field, now);
      if (refusal) throw new ProjectError(refusal, `${field} can no longer change`);
      changed[field] = value;
    }
    // Leaving group mode leaves the set too, and its copy.
    if (changed.groupMode === false && body.groupSetId === undefined && project.groupSetId !== null) changed.groupSetId = null;
    const next = { ...project, ...changed } as ProjectRow;
    if (next.groupSetId !== null && !next.groupMode) {
      throw new DomainError("validation", 400, "A group set only applies to a group project");
    }
    if (changed.groupSetId && askedSet?.classroomId !== project.classroomId) throw unknownGroupSet();
    // A duration on a manual draft keeps a provisional deadline, so that the
    // lists stay meaningful; Publish counts it again from the publication.
    if (changed.durationMinutes !== undefined && next.durationMinutes !== null) {
      next.deadlineAt = new Date(now.getTime() + next.durationMinutes * 60_000);
      changed.deadlineAt = next.deadlineAt;
    }
    if (changed.deadlineAt !== undefined && next.deadlineAt.getTime() <= now.getTime()) {
      throw new ProjectError("deadline_past", "The deadline has passed");
    }
    if (next.publishMode === "scheduled" && next.durationMinutes !== null) {
      throw new DomainError("validation", 400, "A duration only applies to a manual publication");
    }
    if (next.deadlineAt.getTime() <= next.startAt.getTime()) {
      throw new DomainError("validation", 400, "The deadline must come after the start");
    }
    if (Object.keys(changed).length === 0) return project;
    const { deadlineAt: movedTo, ...others } = changed;
    let row = project;
    if (Object.keys(others).length > 0) {
      [row] = (await tx
        .update(projects)
        .set(others as Partial<typeof projects.$inferInsert>)
        .where(eq(projects.id, project.id))
        .returning()) as [ProjectRow];
    }
    if (changed.groupSetId !== undefined) await replaceGroupCopy(tx, project.id, row.groupSetId, now);
    // The checkpoints, the repositories following it, and the reopen of a
    // deadline already applied (F-PROJ-09, M3-05a).
    if (movedTo !== undefined) row = await projectDeadlineMoved(tx, row, movedTo as Date, actor, now);
    await audit(tx, { ...actor, action: "project.update", subjectType: "project", subjectId: project.id, payload: body });
    return row;
  });
}

// ---------------------------------------------------------------- publish

/** One claimed student seat of the classroom in no group of the project (ADR-048). */
export interface Unassigned {
  enrollmentId: string;
  nom: string;
  prenom: string;
}

/**
 * The claimed STUDENT seats of the project's classroom in none of its groups:
 * a staff seat (ADR-018) and an unclaimed roster line never count
 * (F-PROJ-05, F-PROJ-06).
 */
export async function unassignedStudents(db: Db | Tx, project: Pick<ProjectRow, "id" | "classroomId">): Promise<Unassigned[]> {
  return db
    .select({ enrollmentId: enrollments.id, nom: enrollments.nom, prenom: enrollments.prenom })
    .from(enrollments)
    .leftJoin(
      projectGroupMembers,
      and(eq(projectGroupMembers.enrollmentId, enrollments.id), eq(projectGroupMembers.projectId, project.id)),
    )
    .where(
      and(
        eq(enrollments.classroomId, project.classroomId),
        eq(enrollments.staff, false),
        isNotNull(enrollments.userId),
        isNull(projectGroupMembers.id),
      ),
    )
    .orderBy(enrollments.nom, enrollments.prenom);
}

/**
 * Publishes a draft (F-PROJ-03): by hand (`POST …/publish`, `actor` the
 * person) or at its start by the ticker (M3-05, `SYSTEM_ACTOR`, audited
 * `project.auto_publish`). A manual publication starts now and counts its
 * duration from now; a scheduled one published early keeps its dates.
 * Refused: `not_draft`, `distribution_missing`, `no_group_set` (a group
 * project that names no group set, ADR-070 §7), `unassigned_students` (a
 * group project with a claimed student in no group of its copy, or no
 * group at all, ADR-048; `students` the ones left out), `deadline_past`.
 * The ticker's publication meets the same refusals and leaves the draft as
 * it is. Nothing is sent to the students yet (M3-09).
 */
export async function publishProject(db: Db, projectId: string, now: Date, actor: AuditActor): Promise<ProjectRow> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw notFound();
    if (project.state !== "draft") throw new ProjectError("not_draft", "The project is already published");
    if (project.distributionFullName === null) {
      throw new ProjectError("distribution_missing", "The project's distribution repository is not built");
    }
    if (project.groupMode) {
      if (project.groupSetId === null) throw new ProjectError("no_group_set", "The group project names no group set");
      const left = await unassignedStudents(tx, project);
      const [group] = await tx
        .select({ id: projectGroups.id })
        .from(projectGroups)
        .where(eq(projectGroups.projectId, project.id))
        .limit(1);
      if (left.length > 0 || !group) {
        throw new ProjectError(
          "unassigned_students",
          left.length > 0 ? `${left.length} student(s) in no group` : "The project has no group",
          { students: left },
        );
      }
    }
    const manual = project.publishMode === "manual";
    const startAt = manual ? now : project.startAt;
    const deadlineAt =
      manual && project.durationMinutes !== null ? new Date(now.getTime() + project.durationMinutes * 60_000) : project.deadlineAt;
    if (deadlineAt.getTime() <= now.getTime()) throw new ProjectError("deadline_past", "The deadline has passed");
    const [row] = await tx
      .update(projects)
      .set({ state: "published", startAt, deadlineAt })
      .where(eq(projects.id, project.id))
      .returning();
    if (deadlineAt.getTime() !== project.deadlineAt.getTime()) await rescheduleCheckpoints(tx, project.id, deadlineAt);
    await audit(tx, {
      ...actor,
      action: actor.actorType === "system" ? "project.auto_publish" : "project.publish",
      subjectType: "project",
      subjectId: project.id,
      payload: { startAt: startAt.toISOString(), deadlineAt: deadlineAt.toISOString() },
    });
    return row!;
  });
}

// ---------------------------------------------------------------- archive, delete

/**
 * Archives or brings back a project (F-PROJ-16): out of the lists, reversibly. Audited when it changes.
 * The archive stops its groups for good (ADR-070 §4): an unarchive never makes its copy follow again.
 */
export async function setProjectArchived(
  db: Db,
  project: ProjectRow,
  archived: boolean,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRow> {
  if ((project.archivedAt !== null) === archived) return project;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set(
        archived
          ? { archivedAt: now, groupsStoppedAt: sql`coalesce(${projects.groupsStoppedAt}, ${ts(now)})` }
          : { archivedAt: null },
      )
      .where(eq(projects.id, project.id))
      .returning();
    await audit(tx, {
      ...actor,
      action: archived ? "project.archive" : "project.unarchive",
      subjectType: "project",
      subjectId: project.id,
    });
    return row!;
  });
}

/**
 * Deletes a project in any state (D19, F-PROJ-16): its rows — repositories,
 * runs, scores, groups, by cascade — and its push receipts (N-DATA-03), in
 * one transaction. NEVER a repository on GitHub: the students' repositories,
 * the distribution repository and the source stay where they are.
 */
export async function deleteProject(db: Db, project: ProjectRow, actor: AuditActor): Promise<void> {
  await db.transaction(async (tx) => {
    const receipts = await purgeProjectReceipts(tx, { projectId: project.id });
    await tx.delete(projects).where(eq(projects.id, project.id));
    await audit(tx, {
      ...actor,
      action: "project.delete",
      subjectType: "project",
      subjectId: project.id,
      payload: {
        name: project.name,
        slug: project.slug,
        source: project.sourceFullName,
        distribution: project.distributionFullName,
        receipts,
      },
    });
  });
}
