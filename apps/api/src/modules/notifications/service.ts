/**
 * The bell: persistent, per-account notifications (F-POOL-05).
 *
 * `notify` is the ONE way a row is written. Every other module calls it and
 * never inserts into `notifications` itself, so the refresh hint on the
 * recipient's own topic can never be forgotten — the row without the hint is
 * a notification nobody sees until their next reload.
 *
 * The stream carries NO data (ADR-005): a `notifications` hint on
 * `user:<id>`, and the client re-reads `GET /app/api/notifications` with its
 * own session. A notification is therefore never a channel for content.
 */
import { randomUUID } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { NotificationPayload, type Notification, type NotificationList } from "@quiz/contracts";

import type { Db } from "../../db/client.js";
import { notifications } from "../../db/schema.js";
import { hint, userTopic } from "../realtime/bus.js";

const DEFAULT_LIMIT = 30;

type NotificationRow = typeof notifications.$inferSelect;

/**
 * Stores one notification and tells its recipient to re-read the inbox.
 *
 * The payload is parsed on the way IN as well as on the way out: a caller
 * that builds one by hand cannot write a shape the list would then refuse.
 */
export async function notify(
  db: Db,
  userId: string,
  payload: NotificationPayload,
): Promise<Notification> {
  const parsed = NotificationPayload.parse(payload);
  const [row] = await db
    .insert(notifications)
    .values({ id: randomUUID(), userId, poolId: parsed.poolId, payload: parsed })
    .returning();
  hint("notifications", [userTopic(userId)]);
  return notificationJson(row!);
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
 * A bell never points at a deleted pool: `pool_id` cascades.
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
