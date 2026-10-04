/**
 * The `group` module (ADR-070, F-PROJ-06; merge task M3-15a): a
 * classroom's group sets, their groups and who is in which, formed by hand
 * or at random. It owns the tables of `db/group.ts`; it reads `projects`
 * by join (who names a set) and keeps the projects' copies in step through
 * the `project` module's service (`followingCopies`, `stepCopies`), never
 * writing them itself.
 *
 * **One write, one transaction** (`writeSet`): the classroom read FOR SHARE
 * (an archived one answers `409 classroom_archived`, and an archive waits
 * for the write), the set locked FOR UPDATE, then the projects whose copy
 * follows it; the write; their copies stepped; the audit. The hints go
 * after the commit, to the course's staff only (ADR-070 §9).
 *
 * **The students of a set** are the classroom's roster lines, claimed or
 * not, except staff seats (ADR-018): never placed, never counted, never
 * drawn; a line that became a staff seat after it was placed is filtered
 * out of every read and of the copies.
 *
 * Default names are written in the creator's language (D10): "Group k"
 * (fr "Groupe k"), "Groups of <date> <time>" (fr "Groupes du …").
 */
import { randomInt, randomUUID } from "node:crypto";

import { and, asc, count, eq, inArray, isNull, max, ne } from "drizzle-orm";

import type { GroupMemberPut, GroupRandomForm, GroupSetCreate, GroupSetDetail, GroupSetPatch, GroupSetSummary, GroupSetUse } from "@quiz/contracts";
import { copyFollows, defaultGroupName, defaultSetName, duplicateSetName, formRandomGroups, type NameLocale } from "@quiz/domain";

import { audit, type AuditAction, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, groupSets, projects, studentGroupMembers, studentGroups } from "../../db/schema.js";
import { DomainError } from "../http.js";
import { followingCopies, projectsChanged, stepCopies } from "../project/service.js";
import { GroupError } from "./errors.js";
import { groupsChanged } from "./events.js";

type SetRow = typeof groupSets.$inferSelect;

/** Who writes, when, in which language a default name is written. */
export interface WriteContext {
  actor: AuditActor;
  userId: string;
  locale: NameLocale;
  now: Date;
}

/** The set as its loader found it (`accessibleGroupSet`): the set, its classroom and course. */
export interface SetScope {
  set: SetRow;
  room: { id: string };
  course: { id: string };
}

const notFound = (what: string) => new DomainError("not_found", 404, `No such ${what}`);

// ---------------------------------------------------------------- reads

/** The classroom's students, as a set reads them: its roster lines but staff seats. */
const isStudentOf = (classroomId: string) => and(eq(enrollments.classroomId, classroomId), eq(enrollments.staff, false));

/** The projects naming each of `setIds`, oldest first. */
async function usesOf(db: Db | Tx, setIds: readonly string[]): Promise<Map<string, GroupSetUse[]>> {
  const out = new Map<string, GroupSetUse[]>();
  if (setIds.length === 0) return out;
  const rows = await db
    .select({
      setId: projects.groupSetId,
      id: projects.id,
      name: projects.name,
      archivedAt: projects.archivedAt,
      groupsStoppedAt: projects.groupsStoppedAt,
    })
    .from(projects)
    .where(inArray(projects.groupSetId, [...setIds]))
    .orderBy(asc(projects.createdAt));
  for (const r of rows) {
    const list = out.get(r.setId!) ?? [];
    list.push({ id: r.id, name: r.name, archived: r.archivedAt !== null, follows: copyFollows(r) });
    out.set(r.setId!, list);
  }
  return out;
}

/** `GET /app/api/classrooms/:id/group-sets`: the classroom's sets, the oldest first. */
export async function classroomGroupSets(db: Db, classroomId: string): Promise<GroupSetSummary[]> {
  const sets = await db.select().from(groupSets).where(eq(groupSets.classroomId, classroomId)).orderBy(asc(groupSets.createdAt), asc(groupSets.id));
  if (sets.length === 0) return [];
  const ids = sets.map((s) => s.id);
  const groupCounts = await db
    .select({ setId: studentGroups.setId, n: count() })
    .from(studentGroups)
    .where(inArray(studentGroups.setId, ids))
    .groupBy(studentGroups.setId);
  const placedCounts = await db
    .select({ setId: studentGroupMembers.setId, n: count() })
    .from(studentGroupMembers)
    .innerJoin(enrollments, eq(enrollments.id, studentGroupMembers.enrollmentId))
    .where(and(inArray(studentGroupMembers.setId, ids), isStudentOf(classroomId)))
    .groupBy(studentGroupMembers.setId);
  const [students] = await db.select({ n: count() }).from(enrollments).where(isStudentOf(classroomId));
  const uses = await usesOf(db, ids);
  const groupsOf = new Map(groupCounts.map((r) => [r.setId, r.n]));
  const placedOf = new Map(placedCounts.map((r) => [r.setId, r.n]));
  return sets.map((s) => {
    const placed = placedOf.get(s.id) ?? 0;
    return {
      id: s.id,
      name: s.name,
      maxSize: s.maxSize,
      groups: groupsOf.get(s.id) ?? 0,
      placed,
      unplaced: students!.n - placed,
      createdAt: iso(s.createdAt),
      usedBy: uses.get(s.id) ?? [],
    };
  });
}

/** `GET /app/api/group-sets/:id`, and the answer of every write on the set. */
export async function groupSetDetail(db: Db, setId: string): Promise<GroupSetDetail> {
  const [row] = await db
    .select({ set: groupSets, archivedAt: classrooms.archivedAt })
    .from(groupSets)
    .innerJoin(classrooms, eq(classrooms.id, groupSets.classroomId))
    .where(eq(groupSets.id, setId));
  if (!row) throw notFound("group set");
  const { set } = row;
  const groups = await db.select().from(studentGroups).where(eq(studentGroups.setId, set.id)).orderBy(asc(studentGroups.position));
  const students = await db
    .select({ enrollmentId: enrollments.id, nom: enrollments.nom, prenom: enrollments.prenom, userId: enrollments.userId, groupId: studentGroupMembers.groupId })
    .from(enrollments)
    .leftJoin(studentGroupMembers, and(eq(studentGroupMembers.enrollmentId, enrollments.id), eq(studentGroupMembers.setId, set.id)))
    .where(isStudentOf(set.classroomId))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom), asc(enrollments.id));
  const view = (s: (typeof students)[number]) => ({ enrollmentId: s.enrollmentId, nom: s.nom, prenom: s.prenom, claimed: s.userId !== null });
  return {
    set: {
      id: set.id,
      classroomId: set.classroomId,
      name: set.name,
      maxSize: set.maxSize,
      createdAt: iso(set.createdAt),
      readOnly: row.archivedAt !== null,
    },
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      position: g.position,
      members: students.filter((s) => s.groupId === g.id).map(view),
    })),
    unplaced: students.filter((s) => s.groupId === null).map(view),
    usedBy: (await usesOf(db, [set.id])).get(set.id) ?? [],
  };
}

// ---------------------------------------------------------------- the write's frame

/** The classroom read FOR SHARE: an archived one's sets are read-only (ADR-070 §2). */
async function lockClassroom(tx: Tx, classroomId: string): Promise<void> {
  const [room] = await tx.select({ archivedAt: classrooms.archivedAt }).from(classrooms).where(eq(classrooms.id, classroomId)).for("share");
  if (!room) throw notFound("classroom");
  if (room.archivedAt !== null) throw new GroupError("classroom_archived", "The classroom is archived: its group sets are read-only");
}

/** The write's audit entry; null when it changed nothing (no audit, no hint). */
type Written = { action: AuditAction; payload: Record<string, unknown> } | null;

/**
 * One write of a set (see the module's header): the copies that follow it
 * are locked before the write and stepped after it, in its transaction.
 */
async function writeSet(db: Db, scope: SetScope, ctx: WriteContext, write: (tx: Tx, set: SetRow) => Promise<Written>): Promise<void> {
  const changed = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const [set] = await tx.select().from(groupSets).where(eq(groupSets.id, scope.set.id)).for("update");
    if (!set) throw notFound("group set");
    const copies = await followingCopies(tx, set.id);
    const written = await write(tx, set);
    if (!written) return null;
    const changed = await stepCopies(tx, set.id, copies, ctx.now);
    await audit(tx, {
      ...ctx.actor,
      action: written.action,
      subjectType: "group_set",
      subjectId: set.id,
      payload: { ...written.payload, copies: changed },
    });
    return changed;
  });
  if (!changed) return;
  groupsChanged(scope.course.id);
  if (changed.length > 0) projectsChanged([scope.course.id]);
}

// ---------------------------------------------------------------- sets

/** `POST /app/api/classrooms/:id/group-sets`: an empty set, named by default after now. Its id. */
export async function createGroupSet(
  db: Db,
  scope: { room: { id: string }; course: { id: string } },
  body: GroupSetCreate,
  ctx: WriteContext,
): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const name = body.name ?? defaultSetName(ctx.now, ctx.locale);
    await tx.insert(groupSets).values({ id, classroomId: scope.room.id, name, maxSize: body.maxSize ?? null, createdBy: ctx.userId, createdAt: ctx.now });
    await audit(tx, { ...ctx.actor, action: "group_set.create", subjectType: "group_set", subjectId: id, payload: { name, maxSize: body.maxSize ?? null } });
  });
  groupsChanged(scope.course.id);
  return id;
}

/** `PATCH /app/api/group-sets/:id`: its name, its maximum size. */
export async function patchGroupSet(db: Db, scope: SetScope, body: GroupSetPatch, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    await tx.update(groupSets).set(body).where(eq(groupSets.id, set.id));
    return { action: "group_set.update", payload: body };
  });
}

/**
 * `POST /app/api/group-sets/:id/duplicate`: a new set of the same
 * classroom with the same groups and members (staff seats left out),
 * named "<name> (copy)" in the creator's language. Its id.
 */
export async function duplicateGroupSet(db: Db, scope: SetScope, ctx: WriteContext): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const [source] = await tx.select().from(groupSets).where(eq(groupSets.id, scope.set.id)).for("share");
    if (!source) throw notFound("group set");
    const name = duplicateSetName(source.name, ctx.locale);
    await tx.insert(groupSets).values({ id, classroomId: source.classroomId, name, maxSize: source.maxSize, createdBy: ctx.userId, createdAt: ctx.now });
    const groups = await tx.select().from(studentGroups).where(eq(studentGroups.setId, source.id));
    const newId = new Map(groups.map((g) => [g.id, randomUUID()]));
    if (groups.length > 0) {
      await tx.insert(studentGroups).values(groups.map((g) => ({ id: newId.get(g.id)!, setId: id, name: g.name, position: g.position, createdAt: ctx.now })));
    }
    const members = await tx
      .select({ groupId: studentGroupMembers.groupId, enrollmentId: studentGroupMembers.enrollmentId })
      .from(studentGroupMembers)
      .innerJoin(enrollments, eq(enrollments.id, studentGroupMembers.enrollmentId))
      .where(and(eq(studentGroupMembers.setId, source.id), isStudentOf(source.classroomId)));
    if (members.length > 0) {
      await tx.insert(studentGroupMembers).values(
        members.map((m) => ({ id: randomUUID(), setId: id, groupId: newId.get(m.groupId)!, enrollmentId: m.enrollmentId, addedAt: ctx.now })),
      );
    }
    await audit(tx, { ...ctx.actor, action: "group_set.duplicate", subjectType: "group_set", subjectId: id, payload: { from: source.id, name } });
  });
  groupsChanged(scope.course.id);
  return id;
}

/**
 * `DELETE /app/api/group-sets/:id`: refused while a project that is not
 * archived names it (`409 set_in_use`, the projects named); an archived
 * project's name of it is cleared, its stopped copy kept.
 */
export async function deleteGroupSet(db: Db, scope: SetScope, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const holding = ((await usesOf(tx, [set.id])).get(set.id) ?? []).filter((use) => !use.archived).map(({ id, name }) => ({ id, name }));
    if (holding.length > 0) {
      throw new GroupError("set_in_use", `${holding.length} project(s) follow this group set`, { projects: holding });
    }
    await tx.delete(groupSets).where(eq(groupSets.id, set.id));
    return { action: "group_set.delete", payload: { name: set.name } };
  });
}

// ---------------------------------------------------------------- groups

/** The set's group `groupId`, or the 404 of a missing one. */
async function groupOf(tx: Tx, setId: string, groupId: string) {
  const [group] = await tx.select().from(studentGroups).where(and(eq(studentGroups.id, groupId), eq(studentGroups.setId, setId)));
  if (!group) throw notFound("group");
  return group;
}

const duplicateName = (name: string) => new GroupError("duplicate_name", `A group "${name}" already exists in this set`);

/** `409 duplicate_name` when another group of the set than `groupId` holds `name` (the set's row lock makes it final). */
async function refuseTakenName(tx: Tx, setId: string, name: string, groupId: string): Promise<void> {
  const [taken] = await tx
    .select({ id: studentGroups.id })
    .from(studentGroups)
    .where(and(eq(studentGroups.setId, setId), eq(studentGroups.name, name), ne(studentGroups.id, groupId)));
  if (taken) throw duplicateName(name);
}

/** The names taken in the set, and the next position. */
async function groupsSoFar(tx: Tx, setId: string): Promise<{ names: Set<string>; next: number }> {
  const rows = await tx.select({ name: studentGroups.name }).from(studentGroups).where(eq(studentGroups.setId, setId));
  const [top] = await tx.select({ position: max(studentGroups.position) }).from(studentGroups).where(eq(studentGroups.setId, setId));
  return { names: new Set(rows.map((r) => r.name)), next: (top?.position ?? -1) + 1 };
}

/** `POST /app/api/group-sets/:id/groups`: an empty group, last, named "Group k" by default. */
export async function createGroup(db: Db, scope: SetScope, name: string | undefined, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const { names, next } = await groupsSoFar(tx, set.id);
    const chosen = name ?? defaultGroupName(names, ctx.locale);
    if (names.has(chosen)) throw duplicateName(chosen);
    const id = randomUUID();
    await tx.insert(studentGroups).values({ id, setId: set.id, name: chosen, position: next, createdAt: ctx.now });
    return { action: "group.create", payload: { groupId: id, name: chosen } };
  });
}

/** `PATCH /app/api/group-sets/:id/groups/:gid`: the copies follow the name (ADR-070 §4). */
export async function renameGroup(db: Db, scope: SetScope, groupId: string, name: string, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const group = await groupOf(tx, set.id, groupId);
    if (group.name === name) return null;
    await refuseTakenName(tx, set.id, name, group.id);
    await tx.update(studentGroups).set({ name }).where(eq(studentGroups.id, group.id));
    return { action: "group.rename", payload: { groupId: group.id, from: group.name, to: name } };
  });
}

/** `DELETE /app/api/group-sets/:id/groups/:gid`: its students in no group; a following copy's group goes too. */
export async function deleteGroup(db: Db, scope: SetScope, groupId: string, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const group = await groupOf(tx, set.id, groupId);
    await tx.delete(studentGroups).where(eq(studentGroups.id, group.id));
    return { action: "group.delete", payload: { groupId: group.id, name: group.name } };
  });
}

/**
 * `PUT /app/api/group-sets/:id/members/:eid`: the student into a group of
 * the set, or out of every group (`groupId: null`). A roster line of
 * another classroom, or a staff seat, is the 404 of a missing student.
 */
export async function placeStudent(db: Db, scope: SetScope, enrollmentId: string, body: GroupMemberPut, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const [student] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), isStudentOf(set.classroomId)));
    if (!student) throw notFound("student");
    if (body.groupId !== null) await groupOf(tx, set.id, body.groupId);
    const [current] = await tx
      .select({ groupId: studentGroupMembers.groupId })
      .from(studentGroupMembers)
      .where(and(eq(studentGroupMembers.setId, set.id), eq(studentGroupMembers.enrollmentId, student.id)));
    const from = current?.groupId ?? null;
    if (from === body.groupId) return null;
    if (body.groupId === null) {
      await tx.delete(studentGroupMembers).where(and(eq(studentGroupMembers.setId, set.id), eq(studentGroupMembers.enrollmentId, student.id)));
    } else {
      await tx
        .insert(studentGroupMembers)
        .values({ id: randomUUID(), setId: set.id, groupId: body.groupId, enrollmentId: student.id, addedAt: ctx.now })
        .onConflictDoUpdate({
          target: [studentGroupMembers.setId, studentGroupMembers.enrollmentId],
          set: { groupId: body.groupId, addedAt: ctx.now },
        });
    }
    return { action: "group.member_move", payload: { enrollmentId: student.id, from, to: body.groupId } };
  });
}

/**
 * `POST /app/api/group-sets/:id/random` (ADR-070 §3): the set's students in
 * no group, shuffled (`crypto`) and cut into new groups of `size`; groups
 * already formed are never touched. `409 nobody_to_place`, `422
 * size_out_of_range` (above their number).
 */
export async function formRandom(db: Db, scope: SetScope, body: GroupRandomForm, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const free = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .leftJoin(studentGroupMembers, and(eq(studentGroupMembers.enrollmentId, enrollments.id), eq(studentGroupMembers.setId, set.id)))
      .where(and(isStudentOf(set.classroomId), isNull(studentGroupMembers.id)))
      .orderBy(asc(enrollments.id));
    if (free.length === 0) throw new GroupError("nobody_to_place", "Every student of the set is in a group");
    if (body.size > free.length) {
      throw new GroupError("size_out_of_range", `A size from 1 to ${free.length}`, { max: free.length });
    }
    const drawn = formRandomGroups(free.map((s) => s.id), body.size, body.remainder, randomInt);
    const { names, next } = await groupsSoFar(tx, set.id);
    const groups = drawn.map((members, i) => {
      const name = defaultGroupName(names, ctx.locale);
      names.add(name);
      return { id: randomUUID(), name, position: next + i, members };
    });
    await tx.insert(studentGroups).values(groups.map((g) => ({ id: g.id, setId: set.id, name: g.name, position: g.position, createdAt: ctx.now })));
    await tx.insert(studentGroupMembers).values(
      groups.flatMap((g) => g.members.map((enrollmentId) => ({ id: randomUUID(), setId: set.id, groupId: g.id, enrollmentId, addedAt: ctx.now }))),
    );
    return {
      action: "group.random_form",
      payload: { size: body.size, remainder: body.remainder, groups: groups.map((g) => g.id), placed: free.length },
    };
  });
}
