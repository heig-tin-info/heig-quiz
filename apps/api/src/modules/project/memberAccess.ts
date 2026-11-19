/**
 * Each member's access to a project repository on GitHub (F-PROJ-07,
 * ADR-070's amendment of 2026-11-19): a group has several members, so the
 * repository's `invitation_status` (one member in: `accepted`) says nothing
 * of each one. What is known of a member lives on their grant
 * (`project_repo_access`): `accepted_at` (GitHub said they are in) and
 * `absent_at` (a check found them neither in nor invited), the state is
 * `repoAccessState` of `@quiz/domain` over their latest live grant. A
 * student's own repository is read the same way: one rule for both kinds.
 *
 * - `liveGrants` and `checkGrants` — the one check against GitHub: one
 *   listing of the collaborators and one of the invitations per repository,
 *   whatever the number of members (N-PERF-07); the daily
 *   reconciliation's, and the resend's on a group's repository;
 * - `accessStates` — the reading: one query for any number of seats.
 */
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Octokit } from "octokit";

import { repoAccessState, type RepoAccessState } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { projectRepoAccess } from "../../db/schema.js";
import { ownerRepo } from "../../github/app.js";
import { directCollaborators, pendingInvitees } from "../../github/collaborators.js";
import type { GrantRow } from "./access.js";

/** The live grants of repository `repoId` (not revoked; one a revocation is asking about included). */
export const liveGrants = (db: Db, repoId: string): Promise<GrantRow[]> =>
  db
    .select()
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.repoId, repoId), isNull(projectRepoAccess.revokedAt)));

/**
 * The `grants` of a repository named `fullName` on GitHub that are not known
 * in (`accepted_at` null) nor being revoked (`revoking_at`, left to its
 * revocation), looked at on GitHub by their accounts' immutable ids, and
 * what was found written on each: a collaborator is `accepted_at` (now); an
 * invitee whose invitation GitHub still offers clears `absent_at`; anyone
 * else — no invitation, or one GitHub reports `expired` — is `absent_at`
 * (now). Each write holds only while the grant is the one read (a new
 * invitation since starts over) and is still not known in (a `member`
 * webhook joining it meanwhile wins). No grant to look at: no request.
 */
export async function checkGrants(db: Db, octokit: Octokit, fullName: string, grants: readonly GrantRow[], now: Date): Promise<{ joined: GrantRow[]; absent: GrantRow[] }> {
  const open = grants.filter((g) => g.acceptedAt === null && g.revokingAt === null);
  const joined: GrantRow[] = [];
  const invited: GrantRow[] = [];
  const absent: GrantRow[] = [];
  if (open.length === 0) return { joined, absent };
  const { owner, repo } = ownerRepo(fullName);
  const [collaborators, invitees] = await Promise.all([directCollaborators(octokit, owner, repo), pendingInvitees(octokit, owner, repo)]);
  const offered = new Set(invitees.filter((i) => !i.expired).map((i) => i.accountId));
  const collaborating = new Set(collaborators.map((c) => c.accountId));
  for (const grant of open) {
    // An invitation GitHub still offers wins: GitHub may list its invitee among the collaborators already.
    if (offered.has(grant.githubUserId)) invited.push(grant);
    else if (collaborating.has(grant.githubUserId)) joined.push(grant);
    else absent.push(grant);
  }
  const unchanged = (list: GrantRow[]) =>
    and(
      isNull(projectRepoAccess.acceptedAt),
      isNull(projectRepoAccess.revokedAt),
      or(...list.map((g) => and(eq(projectRepoAccess.id, g.id), eq(projectRepoAccess.invitedAt, g.invitedAt)))),
    );
  if (joined.length > 0) await db.update(projectRepoAccess).set({ acceptedAt: now, absentAt: null }).where(unchanged(joined));
  if (invited.length > 0) await db.update(projectRepoAccess).set({ absentAt: null }).where(unchanged(invited));
  if (absent.length > 0) await db.update(projectRepoAccess).set({ absentAt: now }).where(unchanged(absent));
  return { joined, absent };
}

/** A seat on a repository: the repository and the roster line reading it. */
export interface Seat {
  repoId: string;
  enrollmentId: string;
}

const seatKey = (s: Seat): string => `${s.repoId}:${s.enrollmentId}`;

/**
 * The access of each of `seats`: its latest live grant (the last invited)
 * through `repoAccessState`, none `unlinked`. One query whatever the count;
 * the answer reads any of `seats`.
 */
export async function accessStates(db: Db, seats: readonly Seat[]): Promise<(seat: Seat) => RepoAccessState> {
  const repoIds = [...new Set(seats.map((s) => s.repoId))];
  const grants =
    repoIds.length === 0
      ? []
      : await db
          .select({
            repoId: projectRepoAccess.repoId,
            enrollmentId: projectRepoAccess.enrollmentId,
            acceptedAt: projectRepoAccess.acceptedAt,
            absentAt: projectRepoAccess.absentAt,
          })
          .from(projectRepoAccess)
          .where(and(inArray(projectRepoAccess.repoId, repoIds), isNull(projectRepoAccess.revokedAt)))
          .orderBy(asc(projectRepoAccess.invitedAt));
  // In invitation order: the last one set is the seat's latest grant.
  const latest = new Map(grants.map((g) => [seatKey(g), g]));
  return (seat) => repoAccessState(latest.get(seatKey(seat)) ?? null);
}

/** {@link accessStates} of one seat. */
export async function seatAccess(db: Db, seat: Seat): Promise<RepoAccessState> {
  return (await accessStates(db, [seat]))(seat);
}
