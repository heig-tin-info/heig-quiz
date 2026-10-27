/**
 * The commit graph of a project repository as the grading screen shows it
 * (ADR-119 §8): which commits the distribution handed out, and when the
 * platform received each one. Pure walks over the parents of the commits
 * GitHub listed; a parent outside the list (a history cut by the listing's
 * cap) ends the walk.
 */

/** A commit as the walks read it: its sha and its parents' shas. */
export interface GraphCommit {
  sha: string;
  parents: readonly string[];
}

/** A push the platform received: its head, and the server's receipt time. */
export interface GraphReceipt {
  headSha: string;
  receivedAt: Date;
}

/** Every commit of `commits` reachable from `heads` through its parents (a head included). */
export function reachableCommits(commits: readonly GraphCommit[], heads: Iterable<string>): Set<string> {
  const parents = new Map(commits.map((c) => [c.sha, c.parents]));
  const seen = new Set<string>();
  const stack = [...heads];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha) || !parents.has(sha)) continue;
    seen.add(sha);
    stack.push(...parents.get(sha)!);
  }
  return seen;
}

/**
 * Each commit's receipt time: that of the EARLIEST push whose head reaches
 * it — a commit arrives with the first push that carries it, whichever
 * branch. A commit no receipt reaches (pushed before the platform listened)
 * has none.
 */
export function commitReceiptTimes(commits: readonly GraphCommit[], receipts: readonly GraphReceipt[]): Map<string, Date> {
  const parents = new Map(commits.map((c) => [c.sha, c.parents]));
  const times = new Map<string, Date>();
  const ordered = [...receipts].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const { headSha, receivedAt } of ordered) {
    // A commit already timed was walked with all its ancestors: the walk stops there.
    const stack = [headSha];
    while (stack.length > 0) {
      const sha = stack.pop()!;
      if (times.has(sha) || !parents.has(sha)) continue;
      times.set(sha, receivedAt);
      stack.push(...parents.get(sha)!);
    }
  }
  return times;
}
