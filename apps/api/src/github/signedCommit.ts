/**
 * THE way the platform creates a commit in a repository on GitHub (#917):
 * `POST /git/commits` authenticated as the App, WITHOUT `author` nor
 * `committer`. GitHub then signs it with its web-flow key (the Verified
 * badge; anyone can check it with `gpg --verify` against
 * https://github.com/web-flow.gpg) and attributes it to `<slug>[bot]`, so
 * the platform's commits cannot be imitated in appearance by a student. The
 * input has no field for an identity: none can be passed.
 *
 * Only the commit object: the caller builds its tree (the Git Data API, or
 * a throwaway git commit pushed beforehand) and moves the ref itself, after
 * recording the sha where it must (N-RES-08, N-SEC-21).
 *
 * A tree pushed a moment ago may not be visible to the API yet (a fresh
 * repository settles asynchronously, `provision.ts`): a 404 or a 422 whose
 * message says the tree or an object does not exist is retried with the
 * waits of `retry.ts`; any other failure is thrown at once.
 */
import type { Octokit } from "octokit";

import { RETRY_DELAYS_MS } from "./retry.js";

export interface SignedCommitInput {
  octokit: Octokit;
  owner: string;
  repo: string;
  /** The tree's sha, already in the repository on GitHub. */
  tree: string;
  /** The parents' shas: none for a root commit. */
  parents: string[];
  message: string;
}

/** GitHub's words for a tree or a parent it does not know (yet): "Tree SHA does not exist", "Not Found". */
const NOT_YET_THERE = /does not exist|not found/i;

function notYetThere(err: unknown): boolean {
  const { status, message } = err as { status?: number; message?: unknown };
  return (status === 404 || status === 422) && NOT_YET_THERE.test(String(message ?? ""));
}

/** The sha of the GitHub-signed commit of `tree` on `parents`. */
export async function signedCommit({ octokit, owner, repo, tree, parents, message }: SignedCommitInput): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const { data } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message,
        tree,
        parents,
      });
      return data.sha;
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length || !notYetThere(err)) throw err;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}
