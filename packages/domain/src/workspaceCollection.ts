/**
 * The online workspace collected at the deadline (ADR-130 §3): which paths
 * stay the repository's, how the collected tree is composed, and what stands
 * for a file the confined reader could not read. The values of Quiz's order
 * are checked by its contract (`@quiz/contracts`), not here.
 */
import { WORKFLOWS_DIR } from "./protectedFiles.js";
import type { OnlineModeName } from "./workMode.js";

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

/** The proper ancestors of `path` (`a/b/c` → `a`, `a/b`). */
function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let at = path.indexOf("/"); at !== -1; at = path.indexOf("/", at + 1)) out.push(path.slice(0, at));
  return out;
}

/** "`path` is one of `roots` or lies under one", linear in the path's depth, not in the roots. */
function underAny(roots: Iterable<string>): (path: string) => boolean {
  const set = new Set(roots);
  return (path) => set.has(path) || ancestors(path).some((a) => set.has(a));
}

/**
 * A tree with its kept paths taken from another, as a flat sorted list:
 * `snapshot`'s entries, except those under a kept path — whatever the
 * snapshot did to them, changed, deleted or replaced —, plus `base`'s
 * entries under a kept path. A snapshot entry that would be a file where a
 * kept entry needs a directory goes too. The one rule of the collection
 * (ADR-130 §3) and of the graded commit (ADR-132 §2).
 */
export function overlayTree(
  snapshot: readonly CollectionTreeEntry[],
  base: readonly CollectionTreeEntry[],
  kept: readonly string[],
): CollectionTreeEntry[] {
  // Linear in the entries times their depth: a student controls how many there are.
  const isKept = underAny(kept);
  const keptBase = base.filter((e) => isKept(e.path));
  // A kept entry's path, or a directory it needs: no snapshot entry may stand there.
  const needed = new Set(keptBase.flatMap((k) => [k.path, ...ancestors(k.path)]));
  const fromSnapshot = snapshot.filter((e) => !isKept(e.path) && !needed.has(e.path));
  return [...fromSnapshot, ...keptBase].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The collected tree (ADR-130 §3): {@link overlayTree} of the snapshot
 * without its gitlinks (a nested repository the student cloned: a commit id
 * the repository cannot resolve).
 */
export function composeCollectionTree(
  snapshot: readonly CollectionTreeEntry[],
  base: readonly CollectionTreeEntry[],
  kept: readonly string[],
): CollectionTreeEntry[] {
  return overlayTree(
    snapshot.filter((e) => e.mode !== GITLINK_MODE),
    base,
    kept,
  );
}

/** The paths whose entry (mode and object) differs between two trees, one present in either: sorted. */
export function treeDifference(a: readonly CollectionTreeEntry[], b: readonly CollectionTreeEntry[]): string[] {
  const key = (e: CollectionTreeEntry) => `${e.mode} ${e.sha}`;
  const left = new Map(a.map((e) => [e.path, key(e)]));
  const right = new Map(b.map((e) => [e.path, key(e)]));
  return [...new Set([...left.keys(), ...right.keys()])].filter((path) => left.get(path) !== right.get(path)).sort();
}

/** `git ls-tree -r -z --full-tree`'s output read as entries: blobs, symbolic links and gitlinks, never followed. */
export function parseLsTree(out: string): CollectionTreeEntry[] {
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, , sha] = line.slice(0, tab).split(" ") as [string, string, string];
      return { mode, sha, path: line.slice(tab + 1) };
    });
}

/** Entries as `git update-index -z --index-info` reads them. */
export const indexInfo = (entries: readonly CollectionTreeEntry[]): string => entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join("");

/**
 * The workspace's entries with what the confined reader could not read
 * (ADR-130 §3, correction of 2026-11-16) taken from `reference` — the commit
 * that would otherwise be graded: the student's last push in time, else the
 * base. `unreadable` names files and directories; a directory stands for
 * everything under it. A path the
 * reference does not hold is left out: the reader never saw its content, so
 * nothing of it is handed in.
 */
export function withUnreadableKept(
  workspace: readonly CollectionTreeEntry[],
  reference: readonly CollectionTreeEntry[],
  unreadable: readonly string[],
): CollectionTreeEntry[] {
  if (unreadable.length === 0) return [...workspace];
  const covered = underAny(unreadable);
  return [...workspace.filter((e) => !covered(e.path)), ...reference.filter((e) => covered(e.path))];
}

/** Every entry under a kept path is the base's, none added, none removed (ADR-130 §4.3: what Quiz checks before signing). */
export function keptEntriesMatch(
  collected: readonly CollectionTreeEntry[],
  base: readonly CollectionTreeEntry[],
  kept: readonly string[],
): boolean {
  const isKept = underAny(kept);
  const under = (entries: readonly CollectionTreeEntry[]) =>
    entries
      .filter((e) => isKept(e.path))
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

/**
 * The student's last push by the deadline, as the collection weighs it
 * (ADR-149 §2): `relayed` when it came from the online workspace — its head
 * one the portal declared before relaying it (`codespace_relays`), or the
 * commit an earlier collection signed.
 */
export interface CollectionLastPush {
  relayed: boolean;
}

/**
 * Whether the deadline collects a repository's workspace (ADR-130 §2 as
 * amended by ADR-149 §2), once the repository is otherwise due (a workspace
 * launched, the deadline applied, no lock): always in `online` and
 * `online_seb`, where only the workspace writes; in `hybrid`, the last
 * writer wins — collected when the student's last push came from the
 * workspace or there was none, never over a push from their own machine
 * (`last_push_local`).
 */
export function collectsWorkspace(mode: OnlineModeName, last: CollectionLastPush | null): boolean {
  return mode !== "hybrid" || last === null || last.relayed;
}

/** What Quiz records of a collection (ADR-130 §7): the portal's answers, and Quiz's own. */
export const COLLECTION_OUTCOMES = [
  "collected",
  "unchanged",
  "no_snapshot",
  "branch_not_handed_out",
  "too_large",
  "too_late",
  "failed",
  "last_push_local",
] as const;
export type CollectionOutcomeName = (typeof COLLECTION_OUTCOMES)[number];

/**
 * Why the portal failed a collection: Quiz or GitHub refused the
 * credential, GitHub or Quiz could not be reached, GitHub refused the push,
 * git failed on the host, the confined reader of the workspace failed or
 * its archive was refused (`read_failed`), or its time budget ran out. The
 * contract's list.
 */
export const COLLECTION_PORTAL_FAILURES = ["forge_refused", "forge_unavailable", "push_rejected", "git_error", "read_failed", "timeout"] as const;

/**
 * Why a collection failed, the portal's reasons and Quiz's: the portal
 * unreachable or out of contract, the pushed tree refused by the check
 * before signing, GitHub refusing a read or a write, an order a crash
 * interrupted (settled by the next job).
 */
export const COLLECTION_FAILURE_REASONS = [...COLLECTION_PORTAL_FAILURES, "portal_unavailable", "check_refused", "github_failed", "interrupted"] as const;
export type CollectionFailureReason = (typeof COLLECTION_FAILURE_REASONS)[number];

/**
 * A stored collection's outcome and reason as the current lists know them:
 * a value no list holds any more (a row written before an outcome was
 * removed, as `stale_snapshot` on 2026-11-16) reads as `failed` with no
 * reason, so no reader past the database ever meets it. Null (ordered,
 * never settled) stays null. Kept on purpose rather than a data migration:
 * no migration number to race, and a value removed later cannot break the
 * staff's sheet again.
 */
export function storedCollection(
  outcome: string | null,
  reason: string | null,
): { outcome: CollectionOutcomeName | null; reason: CollectionFailureReason | null } {
  const known = (outcome === null || (COLLECTION_OUTCOMES as readonly string[]).includes(outcome)) &&
    (reason === null || (COLLECTION_FAILURE_REASONS as readonly string[]).includes(reason));
  if (!known) return { outcome: "failed", reason: null };
  return { outcome: outcome as CollectionOutcomeName | null, reason: reason as CollectionFailureReason | null };
}

/**
 * The largest one student push may carry (the portal's `receive.maxInputSize`),
 * within GitHub's per-file limit, and the largest the files a collection
 * reads from the workspace may be in all.
 */
export const WORKSPACE_PUSH_MAX_BYTES = 100 * 1024 * 1024;
