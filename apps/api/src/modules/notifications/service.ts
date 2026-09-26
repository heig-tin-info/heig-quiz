/**
 * Notifications: the bell (F-POOL-05) and the channels that leave the
 * platform, e-mail and Microsoft Teams (ADR-030).
 *
 * `notify` is the ONE entry. Every other module calls it and never inserts
 * into `notifications` itself, nor enqueues a delivery of its own. For each
 * channel the recipient's preference decides (`notification_preferences`,
 * sparse, defaults of `DEFAULT_CHANNEL_ENABLED`):
 *
 *  - the bell: a row, and the refresh hint on the recipient's own topic — the
 *    row without the hint is a notification nobody sees until their reload;
 *  - e-mail and Teams: a JOB each (`outbox.ts`), never a send inline, so a
 *    slow or failing provider can neither delay nor break the caller.
 *
 * The stream carries NO data (ADR-005): a `notifications` hint on
 * `user:<id>`, and the client re-reads `GET /app/api/notifications` with its
 * own session. A notification is therefore never a channel for content.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import {
  DEFAULT_CHANNEL_ENABLED,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  NotificationPayload,
  type Notification,
  type NotificationChannel,
  type NotificationKind,
  type NotificationList,
  type NotificationMatrix,
  type NotificationPreferencePut,
  type NotificationSettings,
} from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { notificationPreferences, notifications, teamsLinks, users } from "../../db/schema.js";
import { hint, userTopic } from "../realtime/bus.js";
import { enqueueDeliveries, teamsOpen, type ExternalChannel } from "./outbox.js";

const DEFAULT_LIMIT = 30;

type NotificationRow = typeof notifications.$inferSelect;

/** The channels one user wants for one kind, defaults filled in. */
async function channelsFor(
  db: Db,
  userId: string,
  kind: NotificationKind,
): Promise<Record<NotificationChannel, boolean>> {
  const rows = await db
    .select({ channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.kind, kind)));
  const out = { ...DEFAULT_CHANNEL_ENABLED };
  for (const row of rows) out[row.channel] = row.enabled;
  return out;
}

/**
 * Delivers one notification to one account, on every channel it chose.
 *
 * The payload is parsed on the way IN as well as on the way out: a caller
 * that builds one by hand cannot write a shape the list would then refuse.
 *
 * Returns the bell row, or null when the user turned the bell off for this
 * kind: then no row is written at all — a row they asked not to see would
 * still count in the badge.
 *
 * Call it AFTER the write it announces has committed, never inside a
 * transaction: the jobs it enqueues live in their own connection and would
 * survive a rollback.
 */
export async function notify(
  db: Db,
  userId: string,
  payload: NotificationPayload,
): Promise<Notification | null> {
  const parsed = NotificationPayload.parse(payload);
  const wanted = await channelsFor(db, userId, parsed.kind);

  let created: Notification | null = null;
  if (wanted.bell) {
    const [row] = await db
      .insert(notifications)
      .values({
        id: randomUUID(),
        userId,
        poolId: "poolId" in parsed ? parsed.poolId : null,
        evaluationId: "evaluationId" in parsed ? parsed.evaluationId : null,
        payload: parsed,
      })
      .returning();
    hint("notifications", [userTopic(userId)]);
    created = notificationJson(row!);
  }

  const external: ExternalChannel[] = [];
  if (wanted.email) external.push("email");
  // A Teams job needs a link; without one it would only be dropped later.
  if (wanted.teams && teamsOpen() && (await teamsLinkOf(db, userId))) external.push("teams");
  if (external.length > 0) await enqueueDeliveries(userId, parsed, external);
  return created;
}

/**
 * A stored payload that no longer parses (an older shape, a kind that was
 * withdrawn) is DROPPED from the list rather than failing it: the bell of a
 * whole account must not break because one row aged badly.
 */
function notificationJson(row: NotificationRow): Notification {
  return {
    id: row.id,
    payload: NotificationPayload.parse(row.payload),
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

/**
 * `GET /notifications`: newest first, capped, `unread` over the whole inbox.
 * A bell never points at a deleted pool or evaluation: both foreign keys
 * cascade.
 */
export async function listNotifications(
  db: Db,
  userId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<NotificationList> {
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
  ]);
  const items: Notification[] = [];
  for (const row of rows) {
    try {
      items.push(notificationJson(row));
    } catch {
      continue;
    }
  }
  return { items, unread: counted?.n ?? 0 };
}

/**
 * Marks one notification read. Ownership is part of the UPDATE (invariant 6):
 * a row belonging to somebody else is not found, never checked afterwards.
 * Already read is a success — the button is idempotent.
 */
export async function markRead(db: Db, userId: string, id: string): Promise<boolean> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.id, id),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
    .returning({ id: notifications.id });
  if (updated.length > 0) return true;
  const [existing] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
    .limit(1);
  return existing !== undefined;
}

/** Empties the bell in one statement; returns how many rows it cleared. */
export async function markAllRead(db: Db, userId: string): Promise<number> {
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return updated.length;
}

/**
 * A release withdrawn (`results.unreleaseResults`): the bells that announced
 * it go, since the page they open no longer shows anything. An e-mail or a
 * Teams message already sent cannot be taken back, and is not pretended to.
 */
export async function withdrawResultsReleased(db: Db, evaluationId: string): Promise<number> {
  const deleted = await db
    .delete(notifications)
    .where(
      and(
        eq(notifications.evaluationId, evaluationId),
        sql`${notifications.payload}->>'kind' = 'results_released'`,
      ),
    )
    .returning({ userId: notifications.userId });
  const topics = [...new Set(deleted.map((d) => userTopic(d.userId)))];
  if (topics.length > 0) hint("notifications", topics);
  return deleted.length;
}

// --- Preferences (ADR-030) -----------------------------------------------

/** The whole grid of one user: every kind × every channel, defaults filled in. */
export async function preferenceMatrix(db: Db, userId: string): Promise<NotificationMatrix> {
  const rows = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId));
  const matrix = Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [kind, { ...DEFAULT_CHANNEL_ENABLED }]),
  ) as NotificationMatrix;
  for (const row of rows) {
    // A row of a kind or channel that was withdrawn is ignored.
    if (!NOTIFICATION_KINDS.includes(row.kind) || !NOTIFICATION_CHANNELS.includes(row.channel)) continue;
    matrix[row.kind][row.channel] = row.enabled;
  }
  return matrix;
}

/** One toggle of the grid; idempotent. */
export async function setPreference(
  db: Db,
  userId: string,
  pref: NotificationPreferencePut,
): Promise<void> {
  await db
    .insert(notificationPreferences)
    .values({ userId, kind: pref.kind, channel: pref.channel, enabled: pref.enabled })
    .onConflictDoUpdate({
      target: [
        notificationPreferences.userId,
        notificationPreferences.kind,
        notificationPreferences.channel,
      ],
      set: { enabled: pref.enabled, updatedAt: new Date() },
    });
}

/** `GET /notifications/settings`: the grid, the address, the Teams link. */
export async function notificationSettings(
  db: Db,
  userId: string,
  teamsAvailable: boolean,
): Promise<NotificationSettings> {
  const [matrix, link, [user]] = await Promise.all([
    preferenceMatrix(db, userId),
    teamsLinkOf(db, userId),
    db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
  ]);
  return {
    matrix,
    email: user?.email ?? "",
    teams: {
      available: teamsAvailable,
      // A link made while Teams was configured means nothing once it is not.
      linkedAt: teamsAvailable && link ? link.linkedAt.toISOString() : null,
    },
  };
}

// --- The Teams link (ADR-030) ----------------------------------------------

export type TeamsLink = typeof teamsLinks.$inferSelect;

export async function teamsLinkOf(db: Db, userId: string): Promise<TeamsLink | null> {
  const [row] = await db.select().from(teamsLinks).where(eq(teamsLinks.userId, userId)).limit(1);
  return row ?? null;
}

/**
 * Links (or re-links) an account to a Microsoft identity. A new identity
 * forgets the cached chat, which belonged to the previous one.
 */
export async function linkTeams(
  db: Db,
  userId: string,
  identity: { tenantId: string; objectId: string },
  now: Date,
): Promise<TeamsLink> {
  const [row] = await db
    .insert(teamsLinks)
    .values({ userId, ...identity, chatId: null, linkedAt: now })
    .onConflictDoUpdate({
      target: teamsLinks.userId,
      set: { ...identity, chatId: null, linkedAt: now },
    })
    .returning();
  return row!;
}

/** Forgets the link; false when there was none. */
export async function unlinkTeams(db: Db, userId: string): Promise<boolean> {
  const deleted = await db
    .delete(teamsLinks)
    .where(eq(teamsLinks.userId, userId))
    .returning({ userId: teamsLinks.userId });
  return deleted.length > 0;
}

/**
 * Caches the chat a delivery found — for THAT identity only: a link replaced
 * while the job ran keeps its own (null) chat.
 */
export async function rememberTeamsChat(
  db: Db,
  userId: string,
  objectId: string,
  chatId: string,
): Promise<void> {
  await db
    .update(teamsLinks)
    .set({ chatId })
    .where(and(eq(teamsLinks.userId, userId), eq(teamsLinks.objectId, objectId)));
}
