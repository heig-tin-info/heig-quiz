/**
 * The commit listing of a project repository's handed-out branches, as the
 * grading screen's graph reads it (ADR-119 §8): each commit's parents,
 * git's declared author name and date, its message, and the GitHub account
 * GitHub matched to it — never an e-mail address. Read on demand through
 * the App and cached as the live state (`repoReadCache`), never stored.
 */
import type { Octokit } from "octokit";

import { COMMIT_GRAPH_MAX_PER_BRANCH } from "@quiz/contracts";

import { branchHead, failFast, githubStatus, ownerRepo } from "./app.js";
import { repoReadCache } from "./metrics.js";

/** The longest message kept: a commit message is free text of any size. */
const COMMIT_MESSAGE_MAX = 2000;
const PAGE = 100;

export interface ListedCommit {
  sha: string;
  parents: string[];
  message: string;
  /** Git's author field: declared, never verified. */
  authorName: string;
  authoredAt: string | null;
  /** The GitHub account GitHub matched to the commit's author, by its immutable id; null when none. */
  accountId: number | null;
}

export interface CommitListing {
  branches: { name: string; head: string | null }[];
  commits: ListedCommit[];
  /** A branch held more than {@link COMMIT_GRAPH_MAX_PER_BRANCH} commits: the oldest are left out. */
  truncated: boolean;
  /** The distribution's heads of the same branches: what it handed out. */
  handedOut: string[];
}

/** A branch's commits, newest first, up to the cap; empty when the branch (or the repository) is missing or empty. */
async function branchCommits(octokit: Octokit, fullName: string, branch: string): Promise<{ commits: ListedCommit[]; full: boolean }> {
  const { owner, repo } = ownerRepo(fullName);
  const commits: ListedCommit[] = [];
  for (let page = 1; commits.length < COMMIT_GRAPH_MAX_PER_BRANCH; page++) {
    let data;
    try {
      ({ data } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner,
        repo,
        sha: branch,
        per_page: PAGE,
        page,
        request: { retries: 0, noRateLimitWait: true },
      }));
    } catch (err) {
      // 404: no such branch or repository; 409: an empty repository.
      const status = githubStatus(err);
      if (status === 404 || status === 409) return { commits, full: false };
      throw err;
    }
    for (const c of data) {
      commits.push({
        sha: c.sha,
        parents: c.parents.map((p) => p.sha),
        message: c.commit.message.slice(0, COMMIT_MESSAGE_MAX),
        authorName: c.commit.author?.name ?? "",
        authoredAt: c.commit.author?.date ?? null,
        accountId: c.author && "id" in c.author && typeof c.author.id === "number" ? c.author.id : null,
      });
    }
    if (data.length < PAGE) return { commits, full: false };
  }
  return { commits: commits.slice(0, COMMIT_GRAPH_MAX_PER_BRANCH), full: true };
}

/** What a listing reads: the project's handed-out branches, and its distribution repository (null before it is built). */
export interface ListingScope {
  branches: readonly string[];
  distribution: string | null;
}

/** The listing of the `branches` of `fullName`, the commits shared by several branches once. */
export async function fetchCommitListing(octokit: Octokit, fullName: string, { branches, distribution }: ListingScope): Promise<CommitListing> {
  const listing: CommitListing = { branches: [], commits: [], truncated: false, handedOut: [] };
  const seen = new Set<string>();
  for (const name of branches) {
    const { commits, full } = await branchCommits(octokit, fullName, name);
    listing.branches.push({ name, head: commits[0]?.sha ?? null });
    listing.truncated ||= full;
    for (const c of commits) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      listing.commits.push(c);
    }
  }
  if (distribution !== null) {
    const { owner, repo } = ownerRepo(distribution);
    for (const name of branches) {
      const head = await branchHead(failFast(octokit), owner, repo, name);
      if (head !== null) listing.handedOut.push(head);
    }
  }
  return listing;
}

/**
 * {@link fetchCommitListing} through the live state's cache (one minute,
 * served stale up to fifteen, a push forgets it), keyed by the repository
 * and its scope: a change of branches or distribution reads again.
 */
export const readCommitListing = repoReadCache(fetchCommitListing);
