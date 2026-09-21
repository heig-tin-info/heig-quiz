import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "../../db/client.js";
import { notifications, users } from "../../db/schema.js";
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

function poolShared(name: string) {
  return {
    kind: "pool_shared",
    poolId: randomUUID(),
    poolName: name,
    role: "reader",
    byName: "Prof Démo",
  } as const;
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
    const created = await service.notify(db, alice, poolShared("Programmation C"));
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
      const created = await service.notify(db, bob, poolShared(name));
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
    expect(listed.unread).toBeGreaterThan(0);
    await db.delete(notifications).where(eq(notifications.id, orphan));
  });
});

describe("marking read", () => {
  it("marks one, is idempotent, and ignores somebody else's row", async () => {
    const created = await service.notify(db, alice, poolShared("Électronique"));
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
