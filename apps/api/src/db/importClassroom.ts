/**
 * The bookkeeping of the heig-classroom import (ADR-035, merge task M1-06,
 * docs/merge/02-data-and-migration.md §2.5), in a schema of its own,
 * `import_classroom`: nothing of the application reads or writes it. Owned
 * by `apps/api/scripts/import-classroom.ts`, its only writer.
 *
 * `id_map` is what makes the import idempotent — a source row already mapped
 * is never imported again, so a second `--apply` writes nothing — and what
 * the legacy URL resolver will read (M8-02). `runs` records every `--apply`
 * that wrote something, with its report.
 */
import { jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const importClassroom = pgSchema("import_classroom");

/**
 * One heig-classroom row and the Quiz row it became or was merged into.
 * `source_table` is classroom's table name (`users`, `classrooms`,
 * `enrollments`, `teacher_grants`); no foreign key, on purpose: the map
 * outlives a Quiz row deleted later, and says so.
 */
export const importIdMap = importClassroom.table(
  "id_map",
  {
    sourceTable: text("source_table").notNull(),
    sourceId: uuid("source_id").notNull(),
    targetId: uuid("target_id").notNull(),
    /** How the row was mapped: `created`, `swiss_edu_id`, `address`, `merged`, … */
    how: text("how").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceTable, t.sourceId] })],
);

/** One `--apply` that wrote something; a dry run rolls back and leaves none. */
export const importRuns = importClassroom.table("runs", {
  id: uuid("id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  /** The Quiz account that ran it (`--actor`). */
  actorUserId: uuid("actor_user_id").notNull(),
  /** SHA-256 of the mapping file, hex. */
  mappingSha256: text("mapping_sha256").notNull(),
  /** The open decisions as the run was given them (`--assistants`, `--missing-students`). */
  options: jsonb("options").$type<Record<string, string>>().notNull(),
  /** The counts of the report (no personal data). */
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
});
