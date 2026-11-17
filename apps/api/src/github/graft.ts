/**
 * The graded commit of a v3 pass (ADR-132 §2): the target's tree with the
 * graded paths — the protected list and `criteria.yml` — taken from a
 * distribution commit (`overlayTree`, `@quiz/domain`), its parent the
 * target, pushed to `refs/quiz/grade/<pass id>` of the student repository:
 * never a branch, which the deadline's lock does not cover. The student's
 * branches never move.
 *
 * git plumbing only, in a bare repository of its own under the system's
 * temporary directory, removed on every exit: the two commits fetched, their
 * `ls-tree`, the composed list into a temporary index (`update-index
 * --index-info`), `write-tree`, `commit-tree`, the push. Nothing of either
 * tree is checked out, no hook exists (an empty template) nor runs
 * (`--no-verify`). The token reaches git through the environment only
 * (`gitRunner`, invariant 15). Every call shares one budget
 * ({@link GRAFT_BUDGET_MS}): a hung git is killed, never holding the job.
 *
 * Deterministic: the App's throwaway identity, the pass's claim time as both
 * dates and a fixed message make a retry build the same sha, and a push of
 * it again changes nothing. One graft at a time per repository
 * ({@link serialized}): the `project.ci` jobs run in one process.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gradeRef, indexInfo, overlayTree, parseLsTree, treeDifference } from "@quiz/domain";

import { gitRunner, repoUrl } from "./git.js";

/** The time one graft may take in all, every git call included. */
export const GRAFT_BUDGET_MS = 120_000;

/** The graded commit's message (D12: English). */
export const GRAFT_MESSAGE = "Graded with the teacher's protected files";

/** What the graft needs. */
export interface GraftOrder {
  token: string;
  /** The student repository and the distribution, `org/name`. */
  studentRepo: string;
  distributionRepo: string;
  /** The pass's target commit, in the student repository. */
  target: string;
  /** The distribution commit the graded paths come from. */
  distributionSha: string;
  /** The graded paths: entries, a directory standing for its content. */
  paths: readonly string[];
  passId: string;
  /** The commit's dates: the pass's claim. */
  at: Date;
  budgetMs?: number;
}

/** A graded commit pushed: its sha and the paths whose entry it changed. */
export interface Graft {
  sha: string;
  paths: string[];
}

const inFlight = new Map<string, Promise<unknown>>();

/** `work` after every earlier one of `key` settled: one at a time per key, in this process. */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = inFlight.get(key) ?? Promise.resolve();
  const mine = before.catch(() => undefined).then(work);
  inFlight.set(key, mine);
  try {
    return await mine;
  } finally {
    if (inFlight.get(key) === mine) inFlight.delete(key);
  }
}

const remote = (fullName: string) => {
  const [org, name] = fullName.split("/") as [string, string];
  return repoUrl(org, name);
};

/** The graded commit pushed, or null when the target already holds the distribution's graded paths (nothing to graft). */
export function buildGradedCommit(order: GraftOrder): Promise<Graft | null> {
  return serialized(order.studentRepo, () => graft(order));
}

async function graft(order: GraftOrder): Promise<Graft | null> {
  const { plumbing } = gitRunner({ identity: true, token: order.token, deadline: Date.now() + (order.budgetMs ?? GRAFT_BUDGET_MS) });
  const work = await mkdtemp(join(tmpdir(), "quiz-graft-"));
  try {
    const repo = join(work, "repo.git");
    // An empty template: no sample hook, nothing for any later call to run.
    await plumbing(repo, ["init", "--bare", "--quiet", "--template="]);
    const fetch = (fullName: string, sha: string) => plumbing(repo, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote(fullName), sha]);
    await fetch(order.studentRepo, order.target);
    await fetch(order.distributionRepo, order.distributionSha);
    const listing = async (sha: string) => parseLsTree(await plumbing(repo, ["ls-tree", "-r", "-z", "--full-tree", sha]));
    const target = await listing(order.target);
    const graded = overlayTree(target, await listing(order.distributionSha), order.paths);
    const paths = treeDifference(target, graded);
    if (paths.length === 0) return null;

    const index = { GIT_INDEX_FILE: join(work, "index") };
    await plumbing(repo, ["update-index", "-z", "--index-info"], { env: index, input: indexInfo(graded) });
    const tree = (await plumbing(repo, ["write-tree"], { env: index })).trim();
    const date = `@${Math.floor(order.at.getTime() / 1000)} +0000`;
    const sha = (
      await plumbing(repo, ["commit-tree", tree, "-p", order.target, "-m", GRAFT_MESSAGE], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    ).trim();
    // Negotiated: only what the student repository lacks travels (the commit, its new trees, the distribution's blobs).
    await plumbing(repo, ["-c", "push.negotiate=true", "push", "--quiet", "--no-verify", remote(order.studentRepo), `+${sha}:${gradeRef(order.passId)}`]);
    return { sha, paths };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
