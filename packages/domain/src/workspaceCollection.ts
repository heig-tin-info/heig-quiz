/**
 * The online workspace collected at the deadline (ADR-130 §3): which paths
 * stay the repository's, how the collected tree is composed, and when the
 * last snapshot is too old to stand for the workspace. The values of Quiz's
 * order are checked by its contract (`@quiz/contracts`), not here.
 */
import { WORKFLOWS_DIR, isProtected } from "./protectedFiles.js";
import { pathWithin } from "./studentIgnore.js";

/**
 * The paths a collection takes from the branch's head instead of the
 * workspace (ADR-130 §3): the project's protected files, as the project
 * stores them (`withForcedProtected` already applied), and the workflows
 * always — a `contents`-only grant cannot change them. The portal applies it
 * to Quiz's list again, so the workflows stay kept whatever the list says.
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

/** Every entry under a kept path is the base's, none added, none removed (ADR-130 §4.3: what Quiz checks before signing). */
export function keptEntriesMatch(
  collected: readonly CollectionTreeEntry[],
  base: readonly CollectionTreeEntry[],
  kept: readonly string[],
): boolean {
  const under = (entries: readonly CollectionTreeEntry[]) =>
    entries
      .filter((e) => isProtected(e.path, kept))
      .map((e) => `${e.mode} ${e.sha} ${e.path}`)
      .sort();
  const [a, b] = [under(collected), under(base)];
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/** Where the portal carries the collected tree: never a branch (ADR-130 §4, ADR-078 §13). */
export const COLLECTION_REF_PREFIX = "refs/quiz/collect/";

/** The temporary ref of `repoId`'s collection at `deadline`: unique per repository and effective deadline. */
export function collectionRef(repoId: string, deadline: Date): string {
  return `${COLLECTION_REF_PREFIX}${repoId}-${Math.floor(deadline.getTime() / 1000)}`;
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

/** Quiz sends an order only this long after the effective deadline, on its own clock (ADR-130 §5). */
export const COLLECTION_ORDER_WINDOW_MS = 120_000;

/** `too_late` (ADR-130 §5): the order would leave later than the window after the deadline. */
export const collectionTooLate = (deadline: Date, now: Date): boolean =>
  now.getTime() - deadline.getTime() > COLLECTION_ORDER_WINDOW_MS;

/** What Quiz records of a collection (ADR-130 §7): the portal's answers, and Quiz's own. */
export const COLLECTION_OUTCOMES = [
  "collected",
  "unchanged",
  "no_snapshot",
  "stale_snapshot",
  "branch_not_handed_out",
  "too_large",
  "too_late",
  "failed",
] as const;
export type CollectionOutcomeName = (typeof COLLECTION_OUTCOMES)[number];

/**
 * Why the portal failed a collection: Quiz or GitHub refused the
 * credential, GitHub or Quiz could not be reached, GitHub refused the push,
 * git failed on the host, or its time budget ran out. The contract's list.
 */
export const COLLECTION_PORTAL_FAILURES = ["forge_refused", "forge_unavailable", "push_rejected", "git_error", "timeout"] as const;

/**
 * Why a collection failed, the portal's reasons and Quiz's: the portal
 * unreachable or out of contract, the pushed tree refused by the check
 * before signing, GitHub refusing a read or a write, an order a crash
 * interrupted (settled by the next job).
 */
export const COLLECTION_FAILURE_REASONS = [...COLLECTION_PORTAL_FAILURES, "portal_unavailable", "check_refused", "github_failed", "interrupted"] as const;
export type CollectionFailureReason = (typeof COLLECTION_FAILURE_REASONS)[number];

/** The largest a collection or one student push may carry (the portal's `receive.maxInputSize`), within GitHub's per-file limit. */
export const WORKSPACE_PUSH_MAX_BYTES = 100 * 1024 * 1024;

/**
 * A snapshot older than the session's last push would hand in less than
 * was pushed (ADR-130 §3): `stale_snapshot`, nothing collected. Both
 * instants are the engine VM's clock.
 */
export const staleSnapshot = (snapshotAt: Date, lastPushAt: Date | null): boolean =>
  lastPushAt !== null && snapshotAt.getTime() < lastPushAt.getTime();
