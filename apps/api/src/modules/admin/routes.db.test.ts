import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { AdminUser } from "@quiz/contracts";

import {
  classrooms,
  courseStaff,
  courses,
  pools,
  questions,
  teacherGrants,
  userEmails,
  userIdpClaims,
  users,
} from "../../db/schema.js";
import { testServer, type TestServer } from "../../test/http.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;
let granted: Actor;
let seated: Actor;
let staff: Actor;
let student: Actor;
let stale: Actor;
let anonymized: Actor;

/** A verified address in the account's set: what the role rule reads. */
async function address(who: Actor, email: string) {
  await server.app.db.insert(userEmails).values({ userId: who.id, email, source: "login" });
}

beforeAll(async () => {
  server = await testServer({
    SUPER_ADMIN_EMAIL: "boss@heig.test",
    STAFF_AFFILIATION_DOMAINS: "heig-vd.ch,hes-so.ch",
  });
  const db = server.app.db;

  admin = await server.signIn("admin", "boss@heig.test");
  await address(admin, "boss@heig.test");

  // Teacher by grant, issued on an address of their set.
  granted = await server.signIn("teacher", "granted@heig.test");
  await address(granted, "granted@heig.test");
  await db
    .insert(teacherGrants)
    .values({ id: randomUUID(), email: "granted@heig.test", createdBy: admin.id });

  // Teacher by a course seat, with the whole footprint to count.
  seated = await server.signIn("teacher");
  const courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
  await db.insert(courseStaff).values({ courseId, userId: seated.id });
  await db.insert(classrooms).values([
    { id: randomUUID(), courseId, name: "PRG1-2026", period: "2026-A" },
    { id: randomUUID(), courseId, name: "PRG1-2025", period: "2025-A" },
    { id: randomUUID(), courseId, name: "PRG1-2024", period: "2024-A", archivedAt: new Date() },
  ]);
  const [poolA, poolB] = [randomUUID(), randomUUID()];
  await db.insert(pools).values([
    { id: poolA, name: "Bases", ownerId: seated.id },
    { id: poolB, name: "Pointeurs", ownerId: seated.id },
  ]);
  const question = (poolId: string, name: string, deletedAt: Date | null = null) => ({
    id: randomUUID(),
    poolId,
    type: "mcq",
    internalName: name,
    deletedAt,
  });
  await db
    .insert(questions)
    .values([
      question(poolA, "q1"),
      question(poolA, "q2"),
      question(poolB, "q3"),
      question(poolB, "gone", new Date()),
    ]);

  // Teacher by an edu-ID staff affiliation of one of our institutions.
  staff = await server.signIn("teacher");
  await db
    .insert(userIdpClaims)
    .values({ userId: staff.id, claims: {}, affiliations: ["staff@hes-so.ch"] });

  student = await server.signIn("student");
  // Stored teacher, but nothing in the rule gives it any more.
  stale = await server.signIn("teacher");
  anonymized = await server.signIn("student");
  await db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, anonymized.id));
});

afterAll(async () => {
  await server.close();
});

async function list(who: Actor) {
  return server.app.inject({ method: "GET", url: "/app/api/admin/users", headers: who.headers });
}

describe("GET /app/api/admin/users (F-ADMIN-01)", () => {
  it("is refused to anyone but an administrator", async () => {
    expect((await list(granted)).statusCode).toBe(403);
    expect((await list(student)).statusCode).toBe(403);
    expect(
      (await server.app.inject({ method: "GET", url: "/app/api/admin/users" })).statusCode,
    ).toBe(401);
  });

  it("lists every account with its role, the rule's reason and its footprint", async () => {
    const res = await list(admin);
    expect(res.statusCode).toBe(200);
    const rows = z.array(AdminUser).parse(res.json());
    const row = (who: Actor) => rows.find((r) => r.id === who.id);

    expect(row(admin)).toMatchObject({ role: "admin", reason: "super_admin" });
    expect(row(granted)).toMatchObject({ role: "teacher", reason: "grant" });
    expect(row(seated)).toMatchObject({
      role: "teacher",
      reason: "course_seat",
      pools: 2,
      // The deleted question is not counted.
      questions: 3,
      // Nor the archived classroom.
      classrooms: 2,
    });
    expect(row(staff)).toMatchObject({ role: "teacher", reason: "staff_affiliation" });
    expect(row(student)).toMatchObject({
      role: "student",
      reason: null,
      pools: 0,
      questions: 0,
      classrooms: 0,
      lastLoginAt: null,
    });
    // The stored role stays what the guards read; there is no reason to state.
    expect(row(stale)).toMatchObject({ role: "teacher", reason: null });
  });

  it("never lists an anonymized account", async () => {
    const rows = z.array(AdminUser).parse((await list(admin)).json());
    expect(rows.map((r) => r.id)).not.toContain(anonymized.id);
    expect(rows).toHaveLength(6);
  });
});
