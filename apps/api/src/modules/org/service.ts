/**
 * The `org` module's business layer (PLAN-MVP §4.1): courses, their staff,
 * classrooms, the roster, the join code and the student self-enrolment it
 * opens (F-ORG-06), and the student's own list of classrooms.
 *
 * Every statement the routes run is here (audit B-12); `./roster.ts` holds
 * the roster import and the claim rules, a helper of this module that the
 * sign-in path reaches through the re-export below. Access is NOT decided
 * here: the routes load the entity through the guards first (invariant 6),
 * and a list takes the access predicate as an argument.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";

import type { EnrollmentPatch, StudentClassroom } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { avatars, classrooms, courseStaff, courses, enrollments, users } from "../../db/schema.js";
import { emailIn, knownEmails } from "../../identity.js";

export { claimEnrollments } from "./roster.js";

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
 * their headcounts, and its staff.
 */
export async function listCourses(db: Db, access: SQL | undefined) {
  const rows = await db
    .select({ id: courses.id, name: courses.name, code: courses.code, createdAt: courses.createdAt })
    .from(courses)
    .where(access)
    .orderBy(asc(courses.code));
  const ids = rows.map((r) => r.id);
  const rooms = ids.length
    ? await db
        .select({
          id: classrooms.id,
          name: classrooms.name,
          period: classrooms.period,
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
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    createdAt: c.createdAt.toISOString(),
    classrooms: rooms
      .filter((r) => r.courseId === c.id)
      .map((r) => ({
        id: r.id,
        name: r.name,
        period: r.period,
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
        avatarUrl: s.avatarAt
          ? `/app/api/users/${s.userId}/avatar?v=${s.avatarAt.getTime()}`
          : s.pictureUrl,
      })),
  }));
}

/**
 * Creates a course with its creator as the first member of the staff: a
 * course without a staff would be reachable by nobody but an admin. `null`
 * when the code is taken (nothing is written then).
 */
export async function createCourse(
  db: Db,
  input: { name: string; code: string },
  creatorId: string,
): Promise<CourseRecord | null> {
  const id = randomUUID();
  const [created] = await db
    .insert(courses)
    .values({ id, name: input.name, code: input.code })
    .onConflictDoNothing({ target: courses.code })
    .returning();
  if (!created) return null;
  await db.insert(courseStaff).values({ courseId: id, userId: creatorId });
  return created;
}

export async function updateCourse(
  db: Db,
  courseId: string,
  patch: { name?: string | undefined; code?: string | undefined },
) {
  const [updated] = await db
    .update(courses)
    .set({
      ...(patch.name ? { name: patch.name.trim() } : {}),
      ...(patch.code ? { code: patch.code.trim().toUpperCase() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(courses.id, courseId))
    .returning();
  return updated;
}

export async function deleteCourse(db: Db, courseId: string): Promise<void> {
  await db.delete(courses).where(eq(courses.id, courseId));
}

/** The course's staff, for the course detail. */
export async function staffOfCourse(db: Db, courseId: string) {
  return db
    .select({
      userId: users.id,
      givenName: users.givenName,
      familyName: users.familyName,
      email: users.email,
    })
    .from(courseStaff)
    .innerJoin(users, eq(courseStaff.userId, users.id))
    .where(eq(courseStaff.courseId, courseId))
    .orderBy(asc(users.familyName), asc(users.givenName));
}

// --- Course staff -----------------------------------------------------------

/** Gives an account a seat on the staff; a second call is a no-op. */
export async function addStaff(db: Db, courseId: string, userId: string): Promise<void> {
  await db.insert(courseStaff).values({ courseId, userId }).onConflictDoNothing();
}

export async function staffSeatCount(db: Db, courseId: string): Promise<number> {
  const [seats] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(courseStaff)
    .where(eq(courseStaff.courseId, courseId));
  return seats?.count ?? 0;
}

export async function removeStaff(db: Db, courseId: string, userId: string): Promise<void> {
  await db
    .delete(courseStaff)
    .where(and(eq(courseStaff.courseId, courseId), eq(courseStaff.userId, userId)));
}

// --- Classrooms -------------------------------------------------------------

export async function createClassroom(
  db: Db,
  courseId: string,
  input: { name: string; period: string },
): Promise<ClassroomRecord> {
  const [room] = await db
    .insert(classrooms)
    .values({
      id: randomUUID(),
      courseId,
      name: input.name.trim(),
      period: input.period.trim(),
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
  patch: { name?: string | undefined; period?: string | undefined },
) {
  const [updated] = await db
    .update(classrooms)
    .set({
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.period !== undefined ? { period: patch.period.trim() } : {}),
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

export async function deleteClassroom(db: Db, classroomId: string): Promise<void> {
  await db.delete(classrooms).where(eq(classrooms.id, classroomId));
}

// --- Roster entries -----------------------------------------------------------

/**
 * A teacher takes a (staff) seat in their own classroom, claimed at once and
 * flagged `staff` so it stays out of the headcount. Throws on
 * UNIQUE(classroom_id, user_id): already enrolled under another address.
 */
export async function selfEnroll(
  db: Db,
  classroomId: string,
  me: { id: string; email: string; givenName: string; familyName: string },
): Promise<void> {
  await db
    .insert(enrollments)
    .values({
      id: randomUUID(),
      classroomId,
      nom: me.familyName,
      prenom: me.givenName,
      email: me.email.trim().toLowerCase(),
      userId: me.id,
      claimedAt: new Date(),
      staff: true,
    })
    .onConflictDoUpdate({
      target: [enrollments.classroomId, enrollments.email],
      set: { userId: me.id, claimedAt: new Date(), staff: true },
    });
}

/**
 * Edits one roster entry. Changing the e-mail (`emailChanged`) invalidates
 * the attachment: the entry is again claimable by the holder of the new
 * address. Throws on UNIQUE(classroom_id, email).
 */
export async function updateEnrollment(
  db: Db,
  entryId: string,
  patch: EnrollmentPatch,
  email: string | undefined,
  emailChanged: boolean,
) {
  const [updated] = await db
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
    .where(eq(enrollments.id, entryId))
    .returning();
  return updated;
}

export async function unclaimEnrollment(db: Db, entryId: string): Promise<EnrollmentRecord | undefined> {
  const [updated] = await db
    .update(enrollments)
    .set({ userId: null, claimedAt: null, conflictFlag: false })
    .where(eq(enrollments.id, entryId))
    .returning();
  return updated;
}

export async function removeEnrollment(db: Db, entryId: string): Promise<void> {
  await db.delete(enrollments).where(eq(enrollments.id, entryId));
}

// --- Join code (F-ORG-06) -------------------------------------------------------

/**
 * No `0/O`, no `1/I/L`: the code is read off a slide and typed by hand, so
 * the alphabet has no pair a student can confuse. 8 characters out of 32 is
 * ~40 bits — far beyond guessing for a classroom of 200.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

function newJoinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * Turns self-enrolment on or off. Enabling mints a code the first time and
 * keeps it afterwards, so the handout a teacher printed still works next
 * semester; disabling only closes the door.
 */
export async function setJoinCode(
  db: Db,
  classroomId: string,
  enabled: boolean,
): Promise<{ joinCode: string | null; joinCodeEnabled: boolean }> {
  const [current] = await db
    .select({ joinCode: classrooms.joinCode })
    .from(classrooms)
    .where(eq(classrooms.id, classroomId))
    .limit(1);
  const joinCode = enabled ? (current?.joinCode ?? (await mintCode(db, classroomId))) : (current?.joinCode ?? null);
  const [row] = await db
    .update(classrooms)
    .set({ joinCode, joinCodeEnabled: enabled, updatedAt: new Date() })
    .where(eq(classrooms.id, classroomId))
    .returning();
  return { joinCode: row?.joinCode ?? null, joinCodeEnabled: row?.joinCodeEnabled ?? false };
}

/** `classrooms.join_code` is unique instance-wide; retry on the collision. */
async function mintCode(db: Db, classroomId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = newJoinCode();
    const [taken] = await db
      .select({ id: classrooms.id })
      .from(classrooms)
      .where(eq(classrooms.joinCode, code))
      .limit(1);
    if (!taken || taken.id === classroomId) return code;
  }
  throw new Error("could not mint a free join code");
}

type JoinOutcome =
  | { ok: true; status: "joined" | "already" }
  | { ok: false; reason: "claimed_by_other" };

/**
 * A student redeems the code (F-ORG-06). Their identity is a SET of
 * addresses (GH-11), so an existing roster line is matched on any of them
 * before a new one is created — joining must never duplicate a student the
 * teacher already imported.
 */
export async function joinClassroom(
  db: Db,
  classroomId: string,
  user: { id: string; email: string; givenName: string; familyName: string },
): Promise<JoinOutcome> {
  const emails = await knownEmails(db, user.id);
  const addresses = emails.length > 0 ? emails : [user.email.trim().toLowerCase()];

  const [existing] = await db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.classroomId, classroomId), emailIn(enrollments.email, addresses)),
    )
    .limit(1);

  if (existing) {
    if (existing.userId === user.id) return { ok: true, status: "already" };
    if (existing.userId !== null) return { ok: false, reason: "claimed_by_other" };
    await db
      .update(enrollments)
      .set({ userId: user.id, claimedAt: new Date(), conflictFlag: false })
      .where(eq(enrollments.id, existing.id));
    return { ok: true, status: "joined" };
  }

  // Not on the roster: the code itself is the authorization, so the seat is
  // created and claimed in one go.
  const inserted = await db
    .insert(enrollments)
    .values({
      id: randomUUID(),
      classroomId,
      nom: user.familyName,
      prenom: user.givenName,
      email: user.email.trim().toLowerCase(),
      userId: user.id,
      claimedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: enrollments.id });
  // The (classroom_id, user_id) unique index caught a seat held under
  // another address: nothing to do, they are already in.
  return { ok: true, status: inserted.length > 0 ? "joined" : "already" };
}

/** The enabled classroom a join code opens, with its course; null otherwise. */
export async function classroomByJoinCode(
  db: Db,
  code: string,
): Promise<{ room: ClassroomRecord; course: CourseRecord } | null> {
  const [row] = await db
    .select({ room: classrooms, course: courses })
    .from(classrooms)
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(and(eq(classrooms.joinCode, code), eq(classrooms.joinCodeEnabled, true)))
    .limit(1);
  return row ?? null;
}

// --- Student surface ----------------------------------------------------------

/**
 * The classrooms whose roster entry the student claimed, and nothing else —
 * no course listing, no roster of their peers.
 */
export async function studentClassrooms(db: Db, userId: string): Promise<StudentClassroom[]> {
  const rows = await db
    .select({
      id: classrooms.id,
      name: classrooms.name,
      period: classrooms.period,
      courseId: courses.id,
      courseName: courses.name,
      courseCode: courses.code,
      timeBonusPercent: enrollments.timeBonusPercent,
    })
    .from(enrollments)
    .innerJoin(classrooms, eq(enrollments.classroomId, classrooms.id))
    .innerJoin(courses, eq(classrooms.courseId, courses.id))
    .where(eq(enrollments.userId, userId))
    .orderBy(courses.code, classrooms.name);
  if (rows.length === 0) return [];
  const staff = await db
    .select({
      courseId: courseStaff.courseId,
      givenName: users.givenName,
      familyName: users.familyName,
    })
    .from(courseStaff)
    .innerJoin(users, eq(courseStaff.userId, users.id))
    .orderBy(users.familyName);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    period: r.period,
    courseName: r.courseName,
    courseCode: r.courseCode,
    teachers: staff
      .filter((s) => s.courseId === r.courseId)
      .map((s) => `${s.givenName} ${s.familyName}`.trim()),
    timeBonusPercent: r.timeBonusPercent,
  }));
}
