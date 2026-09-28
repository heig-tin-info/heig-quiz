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
 * of its kind in `DEFAULT_CHANNEL_ENABLED` — so a kind added later reaches
 * everyone at its own default without a backfill, and "back to the defaults"
 * is a DELETE.
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
 * An account's Microsoft Teams link (ADR-030): the Teams (Entra) account its
 * notifications go to, as an activity in that account's Teams activity feed.
 * Learned from the SSO token of the HEIG Quiz tab in Teams, and confirmed on
 * the link page while signed in to the platform. No Microsoft token is kept —
 * a delivery uses the application's own credentials.
 *
 * One Teams account per Quiz account (the primary key) and one Quiz account
 * per Teams account (the unique pair): linking a Teams account already linked
 * elsewhere MOVES it.
 */
export const teamsLinks = pgTable(
  "teams_links",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The Entra tenant of the Teams account (the token's `tid`), lower-case. */
    tenantId: text("tenant_id").notNull(),
    /** The Entra object id of the person in that tenant (the token's `oid`). */
    aadObjectId: text("aad_object_id").notNull(),
    /** The display name of the Teams account, shown in the settings. */
    teamsName: text("teams_name").notNull(),
    /** Its sign-in name (`preferred_username`), shown beside the name. */
    teamsUsername: text("teams_username").notNull().default(""),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("teams_links_identity_idx").on(t.tenantId, t.aadObjectId)],
);

/**
 * A pending link, minted when the HEIG Quiz tab in Teams finds its account
 * unlinked (ADR-030). The URL carries a random secret; only its SHA-256 is
 * stored, the way a session id is (`sessions.sid_hash`), so reading this
 * table links nothing. Single use: `consumed_at` is set in the transaction
 * that writes the link. Fifteen minutes to live; a new token for the same
 * Teams account deletes its unspent ones, and expired rows are pruned
 * whenever a token is made.
 */
export const teamsLinkTokens = pgTable(
  "teams_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    aadObjectId: text("aad_object_id").notNull(),
    teamsName: text("teams_name").notNull(),
    teamsUsername: text("teams_username").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("teams_link_tokens_identity_idx").on(t.tenantId, t.aadObjectId),
    index("teams_link_tokens_expires_idx").on(t.expiresAt),
  ],
);
