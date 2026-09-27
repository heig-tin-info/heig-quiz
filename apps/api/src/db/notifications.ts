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
  uniqueIndex,
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
 * An account's Microsoft Teams link (ADR-030): the one-to-one chat between
 * the person and the HEIG Quiz bot, learned when they clicked the link card
 * the bot posted there and confirmed it while signed in to the platform. No
 * Microsoft token is kept — a delivery uses the bot's own credentials.
 *
 * One chat per account (the primary key) and one account per chat (the
 * unique conversation): linking a chat already linked elsewhere MOVES it.
 * `service_url` is where Bot Connector told the bot to answer that chat; it
 * is checked against the allowlist again before every send.
 */
export const teamsLinks = pgTable(
  "teams_links",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Entra tenant of the Teams account (`channelData.tenant.id`). */
    tenantId: text("tenant_id").notNull(),
    /** The Entra object id of the person in that tenant (`from.aadObjectId`). */
    aadObjectId: text("aad_object_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    serviceUrl: text("service_url").notNull(),
    /** The display name Teams gave for the person, shown in the settings. */
    teamsName: text("teams_name").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("teams_links_conversation_idx").on(t.conversationId)],
);

/**
 * A pending link, minted by the bot when it posts its link card (ADR-030).
 * The URL carries a random secret; only its SHA-256 is stored, the way a
 * session id is (`sessions.sid_hash`), so reading this table links nothing.
 * Single use: `consumed_at` is set in the transaction that writes the link.
 * Fifteen minutes to live; expired rows are pruned whenever a new one is made.
 */
export const teamsLinkTokens = pgTable(
  "teams_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    serviceUrl: text("service_url").notNull(),
    tenantId: text("tenant_id").notNull(),
    aadObjectId: text("aad_object_id").notNull(),
    teamsName: text("teams_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("teams_link_tokens_conversation_idx").on(t.conversationId, t.createdAt),
    index("teams_link_tokens_expires_idx").on(t.expiresAt),
  ],
);
