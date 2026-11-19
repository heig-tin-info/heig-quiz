/**
 * Each member's access to a project repository on GitHub (F-PROJ-07,
 * ADR-070's amendment of 2026-11-19): a group has several members, so the
 * repository's `invitation_status` (one member in: `accepted`) says nothing
 * of each one. What is known of a member lives on their grant
 * (`project_repo_access`): `accepted_at` (GitHub said they are in) and
 * `absent_at` (a check found them neither in nor invited), the state is
 * `repoAccessState` of `@quiz/domain` over their latest live grant.
 *
 * - `checkGrants` — the one check against GitHub: one listing of the
 *   collaborators and one of the invitations per repository, whatever the
 *   number of members (N-PERF-07); the daily reconciliation's, and the
 *   resend's on a group's repository;
 * - `accessStates` — the reading: one query for any number of seats.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Octokit } from "octokit";

import { latestGrant, repoAccessState, type RepoAccessState } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { projectRepoAccess } from "../../db/schema.js";
import { ownerRepo } from "../../github/app.js";
import { directCollaborators, pendingInvitees, type ListedAccount } from "../../github/collaborators.js";
import type { GrantRow } from "./access.js";

/** Whether `account` is the grant's: by its immutable id when GitHub gave one, else by the login it was invited under. */
const isGrants = (grant: Pick<GrantRow, "githubUserId" | "githubLogin">, account: ListedAccount): boolean =>
  account.accountId === undefined ? account.login.toLowerCase() === grant.githubLogin.toLowerCase() : account.accountId === grant.githubUserId;

/** What a check found of the grants it read: in, still invited, or gone. */
export interface Checked {
  joined: GrantRow[];
  invited: GrantRow[];
  absent: GrantRow[];
}

/**
 * The live grants of repository `repoId` (named `fullName` on GitHub) looked
 * at on GitHub, and what was found written on each: a collaborator is
 * `accepted_at` (now), an invitee clears `absent_at`, anyone else is
 * `absent_at` (now). `recheck`: the grants already joined too (a resend,
 * where GitHub is asked anyway); otherwise only those not known in (the
 * daily pass). A grant a revocation is taking away (`revoking_at`) is left
 * to its revocation. No grant to look at: no request at all.
 */
export async function checkGrants(db: Db, octokit: Octokit, repoId: string, fullName: string, now: Date, recheck = false): Promise<Checked> {
  const grants = await db
    .select()
    .from(projectRepoAccess)
    .where(
      and(
        eq(projectRepoAccess.repoId, repoId),
        isNull(projectRepoAccess.revokedAt),
        isNull(projectRepoAccess.revokingAt),
        recheck ? undefined : isNull(projectRepoAccess.acceptedAt),
      ),
    );
  const checked: Checked = { joined: [], invited: [], absent: [] };
  if (grants.length === 0) return checked;
  const { owner, repo } = ownerRepo(fullName);
  const [collaborators, invitees] = await Promise.all([directCollaborators(octokit, owner, repo), pendingInvitees(octokit, owner, repo)]);
  for (const grant of grants) {
    // An invitation still pending wins: GitHub may list its invitee among the collaborators already.
    if (invitees.some((i) => isGrants(grant, i))) checked.invited.push(grant);
    else if (collaborators.some((c) => isGrants(grant, c))) checked.joined.push(grant);
    else checked.absent.push(grant);
  }
  // Each write only while the grant is the one read: an invitation since (a new `invited_at`) starts over.
  const unchanged = (list: GrantRow[]) =>
    or(...list.map((g) => and(eq(projectRepoAccess.id, g.id), eq(projectRepoAccess.invitedAt, g.invitedAt), isNull(projectRepoAccess.revokedAt))));
  if (checked.joined.length > 0) {
    await db
      .update(projectRepoAccess)
      .set({ acceptedAt: now, absentAt: null })
      .where(and(isNull(projectRepoAccess.acceptedAt), unchanged(checked.joined)));
  }
  // Not known in when read: a `member` webhook joining it meanwhile wins.
  const stillOut = recheck ? undefined : isNull(projectRepoAccess.acceptedAt);
  if (checked.invited.length > 0) {
    await db.update(projectRepoAccess).set({ acceptedAt: null, absentAt: null }).where(and(stillOut, unchanged(checked.invited)));
  }
  if (checked.absent.length > 0) {
    await db.update(projectRepoAccess).set({ acceptedAt: null, absentAt: now }).where(and(stillOut, unchanged(checked.absent)));
  }
  return checked;
}

/** A seat on a repository: the repository and the roster line reading it. */
export interface Seat {
  repoId: string;
  enrollmentId: string;
}

const seatKey = (s: Seat): string => `${s.repoId}:${s.enrollmentId}`;

/**
 * The access of each of `seats` at `now` (the server's clock): its latest
 * live grant through `repoAccessState`, none `unlinked`. One query whatever
 * the count; the answer reads any of `seats`.
 */
export async function accessStates(db: Db, seats: readonly Seat[], now: Date): Promise<(seat: Seat) => RepoAccessState> {
  const repoIds = [...new Set(seats.map((s) => s.repoId))];
  const grants =
    repoIds.length === 0
      ? []
      : await db
          .select({
            repoId: projectRepoAccess.repoId,
            enrollmentId: projectRepoAccess.enrollmentId,
            invitedAt: projectRepoAccess.invitedAt,
            acceptedAt: projectRepoAccess.acceptedAt,
            absentAt: projectRepoAccess.absentAt,
          })
          .from(projectRepoAccess)
          .where(and(inArray(projectRepoAccess.repoId, repoIds), isNull(projectRepoAccess.revokedAt)));
  const bySeat = new Map<string, typeof grants>();
  for (const g of grants) bySeat.set(seatKey(g), [...(bySeat.get(seatKey(g)) ?? []), g]);
  return (seat) => repoAccessState(latestGrant(bySeat.get(seatKey(seat)) ?? []), now);
}
