/**
 * The journal's assets: the files of the repository that are not pages
 * (figures, handouts), copied into the platform when a page references them
 * (D14) and served under the classroom's own access check (D03, N-SEC-13).
 */
import { JOURNAL_ASSETS_PATH } from "@quiz/contracts";

/**
 * The URL the platform serves a journal asset at. Classroom-scoped: with one
 * journal per classroom (D03) every classroom keeps its own copy, so the
 * rendered HTML of one classroom never names another. Each path segment is
 * percent-encoded; the `/` between them are kept.
 */
export function journalAssetUrl(classroomId: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `${JOURNAL_ASSETS_PATH(classroomId)}/${encoded}`;
}

/** Content types served for the extensions a journal may carry. */
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  pdf: "application/pdf",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  py: "text/plain",
};

/**
 * The content type an asset is served with, from its extension; anything
 * unknown is `application/octet-stream` (downloaded, never rendered). An
 * upload must declare exactly this type (F-JRN-11).
 */
export function assetContentType(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
