/**
 * The GitHub side of the journal's READ half (ported from heig-classroom's
 * `journal/repo.ts`, sync point `ab98cc0`; the writes — create, put,
 * delete, moves — are merge task M4-03's).
 *
 * Everything goes through the REST API with the installation's client, and
 * NOTHING is cloned: a journal only ever needs one tree listing and the
 * blobs that moved, and the VM has no business holding a working copy per
 * classroom (04-journal §4.1). Trees and blobs are addressed by sha, so no
 * file path of the journal ever goes into a URL here; the writes, which do
 * (the Contents API), build theirs with `encodeJournalPath`.
 *
 * Every failure is a {@link JournalRepoError} carrying a `JournalSyncError`
 * code the web app words (invariant 1), or `empty`, which is not a failure:
 * a repository with no commit has no pages.
 */
import type { Octokit } from "octokit";

import type { JournalSyncError } from "@quiz/contracts";

/** One file of the repository tree, as the ingestion needs it. */
export interface TreeEntry {
  /** Relative to the repository's root, as GitHub lists it. */
  path: string;
  sha: string;
  /** Bytes. */
  size: number;
}

export interface RepoTree {
  /** Head commit of the ref the tree was read at. */
  commitSha: string;
  entries: TreeEntry[];
}

/** The repository behind a classroom's row, found by GitHub's immutable id. */
export interface ResolvedRepo {
  owner: string;
  name: string;
  /** `owner/name` as GitHub names it NOW: a rename is followed here too. */
  fullName: string;
}

export class JournalRepoError extends Error {
  constructor(
    readonly code: JournalSyncError | "empty",
    message: string,
  ) {
    super(message);
    this.name = "JournalRepoError";
  }
}

const statusOf = (err: unknown): number | undefined => (err as { status?: number }).status;

/**
 * No automatic retry of Octokit's own: the queue retries a job whose
 * failure is GitHub's (`github_unavailable`), and nothing else is worth one.
 */
const ONCE = { request: { retries: 0 } } as const;

/**
 * The code of a failure GitHub answered, or of no answer at all. A 403 or a
 * 429 that says the quota is spent is GitHub being unavailable for now, not
 * a refusal: the next push, a Refresh or a retry catches up (N-RES-07).
 */
export function syncErrorOf(err: unknown): JournalSyncError {
  if (err instanceof JournalRepoError && err.code !== "empty") return err.code;
  const status = statusOf(err);
  const headers = (err as { response?: { headers?: Record<string, string> } }).response?.headers;
  if (status === 429 || (status === 403 && headers?.["x-ratelimit-remaining"] === "0")) {
    return "github_unavailable";
  }
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "repo_not_found";
  return "github_unavailable";
}

/**
 * The repository by its immutable id (`GET /repositories/{id}`): a renamed
 * or transferred repository is found all the same, and a deleted one — or
 * one the installation no longer reaches — is `repo_not_found`.
 */
export async function resolveRepo(octokit: Octokit, githubRepoId: number): Promise<ResolvedRepo> {
  try {
    const { data } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: githubRepoId,
      ...ONCE,
    });
    const { full_name: fullName, name, owner } = data as {
      full_name: string;
      name: string;
      owner: { login: string };
    };
    return { owner: owner.login, name, fullName };
  } catch (err) {
    if (statusOf(err) === 404) {
      throw new JournalRepoError("repo_not_found", `repository ${githubRepoId} is not reachable`);
    }
    throw err;
  }
}

/**
 * The whole tree of `ref`, flattened to its files. `truncated` is surfaced
 * (`too_large`) rather than swallowed: a half-read tree would delete from
 * the copy every page it did not see.
 */
export async function readTree(octokit: Octokit, repo: ResolvedRepo, ref: string): Promise<RepoTree> {
  let commitSha: string;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner: repo.owner,
      repo: repo.name,
      ref,
      ...ONCE,
    });
    commitSha = data.sha;
  } catch (err) {
    // 409 is GitHub's "this repository is empty": no pages, not a failure.
    if (statusOf(err) === 409) throw new JournalRepoError("empty", `${repo.fullName} has no commit`);
    if (statusOf(err) === 404 || statusOf(err) === 422) {
      throw new JournalRepoError("ref_not_found", `${repo.fullName} has no branch ${ref}`);
    }
    throw err;
  }
  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: repo.owner,
    repo: repo.name,
    tree_sha: commitSha,
    recursive: "1",
    ...ONCE,
  });
  if (tree.truncated) {
    throw new JournalRepoError("too_large", `the tree of ${repo.fullName} is too large to read at once`);
  }
  const entries: TreeEntry[] = [];
  for (const e of tree.tree) {
    if (e.type !== "blob" || !e.path || !e.sha) continue;
    entries.push({ path: e.path, sha: e.sha, size: e.size ?? 0 });
  }
  return { commitSha, entries };
}

/**
 * One blob, by sha: the Git blob endpoint (base64), not the Contents API,
 * so it is not capped at 1 MB and a file whose sha did not move costs
 * nothing — the tree already gave every sha.
 */
export async function readBlob(octokit: Octokit, repo: ResolvedRepo, sha: string): Promise<Buffer> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
    owner: repo.owner,
    repo: repo.name,
    file_sha: sha,
    ...ONCE,
  });
  return Buffer.from(data.content, data.encoding as BufferEncoding);
}
