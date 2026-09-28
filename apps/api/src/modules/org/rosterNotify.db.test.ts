/**
 * Telling the staff is best-effort (#198, review of step 4): the claim runs
 * inside a sign-in, and a notification that cannot be written — a database
 * hiccup, a payload the catalogue refuses — must never fail the login or
 * leave the student without their seat.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Db } from "../../db/client.js";
import { classrooms, courseStaff, courses, enrollments, userEmails, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { claimEnrollments } from "./roster.js";

const failing = vi.hoisted(() => ({ on: false }));

vi.mock("../notifications/service.js", async (original) => {
  const real = await original<typeof import("../notifications/service.js")>();
  return {
    ...real,
    notifyMany: (...args: Parameters<typeof real.notifyMany>) =>
      failing.on ? Promise.reject(new Error("notifications are down")) : real.notifyMany(...args),
  };
});

let db: Db;

beforeAll(async () => {
  db = await testDb();
});

afterEach(() => {
  failing.on = false;
  vi.restoreAllMocks();
});

async function seatAndStudent() {
  const [teacher, student, course, room] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const email = `ada-${student.slice(0, 8)}@heig.test`;
  await db.insert(users).values([
    { id: teacher, oidcSub: `t-${teacher}`, email: `t-${teacher.slice(0, 8)}@heig.test`, role: "teacher" },
    { id: student, oidcSub: `s-${student}`, email, role: "student" },
  ]);
  await db.insert(userEmails).values({ userId: student, email, source: "login", verified: true });
  await db.insert(courses).values({ id: course, name: "Programmation C", code: `C-${course.slice(0, 8)}` });
  await db.insert(courseStaff).values({ courseId: course, userId: teacher });
  await db.insert(classrooms).values({ id: room, courseId: course, name: "PRG1-A" });
  const entry = randomUUID();
  await db.insert(enrollments).values({ id: entry, classroomId: room, nom: "Lovelace", prenom: "Ada", email });
  return { student, entry };
}

describe("the claim at sign-in", () => {
  it("still attaches the seat when the staff cannot be told, and logs why", async () => {
    const { student, entry } = await seatAndStudent();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    failing.on = true;

    await expect(claimEnrollments(db, { id: student })).resolves.toBe(1);

    const [row] = await db.select().from(enrollments).where(eq(enrollments.id, entry));
    expect(row!.userId).toBe(student);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("student_joined"),
      expect.objectContaining({ message: "notifications are down" }),
    );
  });
});
