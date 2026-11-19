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
 * - `pending`: invited and not in yet, the invitation younger than GitHub's
 *   seven days, or never found gone;
 * - `expired`: invited seven days ago or more AND a check found the account
 *   neither a collaborator nor invited any more (`absentAt`): GitHub dropped
 *   or the member declined the invitation. Never without such a check;
 * - `unlinked`: no live grant (never invited, or no linked account to invite).
 */

/** The states of a member's access, in the order the staff reads them. */
export const REPO_ACCESS_STATES = ["joined", "pending", "expired", "unlinked"] as const;
export type RepoAccessState = (typeof REPO_ACCESS_STATES)[number];

/** How long GitHub keeps a repository invitation before dropping it. */
export const INVITATION_EXPIRY_MS = 7 * 24 * 3_600_000;

/** What the rule reads of a member's live grant: the last invitation, GitHub's yes, a check that found it gone. */
export interface AccessGrant {
  invitedAt: Date;
  acceptedAt: Date | null;
  absentAt: Date | null;
}

/** The state of a member whose latest live grant is `grant` (null: none), at `now` (the server's clock). */
export function repoAccessState(grant: AccessGrant | null, now: Date): RepoAccessState {
  if (grant === null) return "unlinked";
  if (grant.acceptedAt !== null) return "joined";
  const old = now.getTime() - grant.invitedAt.getTime() >= INVITATION_EXPIRY_MS;
  return old && grant.absentAt !== null ? "expired" : "pending";
}

/** The latest of a member's live grants (the last invited), or null: the one {@link repoAccessState} reads. */
export function latestGrant<G extends { invitedAt: Date }>(grants: readonly G[]): G | null {
  let latest: G | null = null;
  for (const g of grants) if (latest === null || g.invitedAt > latest.invitedAt) latest = g;
  return latest;
}
