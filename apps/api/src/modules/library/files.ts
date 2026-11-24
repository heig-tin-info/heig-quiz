/**
 * What the `library` module's service and its student view both read: its
 * refusals, a document's row type, and where a document's file lives in the
 * content-addressed store and how it is served (ADR-144 §4, §5). A leaf of
 * the module: it imports neither of them.
 */
import { stat } from "node:fs/promises";

import type { DocumentKind, DocumentUploadRefusal } from "@quiz/contracts";

import type { courseDocuments } from "../../db/schema.js";
import { refusalClass, type Refusal } from "../http.js";
import { pathForHash, safeJoin } from "../pool/assets.js";

const REFUSALS = {
  document_unsupported: [415, "a document is a PDF or a Markdown file"],
  file_too_large: [413, "the file is too large"],
  quota_exceeded: [409, "the course's documents would go past its quota"],
  // The row outlived its file: a staging copy holds the rows only, or a disk was lost.
  file_missing: [404, "the document's file is missing"],
  // ADR-144 §7: a template of the course or an evaluation not yet over
  // provides it; the body names them (`DocumentInUse`).
  document_in_use: [409, "an evaluation or a template still provides this document"],
} satisfies Record<DocumentUploadRefusal | "file_missing" | "document_in_use", Refusal>;

export class LibraryError extends refusalClass("LibraryError", REFUSALS) {}

/** A row of `course_documents`. */
export type DocumentRow = typeof courseDocuments.$inferSelect;

/** A document's file, relative to `ASSETS_DIR`, rebuilt from its hash: its own subtree, never the pool's images. */
export const documentPath = (sha256: string) => `documents/${pathForHash(sha256)}`;

/** The type a document's bytes are served as. */
const MIME: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  markdown: "text/markdown; charset=utf-8",
};

/** The document's file, to stream: its absolute path, size and type, or `404 file_missing`. */
export async function documentFile(
  assetsDir: string,
  row: DocumentRow,
): Promise<{ path: string; size: number; type: string; filename: string }> {
  const path = safeJoin(assetsDir, documentPath(row.sha256));
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new LibraryError("file_missing");
  return { path, size: info.size, type: MIME[row.kind], filename: row.filename };
}

