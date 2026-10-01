/**
 * The journal (ADR-049 and its addendum, docs/merge/04-journal.md §4.2, spec
 * 05 §5.11): a classroom's course documentation, held in a GitHub repository
 * and mirrored here. Owned by the `journal` module (`modules/journal/`, merge
 * task M4-02); every other module reads these tables by join and never writes
 * them.
 *
 * Two modes (ADR-057, D29), the row's `mode`. In Quiz mode these tables ARE
 * the journal: the teacher edits `journal_pages.markdown`, and each save
 * keeps a `journal_page_revisions` row. In GitHub mode the repository is the
 * source of truth for the CONTENT, and these tables are a read-only copy,
 * rebuilt from a push or a Refresh, never written by a teacher in the
 * platform. Every page and asset carries the blob sha it was copied from: a
 * synchronisation re-renders a page only when its blob moved.
 *
 * One journal per classroom (D03): the pages and assets hang off the
 * classroom's row by `classroom_id`; in GitHub mode the row holds the
 * repository, the branch and the root folder. Two classrooms on the
 * same repository each keep their own copy; a push fans out to every row
 * holding its `github_repo_id` (`classroom_journals_repo_idx`). Removing the
 * journal deletes the row, and the copy goes with it by cascade — never the
 * repository (F-JRN-04). Deleting the classroom does the same (F-ORG-09).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import {
  JOURNAL_ASSET_MAX_BYTES,
  JOURNAL_MODES,
  JOURNAL_SYNC_STATUSES,
  type JournalSyncError,
  type JournalTocEntry,
  type JournalWarning,
} from "@quiz/contracts";

import { users } from "./auth.js";
import { bytea } from "./columns.js";
import { classrooms } from "./org.js";

export const classroomJournals = pgTable(
  "classroom_journals",
  {
    classroomId: uuid("classroom_id")
      .primaryKey()
      .references(() => classrooms.id, { onDelete: "cascade" }),
    /**
     * Where the content lives (ADR-057): `quiz`, these tables ARE the
     * journal; `github`, they are a read-only copy of the repository below.
     * No default: every insertion names its mode.
     */
    mode: text("mode", { enum: JOURNAL_MODES }).notNull(),
    /**
     * GitHub's immutable id of the repository: what a push and a rename
     * carry. The three repository columns are set in GitHub mode and null in
     * Quiz mode (`classroom_journals_mode_ck`).
     */
    githubRepoId: bigint("github_repo_id", { mode: "number" }),
    /** `org/name`, followed on a rename. */
    fullName: text("full_name"),
    /** The branch the copy follows. */
    ref: text("ref"),
    /** The folder of the repository holding the pages, "" for its root. */
    rootPath: text("root_path").notNull().default(""),
    /** Head commit the copy was built from; null before the first synchronisation. */
    lastCommitSha: text("last_commit_sha"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    /**
     * The database's `now()` the pages' `html_student` were last rendered at
     * (an ingestion, or the J4 sweep): a page whose `visible_from` passed
     * since is not linked in them yet, and the sweep renders them again.
     */
    studentRenderedAt: timestamp("student_rendered_at", { withTimezone: true }),
    /**
     * Bumped by every write of the row or of its copy (an ingestion, its
     * failure, a rename, a deletion): an ingestion reads GitHub with no lock
     * held, then writes only if the version it started from is still the
     * row's (fix J2, `modules/journal/ingest.ts`).
     */
    version: integer("version").notNull().default(0),
    syncStatus: text("sync_status", { enum: JOURNAL_SYNC_STATUSES }).notNull().default("pending"),
    /** Why the last synchronisation failed: a `JournalSyncError` code, worded by the web app. */
    syncError: text("sync_error").$type<JournalSyncError>(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("classroom_journals_repo_idx").on(t.githubRepoId),
    check(
      "classroom_journals_mode_ck",
      sql`(${t.mode} = 'github' AND ${t.githubRepoId} IS NOT NULL AND ${t.fullName} IS NOT NULL AND ${t.ref} IS NOT NULL)
        OR (${t.mode} = 'quiz' AND ${t.githubRepoId} IS NULL AND ${t.fullName} IS NULL AND ${t.ref} IS NULL)`,
    ),
  ],
);

/**
 * One markdown file of the journal, rendered (`renderPage` of
 * `@quiz/docrender`). `markdown` is kept next to `html` so the editor opens a
 * page without a GitHub round trip, and so a GitHub outage leaves the journal
 * readable. `path` is relative to the journal's root and is the identity of
 * a page: a renamed file is a new page and a deleted one.
 */
export const journalPages = pgTable(
  "journal_pages",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classroomJournals.classroomId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    /** Directory holding the file, "" at the root: the navigation's parent. */
    parentPath: text("parent_path").notNull(),
    /** What the navigation sorts on: the raw file name, landing page first. */
    sortKey: text("sort_key").notNull(),
    /** Plain text; null when neither the page nor its file name gives one. */
    title: text("title"),
    frontMatter: jsonb("front_matter").$type<Record<string, unknown>>().notNull().default({}),
    blobSha: text("blob_sha").notNull(),
    /** The source without NUL (`cleanSource`): what the editor opens. */
    markdown: text("markdown").notNull(),
    /** Rendered with every page linkable: what the staff read. */
    htmlStaff: text("html_staff").notNull(),
    /**
     * Rendered with only the pages visible to students linkable, so that a
     * draft's or a future page's path never reaches a student (N-SEC-12);
     * re-rendered from `markdown` by the `visible_from` sweep (J4).
     */
    htmlStudent: text("html_student").notNull(),
    toc: jsonb("toc").$type<JournalTocEntry[]>().notNull().default([]),
    /** `draft: true` in the front matter: the staff read it, students do not. */
    draft: boolean("draft").notNull().default(false),
    /** `visible_from` in the front matter: hidden from students until then (the database's clock). */
    visibleFrom: timestamp("visible_from", { withTimezone: true }),
    /** Non-fatal rendering warnings, as codes (J5). */
    warnings: jsonb("warnings").$type<JournalWarning[]>().notNull().default([]),
    /**
     * The assets the page references (`RenderedPage.assets`): an asset is
     * served to a student only if a page visible to them lists it (J1,
     * N-SEC-13).
     */
    assetPaths: text("asset_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Serves the page read, the whole-journal reads (tree, ingestion) by its prefix.
    uniqueIndex("journal_pages_classroom_path_uq").on(t.classroomId, t.path),
    // The ticker's sweep for pages whose `visible_from` just passed (J4).
    index("journal_pages_visible_from_idx")
      .on(t.visibleFrom)
      .where(sql`${t.visibleFrom} IS NOT NULL`),
  ],
);

/**
 * A file of the repository that a page references (an image, a handout),
 * copied out of it (D14: `bytea`, a rebuildable read model, at most 5 MB).
 * Served under the classroom's own access check with the blob sha as ETag:
 * the repository is private, so a `raw.githubusercontent` link would 404 for
 * every student.
 */
export const journalAssets = pgTable(
  "journal_assets",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classroomJournals.classroomId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    blobSha: text("blob_sha").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("journal_assets_classroom_path_uq").on(t.classroomId, t.path),
    check(
      "journal_assets_size_ck",
      sql`${t.size} BETWEEN 0 AND ${sql.raw(String(JOURNAL_ASSET_MAX_BYTES))}`,
    ),
  ],
);

/**
 * A saved state of a Quiz-mode page (ADR-057): one row per save, the source
 * only (markdown and front matter; assets are not versioned), no limit. Keyed
 * by the page's path, which a move never changes, so a page deleted and
 * re-added keeps its history. Staff only: no student route ever reads this
 * table (invariant 4). Gone with the journal, by cascade.
 */
export const journalPageRevisions = pgTable(
  "journal_page_revisions",
  {
    id: uuid("id").primaryKey(),
    classroomId: uuid("classroom_id")
      .notNull()
      .references(() => classroomJournals.classroomId, { onDelete: "cascade" }),
    path: text("path").notNull(),
    markdown: text("markdown").notNull(),
    frontMatter: jsonb("front_matter").$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A page's history, newest first.
  (t) => [index("journal_page_revisions_page_idx").on(t.classroomId, t.path, t.createdAt)],
);
