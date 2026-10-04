/**
 * Who GitHub lets into a project repository (ADR-048 lot 2, ADR-070 §4–§5,
 * F-PROJ-17; merge task M3-15b): every account Quiz invites is RECORDED
 * (`project_repo_access`: the repository, the roster line, the account's
 * immutable id and the login it was invited under), and a departure revokes
 * the recorded accounts — never the line's link of today, which the
 * student may have changed since.
 *
 * - `recordGrant` — the account written, or let in again;
 * - `inviteMember` — a member invited on their group's repository, with
 *   `push` and never more (N-SEC-21), recorded and audited;
 * - `inviteOnGithubLink` — a student who links their account is invited on
 *   their groups' existing repositories (best effort);
 * - `revokeEnrollmentAccess` — what the roster's writes call FIRST when a
 *   line leaves, or loses its account (F-PROJ-17, ADR-070 §5): every
 *   recorded account of the line taken out of every repository of the
 *   classroom's projects, a pending invitation cancelled too, or `502
 *   revoke_failed` with nothing changed by the caller. GitHub out of reach
 *   (the App gone, the repository or the account deleted) is no refusal:
 *   there is nothing left to take, and the audit says so (product owner,
 *   2026-10-05, P1).
 *
 * The `org` module calls `revokeEnrollmentAccess` through `service.ts`; it
 * never reads nor writes these tables itself.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Octokit } from "octokit";

import { audit, type AuditActor } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { enrollments, projectGroupMembers, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { githubApp, installationClient, ownerRepo } from "../../github/app.js";
import { currentLogin, inviteCollaborator, revokeCollaborator } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { ProjectError } from "./errors.js";
import { individualHolders } from "./groupRepos.js";
import type { RepoRow } from "./repos.js";

/** The account invited: its immutable id and the login GitHub knew it by then. */
export interface InvitedAccount {
  enrollmentId: string;
  githubUserId: number;
  login: string;
}

/** The account let into repository `repoId`: written, or its row brought back (a new login, `revoked_at` cleared). */
export async function recordGrant(db: Db, repoId: string, account: InvitedAccount, now: Date): Promise<void> {
  const fields = { githubLogin: account.login, invitedAt: now, revokedAt: null };
  await db
    .insert(projectRepoAccess)
    .values({ id: randomUUID(), repoId, enrollmentId: account.enrollmentId, githubUserId: account.githubUserId, ...fields })
    .onConflictDoUpdate({
      target: [projectRepoAccess.repoId, projectRepoAccess.enrollmentId, projectRepoAccess.githubUserId],
      set: fields,
    });
}

/** How a member came to be invited: their own Accept (or a fellow member's), or the link of their account. */
export type InviteVia = "accept" | "link";

/**
 * Invites one member on a group's repository with `push` (idempotent on
 * GitHub's side: 204 for a collaborator, an invitation renewed otherwise),
 * records the account and audits it. Throws when GitHub refuses: each
 * caller decides what that means for its request.
 */
export async function inviteMember(
  db: Db,
  octokit: Octokit,
  repo: Pick<RepoRow, "id" | "fullName">,
  account: InvitedAccount,
  ctx: { actor: AuditActor; now: Date; via: InviteVia },
): Promise<"pending" | "accepted"> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const invitation = await inviteCollaborator(octokit, owner, name, account.login, "push");
  await recordGrant(db, repo.id, account, ctx.now);
  await audit(db, {
    ...ctx.actor,
    action: "project_group.repo_invite",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { repo: repo.fullName, enrollmentId: account.enrollmentId, login: account.login, invitation, via: ctx.via },
  });
  return invitation;
}

/**
 * A group repository's `invitation_status` once a member's invitation is
 * `pending`: the group's invitations are pending while any is (the
 * per-member follow-up is ADR-048's lot 3).
 */
export async function markGroupInvitationPending(db: Db, repoId: string): Promise<void> {
  await db
    .update(projectRepos)
    .set({ invitationStatus: "pending" })
    .where(and(eq(projectRepos.id, repoId), ne(projectRepos.invitationStatus, "pending")));
}

/**
 * A student just linked GitHub account `account` (`auth/githubLink.ts`):
 * their groups may hold a repository they could not be invited on. Each
 * provisioned, live one of a published project that is not archived is
 * invited on, best effort — the link never fails on it, and their Accept
 * invites them anyway. Returns the repositories invited on.
 */
export async function inviteOnGithubLink(
  db: Db,
  config: AppConfig,
  userId: string,
  account: { githubUserId: number; login: string },
  ctx: { now: Date; log: FastifyBaseLogger },
): Promise<string[]> {
  const rows = await db
    .select({ repo: projectRepos, enrollmentId: enrollments.id, orgId: projects.orgId })
    .from(enrollments)
    .innerJoin(projectGroupMembers, eq(projectGroupMembers.enrollmentId, enrollments.id))
    .innerJoin(projectRepos, eq(projectRepos.groupId, projectGroupMembers.groupId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(
      and(
        eq(enrollments.userId, userId),
        eq(enrollments.staff, false),
        ne(projects.state, "draft"),
        isNull(projects.archivedAt),
        eq(projectRepos.provisionStatus, "ok"),
        isNull(projectRepos.deletedAt),
      ),
    );
  const invited: string[] = [];
  for (const { repo, enrollmentId, orgId } of rows) {
    try {
      // A heig-classroom individual repository keeps its student.
      if ((await individualHolders(db, repo.projectId)).has(userId)) continue;
      const org = await projectInstallation(db, orgId);
      if (!org || repo.fullName === null) continue;
      const { octokit } = await installationClient(config, org.installationId);
      const invitation = await inviteMember(db, octokit, repo, { enrollmentId, ...account }, {
        actor: { actorUserId: userId, actorType: "user" },
        now: ctx.now,
        via: "link",
      });
      if (invitation === "pending") await markGroupInvitationPending(db, repo.id);
      invited.push(repo.fullName);
    } catch (err) {
      ctx.log.warn({ err, repo: repo.id }, "a group repository's invitation on link failed");
    }
  }
  return invited;
}

/** Why a revocation had nothing to take (P1): the audit's `reason`. */
type SkipReason = "app_not_installed" | "repo_deleted" | "account_gone" | "not_invited";

/** The roster write a revocation runs before: the audit's `via`. */
export type RevokeVia = "roster.remove" | "roster.unclaim" | "roster.update" | "roster.self_enroll";

export interface RevokeContext {
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
  via: RevokeVia;
}

/**
 * The provisioned repositories of the line's classroom it reaches without
 * a live recorded account: its copy groups' and its user's own. What the
 * audit reports as skipped, `not_invited` (P1: the member never had an
 * account invited).
 */
async function uninvitedRepos(db: Db, enrollmentId: string): Promise<RepoRow[]> {
  const [line] = await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId));
  if (!line) return [];
  const byGroup = db
    .select({ groupId: projectGroupMembers.groupId })
    .from(projectGroupMembers)
    .where(eq(projectGroupMembers.enrollmentId, enrollmentId));
  const granted = db
    .select({ repoId: projectRepoAccess.repoId })
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.enrollmentId, enrollmentId), isNull(projectRepoAccess.revokedAt)));
  const rows = await db
    .select({ repo: projectRepos })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(
      and(
        eq(projects.classroomId, line.classroomId),
        eq(projectRepos.provisionStatus, "ok"),
        or(
          inArray(projectRepos.groupId, byGroup),
          line.userId === null ? undefined : and(isNull(projectRepos.groupId), eq(projectRepos.userId, line.userId)),
        ),
      ),
    );
  const live = new Set((await granted).map((g) => g.repoId));
  return rows.map((r) => r.repo).filter((repo) => !live.has(repo.id));
}

/**
 * Takes every recorded account of roster line `enrollmentId` out of every
 * repository it was let into (a group's or the student's own), the
 * collaborator seat and a pending invitation alike, before the caller
 * removes the line or detaches its account. Each account is marked revoked
 * and audited as it goes, so a retry resumes where GitHub stopped.
 *
 * Nothing to take is no refusal (P1): the App no longer on the
 * organization, the repository deleted on GitHub (or known so), the account
 * deleted, no account ever invited — each audited `skipped` with its
 * reason. GitHub refusing a reachable repository, or failing, throws `502
 * revoke_failed`: the caller then changes nothing.
 */
export async function revokeEnrollmentAccess(db: Db, config: AppConfig, enrollmentId: string, ctx: RevokeContext): Promise<void> {
  const grants = await db
    .select({ grant: projectRepoAccess, repo: projectRepos, orgId: projects.orgId })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepoAccess.enrollmentId, enrollmentId), isNull(projectRepoAccess.revokedAt)))
    .orderBy(projectRepoAccess.repoId, projectRepoAccess.githubUserId);

  const trace = (repo: RepoRow, login: string | null, outcome: Record<string, unknown>) =>
    audit(db, {
      ...ctx.actor,
      action: "project_group.repo_revoke",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { repo: repo.fullName, enrollmentId, login, via: ctx.via, ...outcome },
    });

  for (const repo of await uninvitedRepos(db, enrollmentId)) {
    await trace(repo, null, { outcome: "skipped", reason: "not_invited" });
  }

  // One installation client per organization, null when the App is not on it.
  const clients = new Map<string, Promise<Octokit | null>>();
  const clientOf = (orgId: string) => {
    if (!clients.has(orgId)) {
      clients.set(
        orgId,
        (async () => {
          const org = githubApp(config) === null ? null : await projectInstallation(db, orgId);
          return org === null ? null : (await installationClient(config, org.installationId)).octokit;
        })(),
      );
    }
    return clients.get(orgId)!;
  };

  for (const { grant, repo, orgId } of grants) {
    let outcome: Record<string, unknown>;
    let login = grant.githubLogin;
    try {
      outcome = await (async () => {
        const skipped = (reason: SkipReason) => ({ outcome: "skipped", reason });
        if (repo.deletedAt !== null || repo.fullName === null) return skipped("repo_deleted");
        const octokit = await clientOf(orgId);
        if (octokit === null) return skipped("app_not_installed");
        // The account invited, by its immutable id: its login of today.
        const today = await currentLogin(octokit, grant.githubUserId);
        if (today === null) return skipped("account_gone");
        login = today;
        const { owner, repo: name } = ownerRepo(repo.fullName);
        try {
          const { invitationsCancelled } = await revokeCollaborator(octokit, owner, name, today);
          return { outcome: "ok", invitationsCancelled };
        } catch (err) {
          // The repository is gone from GitHub: nobody reaches it any more.
          if ((err as { status?: number }).status === 404) return skipped("repo_deleted");
          throw err;
        }
      })();
    } catch (err) {
      ctx.log.error({ err, repo: repo.id, enrollmentId }, "revoking a repository access failed");
      throw new ProjectError("revoke_failed", "GitHub did not take the student's access away: nothing was changed, try again", {
        repo: repo.fullName,
      });
    }
    await db.update(projectRepoAccess).set({ revokedAt: ctx.now }).where(eq(projectRepoAccess.id, grant.id));
    await trace(repo, login, outcome);
  }
}
