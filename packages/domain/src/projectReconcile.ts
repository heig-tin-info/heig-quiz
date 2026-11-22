/**
 * Which project repositories the reconciliations still read (N-RES-08,
 * ADR-011 and its addenda of 2026-10-05 and 2026-11-22; merge task M3-06).
 * The `project` module reads the rows; this rule decides, and bounds
 * GitHub's quota: a finished project costs nothing after a day, and a final
 * review that never came costs nothing after a week.
 */

/** A repository frozen for good leaves the reconciliations this long after its freeze. */
export const RECONCILE_AFTER_FREEZE_MS = 24 * 3_600_000;
/** A CI final review asked and never answered keeps its repository polled this long after the freeze, no longer. */
export const RECONCILE_REVIEW_WAIT_MS = 7 * 24 * 3_600_000;

/** What a repository still awaits from its runs, past its freeze. */
export interface AwaitedRuns {
  /** An `auto` project's final review was asked (a `deadline` dispatch): its review run fills the slot. */
  finalReview: boolean;
  /** A schema-3 project's CI pass is open (ADR-119 §6): it ends itself, settled `no_result` 24 h after its dispatch. */
  ciPass: boolean;
}

/**
 * Whether the reconciliations still poll a live repository (product owner,
 * 2026-10-05, bounded 2026-11-22): until 24 hours after its definitive
 * freeze; while a schema-3 project's CI pass is open, whatever the freeze's
 * age (a Regrade opens one on a repository frozen long before, ADR-132, and
 * the pass ends itself within a day); and while an `auto` project's final
 * review was asked and no review run filled the slot, until 7 days after
 * the freeze, never beyond: a review that has not come in a week will not
 * come (production, 2026-11-22: 52 repositories of six projects frozen in
 * September and October were still polled). A reopen clears the freeze,
 * so a reopened repository is polled again.
 */
export function reconciles(
  repo: { frozenAt: Date | null; reviewGradeRunId: string | null },
  awaited: AwaitedRuns,
  now: Date,
): boolean {
  if (repo.frozenAt === null || awaited.ciPass) return true;
  const bound = awaited.finalReview && repo.reviewGradeRunId === null ? RECONCILE_REVIEW_WAIT_MS : RECONCILE_AFTER_FREEZE_MS;
  return now.getTime() - repo.frozenAt.getTime() < bound;
}
