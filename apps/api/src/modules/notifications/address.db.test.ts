/**
 * The notification address (F-NOTIF-01, ADR-030 amendment of 2026-10-28):
 * the institutional address the last login asserts by default, the login one
 * without it, a choice honoured while it is still one of the account's
 * addresses.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { userEmails, userIdpClaims, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { notificationAddress, resolveNotificationEmail, setNotificationEmail } from "./address.js";

describe("resolveNotificationEmail", () => {
  it("defaults to the first institutional address the login asserts, and marks those", () => {
    const got = resolveNotificationEmail({
      login: "Me@Gmail.com",
      verified: ["me@gmail.com", "m.e@heig-vd.ch", "me@heig-vd.ch", "old@example.org"],
      institutional: ["me@heig-vd.ch", "m.e@heig-vd.ch"],
      chosen: null,
    });
    expect(got.address).toBe("me@heig-vd.ch");
    expect(got.defaultAddress).toBe("me@heig-vd.ch");
    expect(got.options).toEqual(
      expect.arrayContaining([
        { email: "me@heig-vd.ch", institutional: true },
        { email: "m.e@heig-vd.ch", institutional: true },
        { email: "me@gmail.com", institutional: false },
        { email: "old@example.org", institutional: false },
      ]),
    );
    expect(got.options).toHaveLength(4);
  });

  it("falls back to the login address without an institutional one, and never offers an asserted address it does not hold", () => {
    expect(resolveNotificationEmail({ login: "me@gmail.com", verified: [], institutional: ["x@heig-vd.ch"], chosen: null })).toEqual({
      address: "me@gmail.com",
      defaultAddress: "me@gmail.com",
      options: [{ email: "me@gmail.com", institutional: false }],
    });
  });

  it("honours a choice among the options, and ignores one that no longer is", () => {
    const base = { login: "me@gmail.com", verified: ["me@heig-vd.ch"], institutional: ["me@heig-vd.ch"] };
    expect(resolveNotificationEmail({ ...base, chosen: "me@gmail.com" })).toMatchObject({
      address: "me@gmail.com",
      defaultAddress: "me@heig-vd.ch",
    });
    expect(resolveNotificationEmail({ ...base, chosen: "gone@gmail.com" }).address).toBe("me@heig-vd.ch");
  });
});

describe("notificationAddress and setNotificationEmail", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
  });

  async function seed(
    login: string,
    rows: { email: string; source: string; verified?: boolean }[],
    claims?: Record<string, unknown>,
  ) {
    const id = randomUUID();
    await db.insert(users).values({ id, oidcSub: `s-${id}`, email: login });
    if (rows.length > 0) await db.insert(userEmails).values(rows.map((r) => ({ userId: id, verified: true, ...r })));
    if (claims) await db.insert(userIdpClaims).values({ userId: id, claims, affiliations: [] });
    return id;
  }

  it("takes the institutional address from the last login, whatever source its row was first stored under", async () => {
    // First login as x@heig-vd.ch, then edu-ID switched to a Gmail address:
    // the row keeps its `login` source, the claims still assert it.
    const id = await seed("hal@gmail.com", [
      { email: "hal@heig-vd.ch", source: "login" },
      { email: "hal@gmail.com", source: "login" },
    ], { email: "hal@gmail.com", swissEduIDLinkedAffiliationMail: ["Hal@heig-vd.ch"] });
    const got = await notificationAddress(db, id);
    expect(got?.address).toBe("hal@heig-vd.ch");
    expect(got?.defaultAddress).toBe("hal@heig-vd.ch");
    expect(got?.options).toContainEqual({ email: "hal@heig-vd.ch", institutional: true });
  });

  it("never defaults to an address of a former affiliation the last login no longer asserts", async () => {
    const id = await seed("ida@gmail.com", [
      { email: "ida@old-school.ch", source: "swissEduIDLinkedAffiliationMail" },
    ], { email: "ida@gmail.com" });
    const got = await notificationAddress(db, id);
    expect(got?.address).toBe("ida@gmail.com");
    expect(got?.options).toContainEqual({ email: "ida@old-school.ch", institutional: false });
  });

  it("reads the verified addresses only", async () => {
    const id = await seed("eve@gmail.com", [
      { email: "eve@heig-vd.ch", source: "swissEduIDLinkedAffiliationMail", verified: false },
      { email: "eve@hes-so.ch", source: "heig-classroom" },
    ]);
    const got = await notificationAddress(db, id);
    expect(got?.address).toBe("eve@gmail.com");
    expect(got?.options.map((o) => o.email).sort()).toEqual(["eve@gmail.com", "eve@hes-so.ch"]);
    expect(await notificationAddress(db, randomUUID())).toBeNull();
  });

  it("stores a known address, resets with null, refuses a foreign one", async () => {
    const id = await seed("fay@gmail.com", [{ email: "fay@heig-vd.ch", source: "swissEduIDLinkedAffiliationMail" }], {
      swissEduIDLinkedAffiliationMail: "fay@heig-vd.ch",
    });
    expect((await notificationAddress(db, id))?.address).toBe("fay@heig-vd.ch");

    expect(await setNotificationEmail(db, id, " Fay@Gmail.com ")).toBe(true);
    expect((await notificationAddress(db, id))?.address).toBe("fay@gmail.com");

    expect(await setNotificationEmail(db, id, "someone@else.ch")).toBe(false);
    expect((await notificationAddress(db, id))?.address).toBe("fay@gmail.com");

    expect(await setNotificationEmail(db, id, null)).toBe(true);
    expect((await notificationAddress(db, id))?.address).toBe("fay@heig-vd.ch");
  });

  it("falls back to the default when the stored choice is no longer an option", async () => {
    const id = await seed("gus@gmail.com", [{ email: "gus@heig-vd.ch", source: "swissEduIDLinkedAffiliationMail" }], {
      swissEduIDLinkedAffiliationMail: "gus@heig-vd.ch",
    });
    await db.update(users).set({ notificationEmail: "gus@old.ch" }).where(eq(users.id, id));
    expect((await notificationAddress(db, id))?.address).toBe("gus@heig-vd.ch");
  });
});
