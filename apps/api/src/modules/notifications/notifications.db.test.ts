import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CHANNEL_ENABLED, type NotificationPayload } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { classrooms, courses, notifications, pools, teamsLinks, users } from "../../db/schema.js";
import { subscribe } from "../../events.js";
import type { JobQueue } from "../../jobs.js";
import { testDb } from "../../test/db.js";
import { deliver, type DeliveryDeps } from "./jobs.js";
import type { Mail } from "./mailer.js";
import { closeOutbox, NOTIFICATION_DELIVERY_QUEUE, openOutbox, type DeliveryJob } from "./outbox.js";
import * as service from "./service.js";
import {
  TeamsError,
  type ActivityNotification,
  type TeamsClient,
  type TeamsRecipient,
} from "./teams.js";

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

/** A real classroom (and its course) for the kinds folded per classroom. */
async function seedClassroom(name: string): Promise<{ classroomId: string; classroomName: string }> {
  const courseId = randomUUID();
  const classroomId = randomUUID();
  await db.insert(courses).values({ id: courseId, name, code: `C-${courseId.slice(0, 8)}` });
  await db.insert(classrooms).values({ id: classroomId, courseId, name });
  return { classroomId, classroomName: name };
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

/** A Teams link as the link page writes it; the flow itself is `teams.db.test.ts`'s. */
async function linkTeams(userId: string, linkedAt = new Date()) {
  await db.insert(teamsLinks).values({
    userId,
    tenantId: "t",
    aadObjectId: `o-${userId}`,
    teamsName: "Léa Teams",
    teamsUsername: "lea@heig-vd.ch",
    linkedAt,
  });
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
  db = await testDb();
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

/**
 * ADR-030 §e: a folded kind keeps ONE unread entry per recipient and
 * classroom. The next event bumps its count and refreshes its `created_at`
 * (so the client toasts it again); once read, the next one starts afresh.
 */
describe("a folded kind", () => {
  const unreadOf = async (userId: string, classroomId: string) =>
    (await db.select().from(notifications).where(eq(notifications.userId, userId))).filter(
      (r) => r.classroomId === classroomId && r.readAt === null,
    );
  // Accounts of their own: the inbox tests below count ann's and ben's rows.
  let ann: string;
  let ben: string;
  beforeAll(async () => {
    ann = await seedUser("ann@heig.test");
    ben = await seedUser("ben@heig.test");
  });

  it("folds two events into one unread entry that counts both, under the same id", async () => {
    const room = await seedClassroom("PRG1-A");
    const joined = { kind: "student_joined", ...room, count: 1 } as const;
    const first = await bell(db, ann, joined);
    await new Promise((r) => setTimeout(r, 5));
    const second = await bell(db, ann, { ...joined, classroomName: "PRG1-A (renamed)" });

    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ ...joined, classroomName: "PRG1-A (renamed)", count: 2 });
    expect(Date.parse(second.createdAt)).toBeGreaterThan(Date.parse(first.createdAt));
    expect(await unreadOf(ann, room.classroomId)).toHaveLength(1);
    // A count of several (a claim pass flagging three lines) adds all of them.
    const conflict = { kind: "roster_conflict", ...room, count: 3 } as const;
    await bell(db, ann, conflict);
    const both = await bell(db, ann, conflict);
    expect(both.payload).toMatchObject({ kind: "roster_conflict", count: 6 });
    // Kinds fold apart, and so do recipients and classrooms.
    expect(await unreadOf(ann, room.classroomId)).toHaveLength(2);
    expect((await bell(db, ben, joined)).payload).toMatchObject({ count: 1 });
    const other = await seedClassroom("PRG1-B");
    expect((await bell(db, ann, { ...joined, ...other })).payload).toMatchObject({ count: 1 });
  });

  it("starts a new entry once the folded one is read", async () => {
    const room = await seedClassroom("PRG2-A");
    const joined = { kind: "student_joined", ...room, count: 1 } as const;
    const first = await bell(db, ann, joined);
    await bell(db, ann, joined);
    expect(await service.markRead(db, ann, first.id)).toBe(true);

    const fresh = await bell(db, ann, joined);
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.payload).toMatchObject({ count: 1 });
    const rows = await db.select().from(notifications).where(eq(notifications.classroomId, room.classroomId));
    expect(rows.map((r) => [(r.payload as { count: number }).count, r.readAt === null]).sort()).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("never duplicates the unread entry under concurrent events", async () => {
    const room = await seedClassroom("PRG3-A");
    const joined = { kind: "student_joined", ...room, count: 1 } as const;
    const created = await Promise.all(Array.from({ length: 8 }, () => service.notify(db, ann, joined)));
    expect(new Set(created.map((c) => c!.id)).size).toBe(1);
    const unread = await unreadOf(ann, room.classroomId);
    expect(unread).toHaveLength(1);
    expect(unread[0]!.payload).toMatchObject({ count: 8 });
  });

  it("goes with its classroom: the foreign key cascades", async () => {
    const room = await seedClassroom("PRG4-A");
    await bell(db, ann, { kind: "roster_conflict", ...room, count: 1 });
    await db.delete(classrooms).where(eq(classrooms.id, room.classroomId));
    expect(await unreadOf(ann, room.classroomId)).toEqual([]);
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

  it("fills an untouched kind with ITS OWN default, not a global one", async () => {
    const erin = await seedUser("erin@heig.test");
    expect(await service.preferenceMatrix(db, erin)).toEqual(DEFAULT_CHANNEL_ENABLED);

    // A background-noise kind (#198): in the app only, while its neighbours
    // are on everywhere. A moved toggle still wins over that default, and the
    // other kinds keep theirs.
    const grid = await service.preferenceMatrix(db, erin);
    expect(grid.student_joined).toEqual({ bell: true, email: false, teams: false });
    expect(grid.roster_conflict).toEqual({ bell: true, email: true, teams: true });
    expect(grid.pool_shared).toEqual({ bell: true, email: true, teams: true });

    await service.setPreference(db, erin, { kind: "student_joined", channel: "teams", enabled: true });
    expect((await service.preferenceMatrix(db, erin)).student_joined).toEqual({
      bell: true,
      email: false,
      teams: true,
    });
  });

  it("reports the address and the Teams link, and hides a link when Teams is off", async () => {
    const dave = await seedUser("dave@heig.test");
    const none = await service.notificationSettings(db, dave, true);
    expect(none.email).toBe("dave@heig.test");
    expect(none.teams).toEqual({ available: true, linkedAt: null, teamsName: null, teamsUsername: null });

    await linkTeams(dave, new Date("2026-09-01T10:00:00Z"));
    const linked = await service.notificationSettings(db, dave, true);
    expect(linked.teams).toEqual({
      available: true,
      linkedAt: "2026-09-01T10:00:00.000Z",
      teamsName: "Léa Teams",
      teamsUsername: "lea@heig-vd.ch",
    });
    expect((await service.notificationSettings(db, dave, false)).teams).toEqual({
      available: false,
      linkedAt: null,
      teamsName: null,
      teamsUsername: null,
    });

    // A link made before the username was recorded: unknown, so null.
    await db.update(teamsLinks).set({ teamsUsername: "" }).where(eq(teamsLinks.userId, dave));
    expect((await service.notificationSettings(db, dave, true)).teams.teamsUsername).toBeNull();

    expect(await service.unlinkTeams(db, { userId: dave })).toBe(dave);
    expect(await service.unlinkTeams(db, { userId: dave })).toBeNull();
    expect(await service.teamsLinkOf(db, { userId: dave })).toBeNull();
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
    await linkTeams(grace);
    await bell(db, grace, payload);
    expect(sent.map((j) => j.data.channel)).toEqual(["email", "teams"]);

    sent.length = 0;
    await service.setPreference(db, grace, { kind: "pool_shared", channel: "email", enabled: false });
    await bell(db, grace, payload);
    expect(sent.map((j) => j.data.channel)).toEqual(["teams"]);
  });

  it("sends on the channels of the kind's own default when nothing was moved", async () => {
    const iris = await seedUser("iris@heig.test");
    await linkTeams(iris);
    const { queue, sent } = recordingQueue();
    openOutbox({ queue, teams: true, log });
    const joined = { kind: "student_joined", ...(await seedClassroom("Défauts")), count: 1 } as const;

    // Off by default outside the app: a bell row, no job at all.
    await bell(db, iris, joined);
    expect(sent).toHaveLength(0);
    // Another kind keeps its own default: both jobs.
    await bell(db, iris, await sharedPool("Défauts"));
    expect(sent.map((j) => j.data.channel)).toEqual(["email", "teams"]);
  });

  it("sends no Teams job when the platform has no Teams application", async () => {
    const heidi = await seedUser("heidi@heig.test");
    await linkTeams(heidi);
    const { queue, sent } = recordingQueue();
    openOutbox({ queue, teams: false, log });
    await bell(db, heidi, await sharedPool("Sans Teams"));
    expect(sent.map((j) => j.data.channel)).toEqual(["email"]);
  });

  it("delivers to many at once exactly as notify would to each", async () => {
    const [judy, karl, lena] = [
      await seedUser("judy@heig.test"),
      await seedUser("karl@heig.test"),
      await seedUser("lena@heig.test"),
    ];
    await service.setPreference(db, karl, { kind: "pool_shared", channel: "bell", enabled: false });
    await service.setPreference(db, lena, { kind: "pool_shared", channel: "email", enabled: false });
    // A preference on ANOTHER kind changes nothing here.
    await service.setPreference(db, judy, { kind: "pool_ownership", channel: "email", enabled: false });
    await linkTeams(lena);
    const { queue, sent } = recordingQueue();
    openOutbox({ queue, teams: true, log });
    const hints: string[][] = [];
    const off = subscribe((e) => {
      if (e.kind === "hint") hints.push(e.topics);
    });
    const payload = await sharedPool("Toute la classe");
    const created = await service.notifyMany(
      db,
      [judy, karl, lena].map((userId) => ({ userId, payload })),
    );
    off();

    expect(created.map((c) => c?.payload ?? null)).toEqual([payload, null, payload]);
    expect(hints).toEqual([[`user:${judy}`], [`user:${lena}`]]);
    expect(sent.map((j) => [j.data.userId, j.data.channel])).toEqual([
      [judy, "email"],
      [karl, "email"],
      [lena, "teams"],
    ]);
    for (const [userId, rows] of [
      [judy, 1],
      [karl, 0],
      [lena, 1],
    ] as const) {
      expect((await service.listNotifications(db, userId)).items).toHaveLength(rows);
    }
    expect(await service.notifyMany(db, [])).toEqual([]);
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
    const posts: { to: TeamsRecipient; activity: ActivityNotification }[] = [];
    const warnings: object[] = [];
    let refuse: number | null = null;
    const teams: TeamsClient = {
      async notify(to, activity) {
        if (refuse) throw new TeamsError(`refused ${refuse}`, refuse, "Forbidden");
        posts.push({ to, activity });
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
      teamsAppId: "app-id",
      tenants: [] as string[],
      log: { info: () => {}, warn: (obj: object) => void warnings.push(obj) },
    };
    return { deps, mails, posts, warnings, refuseWith: (status: number) => (refuse = status) };
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

  it("notifies the linked Teams account in its feed, in the account's language, and nothing once unlinked", async () => {
    const ken = await seedUser("ken@heig.test");
    await db.update(users).set({ locale: "fr" }).where(eq(users.id, ken));
    await linkTeams(ken);
    const { deps, posts } = fakes();
    await deliver(deps, { userId: ken, channel: "teams", payload: released("Labo") });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.to).toEqual({ tenantId: "t", aadObjectId: `o-${ken}` });
    expect(posts[0]!.activity).toMatchObject({
      topic: "Labo",
      activityType: "resultsReleased",
      previewText: "Les résultats de « Labo » sont disponibles.",
      templateParameters: { evaluationTitle: "Labo" },
    });
    expect(posts[0]!.activity.webUrl).toMatch(/^https:\/\/teams\.microsoft\.com\/l\/entity\/app-id\/home\?context=/);

    await service.unlinkTeams(db, { userId: ken });
    await deliver(deps, { userId: ken, channel: "teams", payload: released("Labo") });
    expect(posts).toHaveLength(1);
  });

  it("sends nothing to a link whose tenant was removed from the allowed list", async () => {
    const olga = await seedUser("olga@heig.test");
    await linkTeams(olga);
    const { deps, posts, warnings } = fakes();
    deps.tenants = ["another-tenant"];
    await expect(deliver(deps, { userId: olga, channel: "teams", payload: released("X") })).resolves.toBeUndefined();
    expect(posts).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    deps.tenants = ["another-tenant", "t"];
    await deliver(deps, { userId: olga, channel: "teams", payload: released("X") });
    expect(posts).toHaveLength(1);
  });

  it("drops a delivery Graph refuses for good (403, 404), keeps the link, and retries the rest", async () => {
    const nina = await seedUser("nina@heig.test");
    await linkTeams(nina);
    for (const status of [403, 404]) {
      const { deps, warnings, refuseWith } = fakes();
      refuseWith(status);
      await expect(deliver(deps, { userId: nina, channel: "teams", payload: released("X") })).resolves.toBeUndefined();
      expect(warnings).toEqual([expect.objectContaining({ status, code: "Forbidden" })]);
    }
    expect(await service.teamsLinkOf(db, { userId: nina })).not.toBeNull();
    const { deps, refuseWith } = fakes();
    refuseWith(502);
    await expect(deliver(deps, { userId: nina, channel: "teams", payload: released("X") })).rejects.toThrow("502");
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
