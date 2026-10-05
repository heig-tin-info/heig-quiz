/**
 * Restore of protected files (F-PROJ-08; classroom's GH-30..35): when a push
 * touches a protected file, the App puts back the distribution repository's
 * CURRENT version of each one on that branch (product owner, 2026-10-02) in
 * ONE commit (Git Data API), moved as a non-forced fast-forward: the
 * student's work is never rewritten, only covered. A race with a student
 * push fails cleanly (GitHub's 422) and the delivery is retried.
 *
 * Idempotent (M3-04): a file whose blob at the branch's head is already the
 * distribution's is left out (the head's tree, read once), so a redelivered
 * push, or a retry after the ref moved, commits nothing. The restore commit
 * is handed to `beforeMove` BEFORE the ref moves (N-RES-08): the caller
 * records it — a bot commit from the instant it can carry a run (N-SEC-21),
 * and the restore's count — or refuses it (the cap), and the ref stays.
 */
import type { Octokit } from "octokit";

import { githubStatus } from "./app.js";

export interface RevertResult {
  sha: string;
  files: string[];
  /**
   * The branch head the restore was built on, its parent: the pushed head,
   * or a later push already on the branch when the restore ran.
   */
  covered: string;
}

/** What a restore attempt found: the branch head it read, and the restore commit, or null when every file was the distribution's already. */
export interface RevertOutcome {
  head: string;
  restored: RevertResult | null;
}

/** The distribution's blob of `path` at `ref`, with its content; null when there is no such file. */
async function referenceBlob(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ sha: string; content: string } | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref,
      request: { retries: 0 },
    });
    if (Array.isArray(data) || data.type !== "file") return null;
    return { sha: data.sha, content: data.content };
  } catch (err) {
    if (githubStatus(err) === 404) return null;
    throw err;
  }
}

export async function revertProtectedFiles(opts: {
  octokit: Octokit;
  org: string;
  studentRepo: string;
  /** The project's distribution repository (`<slug>-squashed`), its name only. */
  squashedRepo: string;
  branch: string;
  /** Protected files the push may have touched. */
  paths: string[];
  /**
   * Records the restore commit before the branch moves onto it; false
   * refuses it: the branch is left where it is and nothing is restored.
   */
  beforeMove: (commit: RevertResult) => Promise<boolean>;
}): Promise<RevertOutcome> {
  const { octokit, org, studentRepo, squashedRepo, branch, paths } = opts;

  const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner: org,
    repo: studentRepo,
    ref: `heads/${branch}`,
  });
  const headSha = ref.object.sha;
  const { data: headCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: org,
    repo: studentRepo,
    commit_sha: headSha,
  });
  const { data: headTree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: org,
    repo: studentRepo,
    tree_sha: headCommit.tree.sha,
    recursive: "true",
  });
  // A truncated listing knows nothing of the paths it left out: they are restored.
  const atHead = new Map(headTree.truncated ? [] : headTree.tree.map((e) => [e.path, e.sha] as const));

  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  for (const path of paths) {
    // Absent from the distribution: the protected file has no reference.
    const reference = await referenceBlob(octokit, org, squashedRepo, path, branch);
    if (!reference || atHead.get(path) === reference.sha) continue;
    const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
      owner: org,
      repo: studentRepo,
      content: reference.content,
      encoding: "base64",
    });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  if (tree.length === 0) return { head: headSha, restored: null };

  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: org,
    repo: studentRepo,
    base_tree: headCommit.tree.sha,
    tree,
  });
  const files = tree.map((t) => t.path);
  const { data: commit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: org,
    repo: studentRepo,
    message: `Restore protected files\n\n${files.join("\n")}`,
    tree: newTree.sha,
    parents: [headSha],
  });
  const result = { sha: commit.sha, files, covered: headSha };
  if (!(await opts.beforeMove(result))) return { head: headSha, restored: null };
  // Strict fast-forward: force=false; in case of a race, GitHub refuses.
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: org,
    repo: studentRepo,
    ref: `heads/${branch}`,
    sha: commit.sha,
    force: false,
  });
  return { head: headSha, restored: result };
}

/** GitHub's compare lists at most this many files: past it, the list is not the whole change. */
const COMPARE_FILES_MAX = 300;

/**
 * The paths a push changed between `base` and `head` (both names of a
 * renamed file), read from GitHub's compare (M3-04): for a push whose
 * payload cannot tell — a forced push, or one listing GitHub's 20 commits.
 * Null when the compare cannot list them all (300 files and more).
 */
export async function changedFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string[] | null> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${base}...${head}`,
  });
  const files = data.files ?? [];
  if (files.length >= COMPARE_FILES_MAX) return null;
  return files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
}
