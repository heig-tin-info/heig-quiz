/**
 * Which CI runs of a project repository count, and which one is the
 * current score (F-PROJ-10, F-PROJ-11, ADR-012; merge task M3-04, ported
 * from heig-classroom's `grading.ts`). The `project` module reads the rows
 * and the receipts; these rules decide.
 */

/** The workflow whose runs carry a score (a wire name, I16). */
export const GRADING_WORKFLOW_PATH = ".github/workflows/grading.yml";

/**
 * The review dispatched by Quiz (`grade-final`, `grade-milestone`) is a
 * `review` run; every other run is the indicative `ci` tier.
 */
export function runKind(run: { event: string; path: string }): "ci" | "review" {
  return run.event === "repository_dispatch" && run.path === GRADING_WORKFLOW_PATH ? "review" : "ci";
}

/**
 * A repository's own deadline (D13 as amended 2026-10-02, merge task
 * M3-05a): the staff's individual extension when it has one, the project's
 * otherwise. Everything a deadline decides — the lock or the commit, a late
 * receipt, the provisional and the definitive freeze — reads this one.
 * `coalesce(r.deadline_at, p.deadline_at)` is its SQL twin
 * (`modules/project/deadline.ts`).
 */
export function effectiveDeadline(repo: { deadlineAt: Date | null }, project: { deadlineAt: Date }): Date {
  return repo.deadlineAt ?? project.deadlineAt;
}

/**
 * Whether GitHub should hold a repository locked (F-PROJ-09, M3-05a): the
 * staff's hand when they set one (true locked, false unlocked), else the
 * deadline's — applied, with the `lock` strategy. The ticker's scans carry
 * its SQL twin (`WANTS_LOCK`, `modules/project/deadline.ts`).
 */
export function deadlineWantsLock(
  repo: { staffLock: boolean | null; deadlineAppliedAt: Date | null },
  strategy: "lock" | "commit",
): boolean {
  return repo.staffLock ?? (repo.deadlineAppliedAt !== null && strategy === "lock");
}

/**
 * Whether moving a repository's (or a project's) deadline reopens it
 * (F-PROJ-09): it was applied, and the new deadline lies ahead.
 */
export function reopens(appliedAt: Date | null, deadline: Date, now: Date): boolean {
  return appliedAt !== null && deadline.getTime() > now.getTime();
}

/**
 * Whether a commit came in after the deadline, by the server's receipt of
 * its push (ADR-012), never the commit's date. An unknown receipt — a lost
 * webhook, a run reconciled after the fact — is late once the deadline has
 * passed (GR-14.3); ahead of it, it is on time.
 */
export function receivedLate(receivedAt: Date | null, deadline: Date, now: Date): boolean {
  return (receivedAt ?? now).getTime() > deadline.getTime();
}

/** What the selection reads of a stored run. */
export interface ScoredRun {
  id: string;
  kind: "ci" | "review";
  afterDeadline: boolean;
  parseStatus: "ok" | "no_annotation" | "malformed" | "multiple" | "fallback";
  completedAt: Date;
  headSha: string;
}

/**
 * The current score's run, or null (product owner, 2026-10-02): the latest
 * `ci` run, by GitHub's completion time, on a commit received before the
 * deadline, with a score (`ok`). A pass / fail `fallback` run (another
 * workflow than `grading.yml`) counts only while the repository has no
 * other run at all, so a build beside the grading never displaces a score.
 * A run on a head whose protected files the App restored (`restoredHeads`)
 * never counts: it ran the student's own copy of them (F-PROJ-08).
 */
export function selectScoreRun(runs: readonly ScoredRun[], restoredHeads: ReadonlySet<string>): string | null {
  const graded = runs.some((r) => r.parseStatus !== "fallback");
  let best: ScoredRun | null = null;
  for (const r of runs) {
    if (r.kind !== "ci" || r.afterDeadline || restoredHeads.has(r.headSha)) continue;
    if (r.parseStatus !== "ok" && !(r.parseStatus === "fallback" && !graded)) continue;
    if (!best || r.completedAt.getTime() > best.completedAt.getTime()) best = r;
  }
  return best?.id ?? null;
}
