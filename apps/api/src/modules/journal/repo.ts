/**
 * The GitHub side of the journal (ported from heig-classroom's
 * `journal/repo.ts`, sync point `ab98cc0`): the reads of the ingestion
 * (M4-02), then the writes (M4-03) — create a repository, find one by name,
 * put a file. Since ADR-057 the platform never edits a GitHub-mode journal's
 * pages: the put serves the creation's README and M4-11's Move to GitHub.
 * Classroom's `commitMoves` (a reorder as one commit) is not ported.
 *
 * Everything goes through the REST API with the installation's client, and
 * NOTHING is cloned: a journal only ever needs one tree listing and the
 * blobs that moved, and the VM has no business holding a working copy per
 * classroom (04-journal §4.1). Trees and blobs are addressed by sha, so no
 * file path of the journal ever goes into a URL here; the writes, which do
 * (the Contents API), build theirs with `encodeJournalPath`.
 *
 * Every call is BOUNDED, through the one client {@link boundedClient}: no
 * retry of Octokit's, no waiting out a rate limit, {@link GITHUB_TIMEOUT_MS}
 * at most. A rate limit or a timeout is `github_unavailable`, which the queue
 * retries with backoff — never an ingestion blocked for an hour.
 *
 * Every failure is a {@link JournalRepoError} carrying a `JournalSyncError`
 * code the web app words (invariant 1), or `empty`, which is not a failure:
 * a repository with no commit has no pages.
 */
import type { Octokit } from "octokit";

import { encodeJournalPath, JournalSyncError } from "@quiz/contracts";

import type { AppConfig } from "../../config.js";
import { githubStatus, installationClient, unless404 } from "../../github/app.js";

/** The longest the ingestion waits on one GitHub call, the token included. */
export const GITHUB_TIMEOUT_MS = 30_000;

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
    /**
     * A synchronisation's code; `empty`, a repository with no commit;
     * `name_taken`, a creation on a name the organization already holds.
     */
    readonly code: JournalSyncError | "empty" | "name_taken",
    message: string,
  ) {
    super(message);
    this.name = "JournalRepoError";
  }
}

/** `work`, or a timeout after {@link GITHUB_TIMEOUT_MS}: the installation token's fetch takes no request option. */
function bounded<T>(work: Promise<T>): Promise<T> {
  // After the timeout the token fetch keeps running in the background; its result is dropped.
  const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    }),
  ]);
}

/**
 * THE client of the journal's GitHub calls — the ingestion's and the
 * writes', the shared adapters they call included (the invitations, a linked
 * account's current login), which take no per-request option: the token
 * fetched within {@link GITHUB_TIMEOUT_MS}, then a hook sets on EVERY request
 * no retry, `noRateLimitWait` (what `HTTP_READ` of `github/app.ts` says for
 * the reads serving an HTTP request: a rate limit is answered at once, never
 * waited out for an hour) and a deadline. The client is a fresh one per call
 * of `installationClient`, so no other caller is touched.
 */
export async function boundedClient(config: AppConfig, installationId: number): Promise<Octokit> {
  const { octokit } = await bounded(installationClient(config, installationId));
  octokit.hook.before("request", (options) => {
    options.request = {
      ...options.request,
      retries: 0,
      noRateLimitWait: true,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    } as typeof options.request;
  });
  return octokit;
}

/**
 * The code of a failure GitHub answered, or of no answer at all (a timeout,
 * the network). A 403 or a 429 that says the quota is spent is GitHub being
 * unavailable for now, not a refusal: the queue's retry, the next push or a
 * Refresh catches up (N-RES-07). A 404 of the installation's token is
 * `repo_not_found` too: the App no longer reaches the repository.
 */
export function syncErrorOf(err: unknown): JournalSyncError {
  if (err instanceof JournalRepoError) {
    const code = JournalSyncError.safeParse(err.code);
    if (code.success) return code.data;
  }
  const status = githubStatus(err);
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
    });
    const { full_name: fullName, name, owner } = data as {
      full_name: string;
      name: string;
      owner: { login: string };
    };
    return { owner: owner.login, name, fullName };
  } catch (err) {
    if (githubStatus(err) === 404) {
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
    });
    commitSha = data.sha;
  } catch (err) {
    const status = githubStatus(err);
    // 409 is GitHub's "this repository is empty": no pages, not a failure.
    if (status === 409) throw new JournalRepoError("empty", `${repo.fullName} has no commit`);
    if (status === 404 || status === 422) {
      throw new JournalRepoError("ref_not_found", `${repo.fullName} has no branch ${ref}`);
    }
    throw err;
  }
  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: repo.owner,
    repo: repo.name,
    tree_sha: commitSha,
    recursive: "1",
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
  });
  return Buffer.from(data.content, data.encoding as BufferEncoding);
}

// ---------------------------------------------------------------- the writes (M4-03)


/** Who a browser write is authored as (F-JRN-10): the teacher, never the App. */
export interface CommitAuthor {
  name: string;
  email: string;
}

/** A repository of the organization, as a creation or a choice needs it. */
export interface FoundRepo extends ResolvedRepo {
  githubRepoId: number;
  /** GitHub's immutable id of the owner: what tells the organization's own from another's. */
  ownerId: number;
  defaultBranch: string;
}

interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch?: string;
  owner: { login: string; id: number };
}

const foundRepo = (data: RawRepo): FoundRepo => ({
  githubRepoId: data.id,
  owner: data.owner.login,
  ownerId: data.owner.id,
  name: data.name,
  fullName: data.full_name,
  defaultBranch: data.default_branch || "main",
});

/**
 * `org/name` as GitHub resolves it today, or null when the installation
 * reaches none. GitHub follows a renamed or transferred repository: the
 * caller checks the owner it answers with.
 */
export async function findRepo(octokit: Octokit, org: string, name: string): Promise<FoundRepo | null> {
  return unless404(async () => {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner: org, repo: name });
    return foundRepo(data as RawRepo);
  });
}

/**
 * Creates a private repository in `org` and commits its first file, `seed`
 * (the README), authored by `author`. A name already taken is `name_taken`,
 * NEVER an adoption: handing a classroom whatever sits under that name would
 * render another course to the wrong cohort (F-JRN-02); choosing an existing
 * repository is its own, explicit action.
 */
export async function createRepo(
  octokit: Octokit,
  opts: {
    org: string;
    name: string;
    description: string;
    seed: { path: string; content: string };
    author: CommitAuthor;
  },
): Promise<FoundRepo> {
  let repo: FoundRepo;
  try {
    const { data } = await octokit.request("POST /orgs/{org}/repos", {
      org: opts.org,
      name: opts.name,
      description: opts.description,
      private: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    repo = foundRepo(data as RawRepo);
  } catch (err) {
    // GitHub's "name already exists on this account" (the name itself was validated before).
    if (githubStatus(err) === 422) {
      throw new JournalRepoError("name_taken", `${opts.org}/${opts.name} already exists`);
    }
    throw err;
  }
  // Empty until something is committed: this first write creates the default branch.
  await putFile(octokit, repo, {
    branch: repo.defaultBranch,
    path: opts.seed.path,
    content: Buffer.from(opts.seed.content, "utf8"),
    message: "Start the journal",
    author: opts.author,
  });
  return repo;
}

/** What a write of one new file names: where, what, by whom. */
export interface FileWrite {
  branch: string;
  /** Relative to the repository's root, already checked (`safeJournalPath`). */
  path: string;
  message: string;
  author: CommitAuthor;
}

/**
 * Creates one file through the Contents API (the README of a new
 * repository; M4-11's export). Only the AUTHOR is the teacher: the
 * committer stays the App, so GitHub signs the commit (Verified) and the
 * history says it came through Quiz. The path's segments are encoded, the
 * slashes kept.
 */
export async function putFile(
  octokit: Octokit,
  repo: ResolvedRepo,
  write: FileWrite & { content: Buffer },
): Promise<{ blobSha: string; commitSha: string }> {
  const { data } = await octokit.request(`PUT /repos/{owner}/{repo}/contents/${encodeJournalPath(write.path)}`, {
    owner: repo.owner,
    repo: repo.name,
    branch: write.branch,
    message: write.message,
    author: write.author,
    content: write.content.toString("base64"),
  });
  const written = data as { content?: { sha?: string } | null; commit: { sha?: string } };
  return { blobSha: written.content?.sha ?? "", commitSha: written.commit.sha ?? "" };
}

