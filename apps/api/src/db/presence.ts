/**
 * The platform's activity (ADR-107), owned by the `presence` module
 * (`modules/presence/`), which alone writes both tables. The administrator
 * reads `presence_hours` aggregated only, and `presence_last_seen` per
 * account in the list of accounts, never on a roster.
 */
import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth.js";

/**
 * One row per person and hour (`hour`, truncated to the hour on the server's
 * clock) in which a request of their own session reached the server. Kept
 * eight days (`presence.purge`, N-DATA-03).
 */
export const presenceHours = pgTable(
  "presence_hours",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.hour] }), index("presence_hours_hour_idx").on(t.hour)],
);

/**
 * A person's last activity: the server's time of their own session's last
 * request, to the flush of the recorder (a few seconds), only ever moved
 * forward. Lives with the account.
 */
export const presenceLastSeen = pgTable(
  "presence_last_seen",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
  },
  (t) => [index("presence_last_seen_at_idx").on(t.at)],
);
