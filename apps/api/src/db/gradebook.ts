/**
 * The gradebook (F-GBOOK, D06, ADR-074; merge task M5-03a). Owned by the
 * `gradebook` module (`modules/gradebook/`); every other module reads these
 * tables by join and never writes them.
 *
 * The gradebook STORES settings and staff marks only. A grade is never
 * stored here: an evaluation's comes from its results, a project's from its
 * final score (`modules/gradebook/service.ts` reads them, never recomputes).
 *
 *   - `gradebook_columns`: the settings of one activity's column — its
 *     weight, whether it counts toward the mean, its position. A column is
 *     materialized by the first write that names it; an activity without a
 *     row has the defaults (`@quiz/domain`: weight 1, exams and projects
 *     count, exercises do not). Exactly one of `evaluation_id` /
 *     `project_id`;
 *   - `gradebook_marks`: a staff mark on one student of one column, which
 *     wins over whatever the activity gives them (`absent`: a1.0; `score`:
 *     the teacher's own points out of a maximum, also for a student who
 *     never accepted a project). One mark per (column, student); leaving
 *     the roster takes the marks along;
 *   - `gradebook_settings`: one row per classroom, once the teacher chose
 *     to publish the mean (off by default; no row = off).
 *
 * `updated_at`, `set_at` are the server's clock, written by the service.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { GRADEBOOK_MARK_KINDS } from "@quiz/domain";

import { users } from "./auth.js";
import { evaluations } from "./evaluation.js";
import { classrooms, enrollments } from "./org.js";
import { projects } from "./project.js";

export const gradebookColumns = pgTable(
  "gradebook_columns",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    evaluationId: uuid("evaluation_id").references(() => evaluations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** 0 to 10, at the tenth (`validWeight`). */
    weight: numeric("weight", { precision: 3, scale: 1, mode: "number" }).notNull(),
    /** Whether the column counts toward the mean: the teacher's choice, or the kind's default at creation. */
    counts: boolean("counts").notNull(),
    /** The teacher's order; null keeps the activity's own date order. */
    position: integer("position"),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("gradebook_columns_one_activity", sql`(${t.evaluationId} IS NULL) <> (${t.projectId} IS NULL)`),
    check("gradebook_columns_weight_range", sql`${t.weight} >= 0 AND ${t.weight} <= 10`),
    uniqueIndex("gradebook_columns_evaluation_uq").on(t.evaluationId).where(sql`${t.evaluationId} IS NOT NULL`),
    uniqueIndex("gradebook_columns_project_uq").on(t.projectId).where(sql`${t.projectId} IS NOT NULL`),
    index("gradebook_columns_classroom_idx").on(t.classroomId),
    // The target of a mark's composite key: a mark's column is of its classroom.
    unique("gradebook_columns_id_classroom_uq").on(t.id, t.classroomId),
  ],
);

export const gradebookMarks = pgTable(
  "gradebook_marks",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id").notNull(),
    columnId: uuid("column_id").notNull(),
    /** The roster line (a claimed student seat, checked by the service); leaving the roster deletes the mark. */
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: GRADEBOOK_MARK_KINDS }).notNull(),
    /** `score` only: the teacher's points and the maximum they are out of. */
    points: numeric("points", { precision: 8, scale: 2, mode: "number" }),
    max: numeric("max", { precision: 8, scale: 2, mode: "number" }),
    /** Staff-only: never in a student response. */
    comment: text("comment"),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    setAt: timestamp("set_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      name: "gradebook_marks_column_classroom_fk",
      columns: [t.columnId, t.classroomId],
      foreignColumns: [gradebookColumns.id, gradebookColumns.classroomId],
    }).onDelete("cascade"),
    unique("gradebook_marks_column_enrollment_uq").on(t.columnId, t.enrollmentId),
    index("gradebook_marks_enrollment_idx").on(t.enrollmentId),
    check(
      "gradebook_marks_shape",
      sql`(${t.kind} = 'absent' AND ${t.points} IS NULL AND ${t.max} IS NULL)
        OR (${t.kind} = 'score' AND ${t.points} IS NOT NULL AND ${t.max} IS NOT NULL AND ${t.max} > 0 AND ${t.points} >= 0 AND ${t.points} <= ${t.max})`,
    ),
  ],
);

export const gradebookSettings = pgTable("gradebook_settings", {
  classroomId: uuid("classroom_id")
    .primaryKey()
    .references(() => classrooms.id, { onDelete: "cascade" }),
  /** The teacher publishes the mean to the students (F-GBOOK-05); off by default. */
  meanPublished: boolean("mean_published").notNull().default(false),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
