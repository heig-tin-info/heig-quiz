/**
 * Bot-signed empty commit (GH-42, deadline commit strategy): same tree as
 * the head commit, pushed as a non-forced fast-forward; a race with a
 * student push fails cleanly and the job retries.
 *
 * The message's local instant comes from `zonedIso` in `@quiz/domain`
 * (M1-01), which replaces classroom's `zurichIso` that lived here.
 */
import type { Octokit } from "octokit";

export async function pushEmptyCommit(opts: {
  octokit: Octokit;
  org: string;
  repo: string;
  branch: string;
  message: string;
}): Promise<string | null> {
  const { octokit, org, repo, branch, message } = opts;
  let headSha: string;
  try {
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner: org,
      repo,
      ref: `heads/${branch}`,
      request: { retries: 0 },
    });
    headSha = ref.object.sha;
  } catch (err) {
    // Branch absent from the student repository: nothing to mark.
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
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
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: org,
    repo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });
  return commit.sha;
}
