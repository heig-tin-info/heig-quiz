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

/**
 * `payload` is a `NotificationPayload` of `@quiz/contracts`, a discriminated
 * union on `kind`: the sentence is rendered by the web app, so a new kind
 * needs no migration. It is parsed on the way out (`notificationJson`), so a
 * payload written by an older version can never break the list.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** null = unread; the count of the bell is a count of nulls. */
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);
