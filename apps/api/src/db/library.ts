/**
 * The course library (F-ORG-18, ADR-144). Owned by the `library` module, its
 * only writer (`modules/library/service.ts`).
 *
 * One row per document of a course. The bytes live in the content-addressed
 * store, at `ASSETS_DIR/documents/<sha256[0:2]>/<sha256>`: the path is
 * rebuilt from the hash, never stored, and the same bytes in two courses are
 * two rows and one file. No `assets` row points at it, so
 * `/app/api/assets/:id` never serves it. The row goes with its course
 * (cascade); a file no row names any more is swept by the module's daily
 * task, after a grace period (`library.blob_sweep`).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import type { JournalTocEntry, JournalWarning } from "@quiz/contracts";
import { DOCUMENT_KINDS } from "@quiz/domain";

import { users } from "./auth.js";
import { oneOf } from "./columns.js";
import { courses } from "./org.js";

export const courseDocuments = pgTable(
  "course_documents",
  {
    id: uuid("id").primaryKey(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    /** What students will read: the file's name without its extension until someone renames it. */
    title: text("title").notNull(),
    /** The uploaded file's name, cleaned: the staff's alone. */
    filename: text("filename").notNull(),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    sha256: text("sha256").notNull(),
    bytes: integer("bytes").notNull(),
    /** A Markdown document's rendering (`renderStandalone` of `@quiz/docrender`); null for a PDF. */
    html: text("html"),
    toc: jsonb("toc").$type<JournalTocEntry[]>(),
    /** What the rendering reported: the staff's alone. */
    warnings: jsonb("warnings").$type<JournalWarning[]>(),
    /** The `RENDERER_VERSION` the HTML was rendered with: an older one is rendered again from the file. */
    renderedWith: integer("rendered_with"),
    /** NO ACTION, like `paper_sheets.entered_by`: an account is pseudonymized, never deleted (ADR-117). */
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same bytes twice in one course are one document; it also serves the course's foreign key.
    uniqueIndex("course_documents_course_sha_uq").on(t.courseId, t.sha256),
    // The sweep's question: does any row still name this file?
    index("course_documents_sha256_idx").on(t.sha256),
    check("course_documents_kind_ck", oneOf(t.kind, DOCUMENT_KINDS)),
    check("course_documents_bytes_ck", sql`${t.bytes} > 0`),
    check("course_documents_html_ck", sql`(${t.kind} = 'markdown') = (${t.html} IS NOT NULL)`),
  ],
);
