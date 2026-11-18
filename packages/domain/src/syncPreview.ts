/**
 * The source's sync, previewed (ADR-132 §10, ADR-073 §2): what the
 * distribution would add, modify and delete on a branch, each path marked
 * protected or not, and the teacher's message that goes with the sync.
 */
import { isProtected } from "./protectedFiles.js";

/** What a sync does to a path of the distribution, by git's name-status (a type change is a modification). */
export const SYNC_CHANGES = ["added", "modified", "deleted"] as const;
export type SyncChange = (typeof SYNC_CHANGES)[number];

/** The paths a preview lists per branch at most; the rest are counted. */
export const SYNC_PREVIEW_PATHS_MAX = 200;

/** The teacher's message to the students, at most this many characters once trimmed. */
export const SYNC_MESSAGE_MAX = 500;

export interface SyncPreviewPath {
  path: string;
  change: SyncChange;
  /** Under the project's protected list (`criteria.yml` and the workflows in `criteria` mode). */
  protected: boolean;
}

/**
 * One branch's changes as the preview lists them: each path marked against
 * the project's protected `entries`, the protected ones first (a cap never
 * hides what grading takes), then by path; at most `max`, `more` counting
 * the rest.
 */
export function previewPaths(
  changes: readonly { path: string; change: SyncChange }[],
  entries: readonly string[],
  max: number = SYNC_PREVIEW_PATHS_MAX,
): { paths: SyncPreviewPath[]; more: number } {
  const marked = changes.map((c) => ({ path: c.path, change: c.change, protected: isProtected(c.path, entries) }));
  marked.sort((a, b) => Number(b.protected) - Number(a.protected) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { paths: marked.slice(0, max), more: Math.max(0, marked.length - max) };
}
