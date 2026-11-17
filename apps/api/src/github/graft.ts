/**
 * The graded commit of a v3 pass (ADR-132 §2): the target's tree with the
 * project's protected list (`criteria.yml` and the workflows included)
 * taken from a distribution commit (`overlayTree`, `@quiz/domain`), its
 * parent the target, pushed to `refs/quiz-grade-<pass id>/graded` of the
 * student repository: never a branch, which the deadline's lock does not
 * cover, and under a component holding the pass id, which nobody knows
 * before the push, so nobody can create a ref that blocks it beforehand
 * (git refuses a ref directly under `refs/`, so the name has a second
 * component); once pushed, a member may move or delete it. The ref is a
 * best-effort anchor only: the dispatch, the acceptance and the review read the sha
 * the pass recorded, so a member of the repository who moves or deletes
 * the ref changes nothing.
 *
 * git plumbing only, in a bare repository of its own under the system's
 * temporary directory, removed on every exit (and swept at startup,
 * {@link sweepGraftDirs}, after a crash): the two commits fetched at depth
 * 1, their `ls-tree`, the composed list into a temporary index
 * (`update-index --index-info`), `write-tree`, `commit-tree`, the push.
 * Nothing of either tree is checked out, no hook exists (an empty template)
 * nor runs (`--no-verify`). Paths travel as bytes (`latin1`): a path that
 * is not UTF-8 is kept as it is. The token reaches git through the
 * environment only (`gitRunner`, invariant 15). Every call shares one
 * budget ({@link GRAFT_BUDGET_MS}): a hung git is killed with its helpers.
 *
 * Deterministic: the App's throwaway identity, the pass's creation time as
 * both dates and a fixed message make a retry build the same sha; the push
 * forces the pass's own ref, so a retry that read a newer snapshot is not
 * stuck.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexInfo, overlayTree, parseLsTree, treeDifference } from "@quiz/domain";

import { gitRunner, repoUrl } from "./git.js";

/** The time one graft may take in all, every git call included. */
export const GRAFT_BUDGET_MS = 120_000;

/** The graded commit's message (D12: English). */
export const GRAFT_MESSAGE = "Graded with the teacher's protected files";

/** The ref a pass's graded commit is anchored on (ADR-132 §2): never a branch, under a component of its own that holds the pass id. */
export const gradeRef = (passId: string): string => `refs/quiz-grade-${passId}/graded`;

/** This process's work directories: `quiz-graft-<pid>-…` under the temporary directory. */
const DIR_PREFIX = "quiz-graft-";

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
  /** The commit's dates: the pass's creation. */
  at: Date;
  budgetMs?: number;
}

/** A graded commit pushed: its sha and the paths whose entry it changed (UTF-8, for people to read). */
export interface Graft {
  sha: string;
  paths: string[];
}

const remote = (fullName: string) => {
  const [org, name] = fullName.split("/") as [string, string];
  return repoUrl(org, name);
};

/** A path as git wrote it (bytes read as `latin1`), for people to read. */
const readable = (path: string) => Buffer.from(path, "latin1").toString("utf8");

/** The graded commit pushed, or null when the target already holds the distribution's graded paths (nothing to graft). */
export async function buildGradedCommit(order: GraftOrder): Promise<Graft | null> {
  const { gitBare } = gitRunner({ identity: true, token: order.token, deadline: Date.now() + (order.budgetMs ?? GRAFT_BUDGET_MS) });
  const work = await mkdtemp(join(tmpdir(), `${DIR_PREFIX}${process.pid}-`));
  try {
    const repo = join(work, "repo.git");
    // An empty template: no sample hook, nothing for any later call to run.
    await gitBare(repo, ["init", "--bare", "--quiet", "--template="]);
    const fetch = (fullName: string, sha: string) =>
      gitBare(repo, ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-write-fetch-head", remote(fullName), sha]);
    await fetch(order.studentRepo, order.target);
    await fetch(order.distributionRepo, order.distributionSha);
    const listing = async (sha: string) => parseLsTree(await gitBare(repo, ["ls-tree", "-r", "-z", "--full-tree", sha], { latin1: true }));
    const target = await listing(order.target);
    const graded = overlayTree(target, await listing(order.distributionSha), order.paths.map((p) => Buffer.from(p, "utf8").toString("latin1")));
    const paths = treeDifference(target, graded);
    if (paths.length === 0) return null;

    const index = { GIT_INDEX_FILE: join(work, "index") };
    await gitBare(repo, ["update-index", "-z", "--index-info"], { env: index, input: indexInfo(graded), latin1: true });
    const tree = (await gitBare(repo, ["write-tree"], { env: index })).trim();
    const date = `@${Math.floor(order.at.getTime() / 1000)} +0000`;
    const sha = (
      await gitBare(repo, ["commit-tree", tree, "-p", order.target, "-m", GRAFT_MESSAGE], { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } })
    ).trim();
    // Negotiated: only what the student repository lacks travels (the commit, its new trees, the distribution's blobs).
    await gitBare(repo, ["-c", "push.negotiate=true", "push", "--quiet", "--no-verify", remote(order.studentRepo), `+${sha}:${gradeRef(order.passId)}`]);
    return { sha, paths: paths.map(readable) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The work directories a crash or a deploy left (a `finally` that never
 * ran), removed at startup: this process's own pid's (it has none in
 * flight yet) and a dead process's; never a live one's (a test file's
 * grafts, another process on the same host).
 */
export async function sweepGraftDirs(): Promise<void> {
  const root = tmpdir();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const pid = Number(new RegExp(`^${DIR_PREFIX}(\\d+)-`).exec(name)?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || (pid !== process.pid && alive(pid))) continue;
    await rm(join(root, name), { recursive: true, force: true });
  }
}
