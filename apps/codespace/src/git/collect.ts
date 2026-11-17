/**
 * The workspace collected at the deadline (ADR-130 §3, §4): the portal reads
 * `work/` through its confined reader (`engine/reader.ts`, the portal's
 * invariant 15 — of `work/` this file only asks whether it exists), composes
 * the collected tree — the workspace, what the reader could not read taken
 * from the commit that would otherwise be graded, the kept paths from the
 * branch's head on GitHub (the *base*) — and, when it differs from that
 * commit, pushes one throwaway commit of it on the base to the temporary ref
 * Quiz named. `pushed` means only that: Quiz checks, signs and moves the
 * branch.
 *
 * It writes only a temporary bare repository under `<VOLUMES_ROOT>/.collect/`
 * (the portal's `/tmp` is a tmpfs in its memory), borrowing `staging.git`'s
 * objects, removed on every exit and swept at startup. It never reads
 * `shadow.git`. The token is in no argv, URL, file or log line, and never
 * near the reader. Nothing is forced: `<sha>:<ref>` under
 * `refs/quiz/collect/`, never a branch, no relay declaration, no
 * `PushEvent`. The order is parsed by its contract before this runs; the
 * whole collection fits one time budget, under the minute Quiz waits.
 */
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type CodespaceCollectionRequest, type CodespaceCollectionResult, type CollectionFailure } from "@quiz/contracts";
import { collectionKeptPaths, composeCollectionTree, indexInfo, parseLsTree, withUnreadableKept, type CollectionTreeEntry } from "@quiz/domain";

import { ReaderError, ReaderTimeout, type WorkspaceReader } from "../engine/reader.js";
import { ForgeUnconfiguredError, type Forge, type ForgeOwner } from "./forge.js";
import { git, gitAuthEnv, GitError, redactSecrets, type GitRunOptions } from "./gitRunner.js";
import { credentialRefused, parseRejections } from "./relay.js";
import { RECEIVE_MAX_INPUT_BYTES, stagingPaths } from "./staging.js";
import { ArchiveRefused, ArchiveTooLarge } from "./workArchive.js";
import { COLLECTION_ENTRIES_MAX, readWorkTree, type WorkTree } from "./workTree.js";

/** The order as the route hands it: the parsed body and the assignment of its path. */
export type CollectionOrder = CodespaceCollectionRequest & { assignment: string };

export interface CollectDeps {
  volumesRoot: string;
  /** The `quiz` forge in production: the write grant of ADR-078, unchanged (§13). */
  forge: Pick<Forge, "pushUrl" | "authorization" | "settle" | "invalidate">;
  /** The confined reader of `work/` (`engine/reader.ts`). */
  reader: WorkspaceReader;
  /** The whole collection's time budget. */
  budgetMs?: number;
  /** The cap on the workspace's files; the tests lower it. */
  maxBytes?: number;
  /** The cap on the workspace's entries; the tests lower it. */
  maxEntries?: number;
  log?: { warn: (o: object, m: string) => void };
}

/** Under the 60 s Quiz gives the call (ADR-130 §5): past it, nothing more is pushed. */
export const COLLECTION_BUDGET_MS = 45_000;

/** Where the collections' temporary repositories live: the volumes' disk, the portal's own directory. */
export const collectionDirsRoot = (volumesRoot: string) => join(volumesRoot, ".collect");

/** Removes what a crash left of the collections' temporary repositories (startup only: none runs then). */
export async function sweepCollectionDirs(volumesRoot: string): Promise<void> {
  await rm(collectionDirsRoot(volumesRoot), { recursive: true, force: true });
}

/** The throwaway commit's author: the portal, never the student (the shadow snapshot's identity). */
const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/** The budget ran out: the collection stops where it is. */
class OutOfTime extends Error {}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** `git ls-tree -r -z` of `treeish`: blobs, symbolic links and gitlinks, never followed. */
async function listTree(gitDir: string, treeish: string): Promise<CollectionTreeEntry[]> {
  return parseLsTree(await git(["--git-dir", gitDir, "ls-tree", "-r", "-z", "--full-tree", treeish]));
}

/** `work`, or {@link OutOfTime} once `ms` have passed; the work left running writes only what it would have. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) throw new OutOfTime();
  let timer: NodeJS.Timeout | undefined;
  const out = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new OutOfTime()), ms);
  });
  try {
    return await Promise.race([work, out]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The collected tree, written into the temporary repository `repoDir` only:
 * the workspace's entries, what the reader could not read taken from the
 * commit that would otherwise be graded, and the kept paths — Quiz's list,
 * the workflows added whatever it says (`collectionKeptPaths`) — taken from
 * the base, built in a temporary index beside it. Null past
 * `maxEntries` (`COLLECTION_ENTRIES_MAX`).
 */
async function composeTree(repoDir: string, read: WorkTree, order: CollectionOrder, maxEntries: number): Promise<string | null> {
  const base = await listTree(repoDir, order.base);
  const reference = order.target === null ? base : await listTree(repoDir, order.target);
  const workspace = withUnreadableKept(read.entries, reference, read.unreadable);
  // An unreadable directory brings in everything the graded commit holds under it: the cap again, after.
  if (workspace.length + read.skipped > maxEntries) return null;
  const entries = composeCollectionTree(workspace, base, collectionKeptPaths(order.keep));
  const index = { GIT_INDEX_FILE: join(repoDir, "..", "index") };
  await git(["--git-dir", repoDir, "update-index", "-z", "--index-info"], {
    env: index,
    input: indexInfo(entries),
  });
  return (await git(["--git-dir", repoDir, "write-tree"], { env: index })).trim();
}

/**
 * One collection (ADR-130 §3, §4), within {@link COLLECTION_BUDGET_MS}. The
 * caller serializes the collections of one (student, assignment).
 */
export async function collectWorkspace(order: CollectionOrder, deps: CollectDeps): Promise<CodespaceCollectionResult> {
  const started = Date.now();
  const left = () => (deps.budgetMs ?? COLLECTION_BUDGET_MS) - (Date.now() - started);
  const [owner, name] = order.repository.split("/") as [string, string];
  const repo = { owner, name };
  const forgeOwner: ForgeOwner = { assignment: order.assignment, student: order.userId };
  const fail = (reason: CollectionFailure, err: unknown, what: string): CodespaceCollectionResult => {
    const message = err instanceof Error ? redactSecrets(err.message) : String(err);
    deps.log?.warn({ assignment: order.assignment, student: order.userId, reason, err: message }, `collection: ${what}`);
    return { outcome: "failed", reason };
  };
  /** A fetch, a push or the token request failed: why, in one place; a refused credential is forgotten. */
  const forgeFailure = (err: unknown): CollectionFailure => {
    if (err instanceof OutOfTime || left() <= 0) return "timeout";
    if (err instanceof ForgeUnconfiguredError) return "forge_refused";
    if (err instanceof GitError && credentialRefused(err.message)) {
      deps.forge.invalidate?.(repo, forgeOwner);
      return "forge_refused";
    }
    if (err instanceof GitError && parseRejections(err.stdout).length > 0) return "push_rejected";
    return "forge_unavailable";
  };
  /** The reader or its archive failed: why. */
  const readFailure = (err: unknown): CollectionFailure => {
    if (err instanceof ReaderTimeout || left() <= 0) return "timeout";
    return err instanceof ReaderError || err instanceof ArchiveRefused ? "read_failed" : "git_error";
  };

  const caps = { maxBytes: deps.maxBytes ?? RECEIVE_MAX_INPUT_BYTES, maxEntries: deps.maxEntries ?? COLLECTION_ENTRIES_MAX };
  const paths = stagingPaths(deps.volumesRoot, order.userId, order.assignment);
  // A workspace never opened has nothing to collect. The one thing the host asks of `work/`.
  if (!(await isDirectory(paths.workDir))) return { outcome: "no_snapshot" };

  const url = deps.forge.pushUrl(repo);
  await mkdir(collectionDirsRoot(deps.volumesRoot), { recursive: true });
  const work = await mkdtemp(join(collectionDirsRoot(deps.volumesRoot), "c-"));
  let authorization: string | null = null;
  try {
    const repoDir = join(work, "repo.git");
    const local = (args: string[], opts: GitRunOptions = {}) => git(["--git-dir", repoDir, ...args], opts);
    await git(["init", "--bare", "--quiet", repoDir]);
    // The host's own `staging.git`, read only: its objects make the fetch and the push small.
    if (await isDirectory(join(paths.gitDir, "objects"))) {
      await writeFile(join(repoDir, "objects", "info", "alternates"), `${join(paths.gitDir, "objects")}\n`, "utf8");
    }

    const snapshotAt = new Date().toISOString();
    let read: WorkTree;
    try {
      read = await readWorkTree(deps.reader, paths.workDir, repoDir, left(), caps);
    } catch (err) {
      if (err instanceof ArchiveTooLarge) return { outcome: "too_large", snapshotAt, unreadable: err.unreadable };
      return fail(readFailure(err), err, "the workspace could not be read");
    }
    const facts = { snapshotAt, unreadable: read.unreadable.length + read.skipped };

    try {
      const asked = deps.forge.authorization(repo, forgeOwner, url);
      // Out of time, the token may still land: settled then, as every token handed out is.
      // The `quiz` forge's cache would revoke it at its `useUntil`, except one that landed
      // after `forget` (an orphan, `quizForge.ts` `request`), which only `settle` revokes.
      authorization = await withinBudget(asked, left()).catch((err: unknown) => {
        if (err instanceof OutOfTime) void asked.then((late) => deps.forge.settle?.(late), () => undefined);
        throw err;
      });
      const env = gitAuthEnv(authorization, url);
      for (const sha of new Set([order.base, ...(order.target === null ? [] : [order.target])])) {
        const has = await local(["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
        if (!has) await local(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, sha], { env, timeoutMs: Math.max(1, left()) });
      }
    } catch (err) {
      return fail(forgeFailure(err), err, "the base could not be read from GitHub");
    }

    const tree = await composeTree(repoDir, read, order, caps.maxEntries);
    if (tree === null) return { outcome: "too_large", ...facts };
    if (tree === (await local(["rev-parse", `${order.target ?? order.base}^{tree}`])).trim()) return { outcome: "unchanged", ...facts };

    const commit = (await local(["commit-tree", tree, "-p", order.base, "-m", "Workspace collected at the deadline"], { env: IDENTITY })).trim();
    if (left() <= 0) return fail("timeout", new OutOfTime(), "out of time before the push");
    try {
      await local(["push", "--porcelain", "--no-verify", url, `${commit}:${order.ref}`], { env: gitAuthEnv(authorization, url), timeoutMs: left() });
    } catch (err) {
      return fail(forgeFailure(err), err, "the push failed");
    }
    return { outcome: "pushed", tree, ...facts };
  } catch (err) {
    return fail("git_error", err, "git failed on the host");
  } finally {
    await rm(work, { recursive: true, force: true });
    if (authorization !== null) deps.forge.settle?.(authorization);
  }
}
