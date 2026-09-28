/**
 * The Teams link (ADR-030) on a real database: the single-use token the tab
 * mints for a Teams account, and the link it makes once consumed.
 */
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { teamsLinks, teamsLinkTokens, users } from "../../db/schema.js";
import { testDb } from "../../test/db.js";
import {
  accountName,
  consumeLinkToken,
  issueLinkToken,
  LINK_TOKEN_TTL_MS,
  previewLinkToken,
  teamsLinkOf,
  type TeamsIdentity,
} from "./teamsLink.js";

let db: Db;

async function seedUser(email: string, givenName = "Léa", familyName = "Rochat"): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `s-${id}`, email, role: "student", givenName, familyName });
  return id;
}

beforeAll(async () => {
  db = (await testDb()) as unknown as Db;
});

/** A fresh Teams account of the HEIG tenant. */
function teamsAccount(over: Partial<TeamsIdentity> = {}): TeamsIdentity {
  return {
    tenantId: "tenant-heig",
    aadObjectId: randomUUID(),
    teamsName: "Léa Rochat",
    teamsUsername: "lea.rochat@heig-vd.ch",
    ...over,
  };
}

const tokensOf = (who: TeamsIdentity) =>
  db.select().from(teamsLinkTokens).where(eq(teamsLinkTokens.aadObjectId, who.aadObjectId));

describe("the link token", () => {
  it("is stored as a hash only, with the Teams account it stands for", async () => {
    const who = teamsAccount();
    const token = await issueLinkToken(db, who, new Date("2026-09-28T10:00:00Z"));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await tokensOf(who);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).not.toContain(token);
    expect(rows[0]).toMatchObject({
      tenantId: "tenant-heig",
      teamsName: "Léa Rochat",
      teamsUsername: "lea.rochat@heig-vd.ch",
    });
  });

  it("replaces the unspent token of the same account: only the last link works", async () => {
    const who = teamsAccount();
    const now = new Date("2026-09-28T10:00:00Z");
    const first = await issueLinkToken(db, who, now);
    const second = await issueLinkToken(db, who, now);
    expect(second).not.toBe(first);
    expect(await previewLinkToken(db, first, now)).toBeNull();
    expect(await previewLinkToken(db, second, now)).not.toBeNull();
    expect(await tokensOf(who)).toHaveLength(1);
    // Another account's token is untouched.
    const other = teamsAccount();
    const theirs = await issueLinkToken(db, other, now);
    await issueLinkToken(db, who, now);
    expect(await previewLinkToken(db, theirs, now)).not.toBeNull();
  });

  it("previews without consuming, then links once and never again", async () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const who = teamsAccount();
    const token = await issueLinkToken(db, who, now);
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);

    expect(await previewLinkToken(db, token, now)).toMatchObject({
      teamsName: "Léa Rochat",
      teamsUsername: "lea.rochat@heig-vd.ch",
      tenantId: "tenant-heig",
    });
    expect(await previewLinkToken(db, token, now)).not.toBeNull();

    const outcome = await consumeLinkToken(db, lea, token, now);
    expect(outcome).toMatchObject({
      displaced: null,
      link: { userId: lea, tenantId: "tenant-heig", aadObjectId: who.aadObjectId, teamsUsername: "lea.rochat@heig-vd.ch" },
    });
    expect(await teamsLinkOf(db, who)).toMatchObject({ userId: lea });
    // Replayed: nothing, and the preview says so too.
    expect(await consumeLinkToken(db, lea, token, now)).toBeNull();
    expect(await previewLinkToken(db, token, now)).toBeNull();
  });

  it("is unusable after fifteen minutes, and pruned by the next one made", async () => {
    const now = new Date("2026-09-28T13:00:00Z");
    const token = await issueLinkToken(db, teamsAccount(), now);
    const later = new Date(now.getTime() + LINK_TOKEN_TTL_MS + 1);
    expect(await previewLinkToken(db, token, later)).toBeNull();
    expect(await consumeLinkToken(db, await seedUser(`x-${randomUUID()}@heig.test`), token, later)).toBeNull();

    await issueLinkToken(db, teamsAccount(), later);
    const left = await db.select().from(teamsLinkTokens);
    expect(left.every((row) => row.expiresAt > later)).toBe(true);
  });

  it("is refused, and left unspent, once its tenant is no longer allowed", async () => {
    const now = new Date("2026-09-28T12:30:00Z");
    const token = await issueLinkToken(db, teamsAccount(), now);
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`);
    expect(await previewLinkToken(db, token, now, ["another-tenant"])).toBeNull();
    expect(await consumeLinkToken(db, lea, token, now, ["another-tenant"])).toBeNull();
    expect(await consumeLinkToken(db, lea, token, now, ["another-tenant", "tenant-heig"])).not.toBeNull();
  });

  it("knows nothing of a token it never made", async () => {
    const now = new Date();
    const random = "A".repeat(43);
    expect(await previewLinkToken(db, random, now)).toBeNull();
    expect(await consumeLinkToken(db, await seedUser(`y-${randomUUID()}@heig.test`), random, now)).toBeNull();
  });

  it("moves a Teams account to the Quiz account that links it last, and replaces an account's old one", async () => {
    const now = new Date("2026-09-28T14:00:00Z");
    const first = await seedUser(`first-${randomUUID()}@heig.test`);
    const second = await seedUser(`second-${randomUUID()}@heig.test`);
    const who = teamsAccount();

    await consumeLinkToken(db, first, await issueLinkToken(db, who, now), now);
    // The same Teams account (same tenant and object id, whatever its name
    // now), linked from another Quiz account.
    const renamed = { ...who, teamsName: "Léa R." };
    const moved = await consumeLinkToken(db, second, await issueLinkToken(db, renamed, now), now);
    expect(moved!.displaced).toBe(first);
    const holders = await db.select().from(teamsLinks).where(eq(teamsLinks.aadObjectId, who.aadObjectId));
    expect(holders.map((l) => [l.userId, l.teamsName])).toEqual([[second, "Léa R."]]);

    // The same object id in ANOTHER tenant is another person: no move.
    const elsewhere = { ...who, tenantId: "tenant-other" };
    const third = await seedUser(`third-${randomUUID()}@heig.test`);
    expect((await consumeLinkToken(db, third, await issueLinkToken(db, elsewhere, now), now))!.displaced).toBeNull();
    expect(await teamsLinkOf(db, who)).toMatchObject({ userId: second });

    // A second Teams account for the same Quiz account replaces the first.
    const two = teamsAccount();
    const replaced = await consumeLinkToken(db, second, await issueLinkToken(db, two, now), now);
    expect(replaced!.displaced).toBeNull();
    const mine = await db.select().from(teamsLinks).where(eq(teamsLinks.userId, second));
    expect(mine.map((l) => l.aadObjectId)).toEqual([two.aadObjectId]);
    expect(await teamsLinkOf(db, who)).toBeNull();
  });

  it("names a Quiz account the way the platform does", async () => {
    const lea = await seedUser(`lea-${randomUUID()}@heig.test`, "Léa", "Rochat");
    expect(await accountName(db, lea)).toBe("Léa Rochat");
    expect(await accountName(db, randomUUID())).toBe("");
  });
});
