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
 *   - `GET    /app/api/courses/:id/documents/:documentId/html` — a Markdown
 *     document as rendered at upload ({@link DocumentHtml}), for the viewer;
 *     a PDF has none (the 404 of a missing document);
 *   - `PATCH  /app/api/admin/courses/:id/documents-quota` — the course's
 *     quota, an administrator's alone.
 *
 * Staff only, every one of them. A delete is refused `409 document_in_use`
 * ({@link DocumentInUse}) while a template of the course or an evaluation
 * that is not over provides the document (ADR-144 §7).
 *
 * The student's one exit (ADR-144 §7, F-LIVE-15, invariant 4): the
 * documents the evaluation of their open attempt provides, while the read
 * rule holds (`providedDocumentsReadable`, `@quiz/domain`):
 *
 *   - `GET /app/api/attempts/:id/documents/:documentId/file` — a PDF's
 *     bytes, with `Range`;
 *   - `GET /app/api/attempts/:id/documents/:documentId/html` — a Markdown
 *     document's {@link DocumentHtml}.
 *
 * Every refusal is the 404 of a missing document.
 */
import { z } from "zod";

import { DOCUMENT_KINDS, EVALUATION_STATES, MAX_PROVIDED_DOCUMENTS } from "@quiz/domain";

import { JournalTocEntry, JournalWarning } from "./journal.js";

export { MAX_PROVIDED_DOCUMENTS };

/** The longest title a document may carry: what students will read. */
export const DOCUMENT_TITLE_MAX = 120;
/** The largest Markdown document, in bytes: beyond, it is no course sheet. */
export const DOCUMENT_MARKDOWN_MAX_BYTES = 500_000;
/** The largest document when `DOCUMENT_MAX_BYTES` is not set: 50 MB. */
export const DEFAULT_DOCUMENT_MAX_BYTES = 50_000_000;
/** A course's quota when nobody raised it: 100 MB (decimal units, as `formatBytes` shows them). */
export const DEFAULT_DOCUMENTS_QUOTA_BYTES = 100_000_000;
/** The highest quota an administrator may give a course: 10 GB. */
export const DOCUMENTS_QUOTA_LIMIT_BYTES = 10_000_000_000;
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

/**
 * An evaluation that provides a document (ADR-144 §7): a classroom's, or a
 * template of the course (`template`). What the library tells its staff, so
 * that a refused delete names what holds it.
 */
export const DocumentUse = z.object({
  evaluationId: z.uuid(),
  title: z.string(),
  state: z.enum(EVALUATION_STATES),
  template: z.boolean(),
});
export type DocumentUse = z.infer<typeof DocumentUse>;

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
  /** The evaluations and templates that provide it, by title. */
  usedBy: z.array(DocumentUse),
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

/**
 * The body of `409 document_in_use`, beside `error` and `message`: the
 * templates of the course and the evaluations not yet over that provide the
 * document. A finished evaluation does not hold it: its selection goes with
 * the document.
 */
export const DocumentInUse = z.object({ evaluations: z.array(DocumentUse) });
export type DocumentInUse = z.infer<typeof DocumentInUse>;

/**
 * A document as an evaluation provides it (ADR-144 §7): what the teacher
 * ticked and what the student's panel lists — its title and kind, never its
 * file name, its size or who uploaded it.
 */
export const ProvidedDocument = z.object({ id: z.uuid(), title: z.string(), kind: DocumentKind });
export type ProvidedDocument = z.infer<typeof ProvidedDocument>;

/** The selection of a patch: at most {@link MAX_PROVIDED_DOCUMENTS} documents of the course, in their order, each once. */
export const ProvidedDocumentIds = z
  .array(z.uuid())
  .max(MAX_PROVIDED_DOCUMENTS)
  .refine((ids) => new Set(ids).size === ids.length, "A document is selected once");

/** `/attempts/:id/documents/:documentId`. */
export const AttemptDocumentParam = z.object({ id: z.uuid(), documentId: z.uuid() });
export type AttemptDocumentParam = z.infer<typeof AttemptDocumentParam>;

/**
 * `GET /courses/:id/documents/:documentId/html`: a Markdown document as the
 * server rendered it (`@quiz/docrender`, raw HTML escaped, no image), and
 * the table of contents the viewer's outline reads. The title is the
 * caller's already (the library's row).
 */
export const DocumentHtml = z.object({
  html: z.string(),
  toc: z.array(JournalTocEntry),
});
export type DocumentHtml = z.infer<typeof DocumentHtml>;

/** The body of `409 quota_exceeded`, beside `error` and `message`. */
export const QuotaExceeded = z.object({
  usedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().nonnegative(),
});
export type QuotaExceeded = z.infer<typeof QuotaExceeded>;

/** The body of `413 file_too_large`, beside `error` and `message`: the limit the file went past. */
export const FileTooLarge = z.object({ maxBytes: z.number().int().positive() });
export type FileTooLarge = z.infer<typeof FileTooLarge>;

/**
 * The refusals of an upload the screen words, by code: `415
 * document_unsupported` (neither a PDF nor a Markdown file, by its bytes),
 * `409 quota_exceeded` ({@link QuotaExceeded}) and `413 file_too_large`
 * ({@link FileTooLarge}: past `DOCUMENT_MAX_BYTES`, or a Markdown file past
 * {@link DOCUMENT_MARKDOWN_MAX_BYTES}).
 */
export const DOCUMENT_UPLOAD_REFUSALS = ["document_unsupported", "quota_exceeded", "file_too_large"] as const;
export type DocumentUploadRefusal = (typeof DOCUMENT_UPLOAD_REFUSALS)[number];

/** `PATCH /admin/courses/:id/documents-quota`, and its reply. */
export const DocumentsQuotaPatch = z.object({
  quotaBytes: z.number().int().nonnegative().max(DOCUMENTS_QUOTA_LIMIT_BYTES),
});
export type DocumentsQuotaPatch = z.infer<typeof DocumentsQuotaPatch>;
