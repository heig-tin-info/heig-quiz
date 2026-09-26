import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import type { NotificationPayload } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { notifications, pools, teamsLinks, users } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import type { JobQueue } from "../../jobs.js";
import { testDb } from "../../test/db.js";
import { deliver, type DeliveryDeps } from "./jobs.js";
import type { Mail } from "./mailer.js";
import { closeOutbox, NOTIFICATION_DELIVERY_QUEUE, openOutbox, type DeliveryJob } from "./outbox.js";
import * as service from "./service.js";
import type { TeamsClient, TeamsTarget } from "./teams.js";

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

/** `notify` when the bell is on, which every test of the inbox relies on. */
async function bell(...args: Parameters<typeof service.notify>) {
  const created = await service.notify(...args);
  if (!created) throw new Error("the bell is on by default: a row was expected");
  return created;
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
    const created = await bell(db, alice, await sharedPool("Programmation C"));
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
      const created = await bell(db, bob, await sharedPool(name));
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

  it("drops a notification whose pool was deleted, from the list AND from unread", async () => {
    const poolId = await seedPool("Pool éphémère");
    const created = await bell(db, alice, poolShared(poolId, "Pool éphémère"));
    const before = await service.listNotifications(db, alice);
    expect(before.items.map((n) => n.id)).toContain(created.id);

    await db.delete(pools).where(eq(pools.id, poolId));

    const after = await service.listNotifications(db, alice);
    // The bell would otherwise offer a row that opens on a 404.
    expect(after.items.map((n) => n.id)).not.toContain(created.id);
    expect(after.unread).toBe(before.unread - 1);
  });
});

describe("deleting a pool", () => {
  it("deletes every row pointing at it, through the foreign key, and leaves the others", async () => {
    const doomed = await seedPool("Pool supprimé");
    const kept = await seedPool("Pool gardé");
    const a = await bell(db, alice, poolShared(doomed, "Pool supprimé"));
    const b = await bell(db, bob, poolShared(doomed, "Pool supprimé"));
    const c = await bell(db, alice, poolShared(kept, "Pool gardé"));
    const [stored] = await db.select().from(notifications).where(eq(notifications.id, a.id));
    expect(stored!.poolId).toBe(doomed);

    await db.delete(pools).where(eq(pools.id, doomed));

    const alices = await db.select().from(notifications).where(eq(notifications.userId, alice));
    expect(alices.map((r) => r.id)).not.toContain(a.id);
    expect(alices.map((r) => r.id)).toContain(c.id);
    const bobs = await db.select().from(notifications).where(eq(notifications.id, b.id));
    expect(bobs).toHaveLength(0);
  });
});

describe("marking read", () => {
  it("marks one, is idempotent, and ignores somebody else's row", async () => {
    const created = await bell(db, alice, await sharedPool("Électronique"));
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

// --- Channels and preferences (ADR-030) -------------------------------------

/** A queue that only records what it was asked to send. */
function recordingQueue(failing = false) {
  const sent: { name: string; data: DeliveryJob }[] = [];
  const queue: JobQueue = {
    async createQueue() {},
    async send(name, data) {
      if (failing) throw new Error("queue down");
      sent.push({ name, data: data as unknown as DeliveryJob });
    },
    async work() {},
    async stop() {},
  };
  return { queue, sent };
}

const errors: unknown[] = [];
const log = { error: (obj: object) => void errors.push(obj), info: () => {} };

afterEach(() => {
  closeOutbox();
  errors.length = 0;
});

describe("preferences", () => {
  it("defaults to every channel on, and stores only the toggles moved", async () => {
    const carol = await seedUser("carol@heig.test");
    const fresh = await service.preferenceMatrix(db, carol);
    expect(fresh.results_released).toEqual({ bell: true, email: true, teams: true });
    expect(fresh.pool_shared).toEqual({ bell: true, email: true, teams: true });

    await service.setPreference(db, carol, { kind: "pool_shared", channel: "email", enabled: false });
    // Twice is one row: the toggle is idempotent.
    await service.setPreference(db, carol, { kind: "pool_shared", channel: "email", enabled: false });
    const moved = await service.preferenceMatrix(db, carol);
    expect(moved.pool_shared).toEqual({ bell: true, email: false, teams: true });
    expect(moved.pool_ownership.email).toBe(true);

    await service.setPreference(db, carol, { kind: "pool_shared", channel: "email", enabled: true });
    expect((await service.preferenceMatrix(db, carol)).pool_shared.email).toBe(true);
    // Somebody else's grid is untouched.
    expect((await service.preferenceMatrix(db, alice)).pool_shared.email).toBe(true);
  });

  it("reports the address and the Teams link, and hides a link when Teams is off", async () => {
    const dave = await seedUser("dave@heig.test");
    const none = await service.notificationSettings(db, dave, true);
    expect(none.email).toBe("dave@heig.test");
    expect(none.teams).toEqual({ available: true, linkedAt: null });

    await service.linkTeams(db, dave, { tenantId: "t1", objectId: "o1" }, new Date("2026-09-01T10:00:00Z"));
    const linked = await service.notificationSettings(db, dave, true);
    expect(linked.teams.linkedAt).toBe("2026-09-01T10:00:00.000Z");
    expect((await service.notificationSettings(db, dave, false)).teams).toEqual({
      available: false,
      linkedAt: null,
    });

    expect(await service.unlinkTeams(db, dave)).toBe(true);
    expect(await service.unlinkTeams(db, dave)).toBe(false);
    expect(await service.teamsLinkOf(db, dave)).toBeNull();
  });

  it("forgets the cached chat when the account links another identity", async () => {
    const erin = await seedUser("erin@heig.test");
    await service.linkTeams(db, erin, { tenantId: "t1", objectId: "o1" }, new Date());
    await service.rememberTeamsChat(db, erin, "o1", "19:chat");
    expect((await service.teamsLinkOf(db, erin))!.chatId).toBe("19:chat");
    // A chat found for a previous identity is not written onto the new one.
    await service.linkTeams(db, erin, { tenantId: "t2", objectId: "o2" }, new Date());
    await service.rememberTeamsChat(db, erin, "o1", "19:stale");
    expect((await service.teamsLinkOf(db, erin))!.chatId).toBeNull();
  });
});

describe("notify fans out", () => {
  it("writes no bell row when the bell is off for that kind", async () => {
    const frank = await seedUser("frank@heig.test");
    await service.setPreference(db, frank, { kind: "pool_shared", channel: "bell", enabled: false });
    expect(await service.notify(db, frank, await sharedPool("Sans cloche"))).toBeNull();
    expect((await service.listNotifications(db, frank)).items).toHaveLength(0);
  });

  it("enqueues nothing while the outbox is closed (no queue: never sent inline)", async () => {
    const { sent } = recordingQueue();
    await bell(db, alice, await sharedPool("Sans file"));
    expect(sent).toHaveLength(0);
  });

  it("enqueues one job per external channel chosen, Teams only once linked", async () => {
    const grace = await seedUser("grace@heig.test");
    const { queue, sent } = recordingQueue();
    openOutbox({ queue, teams: true, log });

    const payload = await sharedPool("Réseaux");
    await bell(db, grace, payload);
    expect(sent.map((j) => [j.name, j.data.channel])).toEqual([[NOTIFICATION_DELIVERY_QUEUE, "email"]]);
    expect(sent[0]!.data).toEqual({ userId: grace, channel: "email", payload });

    sent.length = 0;
    await service.linkTeams(db, grace, { tenantId: "t", objectId: "o" }, new Date());
    await bell(db, grace, payload);
    expect(sent.map((j) => j.data.channel)).toEqual(["email", "teams"]);

    sent.length = 0;
    await service.setPreference(db, grace, { kind: "pool_shared", channel: "email", enabled: false });
    await bell(db, grace, payload);
    expect(sent.map((j) => j.data.channel)).toEqual(["teams"]);
  });

  it("sends no Teams job when the platform has no Teams application", async () => {
    const heidi = await seedUser("heidi@heig.test");
    await service.linkTeams(db, heidi, { tenantId: "t", objectId: "o" }, new Date());
    const { queue, sent } = recordingQueue();
    openOutbox({ queue, teams: false, log });
    await bell(db, heidi, await sharedPool("Sans Teams"));
    expect(sent.map((j) => j.data.channel)).toEqual(["email"]);
  });

  it("never breaks the caller when the queue fails: the bell row still stands", async () => {
    const ivan = await seedUser("ivan@heig.test");
    const { queue } = recordingQueue(true);
    openOutbox({ queue, teams: true, log });
    const created = await bell(db, ivan, await sharedPool("File en panne"));
    expect(created.readAt).toBeNull();
    expect(errors).toHaveLength(1);
  });
});

describe("the delivery job", () => {
  function fakes() {
    const mails: Mail[] = [];
    const posts: { target: TeamsTarget; html: string }[] = [];
    const teams: TeamsClient = {
      beginLink: () => {
        throw new Error("not in a job");
      },
      completeLink: () => Promise.reject(new Error("not in a job")),
      async send(target, html) {
        posts.push({ target, html });
        return { chatId: "19:found" };
      },
    };
    const deps: DeliveryDeps = {
      db,
      webUrl: "https://quiz.test",
      mailer: {
        async send(mail) {
          mails.push(mail);
          return "dry_run";
        },
      },
      teams,
      log: { info: () => {} },
    };
    return { deps, mails, posts };
  }

  const released = (title: string): NotificationPayload => ({
    kind: "results_released",
    evaluationId: randomUUID(),
    evaluationTitle: title,
    attemptId: "00000000-0000-4000-8000-000000000001",
  });

  it("mails the account's address in the account's language", async () => {
    const judy = await seedUser("judy@heig.test");
    await db.update(users).set({ locale: "fr" }).where(eq(users.id, judy));
    const { deps, mails } = fakes();
    await deliver(deps, { userId: judy, channel: "email", payload: released("Test <1>") });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("judy@heig.test");
    expect(mails[0]!.subject).toBe("Résultats disponibles : Test <1>");
    expect(mails[0]!.html).toContain("Test &lt;1&gt;");
    expect(mails[0]!.html).toContain(
      "https://quiz.test/attempts/00000000-0000-4000-8000-000000000001/feedback",
    );
  });

  it("posts to Teams, caches the chat, and does nothing once unlinked", async () => {
    const ken = await seedUser("ken@heig.test");
    await service.linkTeams(db, ken, { tenantId: "t", objectId: "o-ken" }, new Date());
    const { deps, posts } = fakes();
    await deliver(deps, { userId: ken, channel: "teams", payload: released("Labo") });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.target).toMatchObject({ tenantId: "t", objectId: "o-ken", chatId: null });
    expect(posts[0]!.html).toContain("Labo");
    expect((await db.select().from(teamsLinks).where(eq(teamsLinks.userId, ken)))[0]!.chatId).toBe(
      "19:found",
    );

    await service.unlinkTeams(db, ken);
    await deliver(deps, { userId: ken, channel: "teams", payload: released("Labo") });
    expect(posts).toHaveLength(1);
  });

  it("drops a delivery for an account that is gone or anonymized", async () => {
    const { deps, mails } = fakes();
    await deliver(deps, { userId: randomUUID(), channel: "email", payload: released("X") });
    const leo = await seedUser("leo@heig.test");
    await db.update(users).set({ anonymizedAt: new Date() }).where(eq(users.id, leo));
    await deliver(deps, { userId: leo, channel: "email", payload: released("X") });
    expect(mails).toHaveLength(0);
  });

  it("lets a transport failure through, so the queue retries it", async () => {
    const mia = await seedUser("mia@heig.test");
    const { deps } = fakes();
    deps.mailer = { send: () => Promise.reject(new Error("Scaleway TEM 503")) };
    await expect(
      deliver(deps, { userId: mia, channel: "email", payload: released("X") }),
    ).rejects.toThrow("503");
  });
});
