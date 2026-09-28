/**
 * Organisation: courses, their teaching staff, classrooms and rosters
 * (PLAN-MVP §3.1). Owned by the `org` module (`modules/org/`); every other
 * module reads them by join and never writes them.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { users } from "./auth.js";

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
    /**
     * The dated period (F-ORG-03, issue #156): first and last month, both
     * inclusive, as `YYYY-MM`. Text and not a `date`: the value IS a month —
     * no day to pin, no time zone to shift it — it is what an
     * `<input type="month">` sends, and two of them compare as strings in
     * calendar order. Both or neither (null = always current), checked below.
     */
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    /** Self-enrolment code; null = never minted. */
    joinCode: text("join_code").unique(),
    /**
     * Whether that code is currently accepted (F-ORG-06). Disabling keeps the
     * code so the same handout works again when the teacher re-opens the
     * classroom, and refusing is a plain 404 for the student.
     */
    joinCodeEnabled: boolean("join_code_enabled").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("classrooms_course_idx").on(t.courseId),
    // The same rule as the zod contract (`ClassroomCreate`): two well-formed
    // months or none, the last not before the first. A CHECK passes on NULL,
    // so the explicit `is not null` pair is what refuses half a period.
    check(
      "classrooms_period_months_ck",
      sql`(${t.periodStart} is null and ${t.periodEnd} is null) or (${t.periodStart} is not null and ${t.periodEnd} is not null and ${t.periodStart} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodEnd} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and ${t.periodEnd} >= ${t.periodStart})`,
    ),
  ],
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
    // The student side reads seats by account alone (the student home, every
    // SSE connect): the unique index above leads with the classroom.
    index("enrollments_user_idx").on(t.userId),
    index("enrollments_email_idx").on(sql`lower(${t.email})`),
  ],
);

/**
 * One user's own display state for one course (#155, ADR-032). Today it
 * holds only `hidden_at`: a course the user no longer teaches, taken out of
 * THEIR navigation (course list, sidebar, command palette) and nowhere
 * else — pickers and the MCP `list_courses` still list it, and nothing about
 * the course itself changes for its other staff members.
 *
 * A table of its own and not a column of `course_staff`, because an admin
 * reaches every course without a staff seat. A row with a null `hidden_at`
 * is a visible course: the row is the home of any later per-user course
 * preference (a favourite), so unhiding clears the column, not the row.
 */
export const userCoursePrefs = pgTable(
  "user_course_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.courseId] })],
);
