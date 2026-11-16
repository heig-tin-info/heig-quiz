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

/**
 * A snapshot older than the session's last push would hand in less than
 * was pushed (ADR-130 §3): `stale_snapshot`, nothing collected. Both
 * instants are the engine VM's clock.
 */
export const staleSnapshot = (snapshotAt: Date, lastPushAt: Date | null): boolean =>
  lastPushAt !== null && snapshotAt.getTime() < lastPushAt.getTime();
