/**
 * The online workspace collected at the deadline (ADR-130): the pure rules
 * Quiz and the portal share — which branch, which paths stay the
 * repository's, how the collected tree is composed, when a snapshot is too
 * old or too large — and the checks every value of the order passes before
 * it reaches git (the contract's schema and the portal both apply them).
 */
import { WORKFLOWS_DIR, isProtected } from "./protectedFiles.js";
import { pathWithin } from "./studentIgnore.js";

/** Where the portal carries the collected tree: never a branch (ADR-130 §4, ADR-078 §13). */
export const COLLECTION_REF_PREFIX = "refs/quiz/collect/";

/**
 * A temporary ref Quiz names for one collection: under
 * {@link COLLECTION_REF_PREFIX}, one component of letters, digits, `-` and
 * `_` — no dot, so no `..` nor `.lock`, no slash, no space.
 */
export const isCollectionRef = (ref: string): boolean => /^refs\/quiz\/collect\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ref);

/** The temporary ref of `repoId`'s collection at `deadline`: unique per repository and effective deadline. */
export function collectionRef(repoId: string, deadline: Date): string {
  return `${COLLECTION_REF_PREFIX}${repoId}-${Math.floor(deadline.getTime() / 1000)}`;
}

/** A full SHA-1 commit id, as GitHub names one: 40 lowercase hex digits. */
export const isSha1 = (sha: string): boolean => /^[0-9a-f]{40}$/.test(sha);

/**
 * A path inside a repository that may reach git as a name: relative, its
 * segments non-empty and neither `.` nor `..` nor `.git`, not starting with
 * `-` (an option) nor `/`, no backslash and no control character.
 */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024 || path.startsWith("-")) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment.toLowerCase() !== ".git");
}

/**
 * A handed-out branch name that may reach git: `git check-ref-format
 * --branch`'s rules, narrowed to letters, digits, `.`, `_`, `-` and `/`
 * (no `..`, no `//`, no segment starting with `.` or `-`, no `.lock` end).
 */
export function isSafeBranchName(branch: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) return false;
  if (branch.includes("..") || branch.endsWith(".lock") || branch.endsWith(".")) return false;
  return branch.split("/").every((segment) => segment !== "" && !segment.startsWith(".") && !segment.startsWith("-"));
}

/**
 * The branch the collection commits to (ADR-130 §3). The host cannot know
 * which branch `work/` has checked out (it never reads `work/.git`), so: the
 * branch of the student's last push when it was handed out; the first
 * handed-out branch when the student never pushed; null —
 * `branch_not_handed_out`, nothing collected — when the last push went to
 * a branch that was not handed out, or none was.
 */
export function collectionBranch(handedOut: readonly string[], lastPushBranch: string | null): string | null {
  if (lastPushBranch === null) return handedOut[0] ?? null;
  return handedOut.includes(lastPushBranch) ? lastPushBranch : null;
}

/**
 * The paths a collection takes from the branch's head instead of the
 * workspace (ADR-130 §3): the project's protected files, as the project
 * stores them (`withForcedProtected` already applied), and the workflows
 * always — a `contents`-only grant cannot change them.
 */
export function collectionKeptPaths(protectedFiles: readonly string[]): string[] {
  return [...new Set([...protectedFiles, WORKFLOWS_DIR])];
}

/** One entry of a recursive tree listing (`git ls-tree -r`): a blob, a symbolic link or a gitlink. */
export interface CollectionTreeEntry {
  /** `100644`, `100755`, `120000` (a symbolic link) or `160000` (a gitlink). */
  mode: string;
  sha: string;
  path: string;
}

/** A gitlink's mode: a submodule's commit, never content. */
export const GITLINK_MODE = "160000";

/**
 * The collected tree (ADR-130 §3), as a flat sorted list: the snapshot's
 * entries, except those under a kept path — whatever the snapshot did to
 * them, changed, deleted or replaced — and its gitlinks (a nested
 * repository the student cloned: a commit id the repository cannot
 * resolve); plus the base's entries under a kept path. A snapshot entry
 * that would be a file where a kept entry needs a directory goes too.
 */
export function composeCollectionTree(
  snapshot: readonly CollectionTreeEntry[],
  base: readonly CollectionTreeEntry[],
  kept: readonly string[],
): CollectionTreeEntry[] {
  const keptBase = base.filter((e) => isProtected(e.path, kept));
  const fromSnapshot = snapshot.filter(
    (e) => e.mode !== GITLINK_MODE && !isProtected(e.path, kept) && !keptBase.some((k) => pathWithin(k.path, e.path)),
  );
  return [...fromSnapshot, ...keptBase].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * A snapshot older than the session's last push would hand in less than
 * was pushed (ADR-130 §3): `stale_snapshot`, nothing collected. Both
 * instants are the engine VM's clock.
 */
export const staleSnapshot = (snapshotAt: Date, lastPushAt: Date | null): boolean =>
  lastPushAt !== null && snapshotAt.getTime() < lastPushAt.getTime();

/** GitHub refuses a file over 100 MiB. */
export const COLLECTION_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** What one collection may carry, the cap of one student push (`receive.maxInputSize`). */
export const COLLECTION_MAX_BYTES = 100 * 1024 * 1024;

/** `too_large` (ADR-130 §3): the sizes of the blobs the base does not hold yet. */
export function collectionTooLarge(newBlobBytes: readonly number[]): boolean {
  let total = 0;
  for (const bytes of newBlobBytes) {
    if (bytes > COLLECTION_MAX_FILE_BYTES) return true;
    total += bytes;
  }
  return total > COLLECTION_MAX_BYTES;
}
