/**
 * The workspace collected at the deadline (ADR-130 §3, §4): Quiz orders,
 * the portal takes a fresh snapshot of `work/` into the host's own
 * `shadow.git`, composes the collected tree — the snapshot, with the kept
 * paths taken from the branch's head on GitHub (the *base*) — and, when it
 * differs from the commit that would otherwise be graded, carries it to
 * GitHub on the temporary ref Quiz named, with one throwaway commit on the
 * base. `pushed` means only that: Quiz checks the pushed tree, makes the
 * GitHub-signed commit and moves the branch; the portal never touches a
 * branch, and only Quiz knows whether the collection succeeded.
 *
 * What it reads and writes:
 *
 *  - the collection itself reads only `shadow.git` and `staging.git`, the
 *    host's own repositories, and writes only a temporary bare repository
 *    ({@link composeTree}) whose object store borrows theirs as alternates:
 *    the base and target fetched from GitHub, the composed tree and the
 *    throwaway commit land there, and it is removed — its alternates file and
 *    its index with it — on every exit path. Nothing is written into
 *    `shadow.git` but the snapshot, nor into `staging.git` at all;
 *  - the snapshot it triggers is `shadow.ts`'s (`git add -A` with `.git`
 *    excluded), with that module's known limit: a nested repository's
 *    gitfile is followed to record a gitlink, which the collection then
 *    leaves out (`composeCollectionTree`);
 *  - no container is started and the quota is not consulted: a closed
 *    session collects the same way;
 *  - the token is in no argv, URL, file or log line: `gitAuthEnv` carries
 *    it, `redactSecrets` scrubs what git says;
 *  - nothing is forced: the push is `<sha>:<ref>` onto the ref Quiz named
 *    under `refs/quiz/collect/`, never a branch, with no relay declaration
 *    and no `PushEvent`.
 *
 * The order reaches here parsed by its contract (`CodespaceCollectionRequest`)
 * in the portal's own process: every value is checked before this runs.
 * The whole collection fits one time budget, under the minute Quiz waits.
 */
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Sha1, type CodespaceCollectionRequest, type CodespaceCollectionResult, type CollectionFailure } from "@quiz/contracts";
import { collectionKeptPaths, composeCollectionTree, staleSnapshot, type CollectionTreeEntry } from "@quiz/domain";

import { snapshot as takeSnapshot, type ShadowResult } from "../sessions/shadow.js";
import { ForgeUnconfiguredError, type Forge, type ForgeOwner } from "./forge.js";
import { git, gitAuthEnv, GitError, redactSecrets, type GitRunOptions } from "./gitRunner.js";
import { credentialRefused, parseRejections } from "./relay.js";
import { RECEIVE_MAX_INPUT_BYTES, stagingPaths } from "./staging.js";

/** The order as the route hands it: the parsed body and the assignment of its path. */
export type CollectionOrder = CodespaceCollectionRequest & { assignment: string };

export interface CollectDeps {
  volumesRoot: string;
  /** The `quiz` forge in production: the write grant of ADR-078, unchanged (§13). */
  forge: Pick<Forge, "pushUrl" | "authorization" | "settle" | "invalidate">;
  /** The session's last `PushEvent`, the engine's clock (`staleSnapshot`). */
  lastPushAt: Date | null;
  /** `shadow.ts`'s snapshot; injectable for the tests of its failure. */
  snapshot?: (volumeDir: string) => Promise<ShadowResult>;
  /** Tries of the fresh snapshot (the root timer may hold the index for a moment), and the wait between them. */
  snapshotTries?: number;
  snapshotWaitMs?: number;
  /** The whole collection's time budget. */
  budgetMs?: number;
  log?: { warn: (o: object, m: string) => void };
}

/** Three tries a second apart (ADR-130 §3). */
const SNAPSHOT_TRIES = 3;
const SNAPSHOT_WAIT_MS = 1000;
/** Under the 60 s Quiz gives the call (ADR-130 §5): past it, nothing more is pushed. */
export const COLLECTION_BUDGET_MS = 45_000;

/** The throwaway commit's author: the portal, never the student (`shadow.ts`'s identity). */
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

interface Snapshot {
  head: string;
  at: Date;
  /** Null for the last snapshot taken before: its unreadable count is not known. */
  unreadable: number | null;
  fresh: boolean;
}

/** The fresh snapshot, or the last one when `shadow.git`'s index stays busy; null when there is none. */
async function freshSnapshot(volumeDir: string, deps: CollectDeps, left: () => number): Promise<Snapshot | null> {
  const snap = deps.snapshot ?? takeSnapshot;
  const tries = deps.snapshotTries ?? SNAPSHOT_TRIES;
  let taken: ShadowResult | null = null;
  for (let attempt = 1; attempt <= tries && taken === null; attempt++) {
    try {
      taken = await withinBudget(snap(volumeDir), left());
    } catch (err) {
      if (err instanceof OutOfTime) throw err;
      deps.log?.warn({ attempt, err: redactSecrets(String((err as Error).message ?? err)) }, "collection: snapshot failed");
      if (attempt < tries) await new Promise((r) => setTimeout(r, deps.snapshotWaitMs ?? SNAPSHOT_WAIT_MS));
    }
  }
  const shadow = join(volumeDir, "shadow.git");
  if (!(await isDirectory(shadow))) return null;
  const head = (await git(["--git-dir", shadow, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "")).trim();
  if (!Sha1.safeParse(head).success) return null;
  if (taken !== null) return { head, at: new Date(), unreadable: taken.unreadable.length, fresh: true };
  const seconds = Number((await git(["--git-dir", shadow, "log", "-1", "--format=%ct", head])).trim());
  return { head, at: new Date(seconds * 1000), unreadable: null, fresh: false };
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
 * the snapshot's tree with the kept paths — Quiz's list, the workflows
 * added whatever it says (`collectionKeptPaths`) — taken from the base,
 * built in a temporary index beside it. The base's entries, to size what is
 * new.
 */
async function composeTree(
  repoDir: string,
  snapshotHead: string,
  order: CollectionOrder,
): Promise<{ tree: string; base: CollectionTreeEntry[]; entries: CollectionTreeEntry[] }> {
  const base = await listTree(repoDir, order.base);
  const entries = composeCollectionTree(await listTree(repoDir, snapshotHead), base, collectionKeptPaths(order.keep));
  const index = { GIT_INDEX_FILE: join(dirname(repoDir), "index") };
  await git(["--git-dir", repoDir, "update-index", "-z", "--index-info"], {
    env: index,
    input: entries.map((e) => `${e.mode} ${e.sha}\t${e.path}\0`).join(""),
  });
  const tree = (await git(["--git-dir", repoDir, "write-tree"], { env: index })).trim();
  return { tree, base, entries };
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

  const paths = stagingPaths(deps.volumesRoot, order.userId, order.assignment);
  // A workspace never opened has nothing to collect, and gets no `shadow.git` from asking.
  if (!(await isDirectory(paths.workDir))) return { outcome: "no_snapshot" };
  let snap: Snapshot | null;
  try {
    snap = await freshSnapshot(paths.dir, deps, left);
  } catch (err) {
    return fail("timeout", err, "out of time at the snapshot");
  }
  if (snap === null) return { outcome: "no_snapshot" };
  const snapshotAt = snap.at.toISOString();
  if (!snap.fresh && staleSnapshot(snap.at, deps.lastPushAt)) return { outcome: "stale_snapshot", snapshotAt };
  const facts = { snapshotAt, unreadable: snap.unreadable };

  const url = deps.forge.pushUrl(repo);
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

    const { tree, base, entries } = await composeTree(repoDir, snap.head, order);
    if (tree === (await local(["rev-parse", `${order.target ?? order.base}^{tree}`])).trim()) return { outcome: "unchanged", ...facts };

    // One cap, a student push's (`receive.maxInputSize`), which GitHub's per-file limit does not exceed.
    const known = new Set(base.map((e) => e.sha));
    const fresh = [...new Set(entries.filter((e) => !known.has(e.sha)).map((e) => e.sha))];
    if (fresh.length > 0) {
      const sizes = (await local(["cat-file", "--batch-check=%(objectsize)"], { input: `${fresh.join("\n")}\n` })).split("\n").filter(Boolean).map(Number);
      if (sizes.reduce((sum, n) => sum + n, 0) > RECEIVE_MAX_INPUT_BYTES) return { outcome: "too_large", ...facts };
    }

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
