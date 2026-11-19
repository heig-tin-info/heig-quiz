/**
 * A member's access to a project repository on GitHub (F-PROJ-07, ADR-070's
 * amendment of 2026-11-19): the ONE rule that turns what the server recorded
 * of a member's invitation (`project_repo_access`) into the state the staff
 * and the member read. A group has several members, so the repository's own
 * `invitation_status` (one member in: `accepted`) says nothing of each one.
 *
 * - `joined`: GitHub said the account is a collaborator (the `member`
 *   webhook, the daily reconciliation, or an invitation GitHub answered
 *   "already a collaborator");
 * - `pending`: invited and not in yet, never found gone since;
 * - `expired`: a check found the account neither a collaborator nor
 *   invited any more since its last invitation (`absentAt`): GitHub dropped
 *   the invitation, or the member declined it. Never without such a check;
 * - `unlinked`: no live grant (never invited, or no linked account to invite).
 */

/** The states of a member's access, in the order the staff reads them. */
export const REPO_ACCESS_STATES = ["joined", "pending", "expired", "unlinked"] as const;
export type RepoAccessState = (typeof REPO_ACCESS_STATES)[number];

/** What the rule reads of a member's live grant: GitHub's yes, a check that found it gone. */
export interface AccessGrant {
  acceptedAt: Date | null;
  absentAt: Date | null;
}

/** The state of a member whose latest live grant is `grant` (null: none). */
export function repoAccessState(grant: AccessGrant | null): RepoAccessState {
  if (grant === null) return "unlinked";
  if (grant.acceptedAt !== null) return "joined";
  return grant.absentAt !== null ? "expired" : "pending";
}
