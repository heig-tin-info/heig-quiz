/**
 * Which project repositories the reconciliations still read (N-RES-08,
 * ADR-011 and its addendum of 2026-10-05; merge task M3-06). The `project`
 * module reads the rows; these rules decide, and bound GitHub's quota: a
 * finished project costs nothing after a day.
 */

/** A repository with no push received and no run completed for this long is QUIET: its webhooks may have been lost. */
export const RECONCILE_QUIET_MS = 30 * 60_000;
/** A repository frozen for good leaves the reconciliations this long after its freeze. */
export const RECONCILE_AFTER_FREEZE_MS = 24 * 3_600_000;

/**
 * Whether the reconciliations still poll a live repository (product owner,
 * 2026-10-05): until 24 hours after its definitive freeze, and longer only
 * while its final review was asked (a `deadline` dispatch) and no review
 * run filled the slot. A reopen clears the freeze, so a reopened repository
 * is polled again.
 */
export function reconciles(
  repo: { frozenAt: Date | null; reviewGradeRunId: string | null },
  reviewAsked: boolean,
  now: Date,
): boolean {
  if (repo.frozenAt === null) return true;
  if (reviewAsked && repo.reviewGradeRunId === null) return true;
  return now.getTime() - repo.frozenAt.getTime() < RECONCILE_AFTER_FREEZE_MS;
}

/**
 * Whether a repository has been quiet (`reconcile.grades` reads the runs of
 * the quiet ones only): nothing happened to it for 30 minutes — `lastActivityAt`
 * is the latest of its push receipts and of its runs' completion, null when
 * there was none — since while the webhooks flow, there is nothing to catch up.
 */
export function isQuiet(lastActivityAt: Date | null, now: Date): boolean {
  return lastActivityAt === null || now.getTime() - lastActivityAt.getTime() > RECONCILE_QUIET_MS;
}
