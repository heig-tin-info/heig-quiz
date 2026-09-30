/**
 * The `github` module's tables (`db/github.ts`, migration `0048_github`)
 * against the real migrations: the UNIQUE constraints every handler's
 * idempotency rests on (ADR-011), one organization per classroom (D02) and
 * the link's cascade, the receipt times the intake must write itself
 * (invariant 5), the indexes of the lookups M2-02 to M2-04 make, and no
 * column able to hold a token (invariant 15, N-SEC-16).
 */
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "./client.js";
import {
  classrooms,
  courses,
  githubAccounts,
  githubClassroomLinks,
  githubOrganizations,
  pushReceipts,
  users,
  webhookDeliveries,
} from "./schema.js";
import { testDb } from "../test/db.js";

const GITHUB_TABLES = [
  "github_organizations",
  "github_classroom_links",
  "github_accounts",
  "webhook_deliveries",
  "push_receipts",
];

let db: Db;
let teacherId: string;
let courseId: string;
let seq = 1000;

beforeAll(async () => {
  db = await testDb();
  teacherId = await user();
  courseId = randomUUID();
  await db.insert(courses).values({ id: courseId, name: "Programmation C", code: "PRG1" });
});

async function user(): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `sub-${id}`, email: `${id}@heig-vd.ch` });
  return id;
}

async function classroom(): Promise<string> {
  const id = randomUUID();
  await db.insert(classrooms).values({ id, courseId, name: `C-${id.slice(0, 4)}`, period: "" });
  return id;
}

async function org(values: Partial<typeof githubOrganizations.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await db.insert(githubOrganizations).values({ id, login: `org-${seq}`, githubOrgId: seq, ...values });
  return id;
}

describe("github_organizations", () => {
  it("starts uninstalled, without an installation", async () => {
    const id = await org();
    const [row] = await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, id));
    expect(row).toMatchObject({ status: "uninstalled", installationId: null, plan: null, avatarSourceUrl: null });
  });

  it("keys an organization on its GitHub id, its login and its installation", async () => {
    await org({ githubOrgId: 1, login: "heig-tin-info", installationId: 11, status: "installed" });
    await expect(org({ githubOrgId: 1 })).rejects.toThrow();
    await expect(org({ login: "heig-tin-info" })).rejects.toThrow();
    await expect(org({ installationId: 11, status: "installed" })).rejects.toThrow();
    // An imported organization, not yet resolved: several may lack the id.
    await org({ githubOrgId: null });
    await org({ githubOrgId: null });
  });

  it("holds an installation id exactly while installed or suspended", async () => {
    await expect(org({ status: "installed" })).rejects.toThrow();
    await expect(org({ status: "suspended" })).rejects.toThrow();
    await expect(org({ installationId: 21 })).rejects.toThrow(); // default `uninstalled`
    await expect(org({ installationId: 22, status: "deleted" })).rejects.toThrow();
    await org({ installationId: 23, status: "suspended" });
    // The staging refresh (N-SEC-18): clearing the ids needs the status with them.
    await expect(
      db.update(githubOrganizations).set({ installationId: null }).where(eq(githubOrganizations.installationId, 23)),
    ).rejects.toThrow();
    await db
      .update(githubOrganizations)
      .set({ installationId: null, status: "uninstalled" })
      .where(eq(githubOrganizations.installationId, 23));
  });

  it("refuses a status outside the closed list", async () => {
    await expect(
      db.execute(sql`INSERT INTO github_organizations (id, login, status) VALUES (${randomUUID()}, 'x-status', 'active')`),
    ).rejects.toThrow();
  });
});

describe("github_classroom_links", () => {
  it("links a classroom to one organization, and many classrooms to one", async () => {
    const o = await org();
    const [a, b] = [await classroom(), await classroom()];
    await db.insert(githubClassroomLinks).values([
      { classroomId: a, orgId: o, linkedBy: teacherId },
      { classroomId: b, orgId: o, linkedBy: teacherId },
    ]);
    await expect(
      db.insert(githubClassroomLinks).values({ classroomId: a, orgId: await org(), linkedBy: teacherId }),
    ).rejects.toThrow();
    const linked = await db.select().from(githubClassroomLinks).where(eq(githubClassroomLinks.orgId, o));
    expect(linked.map((l) => l.classroomId).sort()).toEqual([a, b].sort());
  });

  it("goes with its classroom, and keeps its organization alive", async () => {
    const o = await org();
    const c = await classroom();
    await db.insert(githubClassroomLinks).values({ classroomId: c, orgId: o, linkedBy: teacherId });
    await expect(db.delete(githubOrganizations).where(eq(githubOrganizations.id, o))).rejects.toThrow();
    await db.delete(classrooms).where(eq(classrooms.id, c));
    expect(await db.select().from(githubClassroomLinks).where(eq(githubClassroomLinks.classroomId, c))).toEqual([]);
    expect(await db.select().from(githubOrganizations).where(eq(githubOrganizations.id, o))).toHaveLength(1);
  });
});

describe("github_accounts", () => {
  it("links one GitHub account to one user, once", async () => {
    const [u, v] = [await user(), await user()];
    await db.insert(githubAccounts).values({ userId: u, githubUserId: 583231, login: "octocat" });
    // The UNIQUE is the refusal of a second link (`?github=conflict`).
    await expect(db.insert(githubAccounts).values({ userId: v, githubUserId: 583231, login: "octocat" })).rejects.toThrow();
    await expect(db.insert(githubAccounts).values({ userId: u, githubUserId: 1, login: "other" })).rejects.toThrow();
  });

  it("goes with its user", async () => {
    const u = await user();
    await db.insert(githubAccounts).values({ userId: u, githubUserId: 777, login: "gone" });
    await db.delete(users).where(eq(users.id, u));
    expect(await db.select().from(githubAccounts).where(eq(githubAccounts.githubUserId, 777))).toEqual([]);
  });
});

describe("webhook_deliveries", () => {
  it("acknowledges a delivery seen twice without a second row", async () => {
    const deliveryId = randomUUID();
    const row = { deliveryId, event: "push", receivedAt: new Date(), payload: { ref: "refs/heads/main" } };
    const first = await db.insert(webhookDeliveries).values(row).onConflictDoNothing().returning();
    const again = await db.insert(webhookDeliveries).values(row).onConflictDoNothing().returning();
    expect([first.length, again.length]).toEqual([1, 0]);
  });

  it("takes its receipt time from the intake, never from a default", async () => {
    await expect(
      db.execute(sql`INSERT INTO webhook_deliveries (delivery_id, event) VALUES (${randomUUID()}, 'push')`),
    ).rejects.toThrow();
  });

  it("keeps the row once its payload is purged", async () => {
    const deliveryId = randomUUID();
    await db.insert(webhookDeliveries).values({ deliveryId, event: "ping", receivedAt: new Date(), payload: {} });
    await db.update(webhookDeliveries).set({ payload: null }).where(eq(webhookDeliveries.deliveryId, deliveryId));
    const again = await db
      .insert(webhookDeliveries)
      .values({ deliveryId, event: "ping", receivedAt: new Date(), payload: {} })
      .onConflictDoNothing()
      .returning();
    expect(again).toEqual([]);
  });
});

describe("push_receipts", () => {
  it("keeps the first receipt of a head sha", async () => {
    const first = new Date("2026-10-01T10:00:00Z");
    const receipt = (receivedAt: Date) => ({
      id: randomUUID(),
      githubRepoId: 9001,
      branch: "main",
      headSha: "c".repeat(40),
      receivedAt,
    });
    await db.insert(pushReceipts).values(receipt(first)).onConflictDoNothing();
    await db.insert(pushReceipts).values(receipt(new Date("2026-10-01T11:00:00Z"))).onConflictDoNothing();
    const rows = await db.select().from(pushReceipts).where(eq(pushReceipts.githubRepoId, 9001));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ receivedAt: first, isBot: false, forced: false });
    // The same sha on another repository is another receipt.
    await db.insert(pushReceipts).values({ ...receipt(first), githubRepoId: 9002 });
  });

  it("takes its receipt time from the intake, never from a default", async () => {
    await expect(
      db.execute(
        sql`INSERT INTO push_receipts (id, github_repo_id, branch, head_sha) VALUES (${randomUUID()}, 1, 'main', 'abc')`,
      ),
    ).rejects.toThrow();
  });
});

describe("the github schema", () => {
  it("has no column that could hold a token, a key or a secret", async () => {
    const { rows } = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ${GITHUB_TABLES}`);
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(GITHUB_TABLES));
    const suspicious = rows.filter((r) => /token|secret|password|credential|private|key|pem|jwt/i.test(r.column_name));
    expect(suspicious).toEqual([]);
  });

  it("indexes the lookups of the module", async () => {
    const { rows } = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ${GITHUB_TABLES}`);
    const defs = rows.map((r) => r.indexdef.replace(/"/g, ""));
    // An organization by its installation (the setup return, installation events).
    expect(defs).toContainEqual(expect.stringMatching(/UNIQUE INDEX .* ON public\.github_organizations .*\(installation_id\)/));
    // The classrooms of an organization.
    expect(defs).toContainEqual(expect.stringMatching(/INDEX .* ON public\.github_classroom_links .*\(org_id\)/));
    // The deliveries left unprocessed, for the reconciliation.
    expect(defs).toContainEqual(
      expect.stringMatching(/INDEX .* ON public\.webhook_deliveries .*\(received_at\) WHERE \(processed_at IS NULL\)/),
    );
  });
});
