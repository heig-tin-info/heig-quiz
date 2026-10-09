/**
 * Source → distribution → student repositories synchronization (F-PROJ-12;
 * heig-classroom's GH-50..53, merge task M3-07). The distribution repository
 * is brought up to date first (fast-forward for the `whole` strategy, one
 * commit on top per branch for `squash`), then each student repository
 * receives the distribution's branch on its `sync/<branch>` ref. That
 * bot-only ref is the single place where a forced update is allowed; the
 * handed-out branches are never touched directly.
 *
 * Nothing the students receive names the SOURCE (N-SEC-20): the
 * distribution's commit message carries no sha, and the sync's pull
 * request names the distribution's commit (`modules/project/sync.ts`).
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SourceStrategy } from "@quiz/contracts";

import { type GitRunner, gitRunner, repoUrl } from "./git.js";
import { pushWithRetry } from "./retry.js";
import { applyStudentHandout } from "./studentize.js";

export interface SquashedUpdate {
  /** New distribution head per branch (the content students will receive). */
  heads: Record<string, string>;
  /** Source head per branch at the time of the update: the shas handed out. */
  sourceHeads: Record<string, string>;
  /** Branches whose distribution content actually changed. */
  changed: string[];
}

/** The `whole` strategy's push refused: the source's history was rewritten and the distribution cannot fast-forward. */
export class SourceRewritten extends Error {
  constructor(branches: string[]) {
    super(`the source was rewritten: ${branches.join(", ")} cannot fast-forward`);
    this.name = "SourceRewritten";
  }
}

/** The distribution's commit message (D12: English; never the source's sha, N-SEC-20). */
export const SYNC_COMMIT_MESSAGE = "Project update";

const NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]/i;

/** Step 1: bring the distribution repository up to date with the source. */
export async function updateSquashedRepo(opts: {
  token: string;
  org: string;
  sourceRepo: string;
  squashedRepo: string;
  strategy: SourceStrategy;
  branches: string[];
}): Promise<SquashedUpdate> {
  const { token, org, sourceRepo, squashedRepo, strategy, branches } = opts;
  // Sync creates the per-branch commits: bot identity required.
  const runner = gitRunner({ identity: true, token });
  const { git, gitBare } = runner;
  const work = mkdtempSync(join(tmpdir(), "quiz-sync-"));
  try {
    const heads: Record<string, string> = {};
    const sourceHeads: Record<string, string> = {};
    const changed: string[] = [];

    if (strategy === "whole") {
      await git(work, "clone", "--quiet", "--bare", repoUrl(org, sourceRepo), "src.git");
      const src = join(work, "src.git");
      for (const b of branches) {
        sourceHeads[b] = (await gitBare(src, "rev-parse", `refs/heads/${b}`)).trim();
      }
      // Fast-forward only: the distribution repository is never rewritten.
      const before = await squashedBranchHeads(runner, repoUrl(org, squashedRepo), branches, work);
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      try {
        await pushWithRetry(() => gitBare(src, "push", "--quiet", repoUrl(org, squashedRepo), ...refspecs));
      } catch (err) {
        if (NON_FAST_FORWARD.test(String(err))) throw new SourceRewritten(branches.filter((b) => before[b] !== sourceHeads[b]));
        throw err;
      }
      for (const b of branches) {
        heads[b] = sourceHeads[b]!;
        if (before[b] !== heads[b]) changed.push(b);
      }
      return { heads, sourceHeads, changed };
    }

    // `squash` strategy: one commit per branch replaying the source tree on
    // top of the distribution's history (students merge a single commit).
    for (const branch of branches) {
      const safe = branch.replace(/[^a-zA-Z0-9]/g, "_");
      const sqDir = join(work, `sq-${safe}`);
      const srcDir = join(work, `src-${safe}`);
      await git(work, "clone", "--quiet", "--branch", branch, repoUrl(org, squashedRepo), sqDir);
      await git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, repoUrl(org, sourceRepo), srcDir);
      sourceHeads[branch] = (await git(srcDir, "rev-parse", "HEAD")).trim();
      // Same handout conventions as at creation, or an update would bring
      // the solution back.
      applyStudentHandout(srcDir);

      // Replace the working tree with the source content, keep .git.
      for (const entry of readdirSync(sqDir)) {
        if (entry !== ".git") rmSync(join(sqDir, entry), { recursive: true, force: true });
      }
      for (const entry of readdirSync(srcDir)) {
        if (entry !== ".git") cpSync(join(srcDir, entry), join(sqDir, entry), { recursive: true });
      }
      await git(sqDir, "add", "-A");
      if ((await git(sqDir, "status", "--porcelain")).trim() === "") {
        heads[branch] = (await git(sqDir, "rev-parse", "HEAD")).trim();
        continue; // already up to date
      }
      await git(sqDir, "commit", "-q", "-m", SYNC_COMMIT_MESSAGE);
      await pushWithRetry(() => git(sqDir, "push", "-q", repoUrl(org, squashedRepo), `${branch}:${branch}`));
      heads[branch] = (await git(sqDir, "rev-parse", "HEAD")).trim();
      changed.push(branch);
    }
    return { heads, sourceHeads, changed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function squashedBranchHeads(
  { git }: GitRunner,
  squashedUrl: string,
  branches: string[],
  work: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await git(work, "ls-remote", squashedUrl)).split("\n")) {
    const [sha, ref] = line.split("\t");
    const b = ref?.replace("refs/heads/", "");
    if (sha && b && branches.includes(b)) out[b] = sha;
  }
  return out;
}

/**
 * Step 2: a workspace holding one bare clone of the distribution repository,
 * reused to push `sync/<branch>` to every student repository (forced update
 * allowed on this bot-only ref). `headOf` is the distribution's head of a
 * branch — the commit a push moves the ref onto — known BEFORE the push, so
 * the caller records it as a bot commit first (N-RES-08, N-SEC-21).
 */
export interface SyncWorkspace {
  headOf: (branch: string) => Promise<string>;
  pushSyncRef: (studentRepo: string, branch: string) => Promise<void>;
  dispose: () => void;
}

export async function openSyncWorkspace(opts: { token: string; org: string; squashedRepo: string }): Promise<SyncWorkspace> {
  const { token, org, squashedRepo } = opts;
  const { git, gitBare } = gitRunner({ token });
  const work = mkdtempSync(join(tmpdir(), "quiz-syncpush-"));
  await git(work, "clone", "--quiet", "--bare", repoUrl(org, squashedRepo), "sq.git");
  const sq = join(work, "sq.git");
  return {
    async headOf(branch) {
      return (await gitBare(sq, "rev-parse", `refs/heads/${branch}`)).trim();
    },
    async pushSyncRef(studentRepo, branch) {
      await pushWithRetry(() =>
        gitBare(sq, "push", "--quiet", "--force", repoUrl(org, studentRepo), `refs/heads/${branch}:refs/heads/sync/${branch}`),
      );
    },
    dispose() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}
