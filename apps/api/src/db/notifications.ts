/**
 * Persistent, per-account notifications — the bell (F-POOL-05). Owned by the
 * `notifications` module; every other module writes one through
 * `modules/notifications/service.ts` (`notify`), never by an insert of its
 * own.
 *
 * A row is a FACT, not a message: it survives a reload, unlike the SSE toast
 * of `events.ts`. The stream only carries a `notifications` hint, and the
 * client re-reads its own inbox (ADR-005).
 */
import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { pools } from "./pool.js";

/**
 * `payload` is a `NotificationPayload` of `@quiz/contracts`, a discriminated
 * union on `kind`: the sentence is rendered by the web app, so a new kind
 * needs no migration. It is parsed on the way out (`notificationJson`), so a
 * payload written by an older version can never break the list.
 *
 * `pool_id` is the payload's `poolId`, lifted into a column so the relation
 * is a foreign key: deleting a pool deletes the bells that point at it, and
 * no reader is ever walked to a 404. Null for a kind that names no pool.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    poolId: uuid("pool_id").references(() => pools.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** null = unread; the count of the bell is a count of nulls. */
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt),
    index("notifications_pool_idx").on(t.poolId),
  ],
);
