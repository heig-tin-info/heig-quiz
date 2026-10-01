/**
 * The journal's assets: the files of the repository that are not pages
 * (figures, handouts), copied into the platform when a page references them
 * (D14) and served under the classroom's own access check (D03, N-SEC-13).
 * The content type an asset is served with is `assetContentType` of
 * `@quiz/contracts`, which the upload route checks too (invariant 7).
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
