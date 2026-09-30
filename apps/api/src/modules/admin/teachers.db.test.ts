/**
 * Granting and revoking the teacher role (F-ADMIN-02), on a real
 * application: the grant is keyed on an e-mail, takes effect at once on an
 * existing account, is audited and refused twice; the revoke recomputes the
 * role rather than forcing it. Only an administrator reaches either.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLog, teacherGrants, userEmails, users } from "../../db/schema.js";
import { testServer, type Payload, type TestServer } from "../../test/http.js";

let server: TestServer;
type Actor = Awaited<ReturnType<TestServer["signIn"]>>;
let admin: Actor;
let teacher: Actor;
let student: Actor;

beforeAll(async () => {
  server = await testServer({ SUPER_ADMIN_EMAIL: "boss@heig.test" });
  admin = await server.signIn("admin", "boss@heig.test");
  teacher = await server.signIn("teacher");
  student = await server.signIn("student");
});

afterAll(async () => {
  await server.close();
});

function call(who: Actor | null, method: "GET" | "POST" | "DELETE", url: string, payload?: Payload) {
  return server.app.inject({
    method,
    url,
    ...(who ? { headers: who.headers } : {}),
    ...(payload === undefined ? {} : { payload }),
  });
}

const grant = (email: string, who: Actor | null = admin) =>
  call(who, "POST", "/app/api/admin/teachers", { email });

/** A student account with a verified address in its set: what the role rule reads. */
async function account(email: string): Promise<Actor> {
  const who = await server.signIn("student", email);
  await server.app.db.insert(userEmails).values({ userId: who.id, email, source: "login", verified: true });
  return who;
}

async function roleOf(id: string) {
  const [row] = await server.app.db.select({ role: users.role }).from(users).where(eq(users.id, id));
  return row!.role;
}

async function auditsOf(action: "teacher.grant" | "teacher.revoke", subjectId: string) {
  return server.app.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
}

describe("the guard", () => {
  it("answers anyone but an administrator, and writes nothing", async () => {
    const someId = crypto.randomUUID();
    for (const [method, url, payload] of [
      ["GET", "/app/api/admin/teachers", undefined],
      ["POST", "/app/api/admin/teachers", { email: "intruder@heig.test" }],
      ["DELETE", `/app/api/admin/teachers/${someId}`, undefined],
    ] as const) {
      expect((await call(teacher, method, url, payload)).statusCode).toBe(403);
      expect((await call(student, method, url, payload)).statusCode).toBe(403);
      expect((await call(null, method, url, payload)).statusCode).toBe(401);
    }
    const rows = await server.app.db
      .select()
      .from(teacherGrants)
      .where(eq(teacherGrants.email, "intruder@heig.test"));
    expect(rows).toHaveLength(0);
  });
});

describe("POST /app/api/admin/teachers", () => {
  it("grants by e-mail, normalized, and promotes an existing account at once", async () => {
    const future = await account("future.teacher@heig.test");
    expect(await roleOf(future.id)).toBe("student");

    const res = await grant("Future.Teacher@HEIG.test");
    expect(res.statusCode).toBe(201);
    const created = res.json<{ id: string; email: string; createdBy: string }>();
    expect(created.email).toBe("future.teacher@heig.test");
    expect(created.createdBy).toBe(admin.id);

    expect(await roleOf(future.id)).toBe("teacher");
    const audits = await auditsOf("teacher.grant", created.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorUserId).toBe(admin.id);
    expect(audits[0]!.payload).toEqual({ email: "future.teacher@heig.test" });
  });

  // Issue #410 (roles.ts, `syncUserRole`): for an account "from before the
  // address set" (no `user_emails` row), the fallback finds the owner by its
  // verified login address, but then recomputes the role through
  // `roleForUser`, which reads `knownEmails` (the address set, empty here) —
  // so the grant never reaches it and the account stays a student until a
  // login fills its set. Marked `fails` until #410 is fixed: the fallback
  // must feed the login address to the rule.
  it.fails("promotes at once an account from before the address set (login address only)", async () => {
    const legacy = await server.signIn("student", "legacy.teacher@heig.test");
    expect((await grant("legacy.teacher@heig.test")).statusCode).toBe(201);
    expect(await roleOf(legacy.id)).toBe("teacher");
  });

  it("grants an address nobody has signed up with yet: pending in the list", async () => {
    const res = await grant("not.yet@heig.test");
    expect(res.statusCode).toBe(201);

    const list = await call(admin, "GET", "/app/api/admin/teachers");
    expect(list.statusCode).toBe(200);
    const row = list
      .json<{ email: string; signedUp: boolean; lastLoginAt: string | null; courses: number }[]>()
      .find((r) => r.email === "not.yet@heig.test");
    expect(row).toMatchObject({ signedUp: false, lastLoginAt: null, courses: 0 });
  });

  it("refuses the same e-mail twice (409), whatever its case, with one audit only", async () => {
    const first = await grant("twice@heig.test");
    expect(first.statusCode).toBe(201);
    const again = await grant("TWICE@heig.test");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "already_teacher" });
    const rows = await server.app.db
      .select()
      .from(teacherGrants)
      .where(eq(teacherGrants.email, "twice@heig.test"));
    expect(rows).toHaveLength(1);
    expect(await auditsOf("teacher.grant", rows[0]!.id)).toHaveLength(1);
  });

  it("refuses the administrator's own e-mail (409)", async () => {
    const res = await grant("Boss@heig.test");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "is_admin" });
    expect(await roleOf(admin.id)).toBe("admin");
  });

  it("refuses a body without a valid e-mail (400)", async () => {
    for (const payload of [{ email: "not-an-address" }, {}, { email: 42 }]) {
      const res = await call(admin, "POST", "/app/api/admin/teachers", payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "validation" });
    }
  });
});

describe("DELETE /app/api/admin/teachers/:gid", () => {
  it("revokes, audited, and demotes an account whose only reason was the grant", async () => {
    const holder = await account("short.lived@heig.test");
    const created = (await grant("short.lived@heig.test")).json<{ id: string }>();
    expect(await roleOf(holder.id)).toBe("teacher");

    const res = await call(admin, "DELETE", `/app/api/admin/teachers/${created.id}`);
    expect(res.statusCode).toBe(204);
    expect(await roleOf(holder.id)).toBe("student");

    const rows = await server.app.db.select().from(teacherGrants).where(eq(teacherGrants.id, created.id));
    expect(rows).toHaveLength(0);
    const audits = await auditsOf("teacher.revoke", created.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ email: "short.lived@heig.test" });

    // Gone: a second revoke is the 404 of a missing grant.
    expect((await call(admin, "DELETE", `/app/api/admin/teachers/${created.id}`)).statusCode).toBe(404);
    expect(await auditsOf("teacher.revoke", created.id)).toHaveLength(1);
  });

  it("answers 404 for an unknown grant and for an id that is not a uuid", async () => {
    for (const gid of [crypto.randomUUID(), "not-a-uuid"]) {
      const res = await call(admin, "DELETE", `/app/api/admin/teachers/${gid}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
  });
});
