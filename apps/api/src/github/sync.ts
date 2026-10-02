/**
 * Source → squashed → student repositories synchronization (GH-50..53).
 * The squashed repo is brought up to date first (fast-forward for the
 * `whole` strategy, one primary commit for `squash`, GH-13), then each
 * student repository receives the squashed branch on its `sync/<branch>`
 * ref. That bot-only ref is the single place where a forced update is
 * allowed; the selected branches are never touched directly.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GitRunner, gitRunner, repoUrl } from "./git.js";
import { applyStudentHandout } from "./studentize.js";

export interface SquashedUpdate {
  /** New squashed head per branch (the content students will receive). */
  heads: Record<string, string>;
  /** Source head per branch at the time of the update. */
  sourceHeads: Record<string, string>;
  /** Branches whose squashed content actually changed. */
  changed: string[];
}

/** GH-51 step 1: bring the squashed repo up to date with the source. */
export async function updateSquashedRepo(opts: {
  token: string;
  org: string;
  sourceRepo: string;
  squashedRepo: string;
  strategy: "whole" | "squash";
  branches: string[];
}): Promise<SquashedUpdate> {
  const { token, org, sourceRepo, squashedRepo, strategy, branches } = opts;
  // Sync creates the per-branch primary commits: bot identity required.
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
      // Fast-forward only: the squashed repo is never rewritten (GH-13).
      const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
      const before = await squashedBranchHeads(runner, repoUrl(org, squashedRepo), branches, work);
      await gitBare(src, "push", "--quiet", repoUrl(org, squashedRepo), ...refspecs);
      for (const b of branches) {
        heads[b] = sourceHeads[b]!;
        if (before[b] !== heads[b]) changed.push(b);
      }
      return { heads, sourceHeads, changed };
    }

    // `squash` strategy: one primary commit per branch replaying the source
    // tree on top of the squashed history (students merge a single commit).
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
      await git(
        sqDir,
        "commit",
        "-q",
        "-m",
        `Assignment update (${sourceHeads[branch]!.slice(0, 7)})`,
      );
      await git(sqDir, "push", "-q", repoUrl(org, squashedRepo), `${branch}:${branch}`);
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
 * GH-51 step 2: a workspace holding one bare clone of the squashed repo,
 * reused to push `sync/<branch>` to every student repository (forced update
 * allowed on this bot-only ref).
 */
export interface SyncWorkspace {
  pushSyncRef: (studentRepo: string, branch: string) => Promise<string>;
  dispose: () => void;
}

export async function openSyncWorkspace(opts: {
  token: string;
  org: string;
  squashedRepo: string;
}): Promise<SyncWorkspace> {
  const { token, org, squashedRepo } = opts;
  const { git, gitBare } = gitRunner({ identity: true, token });
  const work = mkdtempSync(join(tmpdir(), "quiz-syncpush-"));
  await git(work, "clone", "--quiet", "--bare", repoUrl(org, squashedRepo), "sq.git");
  const sq = join(work, "sq.git");
  return {
    async pushSyncRef(studentRepo: string, branch: string): Promise<string> {
      await gitBare(
        sq,
        "push",
        "--quiet",
        "--force",
        repoUrl(org, studentRepo),
        `refs/heads/${branch}:refs/heads/sync/${branch}`,
      );
      return (await gitBare(sq, "rev-parse", `refs/heads/${branch}`)).trim();
    },
    dispose() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}
