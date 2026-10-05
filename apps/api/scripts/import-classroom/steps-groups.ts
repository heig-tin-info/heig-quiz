/**
 * Group assignments (merge task M8-01c, ADR-070 §10, docs/merge/02 §2.5): each
 * heig-classroom group assignment of a mapped classroom becomes ONE group set
 * of its Quiz classroom, named after the project, with its groups and its
 * members; the project names the set (`projects.group_set_id`) and its copy
 * (`project_groups`, `project_group_members`) is the imported groups with
 * `source_group_id` set. Classroom's groups belong to one assignment, so a
 * classroom that reused the same groups across assignments yields one set per
 * assignment (identical memberships, no error).
 *
 * Ids are kept in every table (a uuid is unique per table, so a group's id is
 * both its `student_groups` row's and its `project_groups` row's, a member's
 * both its set's and its copy's), and the id map holds the copy's:
 * `assignment_groups` → `project_groups`, which the repository step reads for
 * `project_repos.group_id`. The set's own rows are remembered under
 * `… (set)` names. Every row follows the re-import rule (`syncOwned`), none
 * is ever deleted: a group or a member classroom dropped since is Quiz's to
 * remove (the copy follows its set, the staff edit it). A set, a group or a
 * roster line Quiz deleted since an earlier run is not recreated and nothing
 * is placed under it: it is listed.
 *
 * A member whose roster line is not in the Quiz roster (`--missing-students
 * report`, product owner 2026-10-05) is reported and not placed, so neither
 * set nor copy holds them and no access is recorded for them. A copy whose
 * project's deadline is past, applied, or archived is stopped, as Quiz stops
 * it at the deadline (`stopProjects`, ADR-070 §4): it keeps its members and
 * follows nothing.
 *
 * What the group repositories carry is `steps-repos.ts`; this file ends with
 * the accounts invited on them (`project_repo_access`), read through
 * Quiz's own `repoMembers` and recorded as `recordGrant` records them, but
 * without asking GitHub: classroom
 * already invited every member when the repository was made or the member
 * placed. Nothing is ever revoked here.
 */
import { randomUUID } from "node:crypto";

import { and, inArray, isNull, sql } from "drizzle-orm";

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
} from "../../src/db/schema.js";
import { repoMembers } from "../../src/modules/project/groupRepos.js";
import { stopProjects } from "../../src/modules/project/service.js";
import { note, tally, tallyMapped, written, type Ctx, type OwnedRow } from "./ctx.js";
import type { SourceAssignment, SourceGroup, SourceGroupMember } from "./source.js";
import { assignmentsInScope, carryOwned, reposInScope } from "./steps-projects.js";
import { IN_CHUNK, insertAll, presentKeys } from "./steps-repos.js";

/** The id-map names of what is under a set (the copy's rows use the source's own table names). */
const SET = "assignments (group set)";
const SET_GROUP = "assignment_groups (set)";
const SET_MEMBER = "assignment_group_members (set)";

/** The group assignments of the mapped classrooms whose project was carried. */
export function groupProjects(ctx: Ctx): SourceAssignment[] {
  return assignmentsInScope(ctx).filter((a) => a.groupMode && ctx.known.get("assignments")?.has(a.id));
}

type Existing = typeof groupSets | typeof studentGroups | typeof projectGroups | typeof enrollments;

/** The ids among `ids` that `table` still holds. */
async function existing(ctx: Ctx, table: Existing, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    for (const r of await ctx.db.select({ id: table.id }).from(table).where(inArray(table.id, ids.slice(i, i + IN_CHUNK)))) out.add(r.id);
  }
  return out;
}

/** The source ids an earlier run carried into `table` that Quiz has deleted since (a set of an archived project, a group or a line the staff removed). */
async function goneSince(ctx: Ctx, sourceTable: string, table: Existing): Promise<Set<string>> {
  const known = [...(ctx.known.get(sourceTable)?.keys() ?? [])];
  const here = await existing(ctx, table, known);
  return new Set(known.filter((id) => !here.has(id)));
}

/** Everything a group assignment's groups and members need, once. */
export async function importGroups(ctx: Ctx) {
  ctx.carriedBefore.groups = new Set(ctx.known.get("assignment_groups")?.keys());
  ctx.carriedBefore.members = new Set(ctx.known.get("assignment_group_members")?.keys());
  const setsBefore = new Set(ctx.known.get(SET)?.keys());
  const carried = groupProjects(ctx);
  const gone = {
    sets: await goneSince(ctx, SET, groupSets),
    setGroups: await goneSince(ctx, SET_GROUP, studentGroups),
    copyGroups: await goneSince(ctx, "assignment_groups", projectGroups),
  };
  ctx.goneCopyGroups = gone.copyGroups;
  for (const a of carried) if (gone.sets.has(a.id)) note(ctx, "projects", `group set of "${a.name}": deleted in Quiz since the previous import, not recreated`);
  for (const id of new Set([...gone.setGroups, ...gone.copyGroups])) note(ctx, "projects", `group "${ctx.groupsById.get(id)?.name ?? id}": deleted in Quiz since the previous import, not recreated`);

  const live = await carrySets(ctx, carried, gone);
  const memberLeftOut = await carryMembers(ctx, carried, gone);
  await nameTheSets(ctx, carried.filter((a) => live.has(a.id) && !setsBefore.has(a.id)));
  await stopCopies(ctx, carried.filter((a) => (ctx.groupsOfProject.get(a.id) ?? []).some((g) => ctx.known.get("assignment_groups")?.has(g.id) && !ctx.carriedBefore.groups.has(g.id))));
  tallyGroups(ctx, carried, memberLeftOut);
}

type Gone = { sets: Set<string>; setGroups: Set<string>; copyGroups: Set<string> };

/** The sets, their groups and the project's copy of each group; returns the ids of the sets that are live in Quiz. */
async function carrySets(ctx: Ctx, carried: SourceAssignment[], gone: Gone): Promise<Set<string>> {
  // The set's creator is the carried project's own (a run without --actor may not resolve one).
  const creators = new Map<string, string>();
  for (const row of await ctx.db.select({ id: projects.id, createdBy: projects.createdBy }).from(projects).where(inArray(projects.id, carried.map((a) => a.id)))) creators.set(row.id, row.createdBy);
  const setRows: OwnedRow[] = [];
  const groupRows: OwnedRow[] = [];
  const copyRows: OwnedRow[] = [];
  for (const a of carried) {
    if (gone.sets.has(a.id)) continue;
    const createdBy = creators.get(a.id);
    if (!createdBy) {
      note(ctx, "projects", `project ${a.name}: not in Quiz, its group set is not carried`);
      continue;
    }
    setRows.push({
      sourceTable: SET,
      sourceId: a.id,
      table: groupSets,
      label: `group set "${a.name}"`,
      values: { classroomId: ctx.mapped.get(a.classroomId)!.classroomId, name: a.name, maxSize: a.groupMaxSize, openUntil: null, createdBy, createdAt: a.createdAt },
    });
    for (const g of ctx.groupsOfProject.get(a.id) ?? []) {
      if (gone.setGroups.has(g.id) || gone.copyGroups.has(g.id)) continue;
      groupRows.push({
        sourceTable: SET_GROUP,
        sourceId: g.id,
        table: studentGroups,
        label: `"${g.name}" of "${a.name}"`,
        values: { setId: a.id, name: g.name, position: g.position, createdAt: g.createdAt },
      });
      copyRows.push({
        sourceTable: "assignment_groups",
        sourceId: g.id,
        table: projectGroups,
        label: `"${g.name}" of "${a.name}"`,
        values: { projectId: a.id, name: g.name, slug: g.slug, position: g.position, sourceGroupId: g.id, createdAt: g.createdAt },
      });
    }
  }
  await carryOwned(ctx, setRows, () => "not carried: the group set could not be written");
  const sets = new Set(ctx.known.get(SET)?.keys());
  await carryOwned(ctx, groupRows.filter((r) => sets.has(String(r.values.setId))), () => "not carried: the set already holds a group of this name");
  const setGroups = ctx.known.get(SET_GROUP);
  await carryOwned(ctx, copyRows.filter((r) => setGroups?.has(r.sourceId)), () => "not carried: the project's copy already holds a group of this name or slug");
  return new Set([...sets].filter((id) => !gone.sets.has(id)));
}

/** The members, in the set and in the copy: those on the Quiz roster, whose group and line still exist. */
async function carryMembers(ctx: Ctx, carried: SourceAssignment[], gone: Gone): Promise<Map<string, string>> {
  const lines = ctx.known.get("enrollments");
  const staffLines = new Set(ctx.snapshot.enrollments.filter((e) => e.staff).map((e) => e.id));
  const linesGone = new Set([...(lines?.values() ?? [])]);
  for (const id of await existing(ctx, enrollments, [...linesGone])) linesGone.delete(id);
  const placed = new Map(carried.map((a) => [a.id, a]));
  const copyGroups = ctx.known.get("assignment_groups");
  const setRows: OwnedRow[] = [];
  const copyRows: OwnedRow[] = [];
  const leftOut = new Map<string, string>();
  for (const m of ctx.snapshot.groupMembers) {
    const a = placed.get(m.assignmentId);
    if (!a) continue;
    if (!copyGroups?.has(m.groupId)) {
      leftOut.set(m.id, "its group was not carried (refused or kept, see the findings)");
      continue;
    }
    const line = lines?.get(m.enrollmentId);
    if (line === undefined) {
      leftOut.set(m.id, "not on the Quiz roster (--missing-students=report)");
      note(ctx, "projects", `${memberLabel(ctx, m, a)}: not on the Quiz roster (--missing-students=report), not placed in the group set nor its copy, no access recorded`);
    } else if (staffLines.has(m.enrollmentId)) {
      leftOut.set(m.id, "a staff seat, never placed in a group (ADR-070 §2)");
    } else if (linesGone.has(line)) {
      leftOut.set(m.id, "its roster line was deleted in Quiz since the previous import");
      note(ctx, "projects", `${memberLabel(ctx, m, a)}: its roster line was deleted in Quiz since the previous import, not placed`);
    } else if (gone.sets.has(a.id) || gone.setGroups.has(m.groupId) || gone.copyGroups.has(m.groupId)) {
      leftOut.set(m.id, "its group was deleted in Quiz since the previous import (listed)");
    } else {
      const label = `member of "${a.name}"`;
      setRows.push({ sourceTable: SET_MEMBER, sourceId: m.id, table: studentGroupMembers, label, values: { setId: a.id, groupId: m.groupId, enrollmentId: line, addedAt: m.addedAt } });
      copyRows.push({ sourceTable: "assignment_group_members", sourceId: m.id, table: projectGroupMembers, label, values: { projectId: a.id, groupId: m.groupId, enrollmentId: line, addedAt: m.addedAt } });
    }
  }
  await carryOwned(ctx, setRows, () => "not carried: the set already places this roster line in a group");
  const inSet = ctx.known.get(SET_MEMBER);
  await carryOwned(ctx, copyRows.filter((r) => inSet?.has(r.sourceId)), () => "not carried: the project's copy already places this roster line in a group");
  return leftOut;
}

/** What the groups' tallies say was left out, and why (the parity report lists it). */
function tallyGroups(ctx: Ctx, carried: SourceAssignment[], memberLeftOut: Map<string, string>) {
  const inScope = assignmentsInScope(ctx);
  const placed = new Set(carried.map((a) => a.id));
  const scope = new Set(inScope.map((a) => a.id));
  const groups = ctx.snapshot.groups.filter((g) => scope.has(g.assignmentId));
  const members = ctx.snapshot.groupMembers.filter((m) => scope.has(m.assignmentId));
  const notPlaced = "its project is not a carried group project";
  const copies = ctx.known.get("assignment_groups");
  const groupWhy = (g: SourceGroup) => (!placed.has(g.assignmentId) ? notPlaced : !copies?.has(g.id) && !ctx.known.get(SET)?.has(g.assignmentId) ? "its group set was not carried (refused or kept, see the findings)" : null);
  tallyMapped(ctx, "assignment_groups", groups.map((g) => g.id), new Map(groups.flatMap((g) => { const why = groupWhy(g); return why ? [[g.id, why] as [string, string]] : []; })));
  for (const m of members) if (!placed.has(m.assignmentId)) memberLeftOut.set(m.id, notPlaced);
  const carriedMembers = ctx.known.get("assignment_group_members");
  tallyMapped(ctx, "assignment_group_members", members.map((m) => m.id), new Map([...memberLeftOut].filter(([id]) => !carriedMembers?.has(id))));
  const sets = inScope.filter((a) => a.groupMode);
  tallyMapped(ctx, SET, sets.map((a) => a.id), new Map(sets.filter((a) => !placed.has(a.id)).map((a) => [a.id, "its project was not carried"])));
}

function memberLabel(ctx: Ctx, m: SourceGroupMember, a: SourceAssignment): string {
  const e = ctx.linesById.get(m.enrollmentId);
  const g = ctx.groupsById.get(m.groupId);
  return `group member ${e ? `${e.prenom} ${e.nom} <${e.email}>` : m.enrollmentId} of "${g?.name ?? m.groupId}" in "${a.name}"`;
}

/** `projects.group_set_id` of the sets this run created (the project's id): never moved later, a teacher may have chosen another set or cleared it in Quiz. */
async function nameTheSets(ctx: Ctx, created: SourceAssignment[]) {
  if (created.length === 0) return;
  const done = await ctx.db
    .update(projects)
    .set({ groupSetId: sql`${projects.id}` })
    .where(and(inArray(projects.id, created.map((a) => a.id)), isNull(projects.groupSetId)))
    .returning({ id: projects.id });
  written(ctx, "projects (group set)", done.length);
}

/**
 * The copy of a project this run created stops, through the project module's
 * own `stopProjects`, when QUIZ's project is past its deadline, applied or
 * archived: the decision reads Quiz's row, never the source's. Only on the
 * run that creates the copy: after that Quiz's ticker owns the stops, and a
 * staff resync lifts them, so a later run never stops (nor re-stops) a copy.
 * `stopped_at` and `departing_at` are not owned columns (outside the
 * re-import hash), so the stop is no "edit in Quiz".
 */
async function stopCopies(ctx: Ctx, carried: SourceAssignment[]) {
  if (carried.length === 0) return;
  const rows = await ctx.db
    .select({ id: projects.id, deadlineAt: projects.deadlineAt, appliedAt: projects.deadlineAppliedAt, archivedAt: projects.archivedAt })
    .from(projects)
    .where(inArray(projects.id, carried.map((a) => a.id)));
  const due = rows.filter((p) => p.appliedAt !== null || p.archivedAt !== null || p.deadlineAt <= ctx.now).map((p) => p.id);
  const stopped = await stopProjects(ctx.db, due, ctx.now);
  written(ctx, "project_groups (stopped)", stopped.length);
  if (stopped.length > 0) note(ctx, "projects", `${stopped.length} group(s) of projects whose deadline is past stopped following their set`);
}

/**
 * The accounts invited on the group repositories (`project_repo_access`):
 * for each live carried group repository, whoever Quiz's own `repoMembers`
 * says reads it and has a linked GitHub account, recorded as `recordGrant`
 * records one, `invited_at` the later of the repository's creation and the
 * member's placement. Only members the import placed (a member Quiz's staff added is invited by Quiz). Nothing
 * is asked of GitHub and nothing is revoked; a row present is left as it is.
 * A member with no linked account is invited by Quiz when they link.
 */
export async function importGroupRepoAccess(ctx: Ctx) {
  const lines = ctx.known.get("enrollments");
  const copyGroups = ctx.known.get("assignment_groups");
  const classrooms = new Map(assignmentsInScope(ctx).map((a) => [a.id, ctx.mapped.get(a.classroomId)!.classroomId]));
  const addedAt = new Map<string, Date>();
  for (const m of ctx.snapshot.groupMembers) {
    const line = lines?.get(m.enrollmentId);
    if (line !== undefined && copyGroups?.has(m.groupId)) addedAt.set(`${m.groupId}:${line}`, m.addedAt);
  }

  const known = ctx.known.get("student_repos");
  const carried = reposInScope(ctx).filter((r) => r.groupId !== null && known?.has(r.id));
  const quiz: (typeof projectRepos.$inferSelect)[] = [];
  const ids = carried.map((r) => r.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) quiz.push(...(await ctx.db.select().from(projectRepos).where(inArray(projectRepos.id, ids.slice(i, i + IN_CHUNK)))));

  const rows: (typeof projectRepoAccess.$inferInsert)[] = [];
  const leftOut: string[] = [];
  let pairs = 0;
  for (const repo of quiz) {
    if (repo.groupId === null || repo.provisionStatus !== "ok" || repo.fullName === null || repo.githubRepoId === null || repo.deletedAt !== null) continue;
    for (const member of await repoMembers(ctx.db, repo, classrooms.get(repo.projectId)!)) {
      const placed = addedAt.get(`${repo.groupId}:${member.enrollmentId}`);
      if (placed === undefined) continue; // a member Quiz's staff added: Quiz invites them itself
      pairs += 1;
      if (!member.account) {
        leftOut.push(`${repo.fullName} / ${member.enrollmentId}: no linked GitHub account in Quiz, invited when they link`);
        continue;
      }
      rows.push({
        id: randomUUID(),
        repoId: repo.id,
        enrollmentId: member.enrollmentId,
        githubUserId: member.account.githubUserId,
        githubLogin: member.account.login,
        invitedAt: new Date(Math.max(repo.acceptedAt.getTime(), placed.getTime())),
        revokingAt: null,
        revokedAt: null,
      });
    }
  }
  await insertAll(ctx, projectRepoAccess, rows);
  const keyOf = (r: { repoId: string; enrollmentId: string; githubUserId: number }) => `${r.repoId}:${r.enrollmentId}:${r.githubUserId}`;
  const live = await presentKeys(
    [...new Set(rows.map((r) => r.repoId))],
    async (repoIds) => (await ctx.db.select().from(projectRepoAccess).where(inArray(projectRepoAccess.repoId, repoIds))).filter((x) => x.revokedAt === null && x.revokingAt === null).map(keyOf),
  );
  // A row Quiz revoked (or is revoking) is left as it is and is not a carried grant: said, not counted.
  for (const r of rows) if (!live.has(keyOf(r))) leftOut.push(`${r.repoId} / ${r.enrollmentId}: its access was revoked in Quiz, left as it is`);
  tally(ctx, "group repository access", { source: pairs, carried: rows.filter((r) => live.has(keyOf(r))).length, leftOut });
}
