import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { courseStaff, courses, poolMembers, pools, teacherGrants, users, userEmails } from "../db/schema.js";
import { testDb, testApp } from "../test/db.js";
import { oidcClaims as claims } from "../test/oidc.js";
import { signIn } from "./login.js";
import { PERSONAS, devSub, upsertPersona } from "./dev.js";

const config = {
  SUPER_ADMIN_EMAIL: "boss@heig.test",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch", "hes-so.ch"],
  LOGIN_ALLOWLIST: "",
} as AppConfig;

let db: Db;

beforeAll(async () => {
  db = await testDb();
  const adminId = randomUUID();
  await db
    .insert(users)
    .values({ id: adminId, oidcSub: `u-${adminId}`, email: "boss@heig.test", role: "admin" });
  await db.insert(teacherGrants).values({
    id: randomUUID(),
    email: "granted@heig.test",
    createdBy: adminId,
  });
});

describe("signIn", () => {
  it("grants nothing on an unverified administrator or granted address", async () => {
    for (const email of ["boss@heig.test", "granted@heig.test"]) {
      const user = await signIn(db, config, claims(`s-${randomUUID()}`, { email }, false));
      expect(user.role, email).toBe("student");
    }
  });

  it("honours the same addresses once verified", async () => {
    const admin = await signIn(db, config, claims(`s-${randomUUID()}`, { email: "boss@heig.test" }, true));
    const teacher = await signIn(
      db,
      config,
      claims(`s-${randomUUID()}`, { email: "granted@heig.test" }, true),
    );
    expect([admin.role, teacher.role]).toEqual(["admin", "teacher"]);
  });

  it("keeps a teacher by course seat alone a teacher at the next login", async () => {
    const sub = `s-${randomUUID()}`;
    const login = claims(sub, { email: "seated@gmail.test", eduPersonScopedAffiliation: ["member@hes-so.ch"] }, true);
    const first = await signIn(db, config, login);
    expect(first.role).toBe("student");
    const courseId = randomUUID();
    await db.insert(courses).values({ id: courseId, name: "Seated", code: `S-${courseId}` });
    await db.insert(courseStaff).values({ courseId, userId: first.id });
    expect((await signIn(db, config, login)).role).toBe("teacher");
  });

  it("keeps the stored affiliations, the role and the pools when userinfo failed", async () => {
    const sub = `s-${randomUUID()}`;
    const email = `staff-${sub}@heig.test`;
    const teacher = await signIn(
      db,
      config,
      claims(sub, { email, eduPersonScopedAffiliation: ["staff@hes-so.ch"] }, true),
    );
    expect(teacher.role).toBe("teacher");
    const member = await signIn(db, config, claims(`s-${randomUUID()}`, { email: `m-${sub}@heig.test` }, true));
    const poolId = randomUUID();
    await db.insert(pools).values({ id: poolId, name: `Kept ${poolId}`, ownerId: teacher.id });
    await db.insert(poolMembers).values({ poolId, userId: member.id, role: "reader" });

    // The ID token alone: no affiliation claim at all.
    const again = await signIn(db, config, claims(sub, { email }, true, false));
    expect(again.role).toBe("teacher");
    const [pool] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(pool!.ownerId).toBe(teacher.id);
  });

  it("demotes a teacher whose staff affiliation is gone, but leaves the pools alone", async () => {
    const sub = `s-${randomUUID()}`;
    const email = `gone-${sub}@heig.test`;
    const teacher = await signIn(
      db,
      config,
      claims(sub, { email, eduPersonScopedAffiliation: ["staff@hes-so.ch"] }, true),
    );
    const member = await signIn(db, config, claims(`s-${randomUUID()}`, { email: `m2-${sub}@heig.test` }, true));
    const poolId = randomUUID();
    await db.insert(pools).values({ id: poolId, name: `Stays ${poolId}`, ownerId: teacher.id });
    await db.insert(poolMembers).values({ poolId, userId: member.id, role: "reader" });

    // userinfo answered, without the staff affiliation this time.
    const again = await signIn(
      db,
      config,
      claims(sub, { email, eduPersonScopedAffiliation: ["member@hes-so.ch"] }, true),
    );
    expect(again.role).toBe("student");
    const [pool] = await db.select().from(pools).where(eq(pools.id, poolId));
    expect(pool!.ownerId).toBe(teacher.id);
  });

  it("verifies a stored login address once the IdP vouches for it", async () => {
    const sub = `s-${randomUUID()}`;
    expect((await signIn(db, config, claims(sub, { email: "granted@heig.test" }, false))).role).toBe(
      "student",
    );
    expect((await signIn(db, config, claims(sub, { email: "granted@heig.test" }, true))).role).toBe(
      "teacher",
    );
  });
});

describe("the development personas", () => {
  /*
   * The development persona picker writes ordinary accounts through the
   * ordinary identity code: an account born here must be indistinguishable
   * from one born of an OIDC login, or the dev flow would exercise a second
   * code path nobody ships.
   */
  const teacher = PERSONAS.find((p) => p.key === "teacher")!;
  const student = PERSONAS.find((p) => p.key === "lea")!;

  // One database for the file: each test reads back only the persona it
  // signed in, so the order of the tests does not matter.
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await testApp();
  });

  describe("upsertPersona", () => {
    it("creates the account, its address set and its role", async () => {
      const user = await upsertPersona(app, teacher);
      expect(user.oidcSub).toBe(devSub(teacher));
      expect(user.role).toBe("teacher");
      expect(user.lastLoginAt).not.toBeNull();
      const addresses = await app.db
        .select()
        .from(userEmails)
        .where(eq(userEmails.userId, user.id));
      // The roster matches on the address SET, so a persona with no row there
      // would never claim its seat.
      expect(addresses.map((a) => a.email)).toEqual([teacher.email]);
      expect(addresses[0]!.verified).toBe(true);
    });

    it("is idempotent: signing in twice keeps one account", async () => {
      const first = await upsertPersona(app, student);
      const accounts = (await app.db.select().from(users)).length;
      const second = await upsertPersona(app, student);
      expect(second.id).toBe(first.id);
      // Not one account more, under any sub.
      expect(await app.db.select().from(users)).toHaveLength(accounts);
      expect(await app.db.select().from(users).where(eq(users.oidcSub, devSub(student)))).toHaveLength(1);
    });

    it("carries the persona's role, with no grant in the database", async () => {
      expect((await upsertPersona(app, student)).role).toBe("student");
      const admin = PERSONAS.find((p) => p.key === "admin")!;
      expect((await upsertPersona(app, admin)).role).toBe("admin");
    });
  });
});
