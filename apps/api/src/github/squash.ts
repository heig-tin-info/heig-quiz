/**
 * Creation of the squashed source repository (GH-10..13) when the
 * assignment is created. Two strategies:
 * - `whole`  : the full history of the selected branches is pushed as is;
 * - `squash` : each selected branch is reduced to a single initial commit,
 *   after the student handout conventions (studentize.ts) are applied.
 * Git operations use the installation token (GH-03).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

import type { SourceStrategy } from "@quiz/contracts";

import { gitRunner, repoUrl } from "./git.js";
import { pushWithRetry } from "./retry.js";
import { applyStudentHandout } from "./studentize.js";

export interface SquashedResult {
  repoId: number;
  fullName: string;
  /** Head SHA per branch of the squashed repo (base of future primary_commits). */
  heads: Record<string, string>;
  /** The source's head per branch as it was built from: the shas handed out (F-PROJ-12, M3-07). */
  sourceHeads: Record<string, string>;
}

export async function createSquashedRepo(opts: {
  octokit: Octokit;
  token: string;
  org: string;
  sourceRepo: string;
  targetRepo: string;
  strategy: SourceStrategy;
  branches: string[];
  /**
   * Takes the repository for this caller BEFORE anything is pushed to it
   * (Quiz, ADR-062): false — another project already holds it — refuses it
   * like a name taken (422), and the caller steps to the next name.
   */
  claim?: (repo: { repoId: number; fullName: string }) => Promise<boolean>;
}): Promise<SquashedResult> {
  const { octokit, token, org, sourceRepo, targetRepo, strategy, branches } = opts;
  // Squashing creates commits: run git with the bot identity.
  const { git, gitBare } = gitRunner({ identity: true, token });
  const url = (repo: string) => repoUrl(org, repo);

  // Creation of the target repository. A name collision (422) is tolerated
  // when the existing repository is EMPTY and PRIVATE: it is the leftover of
  // a previous failed attempt, and reusing it makes "try again" actually
  // work. A public one is never adopted: a distribution is private (F-PROJ-02).
  let created: { id: number; full_name: string };
  try {
    const res = await octokit.request("POST /orgs/{org}/repos", {
      org,
      name: targetRepo,
      private: true,
      has_issues: false,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    });
    created = { id: Number(res.data.id), full_name: res.data.full_name };
  } catch (err) {
    if ((err as { status?: number }).status !== 422) throw err;
    const { data: existing } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner: org,
      repo: targetRepo,
    });
    let empty = false;
    try {
      await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner: org,
        repo: targetRepo,
        per_page: 1,
        request: { retries: 0 },
      });
    } catch (probe) {
      empty = (probe as { status?: number }).status === 409; // 409 = empty git repository
    }
    if (!empty || !existing.private) throw err; // a real collision: surface the 422
    created = { id: Number(existing.id), full_name: existing.full_name };
  }
  if (opts.claim && !(await opts.claim({ repoId: created.id, fullName: created.full_name }))) {
    throw Object.assign(new Error(`${created.full_name} is another project's`), { status: 422 });
  }

  const work = mkdtempSync(join(tmpdir(), "quiz-squash-"));
  try {
    const heads: Record<string, string> = {};
    const sourceHeads: Record<string, string> = {};
    if (strategy === "whole") {
      await git(work, "clone", "--quiet", "--bare", url(sourceRepo), "src.git");
      const src = join(work, "src.git");
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      await pushWithRetry(() => gitBare(src, "push", "--quiet", url(targetRepo), ...refspecs));
      for (const b of branches) {
        heads[b] = sourceHeads[b] = (await gitBare(src, "rev-parse", `refs/heads/${b}`)).trim();
      }
    } else {
      for (const branch of branches) {
        const dir = join(work, `b-${branch.replace(/[^a-zA-Z0-9]/g, "_")}`);
        await git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, url(sourceRepo), dir);
        sourceHeads[branch] = (await git(dir, "rev-parse", "HEAD")).trim();
        // A single initial commit: replay the head tree without history.
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        // `student/` overlay and `.studentignore`: the solution stays private.
        applyStudentHandout(dir);
        await git(dir, "init", "-q", "-b", branch);
        await git(dir, "add", "-A");
        await git(dir, "commit", "-q", "-m", "Initial assignment commit");
        await pushWithRetry(() => git(dir, "push", "-q", url(targetRepo), `${branch}:${branch}`));
        heads[branch] = (await git(dir, "rev-parse", "HEAD")).trim();
      }
    }
    return { repoId: created.id, fullName: created.full_name, heads, sourceHeads };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
