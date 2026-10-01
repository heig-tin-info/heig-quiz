/**
 * Login adoption (ADR-061): the first login of a person the heig-classroom
 * import created takes over that account, by `swiss_edu_id`, then by a
 * verified address; never an ambiguous one, never a row that is not a
 * `classroom:` placeholder.
 */
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { auditLog, userEmails, users } from "../db/schema.js";
import { testDb } from "../test/db.js";
import { oidcClaims } from "../test/oidc.js";
import { applyAdoption, findAdoption } from "./adoption.js";
import { loginAdmits, signIn } from "./login.js";

const config = {
  SUPER_ADMIN_EMAIL: "",
  STAFF_AFFILIATION_DOMAINS: ["heig-vd.ch"],
  LOGIN_ALLOWLIST: "",
} as unknown as AppConfig;

let db: Db;

beforeAll(async () => {
  db = await testDb();
});

/** An account as the import leaves it: placeholder sub, its addresses verified. */
async function account(sub: string, opts: { swissEduId?: string; emails?: string[]; anonymized?: boolean } = {}) {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    oidcSub: sub,
    email: opts.emails?.[0] ?? "",
    emailVerified: true,
    givenName: "Imported",
    swissEduId: opts.swissEduId ?? null,
    anonymizedAt: opts.anonymized ? new Date() : null,
  });
  for (const email of opts.emails ?? []) {
    await db.insert(userEmails).values({ userId: id, email, source: "login", verified: true });
  }
  return id;
}

function login(sub: string, opts: { swissEduId?: string; email?: string; institutional?: string[] } = {}) {
  const raw: Record<string, unknown> = { email: opts.email ?? "" };
  if (opts.institutional) raw.swissEduIDLinkedAffiliationMail = opts.institutional;
  return { ...oidcClaims(sub, raw, true), swissEduId: opts.swissEduId ?? null };
}

async function audits(action: "auth.account_adopted" | "auth.adoption_ambiguous", subjectId: string) {
  return db
    .select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
}

async function subOf(id: string) {
  const [row] = await db.select({ sub: users.oidcSub }).from(users).where(eq(users.id, id));
  return row?.sub;
}

describe("login adoption", () => {
  it("adopts the one imported account with the same swiss_edu_id, once", async () => {
    const id = await account("classroom:cr-1", { swissEduId: "eid-1@eduid.ch", emails: ["one@heig-vd.ch"] });
    const user = await signIn(db, config, login("quiz-1", { swissEduId: "eid-1@eduid.ch", email: "one@heig-vd.ch" }));
    expect(user.id).toBe(id);
    expect(user.oidcSub).toBe("quiz-1");
    expect(await audits("auth.account_adopted", id)).toEqual([
      { payload: { key: "swiss_edu_id", previousSub: "classroom:cr-1" } },
    ]);
    // The next login is an ordinary one.
    await signIn(db, config, login("quiz-1", { swissEduId: "eid-1@eduid.ch" }));
    expect(await audits("auth.account_adopted", id)).toHaveLength(1);
  });

  it("adopts by an institutional address, whoever else holds it", async () => {
    const id = await account("classroom:cr-2", { emails: ["two@heig-vd.ch"] });
    const user = await signIn(
      db,
      config,
      login("quiz-2", { email: "two@mail.test", institutional: ["two@heig-vd.ch"] }),
    );
    expect(user.id).toBe(id);
    expect((await audits("auth.account_adopted", id))[0]?.payload).toMatchObject({ key: "institutional_address" });
  });

  it("adopts by a private address unique on both sides", async () => {
    const id = await account("classroom:cr-3", { emails: ["three@mail.test"] });
    const user = await signIn(db, config, login("quiz-3", { email: "three@mail.test" }));
    expect(user.id).toBe(id);
    expect((await audits("auth.account_adopted", id))[0]?.payload).toMatchObject({ key: "private_address" });
  });

  it("refuses a private address another Quiz account holds too", async () => {
    const id = await account("classroom:cr-4", { emails: ["four@mail.test"] });
    await account("quiz-other-4", { emails: ["four@mail.test"] });
    const user = await signIn(db, config, login("quiz-4", { email: "four@mail.test" }));
    expect(user.id).not.toBe(id);
    expect(await subOf(id)).toBe("classroom:cr-4");
    expect(await audits("auth.adoption_ambiguous", user.id)).toEqual([
      { payload: { key: "private_address", candidates: [id] } },
    ]);
  });

  it("adopts nothing when two imported accounts match, and says so", async () => {
    const a = await account("classroom:cr-5a", { swissEduId: "eid-5@eduid.ch" });
    const b = await account("classroom:cr-5b", { swissEduId: "eid-5@eduid.ch" });
    const user = await signIn(db, config, login("quiz-5", { swissEduId: "eid-5@eduid.ch" }));
    expect([a, b]).not.toContain(user.id);
    expect([await subOf(a), await subOf(b)]).toEqual(["classroom:cr-5a", "classroom:cr-5b"]);
    expect((await audits("auth.adoption_ambiguous", user.id))[0]?.payload).toEqual({
      key: "swiss_edu_id",
      candidates: [a, b].sort(),
    });
  });

  it("adopts once under two concurrent first logins", async () => {
    // PGlite runs one transaction at a time, so `Promise.all` only shows the
    // outcome once serialized; the race itself is driven step by step below.
    const id = await account("classroom:cr-6", { swissEduId: "eid-6@eduid.ch" });
    const same = login("quiz-6", { swissEduId: "eid-6@eduid.ch" });
    const [x, y] = await Promise.all([signIn(db, config, same), signIn(db, config, same)]);
    expect([x.id, y.id]).toEqual([id, id]);
    expect(await audits("auth.account_adopted", id)).toHaveLength(1);

    // Two subjects that BOTH read the placeholder before either wrote: the
    // first adoption commits, the second's conditional UPDATE finds no
    // placeholder left and falls through to the ordinary insert.
    const shared = await account("classroom:cr-7", { swissEduId: "eid-7@eduid.ch" });
    const a = login("quiz-7a", { swissEduId: "eid-7@eduid.ch" });
    const b = login("quiz-7b", { swissEduId: "eid-7@eduid.ch" });
    const readA = await db.transaction((tx) => findAdoption(tx, a));
    const readB = await db.transaction((tx) => findAdoption(tx, b));
    expect([readA, readB]).toMatchObject([
      { kind: "candidate", userId: shared },
      { kind: "candidate", userId: shared },
    ]);
    expect(await db.transaction((tx) => applyAdoption(tx, shared, a.sub))).toBe(true);
    expect(await db.transaction((tx) => applyAdoption(tx, shared, b.sub))).toBe(false);
    expect(await subOf(shared)).toBe("quiz-7a");
    // And through the whole sign-in, b gets an account of its own, nothing audited as adopted.
    const other = await signIn(db, config, b);
    expect(other.id).not.toBe(shared);
    expect(await audits("auth.account_adopted", other.id)).toEqual([]);
  });

  it("refuses a login whose own subject looks like a placeholder", async () => {
    const id = await account("classroom:cr-12", { swissEduId: "eid-12@eduid.ch" });
    const forged = login("classroom:cr-12", { swissEduId: "eid-12@eduid.ch" });
    expect(loginAdmits(config, forged)).toBe(false);
    await expect(signIn(db, config, forged)).rejects.toThrow(/placeholder/);
    const [row] = await db.select({ name: users.givenName }).from(users).where(eq(users.id, id));
    expect(row?.name).toBe("Imported");
  });

  it("adopts a placeholder carrying a swiss_edu_id through that key only", async () => {
    const id = await account("classroom:cr-13", { swissEduId: "eid-13@eduid.ch", emails: ["thirteen@heig-vd.ch"] });
    // No swissEduPersonUniqueID released, the institutional address alone.
    const user = await signIn(db, config, login("quiz-13", { institutional: ["thirteen@heig-vd.ch"] }));
    expect(user.id).not.toBe(id);
    expect(await subOf(id)).toBe("classroom:cr-13");
    expect((await audits("auth.adoption_ambiguous", user.id))[0]?.payload).toEqual({
      key: "institutional_address",
      candidates: [id],
    });
  });

  it("refuses a private address two placeholders hold, whatever their swiss_edu_id", async () => {
    const a = await account("classroom:cr-14a", { swissEduId: "eid-14a@eduid.ch", emails: ["fourteen@mail.test"] });
    const b = await account("classroom:cr-14b", { emails: ["fourteen@mail.test"] });
    const user = await signIn(db, config, login("quiz-14", { swissEduId: "eid-14@eduid.ch", email: "fourteen@mail.test" }));
    expect([a, b]).not.toContain(user.id);
    expect([await subOf(a), await subOf(b)]).toEqual(["classroom:cr-14a", "classroom:cr-14b"]);
    expect((await audits("auth.adoption_ambiguous", user.id))[0]?.payload).toEqual({
      key: "private_address",
      candidates: [a, b].sort(),
    });
  });

  it("never touches a row that is not an imported placeholder", async () => {
    const real = await account("quiz-real-8", { swissEduId: "eid-8@eduid.ch" });
    const dev = await account("dev:alice", { swissEduId: "eid-9@eduid.ch" });
    const gone = await account("classroom:cr-10", { swissEduId: "eid-10@eduid.ch", anonymized: true });
    for (const [sub, eid] of [["quiz-8", "eid-8@eduid.ch"], ["quiz-9", "eid-9@eduid.ch"], ["quiz-10", "eid-10@eduid.ch"]] as const) {
      const user = await signIn(db, config, login(sub, { swissEduId: eid }));
      expect([real, dev, gone]).not.toContain(user.id);
    }
    expect([await subOf(real), await subOf(dev), await subOf(gone)]).toEqual([
      "quiz-real-8",
      "dev:alice",
      "classroom:cr-10",
    ]);
  });

  it("does not adopt by an address an account of another swiss_edu_id holds", async () => {
    const id = await account("classroom:cr-11", { swissEduId: "eid-11@eduid.ch", emails: ["eleven@heig-vd.ch"] });
    const user = await signIn(
      db,
      config,
      login("quiz-11", { swissEduId: "eid-other@eduid.ch", institutional: ["eleven@heig-vd.ch"] }),
    );
    expect(user.id).not.toBe(id);
    expect(await subOf(id)).toBe("classroom:cr-11");
  });
});
