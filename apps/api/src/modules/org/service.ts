/**
 * The `org` module's business layer (PLAN-MVP §4.1): courses, their staff,
 * classrooms, the roster, and the student's own list of classrooms.
 *
 * Every statement the routes run is here (audit B-12); `./roster.ts` holds
 * the roster import and the claim rules, a helper of this module that the
 * sign-in path reaches through the re-export below, and `./conditions.ts`
 * the course's catalog of conditions (F-ORG-16). Access is NOT decided
 * here: the routes load the entity through the guards first (invariant 6),
 * and a list takes the access predicate as an argument.
 */
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type {
  CourseCreate,
  CoursePatch,
  CourseRole,
  EnrollmentPatch,
  StudentClassroom,
  StudentClassroomPage,
  TeacherCandidates,
} from "@quiz/contracts";
import { effectiveCourseRole, staffChangeRefusal, type StaffChange } from "@quiz/domain";

import type { AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { isUniqueViolation, type Db, type Tx } from "../../db/client.js";
import { findTeacherById, searchTeachers } from "../../directory.js";
import { ownersOf } from "../../identity.js";
import {
  avatars,
  classrooms,
  courseStaff,
  courses,
  enrollments,
  userCoursePrefs,
  users,
} from "../../db/schema.js";
import { shownAvatar } from "../avatar.js";
import { countTemplates } from "../evaluation/service.js";
import { purgeProjectReceipts } from "../github/service.js";
import { releaseLine, revokeEnrollmentAccess, RevokeFailed, type RevokeVia } from "../project/service.js";
import { accessRevoked } from "../realtime/bus.js";
import { rosterRefusal } from "./errors.js";

/** The account a new staff seat goes to, or the 409 body that refuses it. */
export type Seatable = { id: string; email: string } | { error: "unknown_account" | "ambiguous_account"; message: string };

/**
 * A pick is a staff account (`findTeacherById`): anyone else is refused as
 * unknown, so the route tells nothing about who exists beyond the directory.
 */
async function byPick(db: Db, userId: string): Promise<Seatable> {
  return (await findTeacherById(db, userId)) ?? { error: "unknown_account", message: "No teacher has this account" };
}

/**
 * A seat is held by an ACCOUNT, not by an address: the identity of a person
 * is a set of addresses (GH-11), so the one behind a typed address must have
 * signed in once, and be the only account holding it.
 */
async function byAddress(db: Db, email: string): Promise<Seatable> {
  const owners = await ownersOf(db, email);
  if (owners.length === 1) return { id: owners[0]!, email };
  return owners.length === 0
    ? { error: "unknown_account", message: "No account has signed in with this address yet" }
    : { error: "ambiguous_account", message: "Several accounts hold this address" };
}

/** Whom a staff invitation names: the picked account, else the one behind the typed address. */
export async function resolveStaffInvitee(
  db: Db,
  body: { userId?: string | undefined; email?: string | undefined },
): Promise<Seatable> {
  return body.userId !== undefined ? byPick(db, body.userId) : byAddress(db, body.email!);
}

export { claimEnrollments, claimLines, type ClaimMatch } from "./roster.js";
export {
  conditionOfCourse,
  conditionView,
  createCondition,
  listConditions,
  reorderConditions,
  setConditionArchived,
  updateCondition,
  type CourseConditionRecord,
} from "./conditions.js";

type CourseRecord = typeof courses.$inferSelect;
type ClassroomRecord = typeof classrooms.$inferSelect;
type EnrollmentRecord = typeof enrollments.$inferSelect;

// --- Courses ----------------------------------------------------------------

/** Staff of a set of courses, for the course cards. */
async function staffOf(db: Db, courseIds: string[]) {
  if (courseIds.length === 0) return [];
  return db
    .select({
      courseId: courseStaff.courseId,
      userId: users.id,
      role: courseStaff.role,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
      pictureUrl: users.pictureUrl,
      avatarAt: avatars.updatedAt,
    })
    .from(courseStaff)
    .innerJoin(users, eq(courseStaff.userId, users.id))
    .leftJoin(avatars, eq(avatars.userId, users.id))
    .where(inArray(courseStaff.courseId, courseIds))
    .orderBy(users.familyName, users.givenName);
}

/**
 * The course cards of `GET /courses`: every course `access` lets through
 * (`accessWhere(user, staffAccess(user.id))`), with its live classrooms and
 * their headcounts, its staff, whether the viewer hid it (#155) and the
 * viewer's role on it (ADR-068: `owner` under Super Powers, else their seat's).
 *
 * A hidden course is still IN the list, flagged: hiding takes a course out
 * of the viewer's navigation only (ADR-032), and the pickers and the MCP
 * `list_courses` read this same list and must keep seeing it.
 */
export async function listCourses(
  db: Db,
  access: SQL | undefined,
  viewer: { id: string; reachesAll: boolean },
) {
  const viewerId = viewer.id;
  const rows = await db
    .select({
      id: courses.id,
      name: courses.name,
      code: courses.code,
      icon: courses.icon,
      color: courses.color,
      createdAt: courses.createdAt,
      hiddenAt: userCoursePrefs.hiddenAt,
    })
    .from(courses)
    .leftJoin(
      userCoursePrefs,
      and(eq(userCoursePrefs.courseId, courses.id), eq(userCoursePrefs.userId, viewerId)),
    )
    .where(access)
    .orderBy(asc(courses.code));
  const ids = rows.map((r) => r.id);
  const rooms = ids.length
    ? await db
        .select({
          id: classrooms.id,
          name: classrooms.name,
          period: classrooms.period,
          periodStart: classrooms.periodStart,
          periodEnd: classrooms.periodEnd,
          courseId: classrooms.courseId,
          createdAt: classrooms.createdAt,
          archivedAt: classrooms.archivedAt,
          students: sql<number>`count(${enrollments.id}) filter (where not ${enrollments.staff})::int`,
          claimed: sql<number>`count(${enrollments.id}) filter (where ${enrollments.userId} is not null and not ${enrollments.staff})::int`,
        })
        .from(classrooms)
        .leftJoin(enrollments, eq(enrollments.classroomId, classrooms.id))
        .where(and(inArray(classrooms.courseId, ids), isNull(classrooms.archivedAt)))
        .groupBy(classrooms.id)
        .orderBy(classrooms.createdAt)
    : [];
  const staff = await staffOf(db, ids);
  const templates = await countTemplates(db, ids);
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    icon: c.icon,
    color: c.color,
    createdAt: c.createdAt.toISOString(),
    hidden: c.hiddenAt !== null,
    // Every listed course is reached by a seat or by Super Powers, so the
    // role is never null here; `assistant` is only the type's floor.
    myRole:
      effectiveCourseRole({
        reachesAll: viewer.reachesAll,
        seatRole: staff.find((s) => s.courseId === c.id && s.userId === viewerId)?.role ?? null,
      }) ?? ("assistant" as const),
    templates: templates.get(c.id) ?? 0,
    classrooms: rooms
      .filter((r) => r.courseId === c.id)
      .map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        courseId: c.id,
        courseName: c.name,
        courseCode: c.code,
        createdAt: r.createdAt.toISOString(),
        archivedAt: r.archivedAt?.toISOString() ?? null,
        students: r.students,
        claimed: r.claimed,
      })),
    staff: staff
      .filter((s) => s.courseId === c.id)
      .map((s) => ({
        userId: s.userId,
        givenName: s.givenName,
        familyName: s.familyName,
        email: s.email,
        avatarUrl: shownAvatar(s.userId, s.avatarAt, s.pictureUrl),
        role: s.role,
      })),
  }));
}

/**
 * Creates a course with its creator as the first member of the staff, its
 * owner: a course without one would be run by nobody but an admin. `null`
 * when the code is taken (nothing is written then).
 */
export async function createCourse(
  db: Db,
  input: CourseCreate,
  creatorId: string,
): Promise<CourseRecord | null> {
  const id = randomUUID();
  const [created] = await db
    .insert(courses)
    .values({
      id,
      name: input.name,
      code: input.code,
      icon: input.icon ?? null,
      color: input.color ?? null,
    })
    .onConflictDoNothing({ target: courses.code })
    .returning();
  if (!created) return null;
  await db.insert(courseStaff).values({ courseId: id, userId: creatorId, role: "owner" });
  return created;
}

/**
 * Renames a course, its name or its code, or changes its icon and colour
 * (null puts the default back). `null` when the new code is
 * already another course's: the code is unique across the instance, and the
 * caller answers 409 `duplicate_code` as the creation does.
 */
export async function updateCourse(
  db: Db,
  courseId: string,
  patch: CoursePatch,
) {
  try {
    const [updated] = await db
      .update(courses)
      .set({
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.code ? { code: patch.code } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.color !== undefined ? { color: patch.color } : {}),
        updatedAt: new Date(),
      })
      .where(eq(courses.id, courseId))
      .returning();
    return updated;
  } catch (err) {
    if (isUniqueViolation(err, "courses_code_unique")) return null;
    throw err;
  }
}

/**
 * Deletes the course and, by cascade, its classrooms and everything they
 * hold (F-ORG-09). Its projects' push receipts go first, in the same
 * transaction: no foreign key reaches them (N-DATA-03). Nothing is deleted
 * on GitHub (D19).
 */
export async function deleteCourse(db: Db, courseId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await purgeProjectReceipts(tx, { courseId });
    await tx.delete(courses).where(eq(courses.id, courseId));
  });
}

/** The course's staff, for the course detail. */
export async function staffOfCourse(db: Db, courseId: string) {
  return db
    .select({
      userId: users.id,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
      role: courseStaff.role,
    })
    .from(courseStaff)
    .innerJoin(users, eq(courseStaff.userId, users.id))
    .where(eq(courseStaff.courseId, courseId))
    .orderBy(asc(users.familyName), asc(users.givenName));
}

/**
 * Hides a course from ONE user's navigation, or shows it again (#155,
 * ADR-032). Personal display state: no audit event, and nothing changes for
 * the course's other staff members. Unhiding clears the column and keeps the
 * row, the home of any later per-user preference.
 */
export async function setCourseHidden(
  db: Db,
  userId: string,
  courseId: string,
  hidden: boolean,
): Promise<void> {
  const hiddenAt = hidden ? new Date() : null;
  await db
    .insert(userCoursePrefs)
    .values({ userId, courseId, hiddenAt })
    .onConflictDoUpdate({ target: [userCoursePrefs.userId, userCoursePrefs.courseId], set: { hiddenAt } });
}

// --- Course staff -----------------------------------------------------------

/**
 * The teachers and admins who hold no seat on the course's staff yet,
 * matched on name or address: what the picker of "Add a person" offers.
 */
export async function staffCandidates(db: Db, courseId: string, q: string): Promise<TeacherCandidates> {
  return searchTeachers(
    db,
    q,
    notInArray(
      users.id,
      db.select({ userId: courseStaff.userId }).from(courseStaff).where(eq(courseStaff.courseId, courseId)),
    ),
  );
}

/**
 * Gives an account a seat on the staff, with its role. True when the seat
 * is new; false when the account already held one, which is left as it was
 * (the route answers 409 `already_staff`; a role changes by `changeStaffSeat`).
 */
export async function addStaff(
  db: Db,
  courseId: string,
  userId: string,
  role: CourseRole,
): Promise<boolean> {
  const added = await db
    .insert(courseStaff)
    .values({ courseId, userId, role })
    .onConflictDoNothing()
    .returning({ userId: courseStaff.userId });
  return added.length > 0;
}

/** What a change to one seat came to: refused, or the role before it. */
export type StaffChangeOutcome =
  | { refused: "not_found" }
  | { refused: "last_owner" }
  | { refused: null; from: CourseRole };

/**
 * Sets the role of `userId`'s seat, or removes it (`next`), under the
 * last-owner rule (`staffChangeRefusal`): a course never loses its last
 * owner. The course's seats are read `FOR UPDATE` in the same transaction as
 * the write, so two owners demoting or removing each other at the same
 * instant cannot both pass the count: the second waits for the first, then
 * counts again. A removed member's open streams are closed with the seat (#248).
 */
export async function changeStaffSeat(
  db: Db,
  courseId: string,
  userId: string,
  next: StaffChange,
): Promise<StaffChangeOutcome> {
  const outcome = await db.transaction(async (tx): Promise<StaffChangeOutcome> => {
    const seats = await tx
      .select({ userId: courseStaff.userId, role: courseStaff.role })
      .from(courseStaff)
      .where(eq(courseStaff.courseId, courseId))
      .for("update");
    const target = seats.find((s) => s.userId === userId);
    if (!target) return { refused: "not_found" };
    const owners = seats.filter((s) => s.role === "owner").length;
    const refused = staffChangeRefusal({ owners, targetRole: target.role, next });
    if (refused) return { refused };
    const seat = and(eq(courseStaff.courseId, courseId), eq(courseStaff.userId, userId));
    if (next === "remove") await tx.delete(courseStaff).where(seat);
    else if (next !== target.role) await tx.update(courseStaff).set({ role: next }).where(seat);
    return { refused: null, from: target.role };
  });
  if (next === "remove" && outcome.refused === null) accessRevoked([userId]);
  return outcome;
}

// --- Classrooms -------------------------------------------------------------

export async function createClassroom(
  db: Db,
  courseId: string,
  input: {
    name: string;
    period: string;
    /** First and last month (`YYYY-MM`), both or neither; null by default. */
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<ClassroomRecord> {
  const [room] = await db
    .insert(classrooms)
    .values({
      id: randomUUID(),
      courseId,
      name: input.name.trim(),
      period: input.period.trim(),
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
    })
    .returning();
  return room!;
}

/** The course's classrooms, archived ones included, oldest first. */
export async function classroomsOfCourse(db: Db, courseId: string) {
  return db
    .select()
    .from(classrooms)
    .where(eq(classrooms.courseId, courseId))
    .orderBy(asc(classrooms.createdAt));
}

export async function updateClassroom(
  db: Db,
  classroomId: string,
  patch: {
    name?: string | undefined;
    period?: string | undefined;
    periodStart?: string | null | undefined;
    periodEnd?: string | null | undefined;
  },
) {
  const [updated] = await db
    .update(classrooms)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.period !== undefined ? { period: patch.period.trim() } : {}),
      ...(patch.periodStart !== undefined ? { periodStart: patch.periodStart } : {}),
      ...(patch.periodEnd !== undefined ? { periodEnd: patch.periodEnd } : {}),
      updatedAt: new Date(),
    })
    .where(eq(classrooms.id, classroomId))
    .returning();
  return updated;
}

export async function setArchived(db: Db, classroomId: string, archived: boolean): Promise<void> {
  await db
    .update(classrooms)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(eq(classrooms.id, classroomId));
}

/**
 * Deletes the classroom and, by cascade, its evaluations, journal and
 * projects (F-ORG-09); its projects' push receipts first, in the same
 * transaction (N-DATA-03). Nothing is deleted on GitHub (D19, F-PROJ-16).
 */
export async function deleteClassroom(db: Db, classroomId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await purgeProjectReceipts(tx, { classroomId });
    await tx.delete(classrooms).where(eq(classrooms.id, classroomId));
  });
}

// --- The drill switches (ADR-041 §6) -------------------------------------------
//
// The two columns belong to this module's tables; the `drill` module reaches
// them through these writers only (CLAUDE.md, Conventions).

/**
 * The teacher's switch: the drill on (`drill_enabled_at`, kept at its first
 * instant when switched on again) or off. Returns the stored instant.
 */
export async function setClassroomDrill(
  db: Db,
  classroomId: string,
  enabled: boolean,
  now: Date,
): Promise<Date | null> {
  const [row] = await db
    .update(classrooms)
    .set({
      drillEnabledAt: enabled
        ? sql`coalesce(${classrooms.drillEnabledAt}, ${now.toISOString()}::timestamptz)`
        : null,
      updatedAt: now,
    })
    .where(eq(classrooms.id, classroomId))
    .returning({ drillEnabledAt: classrooms.drillEnabledAt });
  return row?.drillEnabledAt ?? null;
}

/**
 * A student's opt-out of one classroom's drill, on their own claimed student
 * seat. Opting out keeps the first instant (what the teacher's view hides
 * from); opting back in clears it. `undefined` when the user holds no such
 * seat.
 */
export async function setDrillOptOut(
  db: Db,
  classroomId: string,
  userId: string,
  optedOut: boolean,
  now: Date,
): Promise<{ optedOutAt: Date | null } | undefined> {
  const [row] = await db
    .update(enrollments)
    .set({
      drillOptedOutAt: optedOut
        ? sql`coalesce(${enrollments.drillOptedOutAt}, ${now.toISOString()}::timestamptz)`
        : null,
    })
    .where(
      and(
        eq(enrollments.classroomId, classroomId),
        eq(enrollments.userId, userId),
        eq(enrollments.staff, false),
      ),
    )
    .returning({ optedOutAt: enrollments.drillOptedOutAt });
  return row;
}

// --- Roster entries -----------------------------------------------------------

/**
 * What the roster's writes need to revoke a line's GitHub accesses first
 * (F-PROJ-17, ADR-070 §5): the `project` module's `revokeEnrollmentAccess`,
 * `502 revoke_failed` when GitHub does not take them, nothing written.
 */
export interface Revocation {
  config: AppConfig;
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
}

/**
 * THE guard of a roster write that takes line `enrollmentId` or its
 * account away (a removal, an unclaim, an e-mail change, a self-enroll
 * turning it into a staff seat): its GitHub accesses revoked first, then
 * `write` in a transaction behind `releaseLine` — which refuses while an
 * account recorded for the line since is still live. `RevokeFailed` is
 * worded `502 revoke_failed` (`rosterRefusal`): nothing written, retry.
 */
async function afterRevocation<T>(db: Db, enrollmentId: string, ctx: Revocation, via: RevokeVia, write: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await revokeEnrollmentAccess(db, ctx.config, enrollmentId, { ...ctx, via });
    return await db.transaction(async (tx) => {
      await releaseLine(tx, enrollmentId);
      return write(tx);
    });
  } catch (err) {
    if (err instanceof RevokeFailed) throw rosterRefusal("revoke_failed", { repo: err.repo });
    throw err;
  }
}

/**
 * A teacher takes a (staff) seat in their own classroom, claimed at once and
 * flagged `staff` so it stays out of the headcount. A student line holding
 * their e-mail becomes that seat, behind `afterRevocation`. `409
 * already_enrolled` when they hold another line (UNIQUE(classroom_id,
 * user_id)), checked before anything is revoked.
 */
export async function selfEnroll(
  db: Db,
  classroomId: string,
  me: { id: string; email: string; givenName: string; familyName: string },
  ctx: Revocation,
): Promise<void> {
  const email = me.email.trim().toLowerCase();
  const lines = await db
    .select()
    .from(enrollments)
    .where(and(eq(enrollments.classroomId, classroomId), or(eq(enrollments.email, email), eq(enrollments.userId, me.id))));
  if (lines.some((l) => l.email !== email)) throw rosterRefusal("already_enrolled");
  const seat = async (tx: Db | Tx) => {
    await tx
      .insert(enrollments)
      .values({
        id: randomUUID(),
        classroomId,
        nom: me.familyName,
        prenom: me.givenName,
        email,
        userId: me.id,
        claimedAt: new Date(),
        staff: true,
      })
      .onConflictDoUpdate({
        target: [enrollments.classroomId, enrollments.email],
        set: { userId: me.id, claimedAt: new Date(), staff: true },
      });
  };
  const taken = lines.find((l) => !l.staff);
  try {
    await (taken ? afterRevocation(db, taken.id, ctx, "roster.self_enroll", seat) : seat(db));
  } catch (err) {
    if (isUniqueViolation(err, "enrollments_classroom_user_uq")) throw rosterRefusal("already_enrolled");
    throw err;
  }
}

/**
 * Edits one roster entry. Changing the e-mail (`emailChanged`) invalidates
 * the attachment: the entry is again claimable by the holder of the new
 * address — once the address is known to be free (`409 duplicate_email`),
 * behind `afterRevocation` when it detaches an account.
 */
export async function updateEnrollment(
  db: Db,
  entry: Pick<EnrollmentRecord, "id" | "userId" | "classroomId">,
  patch: EnrollmentPatch,
  email: string | undefined,
  emailChanged: boolean,
  ctx: Revocation,
) {
  if (emailChanged && email !== undefined) {
    const [taken] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, entry.classroomId), eq(enrollments.email, email), ne(enrollments.id, entry.id)))
      .limit(1);
    if (taken) throw rosterRefusal("duplicate_email");
  }
  const update = async (tx: Db | Tx) => {
    const [updated] = await tx
      .update(enrollments)
      .set({
        ...(patch.nom ? { nom: patch.nom } : {}),
        ...(patch.prenom ? { prenom: patch.prenom } : {}),
        ...(email ? { email } : {}),
        ...(patch.timeBonusPercent !== undefined
          ? { timeBonusPercent: patch.timeBonusPercent }
          : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(emailChanged ? { userId: null, claimedAt: null, conflictFlag: false } : {}),
      })
      .where(eq(enrollments.id, entry.id))
      .returning();
    return updated;
  };
  try {
    // Every e-mail change goes behind the guard: the line may have been
    // claimed since it was loaded.
    const updated = await (emailChanged ? afterRevocation(db, entry.id, ctx, "roster.update", update) : update(db));
    if (emailChanged) accessRevoked([entry.userId]);
    return updated;
  } catch (err) {
    if (isUniqueViolation(err, "enrollments_classroom_email_uq")) throw rosterRefusal("duplicate_email");
    throw err;
  }
}

/**
 * Detaches a roster line from its account, or removes it: either way its
 * student loses the classroom, and their open streams are closed (#248) —
 * behind `afterRevocation`.
 */
export async function unclaimEnrollment(
  db: Db,
  entry: Pick<EnrollmentRecord, "id" | "userId">,
  ctx: Revocation,
): Promise<EnrollmentRecord | undefined> {
  const unclaim = async (tx: Tx) => {
    const [updated] = await tx
      .update(enrollments)
      .set({ userId: null, claimedAt: null, conflictFlag: false })
      .where(eq(enrollments.id, entry.id))
      .returning();
    return updated;
  };
  // Behind the guard whatever the loaded line said: it may have been claimed since.
  const updated = await afterRevocation(db, entry.id, ctx, "roster.unclaim", unclaim);
  accessRevoked([entry.userId]);
  return updated;
}

/** Removes a line behind `afterRevocation`; its recorded accounts, revoked, go with it. */
export async function removeEnrollment(
  db: Db,
  entry: Pick<EnrollmentRecord, "id" | "userId">,
  ctx: Revocation,
): Promise<void> {
  await afterRevocation(db, entry.id, ctx, "roster.remove", (tx) => tx.delete(enrollments).where(eq(enrollments.id, entry.id)));
  accessRevoked([entry.userId]);
}

// --- Student surface ----------------------------------------------------------

/** The display names of the staff of each course, for the student's cards. */
async function teachersOf(db: Db, courseIds: string[]): Promise<Map<string, string[]>> {
  const teachers = new Map<string, string[]>();
  for (const s of await staffOf(db, courseIds)) {
    const name = [s.givenName, s.familyName].filter(Boolean).join(" ");
    teachers.set(s.courseId, [...(teachers.get(s.courseId) ?? []), name]);
  }
  return teachers;
}

interface StudentClassroomFacts {
  room: Pick<ClassroomRecord, "id" | "name" | "period">;
  course: Pick<CourseRecord, "id" | "name" | "code">;
  timeBonusPercent: number;
}

const studentCard = (r: StudentClassroomFacts, teachers: Map<string, string[]>): StudentClassroom => ({
  id: r.room.id,
  name: r.room.name,
  period: r.room.period,
  courseName: r.course.name,
  courseCode: r.course.code,
  teachers: teachers.get(r.course.id) ?? [],
  timeBonusPercent: r.timeBonusPercent,
});

/**
 * The Courses list (F-ORG-14) and the student home's classroom cards: the
 * classrooms whose roster entry the student claimed, archived ones excepted
 * (F-ORG-03), and nothing else — no course listing, no roster of their peers.
 */
export async function studentClassrooms(db: Db, userId: string): Promise<StudentClassroom[]> {
  const rows = await db
    .select({
      room: { id: classrooms.id, name: classrooms.name, period: classrooms.period },
      course: { id: courses.id, name: courses.name, code: courses.code },
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(enrollments.userId, userId), isNull(classrooms.archivedAt)))
    .orderBy(courses.code, classrooms.name);
  const teachers = await teachersOf(db, [...new Set(rows.map((r) => r.course.id))]);
  return rows.map((r) => studentCard(r, teachers));
}

/**
 * The header of the student's classroom page (F-ORG-15): the Courses card of
 * a classroom the route loaded through `readableClassroom`, archived or not.
 * The time bonus is the caller's own seat's, 0 for a staff member without one.
 */
export async function studentClassroomHeader(
  db: Db,
  scope: {
    room: ClassroomRecord;
    course: CourseRecord;
    seat: { timeBonusPercent: number } | null;
  },
): Promise<StudentClassroomPage["classroom"]> {
  const teachers = await teachersOf(db, [scope.course.id]);
  const facts = { ...scope, timeBonusPercent: scope.seat?.timeBonusPercent ?? 0 };
  return { ...studentCard(facts, teachers), archived: scope.room.archivedAt !== null };
}

