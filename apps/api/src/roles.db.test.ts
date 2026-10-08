import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { subscribe, type BusMessage } from "./events.js";
import { teacherGrants, userEmails, users } from "./db/schema.js";
import { roleForIdentity, syncUserRole, type Identity } from "./roles.js";
import { testDb } from "./test/db.js";

const config = {
  SUPER_ADMIN_EMAIL: "boss@heig.test",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch", "hes-so.ch"],
} as AppConfig;

let db: Db;
let adminId: string;

/** The role alone: most cases below are about which role, not why. */
const roleOf = async (identity: Identity) => (await roleForIdentity(db, config, identity)).role;

beforeAll(async () => {
  db = await testDb();
  adminId = randomUUID();
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
  // Every login fills the address set, so `users.email` alone reaches no
  // one, verified or not (#410).
  it("does not reach it, even with a verified login address", async () => {
    for (const emailVerified of [false, true]) {
      const id = randomUUID();
      const email = `legacy-${id.slice(0, 8)}@heig.test`;
      await db.insert(users).values({ id, oidcSub: `u-${id}`, email, emailVerified });
      expect(await syncUserRole(db, config, email)).toBe(0);
    }
  });
});

/** #248: losing a privilege closes the account's open streams. */
describe("syncUserRole closes the streams of a demoted account", () => {
  async function closesFor(role: "teacher" | "admin", email: string) {
    const id = randomUUID();
    await db.insert(users).values({ id, oidcSub: `u-${id}`, email, emailVerified: true, role });
    await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
    const closed: string[] = [];
    const unsubscribe = subscribe((m: BusMessage) => {
      if (m.kind === "close") closed.push(...m.topics);
    });
    try {
      await syncUserRole(db, config, email);
    } finally {
      unsubscribe();
    }
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, id));
    return { role: row!.role, closed: closed.includes(`user:${id}`) };
  }

  it("when a teacher without grant nor seat falls back to student", async () => {
    expect(await closesFor("teacher", "revoked@heig.test")).toEqual({ role: "student", closed: true });
  });

  it("when an admin falls back to teacher, and keeps the grant", async () => {
    expect(await closesFor("admin", "granted@heig.test")).toEqual({ role: "teacher", closed: true });
  });

  it("not when nothing is lost", async () => {
    const email = `kept-${randomUUID().slice(0, 8)}@heig.test`;
    await db.insert(teacherGrants).values({ id: randomUUID(), email, createdBy: adminId });
    expect(await closesFor("teacher", email)).toEqual({ role: "teacher", closed: false });
  });
});
