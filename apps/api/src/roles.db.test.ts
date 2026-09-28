import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { teacherGrants, users } from "./db/schema.js";
import { roleForIdentity, syncUserRole, type Identity } from "./roles.js";
import { testDb } from "./test/db.js";

const config = {
  SUPER_ADMIN_EMAIL: "boss@heig.test",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch", "hes-so.ch"],
} as AppConfig;

let db: Db;

/** The role alone: most cases below are about which role, not why. */
const roleOf = async (identity: Identity) => (await roleForIdentity(db, config, identity)).role;

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

describe("roleForIdentity (GH-11)", () => {
  it("promotes on a granted address even when the login address is private", async () => {
    // The grant was issued on the institutional address; edu-ID hands us a
    // private one. Before GH-11 this teacher came back as a student.
    expect(
      await roleOf({
        emails: ["someone@gmail.test", "granted@heig.test"],
        affiliations: ["student@hes-so.ch"],
      }),
    ).toBe("teacher");
  });

  it("recognizes the administrator on any of their addresses", async () => {
    expect(
      await roleOf({ emails: ["private@gmail.test", "boss@heig.test"] }),
    ).toBe("admin");
  });

  it("makes a staff affiliation of one of our institutions a teacher", async () => {
    // Exactly the shape production returns for an employee.
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["affiliate@eduid.ch", "member@hes-so.ch", "staff@hes-so.ch"],
      }),
    ).toBe("teacher");
  });

  it("keeps a student who is also staff a student", async () => {
    // Student assistants hold both affiliations; the student side wins.
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["student@hes-so.ch", "staff@hes-so.ch"],
      }),
    ).toBe("student");
  });

  it("leaves a plain student a student", async () => {
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["affiliate@eduid.ch", "member@hes-so.ch", "student@hes-so.ch"],
      }),
    ).toBe("student");
  });

  it("defaults to student without any affiliation", async () => {
    expect(await roleOf({ emails: ["nobody@heig.test"] })).toBe("student");
  });

  it("makes staff@heig-vd.ch a teacher", async () => {
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["staff@heig-vd.ch"],
      }),
    ).toBe("teacher");
  });

  it("leaves another institution's staff a student", async () => {
    // Any edu-ID home organization may assert `staff` for its own people.
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["member@unige.ch", "staff@unige.ch"],
      }),
    ).toBe("student");
  });

  it("does not take an unscoped staff for ours", async () => {
    expect(
      await roleOf({ emails: ["nobody@heig.test"], affiliations: ["staff"] }),
    ).toBe("student");
  });

  it("still lets a student@heig-vd.ch affiliation block the staff one", async () => {
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["student@heig-vd.ch", "staff@hes-so.ch"],
      }),
    ).toBe("student");
  });

  it("lets only a student of our institutions block the staff one", async () => {
    // A HES-SO employee studying at another university remains staff here.
    expect(
      await roleOf({
        emails: ["nobody@heig.test"],
        affiliations: ["student@unil.ch", "staff@hes-so.ch"],
      }),
    ).toBe("teacher");
  });
});

describe("roleForIdentity, the reason", () => {
  it("names the branch of the rule that gave the role", async () => {
    const decide = (identity: Identity) => roleForIdentity(db, config, identity);
    expect(await decide({ emails: ["boss@heig.test", "granted@heig.test"] })).toEqual({
      role: "admin",
      reason: "super_admin",
    });
    expect(await decide({ emails: ["granted@heig.test"] })).toEqual({
      role: "teacher",
      reason: "grant",
    });
    expect(
      await decide({ emails: ["nobody@heig.test"], affiliations: ["staff@heig-vd.ch"] }),
    ).toEqual({ role: "teacher", reason: "staff_affiliation" });
    expect(await decide({ emails: ["nobody@heig.test"] })).toEqual({
      role: "student",
      reason: null,
    });
  });
});

describe("syncUserRole, account without an address set", () => {
  async function legacy(email: string, emailVerified: boolean) {
    const id = randomUUID();
    await db.insert(users).values({ id, oidcSub: `u-${id}`, email, emailVerified });
    return syncUserRole(db, config, email);
  }

  it("does not reach an account whose login address is unverified", async () => {
    expect(await legacy("claimed@heig.test", false)).toBe(0);
  });

  it("reaches it once verified", async () => {
    expect(await legacy("verified@heig.test", true)).toBe(1);
  });
});
