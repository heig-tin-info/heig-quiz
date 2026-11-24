/**
 * The course library (F-ORG-18, F-ADMIN-10, ADR-144): the PDF and Markdown
 * documents of a course, uploaded by its staff.
 *
 *   - `GET    /app/api/courses/:id/documents` — the library: its documents,
 *     the bytes they use and the course's quota;
 *   - `POST   /app/api/courses/:id/documents` — one file, multipart: `201`
 *     with the new document, `200` with the existing one when the same bytes
 *     are already in this course; `415 document_unsupported`, `413` past
 *     `DOCUMENT_MAX_BYTES`, `409 quota_exceeded` ({@link QuotaExceeded});
 *   - `PATCH  /app/api/courses/:id/documents/:documentId` — its title;
 *   - `DELETE /app/api/courses/:id/documents/:documentId` — the uploader's
 *     or a course owner's, `403 owner_required` otherwise;
 *   - `GET    /app/api/courses/:id/documents/:documentId/file` — the bytes,
 *     always as an attachment, with `Range`; `404 file_missing` when the
 *     row outlived its file (a staging copy holds the rows only);
 *   - `PATCH  /app/api/admin/courses/:id/documents-quota` — the course's
 *     quota, an administrator's alone.
 *
 * Staff only, every one of them. The student's exit arrives with the
 * documents an evaluation provides (ADR-144 §PR3).
 */
import { z } from "zod";

import { DOCUMENT_KINDS } from "@quiz/domain";

import { JournalWarning } from "./journal.js";

/** The longest title a document may carry: what students will read. */
export const DOCUMENT_TITLE_MAX = 120;
/** The largest Markdown document, in bytes: beyond, it is no course sheet. */
export const DOCUMENT_MARKDOWN_MAX_BYTES = 500_000;
/** A course's quota when nobody raised it: 100 MiB. */
export const DEFAULT_DOCUMENTS_QUOTA_BYTES = 104_857_600;
/** The highest quota an administrator may give a course: 10 GiB. */
export const DOCUMENTS_QUOTA_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
/** What the file picker offers; the server reads the bytes, never this list. */
export const DOCUMENT_ACCEPT = ".pdf,.md,.markdown";

export const DocumentKind = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof DocumentKind>;

/** `/courses/:id/documents/:documentId`. */
export const CourseDocumentParam = z.object({ id: z.uuid(), documentId: z.uuid() });
export type CourseDocumentParam = z.infer<typeof CourseDocumentParam>;

/** A title as a person typed it: trimmed, one line, not empty. */
const DocumentTitle = z
  .string()
  .trim()
  .min(1)
  .max(DOCUMENT_TITLE_MAX)
  .refine((title) => !/[\u0000-\u001f\u007f]/.test(title), "A title is one line of text");

/** `PATCH /courses/:id/documents/:documentId`: the title students will read. */
export const CourseDocumentPatch = z.object({ title: DocumentTitle });
export type CourseDocumentPatch = z.infer<typeof CourseDocumentPatch>;

/** One document of a course's library, as its staff read it. */
export const CourseDocument = z.object({
  id: z.uuid(),
  /** What students will read. */
  title: z.string(),
  /** The name of the uploaded file: the staff's alone. */
  filename: z.string(),
  kind: DocumentKind,
  bytes: z.number().int().positive(),
  uploadedAt: z.iso.datetime(),
  uploadedBy: z.object({ id: z.uuid(), name: z.string() }),
  /** What the Markdown rendering reported (no image in v1, raw HTML shown as text…); empty for a PDF. */
  warnings: z.array(JournalWarning),
  /** The row outlived its file: nothing to download (a staging copy, a lost disk). */
  missing: z.boolean(),
  /** The caller uploaded it, or owns the course. */
  canDelete: z.boolean(),
});
export type CourseDocument = z.infer<typeof CourseDocument>;

/** `GET /courses/:id/documents`. */
export const CourseLibrary = z.object({
  /** Newest first. */
  documents: z.array(CourseDocument),
  /** The bytes of the course's documents, each counted in full. */
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
});
export type CourseLibrary = z.infer<typeof CourseLibrary>;

/** The body of `409 quota_exceeded`, beside `error` and `message`. */
export const QuotaExceeded = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
});
export type QuotaExceeded = z.infer<typeof QuotaExceeded>;

/**
 * The refusals of an upload the screen words, by code: `415
 * document_unsupported` (neither a PDF nor a Markdown file, by its bytes),
 * `409 quota_exceeded` ({@link QuotaExceeded}) and `413 file_too_large`
 * (`{ maxBytes }`: past `DOCUMENT_MAX_BYTES`, or a Markdown file past
 * {@link DOCUMENT_MARKDOWN_MAX_BYTES}).
 */
export const DOCUMENT_UPLOAD_REFUSALS = ["document_unsupported", "quota_exceeded", "file_too_large"] as const;
export type DocumentUploadRefusal = (typeof DOCUMENT_UPLOAD_REFUSALS)[number];

/** `PATCH /admin/courses/:id/documents-quota`, and its reply. */
export const DocumentsQuotaPatch = z.object({
  quotaBytes: z.number().int().nonnegative().max(DOCUMENTS_QUOTA_LIMIT_BYTES),
});
export type DocumentsQuotaPatch = z.infer<typeof DocumentsQuotaPatch>;
