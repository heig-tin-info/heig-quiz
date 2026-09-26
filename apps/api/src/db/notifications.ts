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
  boolean,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS } from "@quiz/contracts";

import { users } from "./auth.js";
import { evaluations } from "./evaluation.js";
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
    /** Same rule for a kind about an evaluation (`results_released`). */
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** null = unread; the count of the bell is a count of nulls. */
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt),
    index("notifications_pool_idx").on(t.poolId),
    index("notifications_evaluation_idx").on(t.evaluationId),
  ],
);

/**
 * The channels a user chose, per kind (ADR-030). SPARSE: a row exists only
 * for a toggle the user actually moved, and a missing row means the default
 * of `DEFAULT_CHANNEL_ENABLED` — so a kind added later reaches everyone
 * without a backfill, and "back to the defaults" is a DELETE.
 *
 * A row for a kind that was withdrawn is ignored when read, never an error.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    channel: text("channel", { enum: NOTIFICATION_CHANNELS }).notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.channel] })],
);

/**
 * An account's Microsoft Teams link (ADR-030): who this user is in Entra ID,
 * learned once by an OpenID sign-in at Microsoft. No Microsoft token is kept
 * — a delivery uses the application's own credentials for `tenant_id`.
 *
 * `chat_id` is the one-to-one chat between the user and the bot, cached by
 * the first delivery that found it; null until then, and replaced when a send
 * finds the cached chat gone and looks it up again.
 */
export const teamsLinks = pgTable("teams_links", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  /** The Entra object id (`oid`) of the user in that tenant. */
  objectId: text("object_id").notNull(),
  chatId: text("chat_id"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
});
