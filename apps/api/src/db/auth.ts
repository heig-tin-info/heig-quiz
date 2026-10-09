/**
 * Identity, sessions and the audit log (`auth` + the platform-wide log).
 *
 * Inherited from heig-classroom as-is (PLAN-MVP §3.1): the SQL of these
 * tables is the one `drizzle/0000_init.sql` created and must not move.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { DATE_FORMATS, DEFAULT_MAX_ACTIVE_SESSIONS, SESSION_KINDS, USER_ROLES } from "@quiz/contracts";
import { LOCALES, MCQ_SCORE_POLICIES } from "@quiz/domain";

import { bytea } from "./columns.js";
import { evaluations } from "./evaluation.js";
import { kioskDevices } from "./kiosk.js";
import { projects } from "./project.js";

/**
 * The stored roles that make an account staff: the ones that may reach a
 * pool, hold a seat in it or hear of it (`poolAccess`, `pool/members.ts`).
 */
export const STAFF_ROLES = ["teacher", "admin"] as const;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    oidcSub: text("oidc_sub").notNull().unique(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    givenName: text("given_name").notNull().default(""),
    familyName: text("family_name").notNull().default(""),
    swissEduId: text("swiss_edu_id"),
    /** Avatar URL provided by the IdP (OIDC `picture` claim), if present. */
    pictureUrl: text("picture_url"),
    role: text("role", { enum: USER_ROLES })
      .notNull()
      .default("student"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Interface language chosen by the user; null falls back to English. */
    locale: text("locale", { enum: LOCALES }),
    /** Date-time display format; null falls back to ISO (YYYY-MM-DD HH:mm). */
    dateFormat: text("date_format", { enum: DATE_FORMATS }),
    /**
     * Default MCQ scoring policy of the evaluations this teacher creates
     * (docs/04 §4.4); null falls back to `all_or_nothing`. It is a SEED, read
     * once at creation: changing it never moves an existing evaluation.
     */
    mcqPolicy: text("mcq_policy", { enum: MCQ_SCORE_POLICIES }),
    /**
     * The coach marks (the bubbles that introduce a screen to a newcomer,
     * `apps/web/src/coach/`) are shown; null means yes. Turned off from the
     * settings page.
     */
    coachEnabled: boolean("coach_enabled"),
    /**
     * The on-screen calculator an evaluation provides (ADR-069) works in
     * reverse Polish notation for this user; null means no, the infix one.
     * Kept on the account so it follows a student to the exam station.
     */
    rpnCalculator: boolean("rpn_calculator"),
    /**
     * The coach marks this user has read or dismissed, by id. One in this set
     * is never shown again; one shipped later is, so a new feature introduces
     * itself to the people who already know the rest.
     */
    coachSeen: jsonb("coach_seen").$type<string[]>().notNull().default([]),
    /**
     * When this user last acknowledged the platform's "What's new" (ADR-087):
     * an entry live after it is unseen. Born with the account, so a new user
     * is shown no history; moved by `POST /app/api/me/changelog`, on the
     * database's clock, the one that dates the entries.
     */
    changelogSeenAt: timestamp("changelog_seen_at", { withTimezone: true }).notNull().defaultNow(),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("users_email_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** Hex SHA-256 of the session token, never the plaintext token. */
    sidHash: char("sid_hash", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** What the session is and which routes it reaches (ADR-027). */
    kind: text("kind", { enum: SESSION_KINDS }).notNull().default("portal"),
    /** Who acts through the session when it is not `user_id` themself; null otherwise. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "cascade" }),
    /**
     * The one evaluation a confined session (`seb`, `kiosk`) is confined to;
     * null on a `portal` or `impersonation` one.
     */
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    /**
     * The one project a `seb` session is confined to instead (D21, M6-07):
     * its student page and *Open workspace*, nothing else. Never set with
     * `evaluation_id`: a confined session has one activity.
     */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The end of this session's Super Powers (ADR-054): an admin's portal
     * session reaches everyone's content until then, by the server's clock.
     * Null when they are off. Only the enable route sets it; the sliding
     * renewal never touches it; signing out deletes it with the row.
     */
    superPowersUntil: timestamp("super_powers_until", { withTimezone: true }),
    /**
     * The station a `kiosk` session sits on (ADR-051 §7); null on every other
     * kind. At most one session per station: the partial unique index.
     */
    deviceId: uuid("device_id").references(() => kioskDevices.id, { onDelete: "cascade" }),
    /**
     * The Config Key a `seb` session was launched with (ADR-051 §3), hex, to
     * check the header of every later request; null on every other kind.
     */
    sebConfigKey: char("seb_config_key", { length: 64 }),
  },
  (t) => [
    index("sessions_expires_idx").on(t.expiresAt),
    uniqueIndex("sessions_device_idx").on(t.deviceId).where(sql`${t.deviceId} IS NOT NULL`),
    check("sessions_one_activity", sql`${t.evaluationId} IS NULL OR ${t.projectId} IS NULL`),
  ],
);

/**
 * One-time launch tickets (ADR-027): the right to open ONE session of a
 * given kind, for a given user, a few minutes long. Only the SHA-256 of the
 * secret is stored, like a session. Consumed by a single conditional UPDATE;
 * revoked or consumed rows stay, for the audit trail.
 */
export const launchTickets = pgTable(
  "launch_tickets",
  {
    id: uuid("id").primaryKey(),
    secretHash: char("secret_hash", { length: 64 }).notNull().unique(),
    kind: text("kind", { enum: SESSION_KINDS }).notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Who will act through the session, when not the user themself (as on `sessions`). */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "cascade" }),
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    /** The project the session will be confined to instead (as on `sessions`, D21). */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("launch_tickets_user_idx").on(t.userId, t.evaluationId),
    check("launch_tickets_one_activity", sql`${t.evaluationId} IS NULL OR ${t.projectId} IS NULL`),
  ],
);

/**
 * Personal API tokens (docs/08 §8.3 "Automate", ADR-022): a bearer credential
 * a teacher mints in the settings for a script or an MCP client. Like a
 * session, only the SHA-256 of the secret is stored; `prefix` is the first
 * characters of the plaintext, shown in the list so the teacher can tell two
 * tokens apart. Revocation stamps `revoked_at` rather than deleting, so the
 * list keeps saying what was revoked and when.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    prefix: text("prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Set on an OAuth ACCESS token (ADR-023): the grant it was issued under.
     * Null on a personal token the teacher minted by hand.
     */
    grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
    /**
     * The resource an OAuth access token was issued for (RFC 8707): the MCP
     * endpoint. Such a token is refused everywhere else. Null on a personal
     * token, which is valid on the whole API.
     */
    audience: text("audience"),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId), index("api_tokens_grant_idx").on(t.grantId)],
);

/**
 * An OAuth client (ADR-023): an MCP host such as claude.ai or ChatGPT. Either
 * it registered itself (`dcr`, RFC 7591, `id` is ours) or it is identified by
 * the URL of its Client ID Metadata Document (`cimd`, `id` IS that URL, the
 * document cached here). Every client is public: PKCE, no secret.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["dcr", "cimd"] }).notNull(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  clientUri: text("client_uri"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** A `cimd` document is fetched again once this is a day old. */
  fetchedAt: timestamp("fetched_at", { withTimezone: true }),
});

/**
 * One authorization request, from `/authorize` to the code's redemption.
 * Pending until the teacher answers on the consent page; then it holds the
 * code (hashed, 60 seconds, one use).
 */
export const oauthRequests = pgTable(
  "oauth_requests",
  {
    id: uuid("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    state: text("state"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    codeHash: char("code_hash", { length: 64 }).unique(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("oauth_requests_expires_idx").on(t.expiresAt)],
);

/**
 * What a teacher consented to: one client acting for them. It holds the
 * current refresh token (hashed, rotated on every use) and the one before it,
 * so a replayed old refresh token is recognised and refused. Revoking the
 * grant revokes every access token issued under it.
 */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    resource: text("resource").notNull(),
    refreshHash: char("refresh_hash", { length: 64 }).notNull().unique(),
    previousRefreshHash: char("previous_refresh_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("oauth_grants_user_idx").on(t.userId)],
);

/**
 * Every e-mail address known for an account. Switch edu-ID lets a person
 * sign in under a self-chosen preferred address — often a private mailbox —
 * while GAPS exports the institutional one, so matching a roster line
 * against `users.email` alone misses them. Identity is a SET of addresses.
 *
 * Addresses are kept once seen, even if the affiliation later ends: losing
 * one would silently unmatch a student mid-semester.
 */
export const userEmails = pgTable(
  "user_emails",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Normalized (trim + lowercase), like the roster. */
    email: text("email").notNull(),
    /** `login`, or the name of the claim it came from — plain text, so a
     *  change in what edu-ID releases needs no migration. */
    source: text("source").notNull(),
    /**
     * An address asserted by the home organization is verified by
     * construction; only the login claim carries `email_verified`. Matching
     * reads verified addresses exclusively.
     */
    verified: boolean("verified").notNull().default(true),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.email] }),
    index("user_emails_email_idx").on(t.email),
  ],
);

/**
 * Raw claim set released by the IdP at the last login. Diagnostic and
 * matching material only. Deliberately NOT minimized (see auth/claims.ts);
 * in exchange the table is never read by a user-facing view and never
 * leaves the server.
 */
export const userIdpClaims = pgTable("user_idp_claims", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  claims: jsonb("claims").$type<Record<string, unknown>>().notNull(),
  /** Affiliation claims merged and normalized (`student`, `staff@heig-vd.ch`, …). */
  affiliations: text("affiliations")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Uploaded avatar (cropped to 256x256 client-side), takes priority over `picture_url`. */
export const avatars = pgTable("avatars", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  contentType: text("content_type").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Teachers managed in the database by the admin: the grant is made by email
 * even before the person has an account; identity and last login fill in at
 * their first edu-ID login.
 */
export const teacherGrants = pgTable("teacher_grants", {
  id: uuid("id").primaryKey(),
  /** Normalized to lowercase. */
  email: text("email").notNull().unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * The online workspace (ADR-047 §4, amended 2026-10-07): may this teacher
   * put a project of a course they own in the portal, and how many of the
   * workspaces they carry may run at once (the portal enforces it, from the
   * sync). Edited by an administrator only.
   */
  codespaceEnabled: boolean("codespace_enabled").notNull().default(false),
  codespaceMaxActiveSessions: integer("codespace_max_active_sessions").notNull().default(DEFAULT_MAX_ACTIVE_SESSIONS),
});

/**
 * Who an audit entry names as acting: a person through a session (`user`),
 * through a personal or OAuth token (`api_key`, ADR-022), the teacher
 * assistant running a write its teacher confirmed (`assistant`, ADR-080 P3,
 * the teacher as `actor_user_id`), or nobody (`system`). A closed list
 * (invariant 9); the column is text, so the list is the schema's, not a
 * database enum.
 */
export const AUDIT_ACTOR_TYPES = ["user", "system", "api_key", "assistant"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * Append-only audit log (NFR-05, AU-42), platform-wide: it belongs to no
 * single module, and `src/audit.ts` is the only writer. The trigger of
 * migration 0096 refuses every UPDATE and DELETE on it (ADR-003 §5).
 *
 * No route reads it: it is forensics, read with `psql` (ADR-003, addendum
 * 2026-09-23). The two indexes serve the two questions asked there — "what
 * happened lately" and "what happened to this entity" (audit D-15).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id"),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt.desc()),
    index("audit_log_subject_idx").on(t.subjectType, t.subjectId),
  ],
);
