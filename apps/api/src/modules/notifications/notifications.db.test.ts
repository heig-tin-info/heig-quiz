import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { notifications, pools, users } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import { testDb } from "../../test/db.js";
import * as service from "./service.js";

let db: Db;
let alice: string;
let bob: string;

async function seedUser(email: string): Promise<string> {
  const id = randomUUID();
  await db.insert(users).values({ id, oidcSub: `s-${id}`, email, role: "teacher" });
  return id;
}

/**
 * A real pool behind every notification: the bell drops a row whose pool is
 * gone (it would walk the reader to a 404), so a fixture pointing at a random
 * uuid would be invisible to every assertion below.
 */
async function seedPool(name: string): Promise<string> {
  const id = randomUUID();
  await db.insert(pools).values({ id, name, ownerId: alice });
  return id;
}

function poolShared(poolId: string, name: string) {
  return {
    kind: "pool_shared",
    poolId,
    poolName: name,
    role: "reader",
    byName: "Prof Démo",
  } as const;
}

/** The fixture of the common case: a pool that exists, shared with somebody. */
async function sharedPool(name: string) {
  return poolShared(await seedPool(name), name);
}

beforeAll(async () => {
  db = (await testDb()) as unknown as Db;
  alice = await seedUser("alice@heig.test");
  bob = await seedUser("bob@heig.test");
});

describe("notify", () => {
  it("stores the row and hints the recipient's own topic, and nobody else's", async () => {
    const seen: { type: string; topics: string[] }[] = [];
    const off = subscribe((e) => {
      if (e.kind === "hint") seen.push({ type: e.type, topics: e.topics });
    });
    const created = await service.notify(db, alice, await sharedPool("Programmation C"));
    off();

    expect(created.readAt).toBeNull();
    expect(created.payload).toMatchObject({ kind: "pool_shared", poolName: "Programmation C" });
    expect(seen).toEqual([{ type: "notifications", topics: [`user:${alice}`] }]);
    // A hint carries no data: the row is what holds the sentence.
    const [row] = await db.select().from(notifications).where(eq(notifications.id, created.id));
    expect(row!.userId).toBe(alice);
  });

  it("refuses a payload the catalogue does not know", async () => {
    await expect(
      service.notify(db, alice, { kind: "not_a_kind" } as never),
    ).rejects.toBeTruthy();
  });
});

describe("the inbox", () => {
  it("is newest first, capped, and counts the unread over the WHOLE inbox", async () => {
    const names = ["one", "two", "three"];
    for (const [index, name] of names.entries()) {
      const created = await service.notify(db, bob, await sharedPool(name));
      // The order is `created_at`; three inserts in the same millisecond would
      // leave it to the tie-break, so each row is aged by hand.
      await db
        .update(notifications)
        .set({ createdAt: new Date(Date.now() - 60_000 * (names.length - index)) })
        .where(eq(notifications.id, created.id));
    }
    const all = await service.listNotifications(db, bob);
    expect(all.items).toHaveLength(3);
    expect(all.items.map((n) => (n.payload as { poolName: string }).poolName)).toEqual([
      "three",
      "two",
      "one",
    ]);
    expect(all.unread).toBe(3);

    const capped = await service.listNotifications(db, bob, 2);
    expect(capped.items).toHaveLength(2);
    // The cap is on the rows, never on the count.
    expect(capped.unread).toBe(3);
  });

  it("never shows one account the notifications of another", async () => {
    const mine = await service.listNotifications(db, alice);
    expect(mine.items.every((n) => n.payload.kind === "pool_shared")).toBe(true);
    const ids = new Set(mine.items.map((n) => n.id));
    const theirs = await service.listNotifications(db, bob);
    expect(theirs.items.some((n) => ids.has(n.id))).toBe(false);
  });

  it("drops a row whose payload no longer parses instead of failing the list", async () => {
    const orphan = randomUUID();
    await db
      .insert(notifications)
      .values({ id: orphan, userId: alice, payload: { kind: "withdrawn_kind" } });
    const listed = await service.listNotifications(db, alice);
    expect(listed.items.map((n) => n.id)).not.toContain(orphan);
    // It is still counted as unread: the row exists, only its sentence is lost.
    // It carries no `poolId` either, so the dangling filter leaves it alone.
    expect(listed.unread).toBeGreaterThan(0);
    await db.delete(notifications).where(eq(notifications.id, orphan));
  });

  it("drops a notification whose pool was deleted, from the list AND from unread", async () => {
    const poolId = await seedPool("Pool éphémère");
    const created = await service.notify(db, alice, poolShared(poolId, "Pool éphémère"));
    const before = await service.listNotifications(db, alice);
    expect(before.items.map((n) => n.id)).toContain(created.id);

    await db.delete(pools).where(eq(pools.id, poolId));

    const after = await service.listNotifications(db, alice);
    // The bell would otherwise offer a row that opens on a 404.
    expect(after.items.map((n) => n.id)).not.toContain(created.id);
    expect(after.unread).toBe(before.unread - 1);
    // The row is still there; only the READ hides it. `deletePool` removes it.
    const [row] = await db.select().from(notifications).where(eq(notifications.id, created.id));
    expect(row).toBeDefined();
    await db.delete(notifications).where(eq(notifications.id, created.id));
  });
});

describe("dropPoolNotifications", () => {
  it("removes every row pointing at one pool and leaves the others standing", async () => {
    const doomed = await seedPool("Pool supprimé");
    const kept = await seedPool("Pool gardé");
    const a = await service.notify(db, alice, poolShared(doomed, "Pool supprimé"));
    const b = await service.notify(db, bob, poolShared(doomed, "Pool supprimé"));
    const c = await service.notify(db, alice, poolShared(kept, "Pool gardé"));

    expect(await service.dropPoolNotifications(db, doomed)).toBe(2);

    const gone = await db.select().from(notifications).where(eq(notifications.userId, alice));
    expect(gone.map((r) => r.id)).not.toContain(a.id);
    expect(gone.map((r) => r.id)).toContain(c.id);
    const bobs = await db.select().from(notifications).where(eq(notifications.id, b.id));
    expect(bobs).toHaveLength(0);
    // Nothing left: a second call is a no-op.
    expect(await service.dropPoolNotifications(db, doomed)).toBe(0);
  });
});

describe("marking read", () => {
  it("marks one, is idempotent, and ignores somebody else's row", async () => {
    const created = await service.notify(db, alice, await sharedPool("Électronique"));
    expect(await service.markRead(db, alice, created.id)).toBe(true);
    // Twice is a success: the button must not fail on a double click.
    expect(await service.markRead(db, alice, created.id)).toBe(true);
    // Ownership is part of the query (invariant 6), so Bob finds nothing.
    expect(await service.markRead(db, bob, created.id)).toBe(false);
    expect(await service.markRead(db, alice, randomUUID())).toBe(false);

    const [row] = await db.select().from(notifications).where(eq(notifications.id, created.id));
    expect(row!.readAt).not.toBeNull();
  });

  it("empties one inbox and leaves the other alone", async () => {
    const before = await service.listNotifications(db, bob);
    expect(before.unread).toBeGreaterThan(0);
    const cleared = await service.markAllRead(db, bob);
    expect(cleared).toBe(before.unread);
    expect((await service.listNotifications(db, bob)).unread).toBe(0);
    expect((await service.listNotifications(db, alice)).unread).toBeGreaterThan(0);
    // Nothing left to clear: the second call writes nothing.
    expect(await service.markAllRead(db, bob)).toBe(0);
  });
});
