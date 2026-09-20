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
  customType,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
    role: text("role", { enum: ["student", "teacher", "admin"] })
      .notNull()
      .default("student"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Interface language chosen by the user; null falls back to English. */
    locale: text("locale", { enum: ["en", "fr"] }),
    /** Date-time display format; null falls back to ISO (YYYY-MM-DD HH:mm). */
    dateFormat: text("date_format", { enum: ["iso", "eu", "uk", "us"] }),
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
  },
  (t) => [index("sessions_expires_idx").on(t.expiresAt)],
);

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

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
});

/**
 * Bearer tokens for the `/api/v1` surface — PHASE 2: the table exists so the
 * migration chain never has to grow it later, and nothing reads it in the
 * MVP (decision D18 is deferred, the SPA keeps its session cookies).
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Hex SHA-256 of the token, never the token itself (same rule as sessions). */
    tokenHash: char("token_hash", { length: 64 }).notNull().unique(),
    name: text("name").notNull(),
    /** Coarse capabilities, e.g. `["pool:read"]`. Unused until phase 2. */
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_tokens_user_idx").on(t.userId)],
);

/**
 * Append-only audit log (NFR-05, AU-42), platform-wide: it belongs to no
 * single module, and `src/audit.ts` is the only writer. In production the
 * application SQL role has neither UPDATE nor DELETE on it.
 */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorUserId: uuid("actor_user_id"),
  actorType: text("actor_type", { enum: ["user", "system", "api_key"] }).notNull(),
  action: text("action").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
