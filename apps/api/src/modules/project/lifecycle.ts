/**
 * A project's lifecycle (F-PROJ-01 to F-PROJ-03, F-PROJ-16; merge task
 * M3-02), ported from heig-classroom's `modules/assignments/lifecycle.ts`
 * (sync point `ab98cc0`): create with its distribution repository, patch,
 * publish, archive, unarchive, delete. Every write is audited here, so the
 * ticker's scheduled publication (M3-05) audits through the same function.
 *
 * **Creation never deletes anything on GitHub** (ADR-062): the draft row is
 * inserted first, which reserves the slug; the distribution repository is
 * built; the row gets its name. A failed build deletes the ROW only and
 * answers `502 distribution_failed`; the repository it may have left behind
 * is adopted by the next attempt when it is empty, and a non-empty one is
 * stepped over to the next `-squashed-N`.
 *
 * The request that creates a project waits for the build (seconds): the git
 * runner is asynchronous, so the event loop never does.
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { defaultProjectGradingScale, type ProjectCreate, type ProjectPatch } from "@quiz/contracts";
import {
  checkpointDueAt,
  PROJECT_PATCH_FIELDS,
  projectFieldRefusal,
  repoName,
  SLUG_MAX,
  slugify,
  type ProjectPatchField,
} from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { enrollments, projectCheckpoints, projectGroupMembers, projectGroups, projects } from "../../db/schema.js";
import { githubStatus, HTTP_READ } from "../../github/app.js";
import { createSquashedRepo } from "../../github/squash.js";
import { purgeProjectReceipts } from "../github/service.js";
import { DomainError } from "../http.js";
import { ProjectError } from "./errors.js";
import { classroomClient, type OrgRow } from "./organization.js";
import type { ProjectRow } from "./views.js";

/** A name's slug is reused with `-2` … `-20` (heig-classroom cbcc780). */
export const MAX_SLUG_SUFFIX = 20;
/**
 * The distribution repository's name is `<slug>-squashed`, then
 * `-squashed-2` … `-squashed-20` while a non-empty repository holds it: one
 * organization serves a course year after year, and nothing is ever deleted
 * there (ADR-062), so heig-classroom's five would run out.
 */
export const MAX_DISTRIBUTION_SUFFIX = 20;

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

/** The source repository, as the creation reads it from GitHub. */
interface Source {
  id: number;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/**
 * The source must be a repository OF THE CLASSROOM'S ORGANIZATION (`422
 * source_not_found` otherwise, F-PROJ-01), holding every branch asked for.
 * GitHub follows a renamed or transferred repository to its new place: a
 * name that now resolves into another organization is refused too.
 */
async function readSource(
  client: Awaited<ReturnType<typeof classroomClient>>["client"],
  org: OrgRow,
  name: string,
  asked: string[] | undefined,
): Promise<{ source: Source; branches: string[] }> {
  let data;
  try {
    ({ data } = await client.octokit.request("GET /repos/{owner}/{repo}", {
      owner: org.login,
      repo: name,
      request: { retries: 0, ...HTTP_READ },
    }));
  } catch (err) {
    if (githubStatus(err) === 404) throw new ProjectError("source_not_found", `${name} is not a repository of ${org.login}`);
    throw err;
  }
  const sameOrg =
    org.githubOrgId !== null
      ? Number(data.owner.id) === org.githubOrgId
      : data.owner.login.toLowerCase() === org.login.toLowerCase();
  if (!sameOrg) throw new ProjectError("source_not_found", `${name} is not a repository of ${org.login}`);
  const branches = asked ?? [data.default_branch];
  const held = new Set(
    (
      await client.octokit.paginate(client.octokit.rest.repos.listBranches, {
        owner: org.login,
        repo: data.name,
        per_page: 100,
        request: HTTP_READ,
      })
    ).map((b) => b.name),
  );
  const missing = branches.filter((b) => !held.has(b));
  if (missing.length > 0) {
    throw new ProjectError("source_not_found", `${data.full_name} has no branch ${missing.join(", ")}`, { branches: missing });
  }
  return {
    source: { id: Number(data.id), name: data.name, fullName: data.full_name, defaultBranch: data.default_branch },
    branches,
  };
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
 * Inserts the draft under the first free slug of its name (`-2` … `-20`):
 * the UNIQUE (classroom, slug) decides, so two creations racing never take
 * the same one. The row reserves the slug while the distribution is built.
 */
async function reserveDraft(db: Db, values: Omit<typeof projects.$inferInsert, "id" | "slug">, name: string): Promise<ProjectRow> {
  const base = slugify(name);
  for (let n = 1; n <= MAX_SLUG_SUFFIX; n++) {
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
 * The distribution repository (F-PROJ-02), under the first name GitHub
 * lets the App create or adopt: a name held by a NON-EMPTY repository
 * (GitHub's 422, rethrown by the adapter) steps to the next suffix.
 */
async function buildDistribution(
  client: Awaited<ReturnType<typeof classroomClient>>["client"],
  org: OrgRow,
  project: ProjectRow,
  source: Source,
): Promise<{ repoId: number; fullName: string }> {
  for (let n = 1; ; n++) {
    const targetRepo = repoName(`${project.slug}-squashed`, n === 1 ? undefined : String(n));
    try {
      return await createSquashedRepo({
        octokit: client.octokit,
        token: client.token,
        org: org.login,
        sourceRepo: source.name,
        targetRepo,
        strategy: project.sourceStrategy,
        branches: project.branches,
      });
    } catch (err) {
      if (githubStatus(err) !== 422 || n >= MAX_DISTRIBUTION_SUFFIX) throw err;
    }
  }
}

/**
 * `POST /app/api/classrooms/:id/projects` (F-PROJ-01, F-PROJ-02): a draft
 * with its distribution repository. Refused before anything is written:
 * `not_connected`, `app_not_installed`, `source_not_found`,
 * `deadline_past`, `duplicate_slug`; after: `distribution_failed`, the row
 * deleted and nothing on GitHub.
 */
export async function createProject(db: Db, config: AppConfig, input: CreateInput): Promise<ProjectRow> {
  const { body, now } = input;
  const dates = draftDates(body, now);
  if (dates.deadlineAt.getTime() <= now.getTime()) throw new ProjectError("deadline_past", "The deadline has passed");
  const { org, client } = await classroomClient(db, config, input.classroomId);
  const { source, branches } = await readSource(client, org, body.sourceRepo, body.branches);

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
      groupMaxSize: body.groupMaxSize ?? null,
      branches,
      protectedFiles: body.protectedFiles,
      gradingScale: body.gradingScale ?? defaultProjectGradingScale(),
      createdBy: input.userId,
      createdAt: now,
    },
    body.name,
  );

  let built: { repoId: number; fullName: string };
  try {
    built = await buildDistribution(client, org, draft, source);
  } catch (err) {
    input.log.error({ err, project: draft.id, source: source.fullName }, "building a distribution repository failed");
    // The row only: nothing is ever deleted on GitHub (ADR-062).
    await db.delete(projects).where(eq(projects.id, draft.id));
    throw new ProjectError("distribution_failed", "Building the distribution repository failed: try again");
  }
  const [row] = await db
    .update(projects)
    .set({ distributionRepoId: built.repoId, distributionFullName: built.fullName })
    .where(eq(projects.id, draft.id))
    .returning();
  // Deleted by its staff while it was being built: the repository stays.
  if (!row) throw new DomainError("not_found", 404, "The project was deleted meanwhile");
  await audit(db, {
    ...input.actor,
    action: "project.create",
    subjectType: "project",
    subjectId: draft.id,
    payload: { slug: draft.slug, source: source.fullName, distribution: built.fullName },
  });
  return row;
}

// ---------------------------------------------------------------- patch

/** A stable rendering for comparing a sent value with the stored one (object keys sorted). */
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

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

/** Re-resolves the checkpoints authored as J−n that have not fired (F-PROJ-11): they follow the deadline. */
async function retargetCheckpoints(tx: Db | Tx, projectId: string, deadlineAt: Date): Promise<void> {
  const offsets = await tx
    .select({ id: projectCheckpoints.id, offsetDays: projectCheckpoints.offsetDays })
    .from(projectCheckpoints)
    .where(
      and(
        eq(projectCheckpoints.projectId, projectId),
        isNotNull(projectCheckpoints.offsetDays),
        isNull(projectCheckpoints.dispatchedAt),
      ),
    );
  for (const c of offsets) {
    await tx
      .update(projectCheckpoints)
      .set({ dueAt: checkpointDueAt(deadlineAt, c.offsetDays!) })
      .where(eq(projectCheckpoints.id, c.id));
  }
}

/**
 * `PATCH /app/api/projects/:pid` (F-PROJ-03): a field whose value changes
 * must be open (`projectFieldRefusal`), a moved deadline must lie ahead
 * (`deadline_past`); a draft's dates stay coherent (a duration only with a
 * manual publication, the deadline after the start).
 */
export async function patchProject(
  db: Db,
  project: ProjectRow,
  body: ProjectPatch,
  actor: AuditActor,
  now: Date,
): Promise<ProjectRow> {
  const sent = asColumns(body);
  const changed: Partial<Record<ProjectPatchField, unknown>> = {};
  for (const [field, value] of Object.entries(sent) as [ProjectPatchField, unknown][]) {
    if (canonical(value) === canonical(project[field])) continue;
    const refusal = projectFieldRefusal(project, field, now);
    if (refusal) throw new ProjectError(refusal, `${field} can no longer change`);
    changed[field] = value;
  }
  const next = { ...project, ...changed } as ProjectRow;
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

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(projects)
      .set(changed as Partial<typeof projects.$inferInsert>)
      .where(eq(projects.id, project.id))
      .returning();
    if (changed.deadlineAt !== undefined) await retargetCheckpoints(tx, project.id, row!.deadlineAt);
    await audit(tx, { ...actor, action: "project.update", subjectType: "project", subjectId: project.id, payload: body });
    return row!;
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
 * Refused: `not_draft`, `distribution_missing`, `unassigned_students` (a
 * group project with a claimed student in no group, or no group at all,
 * ADR-048), `deadline_past`. Nothing is sent to the students yet (M3-09).
 */
export async function publishProject(db: Db, projectId: string, now: Date, actor: AuditActor): Promise<ProjectRow> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("update");
    if (!project) throw new DomainError("not_found", 404, "No such project");
    if (project.state !== "draft") throw new ProjectError("not_draft", "The project is already published");
    if (project.distributionRepoId === null) {
      throw new ProjectError("distribution_missing", "The project has no distribution repository");
    }
    if (project.groupMode) {
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
    if (deadlineAt.getTime() !== project.deadlineAt.getTime()) await retargetCheckpoints(tx, project.id, deadlineAt);
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

/** Archives or brings back a project (F-PROJ-16): out of the lists, reversibly. Audited when it changes. */
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
      .set({ archivedAt: archived ? now : null })
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
