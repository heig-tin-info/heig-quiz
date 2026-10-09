/**
 * The bookkeeping of the heig-classroom import (ADR-035, merge task M1-06,
 * docs/merge/02-data-and-migration.md §2.5), in a schema of its own,
 * `import_classroom`: nothing of the application reads or writes it. Owned
 * by `apps/api/src/import-classroom.ts`, its only writer.
 *
 * `id_map` is what makes the import idempotent — a source row already mapped
 * is never imported again, so a second `--apply` writes nothing — and what
 * the legacy URL resolver will read (M8-02). `runs` records every `--apply`
 * that wrote something, with its report.
 */
import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

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
    /**
     * Re-import baseline (M8-01a, product owner 2026-10-05). Only a row the
     * import CREATED (`how = 'created'`) is owned by it: `target_table` is
     * the Quiz table it became, `imported_hash` the hash of the columns the
     * import owns as the import left them, `source_hash` the hash of what
     * classroom held. A later run overwrites the Quiz row when classroom's
     * side changed and the Quiz row still hashes to `imported_hash`; a row
     * Quiz changed since is kept and listed. Null on rows an earlier
     * version of the script wrote: the first re-import adopts a baseline.
     */
    targetTable: text("target_table"),
    importedHash: text("imported_hash"),
    sourceHash: text("source_hash"),
  },
  (t) => [primaryKey({ columns: [t.sourceTable, t.sourceId] })],
);

/**
 * heig-classroom's `audit_log`, kept as it was (D11, settled 2026-10-01): a
 * history nothing in Quiz writes after the import, so Quiz's own closed
 * audit union stays clean. Kept indefinitely. No route reads it: like
 * `audit_log`, it is forensics, read by an admin with `psql`.
 *
 * `source_id` is classroom's `audit_log.id`, the idempotency key (a second
 * run inserts nothing). The actor is remapped best-effort: `actor_user_id`
 * is the Quiz account when the import reached the person, null otherwise;
 * `source_actor_user_id` keeps classroom's id either way, so the map can be
 * redone through `import_classroom.id_map`. No foreign key, on purpose.
 */
export const legacyClassroomAuditLog = pgTable(
  "legacy_classroom_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    sourceId: bigint("source_id", { mode: "number" }).notNull().unique(),
    actorUserId: uuid("actor_user_id"),
    sourceActorUserId: uuid("source_actor_user_id"),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("legacy_classroom_audit_subject_idx").on(t.subjectType, t.subjectId)],
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
