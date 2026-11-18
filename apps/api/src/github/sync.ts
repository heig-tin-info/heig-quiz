/**
 * Source → distribution → student repositories synchronization (F-PROJ-12;
 * heig-classroom's GH-50..53, merge task M3-07). The distribution repository
 * is brought up to date first (fast-forward for the `whole` strategy, one
 * commit on top per branch for `squash`), then each student repository
 * receives the distribution's branch on its `sync/<branch>` ref. That
 * bot-only ref is the single place where a forced update is allowed; the
 * handed-out branches are never touched directly.
 *
 * The update is computed once ({@link planDistribution}) and either sent
 * (the sync, {@link updateSquashedRepo}) or only read (its preview,
 * {@link previewSquashedRepo}, ADR-132 §10): one transform for both.
 *
 * The `squash` strategy's commit is created by the API, GitHub-signed and
 * attributed to the App (`signedCommit.ts`, #917; ADR-073 amendment): git
 * builds its tree and carries it on `refs/quiz/tmp-<branch>`, deleted
 * afterwards, best-effort.
 *
 * Nothing the students receive names the SOURCE (N-SEC-20): the
 * distribution's commit message carries no sha, and the sync's pull
 * request names the distribution's commit (`modules/project/sync.ts`).
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Octokit } from "octokit";

import type { SourceStrategy } from "@quiz/contracts";
import type { SyncChange } from "@quiz/domain";

import { type GitRunner, gitRunner, repoUrl } from "./git.js";
import { pushWithRetry } from "./retry.js";
import { signedCommit } from "./signedCommit.js";
import { applyStudentHandout } from "./studentize.js";

export interface SquashedUpdate {
  /** New distribution head per branch (the content students will receive). */
  heads: Record<string, string>;
  /** Source head per branch at the time of the update: the shas handed out. */
  sourceHeads: Record<string, string>;
  /** Branches whose distribution content actually changed. */
  changed: string[];
}

/** One path of the distribution the update adds, modifies or deletes. */
export interface DistributionChange {
  path: string;
  change: SyncChange;
}

/** The `whole` strategy refused: the source's history was rewritten and the distribution cannot fast-forward. */
export class SourceRewritten extends Error {
  constructor(branches: string[]) {
    super(`the source was rewritten: ${branches.join(", ")} cannot fast-forward`);
    this.name = "SourceRewritten";
  }
}

/** The distribution's commit message (D12: English; never the source's sha, N-SEC-20). */
export const SYNC_COMMIT_MESSAGE = "Project update";

/** Git's tree with nothing in it: what a branch the distribution lacks is compared from. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface DistributionUpdateOptions {
  octokit: Octokit;
  token: string;
  org: string;
  sourceRepo: string;
  squashedRepo: string;
  strategy: SourceStrategy;
  branches: string[];
  /** Where a temporary ref left behind is reported. */
  log: { warn: (obj: object, msg: string) => void };
}

/** One branch's update, computed and not sent yet. */
interface BranchPlan {
  branch: string;
  /** The source's head: the sha the update hands out. */
  sourceHead: string;
  /** The distribution's head now; null when it lacks the branch. */
  head: string | null;
  changes: DistributionChange[];
  /** Sends the update and returns the distribution's new head; null when there is nothing to send. */
  send: (() => Promise<string>) | null;
}

/** `git diff --name-status -z` read as changes (renames off): a type change is a modification. */
function nameStatus(out: string): DistributionChange[] {
  const fields = out.split("\0");
  const changes: DistributionChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i]!;
    changes.push({ path: fields[i + 1]!, change: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  return changes;
}

/**
 * The update of the distribution, computed in `work` and not sent (ADR-073
 * §2, ADR-132 §10): THE transform the sync sends and the preview shows.
 * `whole`: the source's history, fast-forward only — a branch whose
 * distribution head the source's history does not hold is refused
 * ({@link SourceRewritten}), the distribution is never rewritten —, its
 * changes the difference between the two heads. `squash`: per branch, the
 * source's tree through the student handout (`applyStudentHandout`, as at
 * creation, or an update would bring the solution back) replacing the
 * distribution's working tree, its changes what git stages against the
 * distribution's head.
 */
async function planDistribution(runner: GitRunner, work: string, opts: DistributionUpdateOptions): Promise<BranchPlan[]> {
  const { octokit, org, sourceRepo, squashedRepo, strategy, branches, log } = opts;
  const { git, gitBare } = runner;
  const plans: BranchPlan[] = [];

  if (strategy === "whole") {
    await git(work, "clone", "--quiet", "--bare", repoUrl(org, sourceRepo), "src.git");
    const src = join(work, "src.git");
    const before = await squashedBranchHeads(runner, repoUrl(org, squashedRepo), branches, work);
    const rewritten: string[] = [];
    for (const branch of branches) {
      const sourceHead = (await gitBare(src, ["rev-parse", `refs/heads/${branch}`])).trim();
      const head = before[branch] ?? null;
      const forward = head === null || (await gitBare(src, ["merge-base", "--is-ancestor", head, sourceHead]).then(() => true, () => false));
      if (!forward) {
        rewritten.push(branch);
        continue;
      }
      const diff = await gitBare(src, ["diff", "--name-status", "--no-renames", "-z", head ?? EMPTY_TREE, sourceHead]);
      const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
      const send = async () => {
        await pushWithRetry(() => gitBare(src, ["push", "--quiet", repoUrl(org, squashedRepo), refspec]));
        return sourceHead;
      };
      plans.push({ branch, sourceHead, head, changes: nameStatus(diff), send: head === sourceHead ? null : send });
    }
    if (rewritten.length > 0) throw new SourceRewritten(rewritten);
    return plans;
  }

  // `squash` strategy: one commit per branch replaying the source tree on
  // top of the distribution's history (students merge a single commit).
  for (const branch of branches) {
    const safe = branch.replace(/[^a-zA-Z0-9]/g, "_");
    const sqDir = join(work, `sq-${safe}`);
    const srcDir = join(work, `src-${safe}`);
    await git(work, "clone", "--quiet", "--branch", branch, repoUrl(org, squashedRepo), sqDir);
    await git(work, "clone", "--quiet", "--depth", "1", "--branch", branch, repoUrl(org, sourceRepo), srcDir);
    const sourceHead = (await git(srcDir, "rev-parse", "HEAD")).trim();
    applyStudentHandout(srcDir);

    // Replace the working tree with the source content, keep .git.
    for (const entry of readdirSync(sqDir)) {
      if (entry !== ".git") rmSync(join(sqDir, entry), { recursive: true, force: true });
    }
    for (const entry of readdirSync(srcDir)) {
      if (entry !== ".git") cpSync(join(srcDir, entry), join(sqDir, entry), { recursive: true });
    }
    await git(sqDir, "add", "-A");
    const head = (await git(sqDir, "rev-parse", "HEAD")).trim();
    const changes = nameStatus(await git(sqDir, "diff", "--cached", "--name-status", "--no-renames", "-z", "HEAD"));
    // A throwaway commit carries the tree to GitHub on a temporary ref of
    // the distribution (never a student's: they receive refs/heads only);
    // the branch fast-forwards onto the API's commit of that tree,
    // GitHub-signed (#917).
    const send = async () => {
      await git(sqDir, "commit", "-q", "-m", SYNC_COMMIT_MESSAGE);
      const tmp = `quiz/tmp-${branch}`;
      await pushWithRetry(() => git(sqDir, "push", "-q", "--force", repoUrl(org, squashedRepo), `HEAD:refs/${tmp}`));
      const tree = (await git(sqDir, "rev-parse", "HEAD^{tree}")).trim();
      const sha = await signedCommit({ octokit, owner: org, repo: squashedRepo, tree, parents: [head], message: SYNC_COMMIT_MESSAGE });
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner: org,
        repo: squashedRepo,
        ref: `heads/${branch}`,
        sha,
        force: false,
      });
      // Best-effort: a leftover is harmless, and the next sync forces it anyway.
      await octokit
        .request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner: org, repo: squashedRepo, ref: tmp })
        .catch((err: unknown) => log.warn({ err, repo: squashedRepo, ref: tmp }, "sync: the temporary ref could not be deleted"));
      return sha;
    };
    // Nothing staged: already up to date.
    plans.push({ branch, sourceHead, head, changes, send: changes.length === 0 ? null : send });
  }
  return plans;
}

/** `fn` in a temporary directory removed on every exit; the runner has an identity for the throwaway commits, which end on no branch. */
async function inWork<T>(token: string, fn: (runner: GitRunner, work: string) => Promise<T>): Promise<T> {
  const work = mkdtempSync(join(tmpdir(), "quiz-sync-"));
  try {
    return await fn(gitRunner({ identity: true, token }), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Step 1: bring the distribution repository up to date with the source. */
export async function updateSquashedRepo(opts: DistributionUpdateOptions): Promise<SquashedUpdate> {
  return inWork(opts.token, async (runner, work) => {
    const update: SquashedUpdate = { heads: {}, sourceHeads: {}, changed: [] };
    for (const plan of await planDistribution(runner, work, opts)) {
      update.sourceHeads[plan.branch] = plan.sourceHead;
      update.heads[plan.branch] = plan.send ? await plan.send() : plan.head!;
      if (plan.send) update.changed.push(plan.branch);
    }
    return update;
  });
}

/** Step 1 previewed (ADR-132 §10): per branch, what the update would change; nothing is sent. */
export async function previewSquashedRepo(opts: DistributionUpdateOptions): Promise<{ branch: string; changes: DistributionChange[] }[]> {
  return inWork(opts.token, async (runner, work) =>
    (await planDistribution(runner, work, opts)).map(({ branch, changes }) => ({ branch, changes })),
  );
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
      return (await gitBare(sq, ["rev-parse", `refs/heads/${branch}`])).trim();
    },
    async pushSyncRef(studentRepo, branch) {
      await pushWithRetry(() =>
        gitBare(sq, ["push", "--quiet", "--force", repoUrl(org, studentRepo), `refs/heads/${branch}:refs/heads/sync/${branch}`]),
      );
    },
    dispose() {
      rmSync(work, { recursive: true, force: true });
    },
  };
}
