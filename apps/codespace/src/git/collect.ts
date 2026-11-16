/**
 * The workspace collected at the deadline (ADR-130 §3, §4): Quiz orders,
 * the portal takes a fresh snapshot of `work/` into the host's own
 * `shadow.git`, composes the collected tree — the snapshot, with the kept
 * paths taken from the branch's head on GitHub (the *base*) — and, when it
 * differs from the commit that would otherwise be graded, carries it to
 * GitHub on the temporary ref Quiz named, with one throwaway commit on the
 * base. Quiz then makes the GitHub-signed commit of that tree and moves the
 * branch; the portal never touches a branch.
 *
 * What it never does (the portal's invariants):
 *
 *  - read or run git on the student's `work/.git` (invariant 13): the
 *    snapshot is `shadow.ts`'s, which excludes `.git`; everything else runs
 *    on a temporary bare repository whose object store borrows
 *    `shadow.git`'s and `staging.git`'s as alternates. Nothing is written
 *    into either: the base and target fetched from GitHub, the composed tree
 *    and the throwaway commit land in the temporary repository, removed —
 *    its alternates file and its index with it — on every exit path;
 *  - start a container, or consult the quota: a closed session collects
 *    the same way;
 *  - put the token in argv, a URL, a file or a log line: `gitAuthEnv`
 *    carries it, `redactSecrets` scrubs what git says;
 *  - force anything: the push is `<sha>:<ref>` onto a ref Quiz named under
 *    `refs/quiz/collect/`, never a branch, with no relay declaration and no
 *    `PushEvent`.
 *
 * Every value of the order is checked again here ({@link checkOrder}),
 * before any git process starts: the contract's schema is the first check,
 * this one is the portal's own.
 */
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CodespaceCollectionRequest, CodespaceCollectionResult, CollectionFailure } from "@quiz/contracts";
import {
  collectionTooLarge,
  composeCollectionTree,
  isCollectionRef,
  isSafeBranchName,
  isSafeRepoPath,
  isSha1,
  staleSnapshot,
  type CollectionTreeEntry,
} from "@quiz/domain";

import { snapshot as takeSnapshot, type ShadowResult } from "../sessions/shadow.js";
import { ForgeUnconfiguredError, type Forge, type ForgeOwner } from "./forge.js";
import { git, gitAuthEnv, GitError, redactSecrets, type GitRunOptions } from "./gitRunner.js";
import { credentialRefused, parseRejections } from "./relay.js";
import { stagingPaths } from "./staging.js";
import type { RepoRef } from "./types.js";

/** The order as the route hands it: the request's body and the assignment of its path. */
export interface CollectionOrder extends CodespaceCollectionRequest {
  assignment: string;
}

/** A value of the order the portal refuses (a 400), raised before any git process starts. */
export class CollectionRefused extends Error {
  constructor(readonly field: string) {
    super(`collection order refused: ${field}`);
    this.name = "CollectionRefused";
  }
}

export interface CollectDeps {
  volumesRoot: string;
  /** The `quiz` forge in production: the write grant of ADR-078, unchanged (§13). */
  forge: Pick<Forge, "pushUrl" | "authorization" | "settle" | "invalidate">;
  /** The session's last `PushEvent`, the engine's clock (`staleSnapshot`). */
  lastPushAt: Date | null;
  now?: () => Date;
  /** `shadow.ts`'s snapshot; injectable for the tests of its failure. */
  snapshot?: (volumeDir: string) => Promise<ShadowResult>;
  /** Tries of the fresh snapshot (the root timer may hold the index for a moment), and the wait between them. */
  snapshotTries?: number;
  snapshotWaitMs?: number;
  /** One fetch or push to GitHub. */
  networkTimeoutMs?: number;
  log?: { warn: (o: object, m: string) => void };
}

/** Three tries a second apart (ADR-130 §3). */
const SNAPSHOT_TRIES = 3;
const SNAPSHOT_WAIT_MS = 1000;
/** Below the 60 s Quiz gives the whole call (ADR-130 §5). */
const NETWORK_TIMEOUT_MS = 40_000;

/** The throwaway commit's author: the portal, never the student (`shadow.ts`'s identity). */
const IDENTITY = {
  GIT_AUTHOR_NAME: "codespace-portal",
  GIT_AUTHOR_EMAIL: "portal@codespace.local",
  GIT_COMMITTER_NAME: "codespace-portal",
  GIT_COMMITTER_EMAIL: "portal@codespace.local",
} as const;

/** The portal's own check of every value that reaches git or a path. */
export function checkOrder(order: CollectionOrder): RepoRef {
  if (!isCollectionRef(order.ref)) throw new CollectionRefused("ref");
  if (!isSafeBranchName(order.branch)) throw new CollectionRefused("branch");
  if (!isSha1(order.base)) throw new CollectionRefused("base");
  if (order.target !== null && !isSha1(order.target)) throw new CollectionRefused("target");
  if (!order.keep.every(isSafeRepoPath)) throw new CollectionRefused("keep");
  const [owner, name, ...rest] = order.repository.split("/");
  if (!owner || !name || rest.length > 0 || !/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new CollectionRefused("repository");
  }
  try {
    stagingPaths("/", order.userId, order.assignment);
  } catch {
    throw new CollectionRefused("userId");
  }
  return { owner, name };
}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );
}

/** `git ls-tree -r -z` of `treeish`: blobs, symbolic links and gitlinks, never followed. */
async function listTree(gitDir: string, treeish: string): Promise<CollectionTreeEntry[]> {
  const out = await git(["--git-dir", gitDir, "ls-tree", "-r", "-z", "--full-tree", treeish]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, , sha] = line.slice(0, tab).split(" ") as [string, string, string];
      return { mode, sha, path: line.slice(tab + 1) };
    });
}

/** The fresh snapshot, or the last one when `shadow.git`'s index stays busy; null when there is none. */
async function freshSnapshot(
  volumeDir: string,
  deps: CollectDeps,
): Promise<{ head: string; at: Date; unreadable: number; fresh: boolean } | null> {
  const snap = deps.snapshot ?? takeSnapshot;
  const now = deps.now ?? (() => new Date());
  const tries = deps.snapshotTries ?? SNAPSHOT_TRIES;
  let taken: ShadowResult | null = null;
  for (let attempt = 1; attempt <= tries && taken === null; attempt++) {
    try {
      taken = await snap(volumeDir);
    } catch (err) {
      deps.log?.warn({ attempt, err: redactSecrets(String((err as Error).message ?? err)) }, "collection: snapshot failed");
      if (attempt < tries) await new Promise((r) => setTimeout(r, deps.snapshotWaitMs ?? SNAPSHOT_WAIT_MS));
    }
  }
  const shadow = join(volumeDir, "shadow.git");
  if (!(await isDirectory(shadow))) return null;
  const head = (await git(["--git-dir", shadow, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "")).trim();
  if (!isSha1(head)) return null;
  if (taken !== null) return { head, at: now(), unreadable: taken.unreadable.length, fresh: true };
  const seconds = Number((await git(["--git-dir", shadow, "log", "-1", "--format=%ct", head])).trim());
  return { head, at: new Date(seconds * 1000), unreadable: 0, fresh: false };
}

/** Why a push or a fetch failed, as the contract names it; the detail goes to the log. */
function failureOf(err: unknown): CollectionFailure {
  // Quiz's refusal, an origin the forge does not serve, no forge at all: not an outage.
  if (err instanceof ForgeUnconfiguredError) return "forge_refused";
  if (err instanceof GitError) {
    if (parseRejections(err.stdout).length > 0) return "push_rejected";
    return "forge_unavailable";
  }
  return "forge_unavailable";
}

/**
 * One collection (ADR-130 §3, §4). The caller serializes the collections of
 * one (student, assignment); {@link checkOrder} throws before anything runs.
 */
export async function collectWorkspace(order: CollectionOrder, deps: CollectDeps): Promise<CodespaceCollectionResult> {
  const repo = checkOrder(order);
  const paths = stagingPaths(deps.volumesRoot, order.userId, order.assignment);
  // A workspace never opened has nothing to collect, and gets no `shadow.git` from asking.
  if (!(await isDirectory(paths.workDir))) return { outcome: "no_snapshot" };
  const snap = await freshSnapshot(paths.dir, deps);
  if (snap === null) return { outcome: "no_snapshot" };
  const snapshotAt = snap.at.toISOString();
  if (!snap.fresh && staleSnapshot(snap.at, deps.lastPushAt)) return { outcome: "stale_snapshot", snapshotAt };
  const facts = { snapshotAt, unreadable: snap.unreadable };

  const owner: ForgeOwner = { assignment: order.assignment, student: order.userId };
  const url = deps.forge.pushUrl(repo);
  const timeoutMs = deps.networkTimeoutMs ?? NETWORK_TIMEOUT_MS;
  const work = await mkdtemp(join(tmpdir(), "collect-"));
  let authorization: string | null = null;
  try {
    const repoDir = join(work, "repo.git");
    const local = (args: string[], opts: GitRunOptions = {}) => git(["--git-dir", repoDir, ...args], opts);
    await git(["init", "--bare", "--quiet", repoDir]);
    // The host's own object stores, read only; `staging.git`'s refs make the fetch and the push small.
    const stores = [join(paths.dir, "shadow.git", "objects")];
    if (await isDirectory(join(paths.gitDir, "objects"))) stores.push(join(paths.gitDir, "objects"));
    await writeFile(join(repoDir, "objects", "info", "alternates"), `${stores.join("\n")}\n`, "utf8");

    try {
      authorization = await deps.forge.authorization(repo, owner, url);
    } catch (err) {
      deps.log?.warn({ assignment: order.assignment, student: order.userId, err: (err as Error).name }, "collection: no token");
      return { outcome: "failed", reason: failureOf(err) };
    }
    const env = gitAuthEnv(authorization, url);
    const has = (sha: string) => local(["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
    for (const sha of new Set([order.base, ...(order.target === null ? [] : [order.target])])) {
      if (await has(sha)) continue;
      try {
        await local(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", url, sha], { env, timeoutMs });
      } catch (err) {
        if (err instanceof GitError && credentialRefused(err.message)) deps.forge.invalidate?.(repo, owner);
        deps.log?.warn({ assignment: order.assignment, student: order.userId, err: redactSecrets(String((err as Error).message)) }, "collection: fetch failed");
        return { outcome: "failed", reason: "forge_unavailable" };
      }
    }

    const base = await listTree(repoDir, order.base);
    const entries = composeCollectionTree(await listTree(repoDir, snap.head), base, order.keep);
    const index = { GIT_INDEX_FILE: join(work, "index") };
    await local(["update-index", "-z", "--index-info"], {
      env: index,
      input: entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join(""),
    });
    const tree = (await local(["write-tree"], { env: index })).trim();
    const graded = (await local(["rev-parse", `${order.target ?? order.base}^{tree}`])).trim();
    if (tree === graded) return { outcome: "unchanged", tree, ...facts };

    const known = new Set(base.map((e) => e.sha));
    const fresh = [...new Set(entries.filter((e) => !known.has(e.sha)).map((e) => e.sha))];
    if (fresh.length > 0) {
      const sizes = await local(["cat-file", "--batch-check=%(objectsize)"], { input: `${fresh.join("\n")}\n` });
      if (collectionTooLarge(sizes.split("\n").filter(Boolean).map(Number))) return { outcome: "too_large", ...facts };
    }

    const commit = (await local(["commit-tree", tree, "-p", order.base, "-m", "Workspace collected at the deadline"], { env: IDENTITY })).trim();
    try {
      await local(["push", "--porcelain", "--no-verify", url, `${commit}:${order.ref}`], { env, timeoutMs });
    } catch (err) {
      if (err instanceof GitError && credentialRefused(err.message)) deps.forge.invalidate?.(repo, owner);
      deps.log?.warn({ assignment: order.assignment, student: order.userId, err: redactSecrets(String((err as Error).message)) }, "collection: push failed");
      return { outcome: "failed", reason: failureOf(err) };
    }
    return { outcome: "pushed", tree, commit, ...facts };
  } catch (err) {
    deps.log?.warn({ assignment: order.assignment, student: order.userId, err: redactSecrets(String((err as Error).message ?? err)) }, "collection: git failed");
    return { outcome: "failed", reason: "git_error" };
  } finally {
    await rm(work, { recursive: true, force: true });
    if (authorization !== null) deps.forge.settle?.(authorization);
  }
}
