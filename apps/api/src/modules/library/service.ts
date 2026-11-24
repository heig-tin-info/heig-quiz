/**
 * The `library` module (F-ORG-18, F-ADMIN-10, ADR-144): the PDF and Markdown
 * documents of a course, uploaded by its staff.
 *
 *   - {@link receiveUpload}: the upload streamed to a temporary file while
 *     it is hashed (never a whole Buffer of 50 MB on the process that serves
 *     live exams), then its kind decided by its bytes alone (N-SEC-24);
 *   - {@link storeDocument}: the quota checked and the row inserted in one
 *     transaction that locks the course, the file renamed into the
 *     content-addressed store `ASSETS_DIR/documents/<sha[0:2]>/<sha256>`.
 *     The same bytes twice in one course are one document; in two courses,
 *     two rows and one file, each counted in full in its course's quota —
 *     and the reply never says whether another course holds them;
 *   - {@link deleteDocument}: the row only. A request never unlinks a file:
 *     it touches its time, and {@link sweepDocumentFiles}, a daily task,
 *     removes the files no row names once they are 48 hours old;
 *   - {@link documentHtml}: a Markdown document's stored rendering, for the
 *     viewer; {@link rerenderDocuments}, in the same daily task, renders
 *     again from its file a document an older renderer rendered.
 *
 * This module owns `course_documents` and is its only writer. It reads
 * `courses` (the quota) and locks its row; `org` writes it.
 */
import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import {
  DOCUMENT_MARKDOWN_MAX_BYTES,
  type CourseDocument,
  type CourseLibrary,
  type DocumentHtml,
  type DocumentKind,
  type DocumentUploadRefusal,
} from "@quiz/contracts";
import { RENDERER_VERSION, renderStandalone } from "@quiz/docrender";

import { iso } from "../../clock.js";
import type { Db, Tx } from "../../db/client.js";
import { courseDocuments, courses, users } from "../../db/schema.js";
import { refusalClass, type Refusal } from "../http.js";
import { dropTemp, pathForHash, placeTemp, safeJoin, streamToTemp, type TempFile } from "../pool/assets.js";

const REFUSALS = {
  document_unsupported: [415, "a document is a PDF or a Markdown file"],
  file_too_large: [413, "the file is too large"],
  quota_exceeded: [409, "the course's documents would go past its quota"],
  // The row outlived its file: a staging copy holds the rows only, or a disk was lost.
  file_missing: [404, "the document's file is missing"],
} satisfies Record<DocumentUploadRefusal | "file_missing", Refusal>;

export class LibraryError extends refusalClass("LibraryError", REFUSALS) {}

/** The store's directory, under `ASSETS_DIR`: its own subtree, never the pool's images. */
const DOCUMENTS_DIR = "documents";
/** Where uploads are streamed before they are placed: the same file system, so a rename. */
const TMP_DIR = `${DOCUMENTS_DIR}/tmp`;
/** How long a file no row names is kept: a delete racing an upload of the same bytes, a restored dump. */
export const SWEEP_GRACE_MS = 48 * 60 * 60 * 1000;

/** A document's file, relative to `ASSETS_DIR`, rebuilt from its hash. */
export const documentPath = (sha256: string) => `${DOCUMENTS_DIR}/${pathForHash(sha256)}`;

/** The type a document's bytes are served as. */
const MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  markdown: "text/markdown; charset=utf-8",
};

type Row = typeof courseDocuments.$inferSelect;

/** An upload written to its temporary file and recognised: {@link storeDocument} places it, or it is dropped. */
export interface ReceivedDocument {
  temp: TempFile;
  kind: DocumentKind;
  filename: string;
  /** A Markdown document's rendering. */
  rendering: { html: string; toc: Row["toc"]; warnings: Row["warnings"] } | null;
}

/**
 * The uploaded name as the staff will read it: its last path segment (a
 * browser may send `C:\fakepath\…`), without control characters, at most
 * 255 characters; `document` when nothing is left.
 */
export function cleanFilename(name: string | undefined): string {
  const last = (name ?? "").split(/[\\/]/).pop() ?? "";
  const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return clean === "" ? "document" : clean;
}

/** The title a new document gets: its file name without the extension, at most 120 characters. */
export function titleOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const stem = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return (stem === "" ? filename : stem).slice(0, 120).trim();
}

const MARKDOWN_NAME = /\.(md|markdown)$/i;

/** The text of a Markdown file, or null when the bytes are not UTF-8 or carry a NUL. */
function markdownText(bytes: Buffer): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/**
 * An upload, streamed to a temporary file and recognised by its bytes, never
 * by the type the browser declared (N-SEC-24): `%PDF-` is a PDF; otherwise a
 * file named `.md` or `.markdown`, valid UTF-8 without NUL and at most
 * {@link DOCUMENT_MARKDOWN_MAX_BYTES}, is Markdown, rendered here; anything
 * else `415`. Past the multipart cap the stream is cut: `413`. A refusal
 * removes the temporary file.
 */
export async function receiveUpload(
  assetsDir: string,
  upload: { filename: string | undefined; file: Readable & { truncated?: boolean } },
  maxBytes: number,
): Promise<ReceivedDocument> {
  const temp = await streamToTemp(assetsDir, TMP_DIR, upload.file);
  try {
    if (upload.file.truncated) throw new LibraryError("file_too_large", undefined, { maxBytes });
    if (temp.bytes === 0) throw new LibraryError("document_unsupported");
    const filename = cleanFilename(upload.filename);
    if (temp.head.subarray(0, 5).toString("latin1") === "%PDF-") {
      return { temp, kind: "pdf", filename, rendering: null };
    }
    if (!MARKDOWN_NAME.test(filename)) throw new LibraryError("document_unsupported");
    if (temp.bytes > DOCUMENT_MARKDOWN_MAX_BYTES) {
      throw new LibraryError("file_too_large", undefined, { maxBytes: DOCUMENT_MARKDOWN_MAX_BYTES });
    }
    const text = markdownText(await readFile(temp.path));
    if (text === null) throw new LibraryError("document_unsupported");
    const { html, toc, warnings } = renderStandalone(text);
    return { temp, kind: "markdown", filename, rendering: { html, toc, warnings } };
  } catch (error) {
    await dropTemp(temp.path);
    throw error;
  }
}

/**
 * Stores a received document in `courseId`'s library (ADR-144), in one
 * transaction that locks the course row: the same bytes already in this
 * course answer that document (`created: false`, no quota spent); otherwise
 * the course's documents plus this one must fit its quota (`409
 * quota_exceeded` with `usedBytes` and `quotaBytes`), the file is renamed
 * into the store and the row inserted. Nothing here looks at another
 * course. The temporary file is gone afterwards, whatever happened.
 */
export async function storeDocument(
  db: Db,
  assetsDir: string,
  courseId: string,
  received: ReceivedDocument,
  by: string,
  now: Date,
): Promise<{ row: Row; created: boolean }> {
  const { temp } = received;
  try {
    return await db.transaction(async (tx) => {
      const [course] = await tx
        .select({ quotaBytes: courses.documentsQuotaBytes })
        .from(courses)
        .where(eq(courses.id, courseId))
        .for("update");
      if (!course) throw new Error(`course ${courseId} vanished under an upload`);
      const [existing] = await tx
        .select()
        .from(courseDocuments)
        .where(and(eq(courseDocuments.courseId, courseId), eq(courseDocuments.sha256, temp.sha256)));
      if (existing) return { row: existing, created: false };
      const usedBytes = await usedBytesOf(tx, courseId);
      if (usedBytes + temp.bytes > course.quotaBytes) {
        throw new LibraryError("quota_exceeded", undefined, { usedBytes, quotaBytes: course.quotaBytes });
      }
      // The sweep holds the same lock while it re-checks and removes a file:
      // the file this row will name is never removed under it.
      await lockFile(tx, temp.sha256);
      // The file's time is the server's (invariant 5): the sweep's grace counts from it.
      const full = await placeTemp(assetsDir, temp, documentPath(temp.sha256));
      await utimes(full, now, now);
      const [row] = await tx
        .insert(courseDocuments)
        .values({
          id: randomUUID(),
          courseId,
          title: titleOf(received.filename),
          filename: received.filename,
          kind: received.kind,
          sha256: temp.sha256,
          bytes: temp.bytes,
          ...(received.rendering ? { ...received.rendering, renderedWith: RENDERER_VERSION } : {}),
          uploadedBy: by,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return { row: row!, created: true };
    });
  } finally {
    await dropTemp(temp.path);
  }
}

/**
 * The lock of one file of the store, until the transaction ends: the upload
 * that is about to name it and the sweep that is about to remove it take it
 * in turn.
 */
async function lockFile(tx: Tx, sha256: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`library:${sha256}`}))`);
}

/** The bytes the course's documents use, each counted in full. */
async function usedBytesOf(db: Db | Tx, courseId: string): Promise<number> {
  const [sum] = await db
    .select({ bytes: sql<number>`coalesce(sum(${courseDocuments.bytes}), 0)`.mapWith(Number) })
    .from(courseDocuments)
    .where(eq(courseDocuments.courseId, courseId));
  return sum?.bytes ?? 0;
}

/** A document of `courseId`, or null: another course's is as missing as one that never existed. */
export async function documentOfCourse(db: Db, courseId: string, documentId: string): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(courseDocuments)
    .where(and(eq(courseDocuments.courseId, courseId), eq(courseDocuments.id, documentId)));
  return row ?? null;
}

/** Whether the document's file is on disk. */
async function present(assetsDir: string, sha256: string): Promise<boolean> {
  return stat(safeJoin(assetsDir, documentPath(sha256))).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** What a staff member may do: delete what they uploaded, or anything as an owner of the course. */
export interface Viewer {
  id: string;
  owner: boolean;
}

/** Whether `viewer` may delete the document: its uploader, or an owner of the course. */
export function mayDelete(row: Pick<Row, "uploadedBy">, viewer: Viewer): boolean {
  return viewer.owner || row.uploadedBy === viewer.id;
}

/** A row as its staff read it. */
function documentView(
  row: Row,
  uploader: { givenName: string; familyName: string; email: string },
  viewer: Viewer,
  missing: boolean,
): CourseDocument {
  const name = `${uploader.givenName} ${uploader.familyName}`.trim();
  return {
    id: row.id,
    title: row.title,
    filename: row.filename,
    kind: row.kind,
    bytes: row.bytes,
    uploadedAt: iso(row.createdAt),
    uploadedBy: { id: row.uploadedBy, name: name || uploader.email },
    warnings: row.warnings ?? [],
    missing,
    canDelete: mayDelete(row, viewer),
  };
}

/** The library of a course: its documents, newest first, the bytes they use and its quota. */
export async function libraryOf(
  db: Db,
  assetsDir: string,
  course: { id: string; documentsQuotaBytes: number },
  viewer: Viewer,
): Promise<CourseLibrary> {
  const rows = await db
    .select({ row: courseDocuments, uploader: { givenName: users.givenName, familyName: users.familyName, email: users.email } })
    .from(courseDocuments)
    .innerJoin(users, eq(users.id, courseDocuments.uploadedBy))
    .where(eq(courseDocuments.courseId, course.id))
    .orderBy(desc(courseDocuments.createdAt), desc(courseDocuments.id));
  const documents = await Promise.all(
    rows.map(async ({ row, uploader }) =>
      documentView(row, uploader, viewer, !(await present(assetsDir, row.sha256))),
    ),
  );
  return {
    documents,
    usedBytes: rows.reduce((sum, { row }) => sum + row.bytes, 0),
    quotaBytes: course.documentsQuotaBytes,
  };
}

/** One document as its staff read it (the reply of an upload or a rename). */
export async function documentOf(db: Db, assetsDir: string, row: Row, viewer: Viewer): Promise<CourseDocument> {
  const [uploader] = await db
    .select({ givenName: users.givenName, familyName: users.familyName, email: users.email })
    .from(users)
    .where(eq(users.id, row.uploadedBy));
  return documentView(row, uploader!, viewer, !(await present(assetsDir, row.sha256)));
}

/** A new title: what students will read. */
export async function renameDocument(db: Db, row: Row, title: string, now: Date): Promise<Row> {
  const [updated] = await db
    .update(courseDocuments)
    .set({ title, updatedAt: now })
    .where(eq(courseDocuments.id, row.id))
    .returning();
  return updated!;
}

/**
 * Deletes the row, never the file: another course may name the same bytes,
 * and an upload of them may be on its way. The file's time is touched, so
 * the sweep's grace starts now.
 */
export async function deleteDocument(db: Db, assetsDir: string, row: Row, now: Date): Promise<void> {
  // The time first: between the two, the row still names the file, and once
  // it does not the file is too recent for the sweep.
  await utimes(safeJoin(assetsDir, documentPath(row.sha256)), now, now).catch(() => undefined);
  await db.delete(courseDocuments).where(eq(courseDocuments.id, row.id));
}

/** The document's file, to stream: its absolute path, size and type, or `404 file_missing`. */
export async function documentFile(
  assetsDir: string,
  row: Row,
): Promise<{ path: string; size: number; type: string; filename: string }> {
  const path = safeJoin(assetsDir, documentPath(row.sha256));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new LibraryError("file_missing");
  return { path, size: info.size, type: MIME[row.kind], filename: row.filename };
}

/** A Markdown document's rendering as stored at upload (or by the last re-rendering); null for a PDF. */
export function documentHtml(row: Row): DocumentHtml | null {
  if (row.kind !== "markdown" || row.html === null) return null;
  return { title: row.title, html: row.html, toc: row.toc ?? [] };
}

/**
 * The Markdown documents an older renderer rendered (`rendered_with` below
 * `RENDERER_VERSION`, or never stamped) rendered again from their file
 * (ADR-144 §3), as the journal's `sweepRenderer` does for its pages: run by
 * the library's daily task, never by a read. A row whose file is missing (a
 * staging copy) or no longer reads as Markdown keeps its rendering and is
 * tried again next time; the update is conditional, so a row re-rendered
 * meanwhile is not written twice. Answers how many were rendered again.
 */
export async function rerenderDocuments(db: Db, assetsDir: string): Promise<number> {
  const stale = or(isNull(courseDocuments.renderedWith), lt(courseDocuments.renderedWith, RENDERER_VERSION));
  const due = await db
    .select({ id: courseDocuments.id, sha256: courseDocuments.sha256 })
    .from(courseDocuments)
    .where(and(eq(courseDocuments.kind, "markdown"), stale));
  let rendered = 0;
  for (const { id, sha256 } of due) {
    const bytes = await readFile(safeJoin(assetsDir, documentPath(sha256))).catch(() => null);
    const text = bytes === null ? null : markdownText(bytes);
    if (text === null) continue;
    const { html, toc, warnings } = renderStandalone(text);
    const updated = await db
      .update(courseDocuments)
      .set({ html, toc, warnings, renderedWith: RENDERER_VERSION })
      .where(and(eq(courseDocuments.id, id), stale))
      .returning({ id: courseDocuments.id });
    rendered += updated.length;
  }
  return rendered;
}

/** A file of the store the sweep may remove: absolute, and the hash its name is (or a temporary name). */
export interface SweepCandidate {
  path: string;
  sha256: string | null;
}

/**
 * The files under `ASSETS_DIR/documents/` that no row named when listed —
 * the documents' files and the temporary files an upload left behind —
 * whose time is older than {@link SWEEP_GRACE_MS}.
 */
export async function sweepCandidates(db: Db, assetsDir: string, now: Date): Promise<SweepCandidate[]> {
  const root = safeJoin(assetsDir, DOCUMENTS_DIR);
  let shards;
  try {
    shards = await readdir(root, { withFileTypes: true });
  } catch {
    return []; // No document was ever stored.
  }
  const named = new Set((await db.selectDistinct({ sha: courseDocuments.sha256 }).from(courseDocuments)).map((r) => r.sha));
  const cutoff = now.getTime() - SWEEP_GRACE_MS;
  const candidates: SweepCandidate[] = [];
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const temporary = shard.name === "tmp";
    const dir = join(root, shard.name);
    for (const name of await readdir(dir)) {
      if (!temporary && named.has(name)) continue;
      const info = await stat(join(dir, name)).catch(() => null);
      if (info?.isFile() && info.mtimeMs <= cutoff) {
        candidates.push({ path: join(dir, name), sha256: temporary ? null : name });
      }
    }
  }
  return candidates;
}

/**
 * Removes one candidate, unless something claimed it since it was listed:
 * under the file's lock, the one {@link storeDocument} takes before it
 * places the file and inserts its row, no row names it and its time is
 * still past the grace. Answers whether it was removed.
 */
export async function removeIfUnnamed(db: Db, candidate: SweepCandidate, now: Date): Promise<boolean> {
  const { path, sha256 } = candidate;
  if (sha256 === null) {
    await rm(path, { force: true });
    return true;
  }
  return db.transaction(async (tx) => {
    await lockFile(tx, sha256);
    const [named] = await tx
      .select({ id: courseDocuments.id })
      .from(courseDocuments)
      .where(eq(courseDocuments.sha256, sha256))
      .limit(1);
    if (named) return false;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.mtimeMs > now.getTime() - SWEEP_GRACE_MS) return false;
    await rm(path, { force: true });
    return true;
  });
}

/**
 * The daily sweep (ADR-144 §4): every candidate that is still unnamed when
 * its turn comes, removed. A file just placed or just released by a delete
 * carries the time of that request and is kept; a course deleted takes its
 * rows at once, and its files follow at the next pass. Answers how many.
 */
export async function sweepDocumentFiles(db: Db, assetsDir: string, now: Date): Promise<number> {
  let removed = 0;
  for (const candidate of await sweepCandidates(db, assetsDir, now)) {
    if (await removeIfUnnamed(db, candidate, now)) removed += 1;
  }
  return removed;
}
