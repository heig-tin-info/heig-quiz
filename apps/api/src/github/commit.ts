/**
 * A GitHub-signed commit of the App on a branch (`signedCommit.ts`), pushed
 * as a non-forced fast-forward: the deadline commit (GH-42, the `commit`
 * strategy; an empty commit, the head's own tree) and the workspace's
 * collection at the deadline (ADR-130 §4.3; a tree the caller checks on
 * the head it goes on).
 *
 * Recorded (M3-05a, N-RES-08): the commit is handed to `beforeMove` BEFORE
 * the ref moves onto it, so that it is known from the instant it can carry
 * a run (N-SEC-21), as the restore's commit is (`revert.ts`); when it never
 * reaches the branch, `notMoved` undoes that. A race with a push fails
 * cleanly (GitHub's 422): retried on the new head while `tries` last, else
 * thrown — the deadline job retries the deadline commit. Any other failure of
 * the move is read against the branch: GitHub may have moved it anyway.
 *
 * The message's local instant comes from `zonedIso` in `@quiz/domain`
 * (M1-01), which replaces classroom's `zurichIso` that lived here.
 */
import type { Octokit } from "octokit";

import { branchHead, githubStatus } from "./app.js";
import { signedCommit } from "./signedCommit.js";

export interface CommitOnBranchInput {
  octokit: Octokit;
  org: string;
  repo: string;
  branch: string;
  message: string;
  /** The tree to commit on `head`; by default the head's own (an empty commit). Null refuses: nothing is signed. */
  treeFor?: (head: string) => Promise<string | null>;
  /** Whether `head` already is this commit: nothing more to do. */
  isDone?: (head: string) => Promise<boolean>;
  /** Records the commit before the branch moves onto it. */
  beforeMove: (sha: string) => Promise<void>;
  /** The commit did not reach the branch: undoes what `beforeMove` recorded. */
  notMoved?: (sha: string) => Promise<void>;
  /** Commits tried when the head moves meanwhile (a 422); one by default. */
  tries?: number;
}

/**
 * The commit on the branch: its sha, `"done"` when the head already is one
 * (with `isDone` only), `"refused"` when `treeFor` refused (with `treeFor`
 * only), or null when the branch does not exist.
 */
export function commitOnBranch(opts: CommitOnBranchInput & { treeFor: NonNullable<CommitOnBranchInput["treeFor"]>; isDone?: undefined }): Promise<string | "refused" | null>;
export function commitOnBranch(opts: CommitOnBranchInput & { treeFor?: undefined }): Promise<string | "done" | null>;
export async function commitOnBranch(opts: CommitOnBranchInput): Promise<string | "done" | "refused" | null> {
  const { octokit, org, repo, branch, message } = opts;
  const tries = opts.tries ?? 1;
  for (let attempt = 1; ; attempt++) {
    const head = await branchHead(octokit, org, repo, branch);
    if (head === null) return null;
    if (await opts.isDone?.(head)) return "done";
    const tree = opts.treeFor
      ? await opts.treeFor(head)
      : (await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner: org, repo, commit_sha: head })).data.tree.sha;
    if (tree === null) return "refused";
    const sha = await signedCommit({ octokit, owner: org, repo, tree, parents: [head], message });
    await opts.beforeMove(sha);
    try {
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", { owner: org, repo, ref: `heads/${branch}`, sha, force: false });
      return sha;
    } catch (err) {
      // Not GitHub's refusal: the move may have happened before the failure reached us.
      if (githubStatus(err) !== 422 && (await branchHead(octokit, org, repo, branch).catch(() => null)) === sha) return sha;
      await opts.notMoved?.(sha);
      if (githubStatus(err) !== 422 || attempt >= tries) throw err;
    }
  }
}

/** The deadline's empty commit on `branch` (GH-42): its sha, `"done"` when the head already is one, or null without the branch. */
export function pushEmptyCommit(opts: Omit<CommitOnBranchInput, "treeFor" | "notMoved" | "tries">): Promise<string | "done" | null> {
  return commitOnBranch(opts);
}
