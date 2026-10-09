/**
 * Bot-signed empty commit (GH-42, deadline commit strategy): same tree as
 * the head commit, pushed as a non-forced fast-forward; a race with a
 * student push fails cleanly (GitHub's 422) and the job retries.
 *
 * Idempotent and recorded (M3-05a, N-RES-08): a branch whose head is
 * already the deadline's commit (`isDone`) gets no second one, and the
 * commit is handed to `beforeMove` BEFORE the ref moves onto it, so that it
 * is a known bot commit from the instant it can carry a run (N-SEC-21), as
 * the restore's commit is (`revert.ts`).
 *
 * The message's local instant comes from `zonedIso` in `@quiz/domain`
 * (M1-01), which replaces classroom's `zurichIso` that lived here.
 */
import type { Octokit } from "octokit";

import { unless404 } from "./app.js";

/**
 * The deadline commit on `branch`: its sha, `"done"` when the head already
 * is one, or null when the branch does not exist in the repository.
 */
export async function pushEmptyCommit(opts: {
  octokit: Octokit;
  org: string;
  repo: string;
  branch: string;
  message: string;
  /** Whether `head` is already the deadline's commit. */
  isDone: (head: string) => Promise<boolean>;
  /** Records the commit before the branch moves onto it. */
  beforeMove: (sha: string) => Promise<void>;
}): Promise<string | "done" | null> {
  const { octokit, org, repo, branch, message } = opts;
  const headSha = await unless404(async () => {
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: org,
      repo,
      ref: `heads/${branch}`,
      request: { retries: 0 },
    });
    return ref.object.sha;
  });
  // Branch absent from the student repository: nothing to mark.
  if (headSha === null) return null;
  if (await opts.isDone(headSha)) return "done";
  const { data: headCommit } = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    { owner: org, repo, commit_sha: headSha },
  );
  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: org,
    repo,
    message,
    tree: headCommit.tree.sha,
    parents: [headSha],
  });
  await opts.beforeMove(commit.sha);
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: org,
    repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });
  return commit.sha;
}
