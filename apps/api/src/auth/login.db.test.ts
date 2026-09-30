import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { courseStaff, courses, poolMembers, pools, teacherGrants, users } from "../db/schema.js";
import { testDb } from "../test/db.js";
import { oidcClaims as claims } from "../test/oidc.js";
import { signIn } from "./login.js";

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
