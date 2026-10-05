/**
 * The project steps of the import (merge task M8-01b, docs/merge/09-tasks.md
 * M3-01, M3-04, M3-05a/b, M3-07, M3-08, M3-09b, "From …" notes): heig-
 * classroom's assignments become projects, its milestones checkpoints. The
 * repositories and what hangs on them are `steps-repos.ts`.
 *
 * Ids are kept (an assignment's id is its project's, a milestone's its
 * checkpoint's), so a permalink resolves through the id map and a restore of
 * either side finds the same rows. A project the import created is refreshed
 * from classroom unless Quiz changed it (`syncOwned`); a row of Quiz's own
 * (a project a teacher made before the import, D26 addendum 2026-10-02) is
 * never touched: a slug or a repository it holds that the import needs too
 * leaves the source row uncarried, which the parity report makes a red line.
 *
 * Not carried here, on purpose: the groups themselves (`steps-groups.ts`,
 * M8-01c: a group project is imported WITHOUT its group set, which that step
 * fills in), organizations and links (D20, D22), the codespace
 * columns (refused by the pre-flight), `llm_dispatched_at` (it becomes the
 * ledger's synthetic row, `steps-repos.ts`).
 */
import { ProjectGradingScale } from "@quiz/contracts";
import { DEADLINE_REMINDER_MS } from "@quiz/domain";
import { and, eq, getTableName, inArray, isNull } from "drizzle-orm";

import { githubClassroomLinks, projectCheckpoints, projects } from "../../src/db/schema.js";
import { nameOf, note, remember, syncOwned, tallyMapped, target, written, type Ctx, type OwnedRow } from "./ctx.js";
import type { SourceAssignment, SourceSnapshot, SourceStudentRepo } from "./source.js";

/** The assignments of the mapped classrooms: what a source row is in scope for (parity). */
export const assignmentsInScope = (ctx: Ctx): SourceAssignment[] => ctx.snapshot.assignments.filter((a) => ctx.mapped.has(a.classroomId));

/** Every repository of the assignments in scope. */
export function reposInScope(ctx: Ctx): SourceStudentRepo[] {
  const ids = new Set(assignmentsInScope(ctx).map((a) => a.id));
  return ctx.snapshot.studentRepos.filter((r) => ids.has(r.assignmentId));
}

/** The source user ids of the roster lines of each group, in member order. */
export function groupUsersOf(snapshot: SourceSnapshot): Map<string, string[]> {
  const lines = new Map(snapshot.enrollments.map((e) => [e.id, e.userId]));
  const byGroup = new Map<string, string[]>();
  for (const m of snapshot.groupMembers) {
    const user = lines.get(m.enrollmentId);
    if (user) byGroup.set(m.groupId, [...(byGroup.get(m.groupId) ?? []), user]);
  }
  return byGroup;
}

/**
 * Who a repository is recorded under (`project_repos.user_id`, NOT NULL): its
 * student's Quiz account; for a group's repository whose creator is not
 * imported (a development account, a roster line gone), the first member
 * who is, so the repository is not lost. `user_id` only records who
 * accepted, a group repository is read through the copy's members
 * (`repoMembers`).
 */
export function repoOwner(ctx: Ctx, r: SourceStudentRepo): string | undefined {
  const own = target(ctx, r.userId);
  if (own !== undefined || r.groupId === null) return own;
  for (const user of (ctx.groupUsers.get(r.groupId) ?? [])) {
    const found = target(ctx, user);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Why a repository whose copy group Quiz deleted is left out (a foreign key would refuse it). */
export const GROUP_GONE = "its group was deleted in Quiz since the previous import";

/**
 * Why the import leaves a repository out, or null when it carries it. A
 * group's repository is carried with its group (`steps-groups.ts`, M8-01c).
 */
export function repoLeftOut(ctx: Ctx, r: SourceStudentRepo): string | null {
  if (!ctx.known.get("assignments")?.has(r.assignmentId)) return "its project was not carried";
  if (r.groupId !== null && ctx.goneCopyGroups.has(r.groupId)) return GROUP_GONE;
  if (r.groupId !== null && !ctx.known.get("assignment_groups")?.has(r.groupId)) return "its group was not carried";
  if (repoOwner(ctx, r) === undefined) return `its student is not imported (${nameOf(ctx.usersById.get(r.userId))})`;
  return null;
}

/** The creator recorded for a project, or a group set: the classroom's owner, else the `--actor`. */
export function creatorOf(ctx: Ctx, a: SourceAssignment): string | null {
  const owner = ctx.snapshot.classrooms.find((c) => c.id === a.classroomId)?.teacherId ?? null;
  return target(ctx, owner) ?? ctx.actorId;
}

/**
 * Carries the rows of one table whose ids are classroom's: a row already
 * mapped is refreshed by the re-import rule, a new one inserted unless
 * present and mapped. A row that could not be inserted (Quiz's own row holds
 * the slug, the name, the repository) is listed with `conflict`, and stays
 * uncarried: the parity report makes it a red line.
 */
export async function carryOwned(ctx: Ctx, rows: OwnedRow[], conflict: (row: OwnedRow) => string): Promise<void> {
  for (const row of rows) {
    if (ctx.known.get(row.sourceTable)?.has(row.sourceId)) {
      await syncOwned(ctx, row);
      continue;
    }
    const table = row.table;
    const done = await ctx.db
      .insert(table)
      .values({ id: row.sourceId, ...row.values } as never)
      .onConflictDoNothing()
      .returning();
    if (done.length === 0) {
      note(ctx, "projects", `${row.sourceTable} ${row.label}: ${conflict(row)}`);
      continue;
    }
    written(ctx, getTableName(table));
    await remember(ctx, row.sourceTable, row.sourceId, row.sourceId, "created", row);
  }
}

/**
 * Assignments → projects. `org_id` is the mapped classroom's link (the import
 * never writes it, D22); `created_by` the classroom's owner, else the
 * `--actor`; `grading_scale` heig-classroom's own reading, a score out of 6
 * is the grade and any other maximum linear (product owner, 2026-10-02);
 * `squashed_*` become `distribution_*`; `grades_validated_*` the release.
 * Neither the freeze nor the reminder is the project's: see `steps-repos.ts`
 * and {@link importReminders}.
 */
export async function importProjects(ctx: Ctx) {
  const links = new Map(
    (
      await ctx.db
        .select({ classroomId: githubClassroomLinks.classroomId, orgId: githubClassroomLinks.orgId })
        .from(githubClassroomLinks)
        .where(inArray(githubClassroomLinks.classroomId, [...ctx.mapped.values()].map((d) => d.classroomId)))
    ).map((l) => [l.classroomId, l.orgId]),
  );
  const leftOut = new Map<string, string>();
  const rows: OwnedRow[] = [];
  for (const a of assignmentsInScope(ctx)) {
    const dest = ctx.mapped.get(a.classroomId)!;
    const orgId = links.get(dest.classroomId);
    const createdBy = creatorOf(ctx, a);
    if (!orgId) {
      leftOut.set(a.id, "its Quiz classroom is not connected to GitHub");
      continue;
    }
    if (!createdBy) {
      leftOut.set(a.id, "no creator to record (its classroom's owner is unresolved and there is no --actor)");
      continue;
    }
    rows.push({
      sourceTable: "assignments",
      sourceId: a.id,
      table: projects,
      label: `"${a.name}" (${dest.courseCode} / ${dest.classroomName})`,
      values: {
        classroomId: dest.classroomId,
        orgId,
        name: a.name,
        slug: a.slug,
        state: a.state,
        startAt: a.startAt,
        deadlineAt: a.deadlineAt,
        graceMinutes: a.graceMinutes,
        sourceRepoId: a.sourceRepoId,
        sourceFullName: a.sourceFullName,
        distributionRepoId: a.squashedRepoId,
        distributionFullName: a.squashedFullName,
        sourceStrategy: a.sourceStrategy,
        deadlineStrategy: a.deadlineStrategy,
        gradingMode: a.gradingMode,
        publishMode: a.publishMode,
        durationMinutes: a.durationMinutes,
        groupMode: a.groupMode,
        branches: a.branches,
        protectedFiles: a.protectedFiles,
        sourceAheadSha: a.sourceAheadSha,
        sourcePushedAt: a.sourcePushedAt,
        syncedAt: a.syncedAt,
        gradingScale: ProjectGradingScale.parse({ kind: "score_is_grade" }),
        deadlineAppliedAt: a.deadlineAppliedAt,
        releasedAt: a.gradesValidatedAt,
        releasedBy: target(ctx, a.gradesValidatedBy),
        archivedAt: a.archivedAt,
        createdBy,
        createdAt: a.createdAt,
      },
    });
    if (a.sourceAheadSha !== null) {
      note(ctx, "projects", `project ${a.name}: the source is ahead of the distribution repository (shown ahead with no number: Quiz has no record of the heads handed out)`);
    }
  }
  await carryOwned(ctx, rows, (row) => `not carried: Quiz already holds the slug "${row.values.slug}" in the classroom, or this distribution repository, in another project`);
  tallyMapped(ctx, "assignments", assignmentsInScope(ctx).map((a) => a.id), leftOut);
}

/** Milestones → review checkpoints: `dispatched_at` kept, or a dispatched milestone would fire again (M3-05b). */
export async function importCheckpoints(ctx: Ctx) {
  const carried = ctx.known.get("assignments");
  const scope = new Set(assignmentsInScope(ctx).map((a) => a.id));
  const inScope = ctx.snapshot.milestones.filter((m) => scope.has(m.assignmentId));
  const leftOut = new Map<string, string>();
  const rows: OwnedRow[] = [];
  for (const m of inScope) {
    if (!carried?.has(m.assignmentId)) {
      leftOut.set(m.id, "its project was not carried");
      continue;
    }
    rows.push({
      sourceTable: "assignment_milestones",
      sourceId: m.id,
      table: projectCheckpoints,
      label: `"${m.name}"`,
      values: { projectId: m.assignmentId, name: m.name, dueAt: m.dueAt, offsetDays: m.offsetDays, dispatchedAt: m.dispatchedAt, createdAt: m.createdAt },
    });
  }
  await carryOwned(ctx, rows, () => "not carried: the project already holds a checkpoint of this name");
  tallyMapped(ctx, "assignment_milestones", inScope.map((m) => m.id), leftOut);
}

/**
 * The day-before reminder (M3-09b): classroom's own marker is copied; where it
 * has none, a project whose deadline lies within 24 h of the import — or is
 * past — is marked sent at the import time, or Quiz's first `projectTick`
 * would remind every student of it at once. A deadline further ahead stays
 * null: Quiz reminds it, legitimately, later. Applied only while Quiz's own
 * marker is null, so a later run, or a reminder Quiz sent, is never undone;
 * the column is not among the owned ones (the re-import hash ignores it). A
 * repository's own marker is for an own deadline, which classroom has not.
 */
export async function importReminders(ctx: Ctx) {
  const horizon = new Date(ctx.now.getTime() + DEADLINE_REMINDER_MS);
  let marked = 0;
  for (const a of assignmentsInScope(ctx)) {
    if (!ctx.known.get("assignments")?.has(a.id)) continue;
    const marker = a.reminderSentAt ?? (a.deadlineAt <= horizon ? ctx.now : null);
    if (marker === null) continue;
    const done = await ctx.db
      .update(projects)
      .set({ reminderSentAt: marker })
      .where(and(eq(projects.id, a.id), isNull(projects.reminderSentAt)))
      .returning({ id: projects.id });
    if (done.length > 0 && a.reminderSentAt === null) {
      marked += 1;
      note(ctx, "projects", `project ${a.name}: deadline within 24 h of the import (or past), its reminder marked sent now`);
    }
    written(ctx, "projects (reminder)", done.length);
  }
  if (marked > 0) note(ctx, "projects", `${marked} project reminder(s) marked sent, so Quiz does not remind the students at once`);
}
