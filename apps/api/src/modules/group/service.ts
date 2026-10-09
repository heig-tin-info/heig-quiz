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
 * after the commit, to the course's staff only (ADR-070 §9). A step that
 * would delete a copy group with a repository refuses the whole write,
 * `409 has_repo`; a rename still follows, the repository's name fixed. A
 * move out of such a group, or into it, is applied on GitHub by the
 * `group.sync` job (M3-15b-2) once its consequences are confirmed: the
 * write ADDING any answers `409 needs_confirmation` (the consequences and
 * their digest) until it is sent again with `confirm: <digest>`; the
 * route then sends the job (`requestGroupSync`).
 *
 * **The students of a set** are the classroom's roster lines, claimed or
 * not, except staff seats (ADR-018): never placed, never counted, never
 * drawn; a line that became a staff seat after it was placed is filtered
 * out of every read and of the copies.
 *
 * Default names are written in the creator's language (D10): "Group k"
 * (fr "Groupe k"), "Groups of <date> <time>" (fr "Groupes du …").
 *
 * **The students' side** (lot 2, F-PROJ-22, M3-17). The staff open a set to
 * its students until a date (`open_until`, a maximum size then required:
 * `422 max_size_required`). While it is open, a student of a claimed seat
 * creates and names a group (moving in), joins one below the maximum, leaves
 * theirs, renames theirs — each through `writeSet` like the staff's, checked
 * under the set's lock BEFORE any step: open by the server's clock
 * (`409 set_closed`, no grace), no group of the set with a repository in any
 * project (`409 set_frozen`, so a student's write never reaches
 * `needs_confirmation`), room left (`409 group_full`, the lock serialising
 * the last seat). What a student reads is {@link studentGroupSets}, the
 * module's one student exit (N-SEC-20): names, sizes, members' names —
 * nothing else. A write on a set that reaches the students hints the
 * `user:` topic of each claimed student of the classroom (never
 * `classroom:`).
 */
import { randomInt, randomUUID } from "node:crypto";

import { and, asc, count, eq, inArray, isNotNull, isNull, max, ne, not, sql, type SQL } from "drizzle-orm";

import type {
  GroupMemberName,
  GroupMemberPut,
  GroupRandomForm,
  GroupRefusalProjects,
  GroupSetCreate,
  GroupSetDetail,
  GroupSetPatch,
  GroupSetSummary,
  GroupSetUse,
  StudentGroupSet,
  StudentGroupSetCard,
  StudentGroupSets,
} from "@quiz/contracts";
import { copyFollows, defaultGroupName, defaultSetName, duplicateSetName, formRandomGroups, type NameLocale } from "@quiz/domain";

import { audit, type AuditAction, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, courses, enrollments, groupSets, projects, studentGroupMembers, studentGroups } from "../../db/schema.js";
import { openSet, studentVisibleSet } from "../guards.js";
import { notFoundError } from "../http.js";
import { ConfirmationNeeded, copiesBefore, followingCopies, projectsChanged, RepoGroupTouched, setFrozen, stepCopies } from "../project/service.js";
import { GroupError } from "./errors.js";
import { groupsChanged } from "./events.js";

type SetRow = typeof groupSets.$inferSelect;

/** Who writes, when, in which language a default name is written; the digest of the consequences the writer confirmed. */
export interface WriteContext {
  actor: AuditActor;
  userId: string;
  locale: NameLocale;
  now: Date;
  confirm?: string | undefined;
}

/** A set as a student's write loaded it (`studentGroupSet`, `guards.ts`): the scope and the writer's claimed student seat. */
export interface StudentSetScope extends SetScope {
  seat: { id: string };
}

/** The set as its loader found it (`accessibleGroupSet`): the set, its classroom and course. */
export interface SetScope {
  set: SetRow;
  room: { id: string };
  course: { id: string };
}


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

/**
 * The sets matching `where`, the oldest first, with what every read says of
 * them: `readOnly` (the classroom archived), `open` — {@link openSet}, THE
 * rule of an open set, read as a column — and `frozen` ({@link setFrozen}:
 * a group with a repository in a project naming it).
 */
function setRows(db: Db | Tx, where: SQL | undefined, now: Date) {
  return db
    .select({
      set: groupSets,
      readOnly: sql<boolean>`(${classrooms.archivedAt} IS NOT NULL)`,
      open: sql<boolean>`${openSet(now)}`,
      frozen: sql<boolean>`${setFrozen(db, groupSets.id)}`,
    })
    .from(groupSets)
    .innerJoin(classrooms, eq(classrooms.id, groupSets.classroomId))
    .where(where)
    .orderBy(asc(groupSets.createdAt), asc(groupSets.id));
}

/** Whether a set matching `where` reaches its students now ({@link studentVisibleSet}). */
async function anyVisibleSet(db: Db | Tx, where: SQL, now: Date): Promise<boolean> {
  const [row] = await setRows(db, and(where, studentVisibleSet(now)), now).limit(1);
  return row !== undefined;
}

/** `GET /app/api/classrooms/:id/group-sets`: the classroom's sets, the oldest first. */
export async function classroomGroupSets(db: Db, classroomId: string, now: Date): Promise<GroupSetSummary[]> {
  const rows = await setRows(db, eq(groupSets.classroomId, classroomId), now);
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.set.id);
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
  return rows.map(({ set: s, open }) => {
    const placed = placedOf.get(s.id) ?? 0;
    return {
      id: s.id,
      name: s.name,
      maxSize: s.maxSize,
      groups: groupsOf.get(s.id) ?? 0,
      placed,
      unplaced: students!.n - placed,
      createdAt: iso(s.createdAt),
      openUntil: s.openUntil === null ? null : iso(s.openUntil),
      open,
      usedBy: uses.get(s.id) ?? [],
    };
  });
}

/** `GET /app/api/group-sets/:id`, and the answer of every write on the set. */
export async function groupSetDetail(db: Db, setId: string, now: Date): Promise<GroupSetDetail> {
  const [row] = await setRows(db, eq(groupSets.id, setId), now);
  if (!row) throw notFoundError("group set");
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
      readOnly: row.readOnly,
      openUntil: set.openUntil === null ? null : iso(set.openUntil),
      open: row.open,
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
  if (!room) throw notFoundError("classroom");
  if (room.archivedAt !== null) throw new GroupError("classroom_archived", "The classroom is archived: its group sets are read-only");
}

/** The write's audit entry; null when it changed nothing (no audit, no hint). */
type Written = { action: AuditAction; payload: Record<string, unknown> } | null;

/** The project module's refusals of a step, worded as the group's. */
async function stepRefusal(tx: Tx, err: unknown): Promise<never> {
  if (err instanceof ConfirmationNeeded) {
    throw new GroupError("needs_confirmation", "This change has consequences on GitHub: confirm them", err.details);
  }
  if (!(err instanceof RepoGroupTouched)) throw err;
  const held = await tx.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, [...err.projectIds])).orderBy(asc(projects.id));
  const details: GroupRefusalProjects = { projects: held };
  throw new GroupError("has_repo", "This change deletes a group that has a repository on GitHub", details);
}

/** The accounts of the classroom's claimed student seats: whom a write on a set they read is hinted to. */
async function claimedStudents(tx: Tx, classroomId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: enrollments.userId })
    .from(enrollments)
    .where(and(isStudentOf(classroomId), isNotNull(enrollments.userId)));
  return rows.map((r) => r.userId!);
}

/**
 * One write of a set (see the module's header): the copies that follow it
 * are locked and read before the write and stepped after it, in its
 * transaction. The projects whose moves now wait for the `group.sync` job.
 */
async function writeSet(db: Db, scope: SetScope, ctx: WriteContext, write: (tx: Tx, set: SetRow) => Promise<Written>): Promise<string[]> {
  const done = await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const [set] = await tx.select().from(groupSets).where(eq(groupSets.id, scope.set.id)).for("update");
    if (!set) throw notFoundError("group set");
    const before = await copiesBefore(tx, set.id, await followingCopies(tx, set.id));
    const thisSet = eq(groupSets.id, set.id);
    const seenBefore = await anyVisibleSet(tx, thisSet, ctx.now);
    const written = await write(tx, set);
    if (!written) return null;
    const stepped = await stepCopies(tx, set.id, before, { now: ctx.now, confirm: ctx.confirm }).catch((err: unknown) => stepRefusal(tx, err));
    await audit(tx, {
      ...ctx.actor,
      action: written.action,
      subjectType: "group_set",
      subjectId: set.id,
      payload: { ...written.payload, copies: stepped.changed, deferred: stepped.due },
    });
    // Seen by the students before or after (opened, closed, deleted): they re-read.
    const seen = seenBefore || (await anyVisibleSet(tx, thisSet, ctx.now));
    return { stepped, readers: seen ? await claimedStudents(tx, set.classroomId) : [] };
  });
  if (!done) return [];
  groupsChanged(scope.course.id, done.readers);
  if (done.stepped.changed.length > 0) projectsChanged([scope.course.id]);
  return done.stepped.due;
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

/**
 * `PATCH /app/api/group-sets/:id`: its name, its maximum size, its opening
 * to the students (F-PROJ-22: a date opens it until then, null closes it,
 * reopening allowed). A set open after the write needs a maximum size
 * (`422 max_size_required`).
 */
export async function patchGroupSet(db: Db, scope: SetScope, body: GroupSetPatch, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const openUntil = body.openUntil === undefined ? set.openUntil : body.openUntil === null ? null : new Date(body.openUntil);
    const maxSize = body.maxSize === undefined ? set.maxSize : body.maxSize;
    if (openUntil !== null && openUntil > ctx.now && maxSize === null) {
      throw new GroupError("max_size_required", "A group set open to its students needs a maximum size");
    }
    await tx.update(groupSets).set({ ...body, openUntil }).where(eq(groupSets.id, set.id));
    return { action: "group_set.update", payload: body };
  });
}

/**
 * `POST /app/api/group-sets/:id/duplicate`: a new set of the same
 * classroom with the same groups and members (staff seats left out),
 * named "<name> (copy)" in the creator's language, closed to the students.
 * Its id.
 */
export async function duplicateGroupSet(db: Db, scope: SetScope, ctx: WriteContext): Promise<string> {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    await lockClassroom(tx, scope.room.id);
    const [source] = await tx.select().from(groupSets).where(eq(groupSets.id, scope.set.id)).for("share");
    if (!source) throw notFoundError("group set");
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
      const details: GroupRefusalProjects = { projects: holding };
      throw new GroupError("set_in_use", `${holding.length} project(s) follow this group set`, details);
    }
    await tx.delete(groupSets).where(eq(groupSets.id, set.id));
    return { action: "group_set.delete", payload: { name: set.name } };
  });
}

// ---------------------------------------------------------------- groups

/** The set's group `groupId`, or the 404 of a missing one. */
async function groupOf(tx: Tx, setId: string, groupId: string) {
  const [group] = await tx.select().from(studentGroups).where(and(eq(studentGroups.id, groupId), eq(studentGroups.setId, setId)));
  if (!group) throw notFoundError("group");
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

/** A new group of the set, last, named `name` or "Group k" in `locale` (`409 duplicate_name`). */
async function insertGroup(tx: Tx, setId: string, name: string | undefined, locale: NameLocale, now: Date): Promise<{ groupId: string; name: string }> {
  const { names, next } = await groupsSoFar(tx, setId);
  const chosen = name ?? defaultGroupName(names, locale);
  if (names.has(chosen)) throw duplicateName(chosen);
  const groupId = randomUUID();
  await tx.insert(studentGroups).values({ id: groupId, setId, name: chosen, position: next, createdAt: now });
  return { groupId, name: chosen };
}

/** Group `groupId` of the set renamed — the copies follow the name (ADR-070 §4); null when unchanged. */
async function renameIn(tx: Tx, setId: string, groupId: string, name: string, own?: string): Promise<Written> {
  const group = await groupOf(tx, setId, groupId);
  // A student renames their own group only: another is the 404 of a missing one.
  if (own !== undefined && (await groupNow(tx, setId, own)) !== group.id) throw notFoundError("group");
  if (group.name === name) return null;
  await refuseTakenName(tx, setId, name, group.id);
  await tx.update(studentGroups).set({ name }).where(eq(studentGroups.id, group.id));
  return { action: "group.rename", payload: { groupId: group.id, from: group.name, to: name } };
}

/** `POST /app/api/group-sets/:id/groups`: an empty group, last, named "Group k" by default. */
export async function createGroup(db: Db, scope: SetScope, name: string | undefined, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => ({ action: "group.create", payload: await insertGroup(tx, set.id, name, ctx.locale, ctx.now) }));
}

/** `PATCH /app/api/group-sets/:id/groups/:gid`. */
export async function renameGroup(db: Db, scope: SetScope, groupId: string, name: string, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, (tx, set) => renameIn(tx, set.id, groupId, name));
}

/** `DELETE /app/api/group-sets/:id/groups/:gid`: its students in no group; a following copy's group goes too. */
export async function deleteGroup(db: Db, scope: SetScope, groupId: string, ctx: WriteContext): Promise<void> {
  await writeSet(db, scope, ctx, async (tx, set) => {
    const group = await groupOf(tx, set.id, groupId);
    await tx.delete(studentGroups).where(eq(studentGroups.id, group.id));
    return { action: "group.delete", payload: { groupId: group.id, name: group.name } };
  });
}

/** The group of the set `enrollmentId` is in, null when in none. */
async function groupNow(tx: Tx, setId: string, enrollmentId: string): Promise<string | null> {
  const [current] = await tx
    .select({ groupId: studentGroupMembers.groupId })
    .from(studentGroupMembers)
    .where(and(eq(studentGroupMembers.setId, setId), eq(studentGroupMembers.enrollmentId, enrollmentId)));
  return current?.groupId ?? null;
}

/** The students of a group, staff seats aside: its size against the maximum. */
async function sizeOf(tx: Tx, set: SetRow, groupId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(studentGroupMembers)
    .innerJoin(enrollments, eq(enrollments.id, studentGroupMembers.enrollmentId))
    .where(and(eq(studentGroupMembers.groupId, groupId), isStudentOf(set.classroomId)));
  return row?.n ?? 0;
}

/**
 * `enrollmentId` into group `to` of the set (moved out of the one they were
 * in), or out of every group (null); null when already there. `capacity`:
 * a student's move, refused at the set's maximum or above (`409
 * group_full`, a group the staff filled past it included) — the set's lock
 * serialises two racing for the last seat. The staff's maximum is advisory.
 */
async function placeIn(tx: Tx, set: SetRow, enrollmentId: string, to: string | null, now: Date, { capacity = false } = {}): Promise<Written> {
  if (to !== null) await groupOf(tx, set.id, to);
  const from = await groupNow(tx, set.id, enrollmentId);
  if (from === to) return null;
  if (to === null) {
    await tx.delete(studentGroupMembers).where(and(eq(studentGroupMembers.setId, set.id), eq(studentGroupMembers.enrollmentId, enrollmentId)));
  } else {
    if (capacity && set.maxSize !== null && (await sizeOf(tx, set, to)) >= set.maxSize) {
      throw new GroupError("group_full", `This group already has ${set.maxSize} member(s)`, { max: set.maxSize });
    }
    await tx
      .insert(studentGroupMembers)
      .values({ id: randomUUID(), setId: set.id, groupId: to, enrollmentId, addedAt: now })
      .onConflictDoUpdate({
        target: [studentGroupMembers.setId, studentGroupMembers.enrollmentId],
        set: { groupId: to, addedAt: now },
      });
  }
  return { action: "group.member_move", payload: { enrollmentId, from, to } };
}

/**
 * `PUT /app/api/group-sets/:id/members/:eid`: the student into a group of
 * the set, or out of every group (`groupId: null`). A roster line of
 * another classroom, or a staff seat, is the 404 of a missing student.
 * The projects whose part of it waits for the `group.sync` job.
 */
export async function placeStudent(db: Db, scope: SetScope, enrollmentId: string, body: GroupMemberPut, ctx: WriteContext): Promise<string[]> {
  return writeSet(db, scope, ctx, async (tx, set) => {
    const [student] = await tx
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.id, enrollmentId), isStudentOf(set.classroomId)));
    if (!student) throw notFoundError("student");
    return placeIn(tx, set, student.id, body.groupId, ctx.now);
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

// ---------------------------------------------------------------- the students' writes (F-PROJ-22, M3-17)

const frozen = () => new GroupError("set_frozen", "A group of this set has a repository: only the staff change its groups now");

/**
 * A student's write: `writeSet`, the set checked under its lock before
 * anything is written or stepped — still open by the server's clock (`409
 * set_closed`, no grace: {@link openSet} read again under the lock; the
 * archive is `lockClassroom`'s `409 classroom_archived` first), and not
 * frozen (`409 set_frozen`, {@link setFrozen}). The audit names the student (`self`, their line).
 */
async function studentWrite(db: Db, scope: StudentSetScope, ctx: WriteContext, write: (tx: Tx, set: SetRow) => Promise<Written>): Promise<void> {
  try {
    await writeSet(db, scope, ctx, async (tx, set) => {
      // The set as every read sees it (`openSet`, `setFrozen`), re-read under the lock this write holds.
      const [row] = await setRows(tx, eq(groupSets.id, set.id), ctx.now);
      if (!row?.open) throw new GroupError("set_closed", "This group set is closed to its students");
      if (row.frozen) throw frozen();
      const written = await write(tx, set);
      return written && { action: written.action, payload: { ...written.payload, enrollmentId: scope.seat.id, self: true } };
    });
  } catch (err) {
    // Never reached (the freeze is checked first); fail closed should a step still reach GitHub.
    if (err instanceof GroupError && (err.code === "needs_confirmation" || err.code === "has_repo")) throw frozen();
    throw err;
  }
}

/**
 * `POST /app/api/group-sets/:id/student/groups`: a new group, last, named
 * "Group k" by default in the student's language, with the student moved in
 * (their former group, emptied or not, stays). One audit: `group.create`
 * with the group the student left.
 */
export async function studentCreateGroup(db: Db, scope: StudentSetScope, name: string | undefined, ctx: WriteContext): Promise<void> {
  await studentWrite(db, scope, ctx, async (tx, set) => {
    const created = await insertGroup(tx, set.id, name, ctx.locale, ctx.now);
    const moved = await placeIn(tx, set, scope.seat.id, created.groupId, ctx.now);
    return { action: "group.create", payload: { ...created, from: moved?.payload.from ?? null } };
  });
}

/** `PUT /app/api/group-sets/:id/student/membership`: the student into a group below the maximum. */
export async function studentJoin(db: Db, scope: StudentSetScope, groupId: string, ctx: WriteContext): Promise<void> {
  await studentWrite(db, scope, ctx, (tx, set) => placeIn(tx, set, scope.seat.id, groupId, ctx.now, { capacity: true }));
}

/** `DELETE /app/api/group-sets/:id/student/membership`: the student out of their group (kept, even empty). */
export async function studentLeave(db: Db, scope: StudentSetScope, ctx: WriteContext): Promise<void> {
  await studentWrite(db, scope, ctx, (tx, set) => placeIn(tx, set, scope.seat.id, null, ctx.now));
}

/** `PATCH /app/api/group-sets/:id/student/groups/:gid`: the student's own group renamed. */
export async function studentRenameGroup(db: Db, scope: StudentSetScope, groupId: string, name: string, ctx: WriteContext): Promise<void> {
  await studentWrite(db, scope, ctx, (tx, set) => renameIn(tx, set.id, groupId, name, scope.seat.id));
}

// ---------------------------------------------------------------- the students' view (N-SEC-20)

/**
 * Who reads: their claimed seat in the classroom (null: none, e.g. a teacher
 * in the student view without one), and whether they may write
 * (`selfFormingSeat`, `guards.ts`).
 */
export interface StudentReader {
  seatId: string | null;
  writer: boolean;
}

/**
 * `GET /app/api/classrooms/:id/group-sets/student`, and the answer of every
 * student write: the classroom's sets that reach its students
 * ({@link studentVisibleSet}), the oldest first, as `reader` reads them —
 * THE student exit of the module (ADR-070 §8, N-SEC-20). Every field is
 * picked by hand: names, sizes, members' first and last names; never a
 * roster line's id, a claim, an e-mail, a GitHub login, the projects naming
 * a set. Open: every group and the students in no group; closed: the
 * reader's own group alone. Three reads whatever the number of sets.
 */
export async function studentGroupSets(db: Db, classroomId: string, reader: StudentReader, now: Date): Promise<StudentGroupSets> {
  const rows = await setRows(db, and(eq(groupSets.classroomId, classroomId), studentVisibleSet(now)), now);
  if (rows.length === 0) return { serverNow: iso(now), sets: [] };
  const ids = rows.map((r) => r.set.id);
  const groups = await db
    .select({ id: studentGroups.id, setId: studentGroups.setId, name: studentGroups.name })
    .from(studentGroups)
    .where(inArray(studentGroups.setId, ids))
    .orderBy(asc(studentGroups.position));
  const students = await db
    .select({ id: enrollments.id, nom: enrollments.nom, prenom: enrollments.prenom })
    .from(enrollments)
    .where(isStudentOf(classroomId))
    .orderBy(asc(enrollments.nom), asc(enrollments.prenom), asc(enrollments.id));
  const places = await db
    .select({ setId: studentGroupMembers.setId, groupId: studentGroupMembers.groupId, enrollmentId: studentGroupMembers.enrollmentId })
    .from(studentGroupMembers)
    .where(inArray(studentGroupMembers.setId, ids));
  const groupOfLine = new Map(places.map((p) => [`${p.setId}:${p.enrollmentId}`, p.groupId]));
  const name = (s: (typeof students)[number]): GroupMemberName => ({ nom: s.nom, prenom: s.prenom });

  const sets = rows.map(({ set, open, frozen }): StudentGroupSet => {
    const placeOf = (line: string) => groupOfLine.get(`${set.id}:${line}`) ?? null;
    const myGroupId = reader.seatId === null ? null : placeOf(reader.seatId);
    const shown = groups.filter((g) => g.setId === set.id && (open || g.id === myGroupId));
    return {
      set: { id: set.id, name: set.name, maxSize: set.maxSize, openUntil: set.openUntil === null ? null : iso(set.openUntil), open },
      writable: open && reader.writer && !frozen,
      myGroupId,
      groups: shown.map((g) => {
        const members = students.filter((s) => placeOf(s.id) === g.id).map(name);
        return { id: g.id, name: g.name, size: members.length, members };
      }),
      ...(open ? { unplaced: students.filter((s) => placeOf(s.id) === null).map(name) } : {}),
    };
  });
  return { serverNow: iso(now), sets };
}

/** Whether a set of the classroom reaches its students: the student page's Groups tab (`hasGroups`). */
export function hasStudentGroupSets(db: Db, classroomId: string, now: Date): Promise<boolean> {
  return anyVisibleSet(db, eq(groupSets.classroomId, classroomId), now);
}

/**
 * The sets OPEN to `userId`'s self-formation in the classrooms where they
 * hold a claimed STUDENT seat (one classroom: the classroom page), the soonest
 * closing first: the "Form your group until …" rows of their Activities
 * (S3). A frozen set invites nobody: it has no row.
 */
export async function studentGroupSetCards(db: Db, userId: string, now: Date, classroomId?: string): Promise<StudentGroupSetCard[]> {
  const rows = await db
    .select({ set: groupSets, classroomName: classrooms.name, courseCode: courses.code, myGroup: studentGroups.name })
    .from(enrollments)
    .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
    .innerJoin(courses, eq(courses.id, classrooms.courseId))
    .innerJoin(groupSets, eq(groupSets.classroomId, classrooms.id))
    .leftJoin(studentGroupMembers, and(eq(studentGroupMembers.setId, groupSets.id), eq(studentGroupMembers.enrollmentId, enrollments.id)))
    .leftJoin(studentGroups, eq(studentGroups.id, studentGroupMembers.groupId))
    .where(
      and(
        eq(enrollments.userId, userId),
        // A student seat: a staff seat (a teacher in the student view, ADR-018) forms no group, so it is not invited.
        eq(enrollments.staff, false),
        classroomId === undefined ? undefined : eq(enrollments.classroomId, classroomId),
        openSet(now),
        not(setFrozen(db, groupSets.id)),
      ),
    )
    .orderBy(asc(groupSets.openUntil), asc(groupSets.id));
  return rows.map((r) => ({
    id: r.set.id,
    classroomId: r.set.classroomId,
    classroomName: r.classroomName,
    courseCode: r.courseCode,
    name: r.set.name,
    openUntil: iso(r.set.openUntil!),
    myGroup: r.myGroup,
  }));
}
