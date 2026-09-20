/**
 * Drizzle schema (see docs/spec/05-architecture.md, section 5.3). UTC
 * everywhere (timestamptz), uuid primary keys generated application-side.
 * UNIQUE constraints are the idempotency mechanism.
 *
 * Scope of this bootstrap: identity, organisation (courses, classrooms,
 * rosters) and the audit log. The quiz tables (pools, questions,
 * evaluations, attempts, gradings) land with their modules.
 */
import { sql } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import {
  bigserial,
  boolean,
  char,
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
 * A course (`Programmation C`, code `PRG1`): the unit a question pool and a
 * teaching staff hang off. Classrooms are its per-semester instances.
 */
export const courses = pgTable("courses", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  /** Short school code (`PRG1`), unique across the instance. */
  code: text("code").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Teaching staff of a course. Every member holds the same rights
 * (docs/spec/07-reutilisation-heig-classroom.md, 7.3): no permission matrix
 * until a real need shows up. THE access predicate of `guards.ts` reads it.
 */
export const courseStaff = pgTable(
  "course_staff",
  {
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.courseId, t.userId] }),
    index("course_staff_user_idx").on(t.userId),
  ],
);

/** One instance of a course for a group of students, over one period. */
export const classrooms = pgTable(
  "classrooms",
  {
    id: uuid("id").primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Free-form academic period label (`2026-A`, `Automne 2026`). */
    period: text("period").notNull().default(""),
    /** Self-enrolment code; null = closed classroom. */
    joinCode: text("join_code").unique(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("classrooms_course_idx").on(t.courseId)],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    nom: text("nom").notNull(),
    prenom: text("prenom").notNull(),
    /** Normalized (trim + lowercase) at import time. */
    email: text("email").notNull(),
    status: text("status", { enum: ["pending", "claimed"] })
      .notNull()
      .default("pending"),
    userId: uuid("user_id").references(() => users.id),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    conflictFlag: boolean("conflict_flag").notNull().default(false),
    /** Teacher/admin seat (self-enroll): excluded from the class headcount. */
    staff: boolean("staff").notNull().default(false),
    /**
     * Accommodation (F-ORG-07): extra time granted on every timed
     * evaluation, in percent of the nominal duration. 0 = none.
     */
    timeBonusPercent: integer("time_bonus_percent").notNull().default(0),
    /** Free-form teacher note about this student (never shown to them). */
    note: text("note"),
  },
  (t) => [
    uniqueIndex("enrollments_classroom_email_uq").on(t.classroomId, t.email),
    uniqueIndex("enrollments_classroom_user_uq").on(t.classroomId, t.userId),
    index("enrollments_email_idx").on(sql`lower(${t.email})`),
  ],
);

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
