/**
 * The teacher's update in a staging repository (ADR-132 §11).
 *
 * A teacher's sync hands every student repository the distribution's new
 * commit on `sync/<branch>`. In an `online` workspace the student cannot
 * merge that pull request; instead the portal fetches the commit, BY ITS
 * SHA — the one the platform's assignment sync names, never a ref's —,
 * onto `refs/quiz/update/<branch>` of the student's staging repository,
 * and the workspace's status bar offers to merge it, inside the container,
 * as the student (`images/c-dev/extension/update.js`).
 *
 *   - `refs/quiz/` is the portal's own namespace: never a branch, so the
 *     relay never carries it (`diffRefs` ignores it too), a student's push
 *     never collides with it, and nothing the student pushed moves.
 *     `receive.hideRefs` refuses every student push to it, a deletion
 *     included, so nobody plants an "update" in it;
 *   - the fetch happens only when a ref is missing or elsewhere (derived
 *     from the repository's state), one at a time per staging repository,
 *     bounded in time; a failure throws to the caller, which logs it and
 *     tries again at the next occasion;
 *   - the authorization, asked for only when a fetch is needed, reaches git
 *     through the environment only (`gitAuthEnv`), as the seeding's does.
 *
 * Host git runs on `staging.git` only, the portal's repository, never on a
 * student's `work/.git` (the portal's invariant 13).
 */
import { BranchName, Sha1 } from "@quiz/contracts";

import { gitAuthEnv, gitBare } from "./gitRunner.js";
import { guardPortalRefs, PORTAL_REFS, refSnapshot } from "./staging.js";

/** Where a branch's update lands. */
export const updateRef = (branch: string): string => `${PORTAL_REFS}/update/${branch}`;

/** One fetch of the update never takes longer: GitHub down must not hold anything for long. */
export const UPDATE_FETCH_TIMEOUT_MS = 60_000;

export interface UpdateHead {
  branch: string;
  sha: string;
}

export interface FetchUpdateOptions {
  gitDir: string;
  /** The student's repository on the forge, where each commit sits on `sync/<branch>`. */
  url: string;
  heads: readonly UpdateHead[];
  /** The forge's `Authorization`, asked for only when something is fetched. */
  authorize?: () => Promise<string | undefined>;
  /** The fetch that used an authorization is over (`Forge.settle`). */
  settle?: (authorization: string) => void;
  timeoutMs?: number;
}

/** A second wall behind the contract: a refspec is built from these two only. */
function checked(head: UpdateHead): UpdateHead {
  if (!BranchName.safeParse(head.branch).success || !Sha1.safeParse(head.sha).success) {
    throw new Error(`invalid update head ${JSON.stringify(head.branch)}`);
  }
  return head;
}

/** The heads whose ref is missing from the staging repository or names another commit. */
export async function missingUpdates(gitDir: string, heads: readonly UpdateHead[]): Promise<UpdateHead[]> {
  const refs = await refSnapshot(gitDir);
  return heads.map(checked).filter((h) => refs.get(updateRef(h.branch)) !== h.sha);
}

/** Whether the branch's update ref is in the staging repository at `sha`: what `push-status` may announce. */
export async function updateAt(gitDir: string, branch: string, sha: string): Promise<boolean> {
  const found = await gitBare(gitDir, ["rev-parse", "--verify", "--quiet", updateRef(branch)]).catch(() => "");
  return found.trim() === sha;
}

/** One operation at a time per staging repository. */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const settled = run.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}

/**
 * Brings the staging repository's update refs to the heads given: nothing
 * when they are there already (`current`), else one fetch of the missing
 * commits by sha (`fetched`). Throws on a failure; the refs it did not set
 * stay as they were.
 */
export function fetchProjectUpdate(opts: FetchUpdateOptions): Promise<"current" | "fetched"> {
  return oneAtATime(opts.gitDir, async () => {
    const missing = await missingUpdates(opts.gitDir, opts.heads);
    if (missing.length === 0) return "current";
    // A staging repository seeded before this rule existed gets it here.
    await guardPortalRefs(opts.gitDir);
    const authorization = await opts.authorize?.();
    try {
      await gitBare(
        opts.gitDir,
        ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", opts.url, ...missing.map((h) => `+${h.sha}:${updateRef(h.branch)}`)],
        {
          ...(authorization ? { env: gitAuthEnv(authorization, opts.url) } : {}),
          timeoutMs: opts.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS,
        },
      );
    } finally {
      if (authorization) opts.settle?.(authorization);
    }
    return "fetched";
  });
}
