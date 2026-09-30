/**
 * `findReadableClassroom` against the real migrations: what its SQL adds to
 * the pure rule `classroomPayload` (tested in `guards.test.ts`) — the staff
 * EXISTS, the admin override, the seat join and its bonus, an unclaimed
 * line, an unknown id, and an impersonation read through the seat alone.
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

beforeAll(async () => {
  db = await testDb();
  for (const { id, role } of [teacher, outsider, admin, student, unclaimed, keptSeat]) {
    await db.insert(users).values({ id, oidcSub: `test-${id}`, email: `${id}@heig.test`, role });
  }
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

const read = (caller: Caller, classroomId: string, auth: SessionAuth = PORTAL) =>
  findReadableClassroom(db, caller, auth, classroomId, { studentView: false });

describe("findReadableClassroom", () => {
  it("serves the staff the staff payload, with no seat, and nobody off the staff", async () => {
    const found = await read(teacher, mine.classroomId);
    expect(found).toMatchObject({ payload: "staff", seat: null });
    expect(found!.room.id).toBe(mine.classroomId);
    expect(found!.course.id).toBe(mine.courseId);
    expect(await read(outsider, mine.classroomId)).toBeNull();
  });

  it("serves an admin the staff payload, like `staffAccess` does", async () => {
    expect((await read(admin, other.classroomId))!.payload).toBe("staff");
  });

  it("serves a claimed seat the student payload, with its bonus", async () => {
    expect(await read(student, mine.classroomId)).toMatchObject({
      payload: "student",
      seat: { timeBonusPercent: 25 },
    });
  });

  it("answers null for an unclaimed line and an unknown id", async () => {
    expect(await read(unclaimed, mine.classroomId)).toBeNull();
    expect(await read(teacher, randomUUID())).toBeNull();
  });

  it("serves an impersonation session through the seat alone", async () => {
    // In its own portal session, the account's kept staff seat opens the
    // other course; acting as it, an admin gets the 404 of a missing classroom.
    expect((await read(keptSeat, other.classroomId))!.payload).toBe("staff");
    expect(await read(keptSeat, other.classroomId, impersonation)).toBeNull();
    expect((await read(keptSeat, mine.classroomId, impersonation))!.payload).toBe("student");
  });
});
