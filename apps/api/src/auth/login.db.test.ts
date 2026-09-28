import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import { courseStaff, courses, teacherGrants, users } from "../db/schema.js";
import { testDb, type TestDb } from "../test/db.js";
import { loginAdmits, signIn } from "./login.js";
import type { OidcClaims } from "./oidc.js";

const config = {
  SUPER_ADMIN_EMAIL: "boss@heig.test",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch", "hes-so.ch"],
  LOGIN_ALLOWLIST: "",
} as AppConfig;

let db: TestDb;

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

function claims(sub: string, raw: Record<string, unknown>, emailVerified: boolean): OidcClaims {
  return {
    sub,
    email: typeof raw.email === "string" ? raw.email : "",
    emailVerified,
    givenName: "",
    familyName: "",
    swissEduId: null,
    picture: null,
    raw,
  };
}

describe("loginAdmits (ADR-028)", () => {
  const staging = { ...config, LOGIN_ALLOWLIST: "dev@heig.test" } as AppConfig;

  it("refuses a listed login address the IdP did not verify", () => {
    expect(loginAdmits(staging, claims("s", { email: "dev@heig.test" }, false))).toBe(false);
  });

  it("admits a listed address the institution asserts", () => {
    expect(
      loginAdmits(
        staging,
        claims("s", { email: "x@gmail.test", swissEduIDLinkedAffiliationMail: ["dev@heig.test"] }, false),
      ),
    ).toBe(true);
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
