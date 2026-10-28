/**
 * The notification address (F-NOTIF-01, ADR-030 amendment of 2026-10-28):
 * the institutional address by default, the login one without it, a choice
 * honoured while it is still one of the account's addresses.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { userEmails, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import { notificationAddress, resolveNotificationEmail, setNotificationEmail } from "./address.js";

const LINKED = "swissEduIDLinkedAffiliationMail";
const ORGANIZATIONAL = "swissEduPersonOrganizationalMail";

describe("resolveNotificationEmail", () => {
  it("defaults to the first institutional address, by claim rank, and marks it", () => {
    const got = resolveNotificationEmail(
      "Me@Gmail.com",
      [
        { email: "me@gmail.com", source: "login" },
        { email: "m.e@heig-vd.ch", source: ORGANIZATIONAL },
        { email: "me@heig-vd.ch", source: LINKED },
        { email: "old@example.org", source: "heig-classroom" },
      ],
      null,
    );
    expect(got).toEqual({
      address: "me@heig-vd.ch",
      choice: null,
      defaultAddress: "me@heig-vd.ch",
      options: [
        { email: "me@heig-vd.ch", institutional: true },
        { email: "m.e@heig-vd.ch", institutional: true },
        { email: "me@gmail.com", institutional: false },
        { email: "old@example.org", institutional: false },
      ],
    });
  });

  it("falls back to the login address without an institutional one", () => {
    const got = resolveNotificationEmail("me@gmail.com", [], null);
    expect(got).toEqual({ address: "me@gmail.com", choice: null, defaultAddress: "me@gmail.com", options: [{ email: "me@gmail.com", institutional: false }] });
  });

  it("honours a choice among the options, and ignores one that no longer is", () => {
    const rows = [{ email: "me@heig-vd.ch", source: LINKED }];
    expect(resolveNotificationEmail("me@gmail.com", rows, "me@gmail.com")).toMatchObject({
      address: "me@gmail.com",
      choice: "me@gmail.com",
      defaultAddress: "me@heig-vd.ch",
    });
    expect(resolveNotificationEmail("me@gmail.com", rows, "gone@gmail.com")).toMatchObject({
      address: "me@heig-vd.ch",
      choice: null,
    });
  });
});

describe("notificationAddress and setNotificationEmail", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
  });

  async function seed(login: string, rows: { email: string; source: string; verified?: boolean }[]) {
    const id = randomUUID();
    await db.insert(users).values({ id, oidcSub: `s-${id}`, email: login });
    if (rows.length > 0) await db.insert(userEmails).values(rows.map((r) => ({ userId: id, verified: true, ...r })));
    return id;
  }

  it("reads the verified addresses only", async () => {
    const id = await seed("eve@gmail.com", [
      { email: "eve@gmail.com", source: "login" },
      { email: "eve@heig-vd.ch", source: LINKED, verified: false },
      { email: "eve@hes-so.ch", source: "heig-classroom" },
    ]);
    expect(await notificationAddress(db, id)).toEqual({
      address: "eve@gmail.com",
      choice: null,
      defaultAddress: "eve@gmail.com",
      options: [
        { email: "eve@gmail.com", institutional: false },
        { email: "eve@hes-so.ch", institutional: false },
      ],
    });
    expect(await notificationAddress(db, randomUUID())).toBeNull();
  });

  it("stores a known address, resets with null, refuses a foreign one", async () => {
    const id = await seed("fay@gmail.com", [{ email: "fay@heig-vd.ch", source: LINKED }]);
    expect((await notificationAddress(db, id))?.address).toBe("fay@heig-vd.ch");

    expect(await setNotificationEmail(db, id, " Fay@Gmail.com ")).toBe(true);
    expect(await notificationAddress(db, id)).toMatchObject({ address: "fay@gmail.com", choice: "fay@gmail.com" });

    expect(await setNotificationEmail(db, id, "someone@else.ch")).toBe(false);
    expect((await notificationAddress(db, id))?.address).toBe("fay@gmail.com");

    expect(await setNotificationEmail(db, id, null)).toBe(true);
    expect(await notificationAddress(db, id)).toMatchObject({ address: "fay@heig-vd.ch", choice: null });
  });

  it("falls back to the default when the stored choice is no longer an option", async () => {
    const id = await seed("gus@gmail.com", [{ email: "gus@heig-vd.ch", source: LINKED }]);
    await db.update(users).set({ notificationEmail: "gus@old.ch" }).where(eq(users.id, id));
    expect(await notificationAddress(db, id)).toMatchObject({ address: "gus@heig-vd.ch", choice: null });
  });
});
