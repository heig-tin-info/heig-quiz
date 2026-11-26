/**
 * What Quiz reads on GitHub before it signs a workspace's collection
 * (ADR-130 §4.3): the commit the portal pushed on the temporary ref, and the
 * entries under the kept paths of the tree to sign against a head's. Next
 * to `revert.ts`, which reads trees for the protected files too.
 */
import type { Octokit } from "octokit";

import { keptEntriesMatch, type CollectionTreeEntry } from "@quiz/domain";

import { unless404 } from "./app.js";

/** `git ls-tree -r` of a tree on GitHub, or null when GitHub truncated it (the check then refuses). */
async function treeEntries(octokit: Octokit, owner: string, repo: string, tree: string): Promise<CollectionTreeEntry[] | null> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", { owner, repo, tree_sha: tree, recursive: "1" });
  if (data.truncated) return null;
  return data.tree.filter((e) => e.type !== "tree").map((e) => ({ mode: e.mode ?? "", sha: e.sha ?? "", path: e.path ?? "" }));
}

/** Whether the commit on `ref` (`refs/…`) is `tree` with `base` as its one parent; false when the ref is missing. */
export async function pushedCommitIs(octokit: Octokit, owner: string, repo: string, ref: string, base: string, tree: string): Promise<boolean> {
  const pushed = await unless404(async () => (await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: ref.slice("refs/".length) })).data.object.sha);
  if (pushed === null) return false;
  const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: pushed });
  return commit.tree.sha === tree && commit.parents.length === 1 && commit.parents[0]?.sha === base;
}

/** Whether every entry of `tree` under `kept` is `head`'s, none added, none removed; false on a truncated listing. */
export async function keptEntriesHold(octokit: Octokit, owner: string, repo: string, tree: string, head: string, kept: readonly string[]): Promise<boolean> {
  const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: head });
  const [collected, before] = await Promise.all([treeEntries(octokit, owner, repo, tree), treeEntries(octokit, owner, repo, commit.tree.sha)]);
  return collected !== null && before !== null && keptEntriesMatch(collected, before, kept);
}

/**
 * Whether the commit `sha` is in `branch`'s history — its head, or behind
 * it (a student's push relayed on top): GitHub's compare of `sha...branch`
 * says `identical` or `ahead`. False when GitHub does not know the commit;
 * any other failure throws (an outage is no answer).
 */
export async function collectionLanded(octokit: Octokit, owner: string, repo: string, sha: string, branch: string): Promise<boolean> {
  const status = await unless404(
    async () => (await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", { owner, repo, basehead: `${sha}...${branch}` })).data.status,
  );
  return status === "identical" || status === "ahead";
}

/** The account GitHub commits as on its web interface: an edit, a pull request merged there. */
export const GITHUB_WEB_COMMITTER = "web-flow";

/**
 * Whether the commit `sha` was made on GitHub's web interface (ADR-149 §2):
 * its committer is {@link GITHUB_WEB_COMMITTER}. False when GitHub does not
 * know the commit; any other failure throws.
 */
export async function madeOnGitHub(octokit: Octokit, owner: string, repo: string, sha: string): Promise<boolean> {
  const committer = await unless404(
    async () => (await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref: sha })).data.committer?.login ?? null,
  );
  return committer === GITHUB_WEB_COMMITTER;
}

/** The temporary ref deleted, best effort (§4.3): a leftover is harmless and never on a branch. */
export async function deleteCollectionRef(octokit: Octokit, owner: string, repo: string, ref: string): Promise<void> {
  await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: ref.slice("refs/".length) }).catch(() => undefined);
}
