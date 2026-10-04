/**
 * Group sets (ADR-070, F-PROJ-06; merge task M3-15a). Owned by the `group`
 * module (`modules/group/`); every other module reads them by join and
 * never writes them.
 *
 * A **group set** is a named list of groups of one classroom; a classroom
 * holds any number of them, and a group project names one
 * (`projects.group_set_id`) and keeps its own copy of it (`project_groups`,
 * `project_group_members`, the `project` module's), which follows the set
 * until the project's groups stop (`projects.groups_stopped_at`).
 *
 * Membership is by roster line, as in ADR-048: a student is placed before
 * they ever sign in. A staff seat (ADR-018) is never placed by the service;
 * a line that turns into a staff seat later is filtered out by every read.
 * Leaving the roster cascades out of every set (F-PROJ-17).
 *
 * `created_at`, `added_at` are the server's clock, written by the service:
 * no database default. `groups` is a reserved word in PostgreSQL, hence
 * `student_groups`.
 */
import { foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { users } from "./auth.js";
import { classrooms, enrollments } from "./org.js";

/** A classroom's named list of groups (ADR-070 §2). */
export const groupSets = pgTable(
  "group_sets",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Advisory for the staff (a warning), binding for the students (lot 2); null: none. */
    maxSize: integer("max_size"),
    /** Open to the students' self-formation until then (lot 2, M3-17); unused before. */
    openUntil: timestamp("open_until", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("group_sets_classroom_idx").on(t.classroomId)],
);

/**
 * A group of a set: a free-text name, unique in its set; `position` keeps
 * the creation order across renames. The UNIQUE (id, set_id) is the target
 * of the members' composite key, so a member's group is always of its set.
 */
export const studentGroups = pgTable(
  "student_groups",
  {
    id: uuid("id").primaryKey(),
    setId: uuid("set_id")
      .notNull()
      .references(() => groupSets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("student_groups_set_name_uq").on(t.setId, t.name),
    unique("student_groups_id_set_uq").on(t.id, t.setId),
  ],
);

/**
 * A student in a group of a set, by roster line. `set_id` is denormalized
 * so that the UNIQUE states the rule itself — a student is in at most one
 * group of a set, and adding them to another moves them.
 */
export const studentGroupMembers = pgTable(
  "student_group_members",
  {
    id: uuid("id").primaryKey(),
    setId: uuid("set_id")
      .notNull()
      .references(() => groupSets.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").notNull(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "student_group_members_group_set_fk",
      columns: [t.groupId, t.setId],
      foreignColumns: [studentGroups.id, studentGroups.setId],
    }).onDelete("cascade"),
    uniqueIndex("student_group_members_set_enrollment_uq").on(t.setId, t.enrollmentId),
    index("student_group_members_group_idx").on(t.groupId),
    index("student_group_members_enrollment_idx").on(t.enrollmentId),
  ],
);
