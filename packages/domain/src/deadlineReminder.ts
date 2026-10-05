/**
 * The day-before reminder of a deadline (F-NOTIF-06 for an evaluation,
 * F-NOTIF-13 for a project under the same rules; merge task M3-09b): how
 * long before the end it is due, and when a deadline that MOVED re-arms a
 * reminder already sent. The `notifications` and `project` modules hold the
 * claims (`deadline_reminders`, `projects.reminder_sent_at`,
 * `project_repos.reminder_sent_at`) and run the scans; these decide. `now`
 * is the server's clock (invariant 5), never read here.
 */

/** How long before a deadline the reminder is due. Fixed: no setting (ADR-030 §d, §g). */
export const DEADLINE_REMINDER_MS = 24 * 3_600_000;

/**
 * The claim of a project's reminder after its deadline MOVED (a project's
 * patch, a repository's own deadline changed, a reopen): re-armed — null —
 * only when the new deadline is more than a day away; otherwise kept as it
 * was, so a reminder already sent is not sent again, and one still owed on
 * a deadline brought nearer is still owed (F-NOTIF-06: a moved end never
 * sends it again). The window rule — no reminder when the whole window is
 * under a day — is the scan's, on the project's `start_at`, as the
 * evaluation reminder reads `started_at`.
 */
export function reminderClaimAfterMove(claim: Date | null, deadlineAt: Date, now: Date): Date | null {
  return deadlineAt.getTime() - now.getTime() > DEADLINE_REMINDER_MS ? null : claim;
}
