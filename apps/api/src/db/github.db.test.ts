/**
 * The `github` module's tables (`db/github.ts`, migration `0048_github`)
 * against the real migrations: the UNIQUE constraints the handlers'
 * idempotency rests on (ADR-011), and no column able to hold a token
 * (invariant 15, N-SEC-16).
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import { githubAccounts, pushReceipts, users, webhookDeliveries } from "./schema.js";
import { testDb } from "../test/db.js";

const GITHUB_TABLES = ["github_organizations", "github_classroom_links", "github_accounts", "webhook_deliveries", "push_receipts"];

let db: Db;
beforeAll(async () => {
  db = await testDb();
});

async function user(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `sub-${id}`, email: `${id}@heig-vd.ch` });
  return id;
}

describe("the github schema", () => {
  it("acknowledges a delivery seen twice, even after its payload was purged", async () => {
    const row = { deliveryId: randomUUID(), event: "push", receivedAt: new Date(), payload: { ref: "refs/heads/main" } };
    const insert = () => db.insert(webhookDeliveries).values(row).onConflictDoNothing().returning();
    expect(await insert()).toHaveLength(1);
    expect(await insert()).toEqual([]);
    await db.update(webhookDeliveries).set({ payload: null }).where(eq(webhookDeliveries.deliveryId, row.deliveryId));
    expect(await insert()).toEqual([]);
  });

  it("keeps the first receipt of a head sha", async () => {
    const first = new Date("2026-10-01T10:00:00Z");
    const receipt = (receivedAt: Date) => ({ id: randomUUID(), githubRepoId: 9001, branch: "main", headSha: "c".repeat(40), receivedAt });
    await db.insert(pushReceipts).values(receipt(first)).onConflictDoNothing();
    await db.insert(pushReceipts).values(receipt(new Date("2026-10-01T11:00:00Z"))).onConflictDoNothing();
    const rows = await db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, 9001));
    expect(rows.map((r) => r.receivedAt)).toEqual([first]);
  });

  it("links one GitHub account to one user", async () => {
    await db.insert(githubAccounts).values({ userId: await user(), githubUserId: 583231, login: "octocat" });
    // The UNIQUE is the refusal of a second link (`?github=conflict`).
    await expect(
      db.insert(githubAccounts).values({ userId: await user(), githubUserId: 583231, login: "octocat" }),
    ).rejects.toThrow();
  });

  it("has no column that could hold a token, a key or a secret", async () => {
    const { rows } = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ${GITHUB_TABLES}`);
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(GITHUB_TABLES));
    const suspicious = rows.filter((r) => /token|secret|password|credential|private|key|pem|jwt/i.test(r.column_name));
    expect(suspicious).toEqual([]);
  });
});
