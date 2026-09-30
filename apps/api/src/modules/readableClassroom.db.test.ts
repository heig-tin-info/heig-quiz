/**
 * `findReadableClassroom` against the real migrations: the student branch of
 * invariant 6 (spec 05 §5.7), each row of `classroomPayload`'s table on real
 * rows — a staff seat, a claimed seat, an unclaimed one, an admin, an
 * impersonation session, a `seb` session.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { PORTAL, type SessionAuth } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { courseStaff, enrollments, users } from "../db/schema.js";
import { testDb } from "../test/db.js";
import { seedLive, type Seeded } from "../test/live.js";
import { findReadableClassroom, type Caller } from "./guards.js";

let db: Db;
let mine: Seeded;
let other: Seeded;
const account = (role: "teacher" | "admin" | "student") => ({ id: randomUUID(), role });
const teacher = account("teacher");
const outsider = account("teacher");
const admin = account("admin");
const student = account("student");
const unclaimed = account("student");
/** A student account that kept a staff seat on the other course (ADR-013 rule 5). */
const keptSeat = account("student");

const impersonation: SessionAuth = { kind: "impersonation", actorUserId: admin.id, evaluationId: null };
const seb: SessionAuth = { kind: "seb", actorUserId: null, evaluationId: randomUUID() };

async function user({ id, role }: ReturnType<typeof account>) {
  await db.insert(users).values({ id, oidcSub: `test-${id}`, email: `${id}@heig.test`, role });
}

beforeAll(async () => {
  db = await testDb();
  for (const u of [teacher, outsider, admin, student, unclaimed, keptSeat]) await user(u);
  mine = await seedLive(db, { teacherId: teacher.id, studentIds: [student.id, keptSeat.id], questions: 0, timeBonusPercent: 25 });
  other = await seedLive(db, { teacherId: outsider.id, studentIds: [], questions: 0 });
  await db.insert(courseStaff).values({ courseId: other.courseId, userId: keptSeat.id });
  // A roster line bearing the account's address, never claimed: no seat.
  await db.insert(enrollments).values({
    id: randomUUID(),
    classroomId: mine.classroomId,
    nom: "Unclaimed",
    prenom: "Student",
    email: `${unclaimed.id}@heig.test`,
  });
});

const read = (
  caller: Caller,
  classroomId: string,
  { auth = PORTAL as SessionAuth | null, studentView = false } = {},
) => findReadableClassroom(db, caller, auth, classroomId, { studentView });

describe("findReadableClassroom", () => {
  it("serves the staff the staff payload, with no seat", async () => {
    const found = await read(teacher, mine.classroomId);
    expect(found).toMatchObject({ payload: "staff", seat: null });
    expect(found!.room.id).toBe(mine.classroomId);
    expect(found!.course.id).toBe(mine.courseId);
  });

  it("narrows the staff to the student payload when asked", async () => {
    expect((await read(teacher, mine.classroomId, { studentView: true }))!.payload).toBe("student");
  });

  it("serves an admin the staff payload, like `staffAccess` does", async () => {
    expect((await read(admin, mine.classroomId))!.payload).toBe("staff");
    expect((await read(admin, other.classroomId, { studentView: true }))!.payload).toBe("student");
  });

  it("serves a claimed seat the student payload, with its bonus", async () => {
    const found = await read(student, mine.classroomId);
    expect(found).toMatchObject({ payload: "student", seat: { timeBonusPercent: 25 } });
  });

  it("a bearer token (no browser session) is read like a portal session", async () => {
    expect((await read(student, mine.classroomId, { auth: null }))!.payload).toBe("student");
  });

  it("answers null for a classroom of another course, an unclaimed line and a stranger", async () => {
    expect(await read(student, other.classroomId)).toBeNull();
    expect(await read(unclaimed, mine.classroomId)).toBeNull();
    expect(await read(outsider, mine.classroomId)).toBeNull();
    expect(await read(outsider, mine.classroomId, { studentView: true })).toBeNull();
    expect(await read(teacher, randomUUID())).toBeNull();
  });

  it("serves an impersonation session the student payload through the seat alone", async () => {
    expect((await read(student, mine.classroomId, { auth: impersonation }))!.payload).toBe("student");
    // In its own portal session, the account's kept staff seat opens the
    // other course; acting as it, an admin gets the 404 of a missing classroom.
    expect((await read(keptSeat, other.classroomId))!.payload).toBe("staff");
    expect(await read(keptSeat, other.classroomId, { auth: impersonation })).toBeNull();
    expect((await read(keptSeat, mine.classroomId, { auth: impersonation }))!.payload).toBe("student");
  });

  it("refuses a seb session, whoever holds it", async () => {
    expect(await read(student, mine.classroomId, { auth: seb })).toBeNull();
    expect(await read(teacher, mine.classroomId, { auth: seb })).toBeNull();
    expect(await read(admin, mine.classroomId, { auth: seb })).toBeNull();
  });
});
