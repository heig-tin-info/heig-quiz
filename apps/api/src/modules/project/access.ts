/**
 * Who GitHub lets into a project repository (ADR-048 lot 2, ADR-070 §4–§5,
 * F-PROJ-17; merge task M3-15b): every account Quiz invites is RECORDED
 * (`project_repo_access`: the repository, the roster line, the account's
 * immutable id and the login it was invited under), and a departure revokes
 * the recorded accounts — never the line's link of today, which the
 * student may have changed since.
 *
 * - `recordGrant` — the account written BEFORE GitHub is asked, the line
 *   locked FOR SHARE: a line removed meanwhile is never invited;
 * - `inviteAccount` — the one invitation: the login of today, the grant
 *   recorded, the `push` invitation (never more, N-SEC-21), the grant
 *   taken back when GitHub refuses, and, when the line's grant was revoked
 *   while GitHub was being asked, the invitation taken back too;
 * - `inviteOnGithubLink` — a student who links their account is invited on
 *   their groups' existing repositories (best effort);
 * - `revokeEnrollmentAccess` — what the roster's writes call FIRST when a
 *   line leaves, or loses its account (F-PROJ-17, ADR-070 §5): every
 *   recorded account of the line taken out of every repository of the
 *   classroom's projects, a pending invitation cancelled first, or `502
 *   revoke_failed` with nothing changed by the caller. GitHub out of reach
 *   (the App gone, the repository or the account deleted) is no refusal:
 *   there is nothing left to take, and the audit says so (product owner,
 *   2026-10-05, P1).
 *
 * The `org` module calls `revokeEnrollmentAccess` through `service.ts`; it
 * never reads nor writes these tables itself.
 */
import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNotNull, isNull, ne, notExists, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Octokit } from "octokit";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { classrooms, enrollments, githubAccounts, projectGroupMembers, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { githubApp, installationClient, ownerRepo } from "../../github/app.js";
import { currentLogin, inviteCollaborator, isInvitationRefused, revokeCollaborator } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { rosterRefusal } from "../org/errors.js";
import { ProjectError } from "./errors.js";
import { seatRepos, type RepoMember } from "./groupRepos.js";
import type { RepoRow } from "./repos.js";

/** The account invited: its line, its immutable id and the login GitHub knew it by then. */
export interface InvitedAccount {
  enrollmentId: string;
  githubUserId: number;
  login: string;
}

/** A grant written: its id, and how to take it back if GitHub refuses the invitation. */
interface Grant {
  id: string;
  undo: () => Promise<void>;
}

/**
 * The account let into repository `repoId`, written BEFORE GitHub is asked:
 * in one short transaction that locks the line FOR SHARE, so that a line
 * being removed is never recorded (null: the line is gone) and a line
 * recorded meanwhile makes its removal fail on the foreign key (R2). A row
 * already there is brought back (a new login, `revoked_at` cleared).
 */
export async function recordGrant(db: Db, repoId: string, account: InvitedAccount, now: Date): Promise<Grant | null> {
  return db.transaction(async (tx) => {
    const [line] = await tx.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.id, account.enrollmentId)).for("share");
    if (!line) return null;
    const key = and(
      eq(projectRepoAccess.repoId, repoId),
      eq(projectRepoAccess.enrollmentId, account.enrollmentId),
      eq(projectRepoAccess.githubUserId, account.githubUserId),
    );
    const [before] = await tx.select().from(projectRepoAccess).where(key).for("update");
    const fields = { githubLogin: account.login, invitedAt: now, revokedAt: null };
    if (!before) {
      const id = randomUUID();
      await tx.insert(projectRepoAccess).values({ id, repoId, enrollmentId: account.enrollmentId, githubUserId: account.githubUserId, ...fields });
      return { id, undo: async () => void (await db.delete(projectRepoAccess).where(eq(projectRepoAccess.id, id))) };
    }
    await tx.update(projectRepoAccess).set(fields).where(eq(projectRepoAccess.id, before.id));
    const undo = async () => {
      if (before.revokedAt !== null) await db.update(projectRepoAccess).set({ revokedAt: before.revokedAt }).where(eq(projectRepoAccess.id, before.id));
    };
    return { id: before.id, undo };
  });
}

/**
 * The recorded accounts of the lines of a classroom, or of a course's
 * classrooms, forgotten in the transaction that deletes them: the line's
 * foreign key does not cascade (R2), and GitHub keeps the repositories and
 * their collaborators, as it keeps the repositories (D19, F-PROJ-16).
 */
export async function forgetGrants(tx: Db | Tx, gone: { classroomId: string } | { courseId: string }): Promise<void> {
  const lines =
    "classroomId" in gone
      ? tx.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.classroomId, gone.classroomId))
      : tx
          .select({ id: enrollments.id })
          .from(enrollments)
          .innerJoin(classrooms, eq(classrooms.id, enrollments.classroomId))
          .where(eq(classrooms.courseId, gone.courseId));
  await tx.delete(projectRepoAccess).where(inArray(projectRepoAccess.enrollmentId, lines));
}

/** How an invitation came: an Accept (one's own, or a fellow member's), a link, a resend. */
export type InviteVia = "accept" | "link" | "resend";

export interface InviteContext {
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
  via: InviteVia;
  /** The code of GitHub failing: Accept's `provision_failed`, a resend's `invite_failed`. */
  failure: "provision_failed" | "invite_failed";
}

/**
 * Invites `member` (who has a link) on `repo` with `push`: the login of
 * today for their immutable id (`linkedLogin`: a stored login renamed away
 * may be somebody else's now), the grant recorded first, the invitation
 * (idempotent on GitHub's side: 204 for a collaborator), the grant taken
 * back if GitHub refuses it. Audited `project_group.repo_invite` (a resend
 * audits itself). Null when the line is gone. Refusals: `github_account_stale`
 * (the account deleted, renamed away or refused), `ctx.failure`.
 */
export async function inviteAccount(
  db: Db,
  octokit: Octokit,
  repo: Pick<RepoRow, "id" | "fullName">,
  member: RepoMember & { account: NonNullable<RepoMember["account"]> },
  ctx: InviteContext,
): Promise<{ login: string; invitation: "pending" | "accepted" } | null> {
  const login = await linkedLogin(db, octokit, member.userId, member.account).catch((err: unknown) => {
    ctx.log.warn({ err, repo: repo.id }, "GitHub login lookup failed");
    throw new ProjectError(ctx.failure, "GitHub cannot be reached: try again");
  });
  if (typeof login !== "string") throw new ProjectError("github_account_stale", "The GitHub account is gone or renamed: relink it");
  const account = { enrollmentId: member.enrollmentId, githubUserId: member.account.githubUserId, login };
  const grant = await recordGrant(db, repo.id, account, ctx.now);
  if (grant === null) return null;
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  let invitation: "pending" | "accepted";
  try {
    invitation = await inviteCollaborator(octokit, owner, name, login, "push");
  } catch (err) {
    await grant.undo();
    if (isInvitationRefused(err)) throw new ProjectError("github_account_stale", "GitHub refused to invite the account: relink it");
    ctx.log.error({ err, repo: repo.id }, "an invitation failed");
    throw new ProjectError(ctx.failure, "GitHub failed: try again");
  }
  // The line's grant revoked (its line leaving) while GitHub was asked: the
  // revocation may have run before this invitation landed — take it back.
  const [live] = await db
    .select({ id: projectRepoAccess.id })
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.id, grant.id), isNull(projectRepoAccess.revokedAt)));
  if (!live) {
    await revokeCollaborator(octokit, owner, name, login);
    return null;
  }
  if (ctx.via !== "resend") {
    await audit(db, {
      ...ctx.actor,
      action: "project_group.repo_invite",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { repo: repo.fullName, enrollmentId: member.enrollmentId, login, invitation, via: ctx.via },
    });
  }
  return { login, invitation };
}

/**
 * A repository's `invitation_status` after an invitation answered
 * `invitation`: a student's own repository follows it; a group's is pending
 * while any member's is (the per-member follow-up is ADR-048's lot 3).
 */
export async function followInvitation(db: Db, repo: Pick<RepoRow, "id" | "groupId">, invitation: "pending" | "accepted"): Promise<void> {
  if (repo.groupId !== null && invitation === "accepted") return;
  await db.update(projectRepos).set({ invitationStatus: invitation }).where(and(eq(projectRepos.id, repo.id), ne(projectRepos.invitationStatus, invitation)));
}

/**
 * A student just linked their GitHub account (`auth/githubLink.ts`): their
 * groups may hold a repository they could not be invited on. Each
 * provisioned, live one of a published project that is not archived — the
 * one their seat reads (`seatRepos`) — is invited on, best effort: the link
 * never fails on it, and their Accept invites them anyway.
 */
export async function inviteOnGithubLink(db: Db, config: AppConfig, userId: string, ctx: { now: Date; log: FastifyBaseLogger }): Promise<void> {
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!account) return;
  const rows = await db
    .select({ project: projects, enrollmentId: enrollments.id })
    .from(enrollments)
    .innerJoin(projects, and(eq(projects.classroomId, enrollments.classroomId), eq(projects.groupMode, true)))
    .where(and(eq(enrollments.userId, userId), eq(enrollments.staff, false), ne(projects.state, "draft"), isNull(projects.archivedAt)));
  const seats = await seatRepos(
    db,
    rows.map((r) => r.project),
    rows.map((r) => r.enrollmentId),
  );
  for (const { project, enrollmentId } of rows) {
    const repo = seats.of(project.id, enrollmentId);
    if (!repo || repo.groupId === null || repo.provisionStatus !== "ok" || repo.deletedAt !== null) continue;
    try {
      const org = await projectInstallation(db, project.orgId);
      if (!org) continue;
      const { octokit } = await installationClient(config, org.installationId);
      const invited = await inviteAccount(db, octokit, repo, { enrollmentId, userId, account }, {
        actor: { actorUserId: userId, actorType: "user" },
        now: ctx.now,
        log: ctx.log,
        via: "link",
        failure: "invite_failed",
      });
      if (invited) await followInvitation(db, repo, invited.invitation);
    } catch (err) {
      ctx.log.warn({ err, repo: repo.id }, "a group repository's invitation on link failed");
    }
  }
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

type GrantRow = typeof projectRepoAccess.$inferSelect;
type Revoked = { outcome: "ok"; login: string; invitationsCancelled: number } | { outcome: "skipped"; login: string; reason: SkipReason };

/**
 * One installation client per organization, before any revocation: null
 * when Quiz's App is not on it — off, uninstalled, suspended (`installed`
 * forgets those), or gone without our hearing of it (GitHub answers the
 * token's request 404 or 403). Any other failure throws.
 */
async function installationClients(db: Db, config: AppConfig, orgIds: readonly string[]): Promise<Map<string, Octokit | null>> {
  const clients = new Map<string, Octokit | null>();
  for (const orgId of new Set(orgIds)) {
    const org = githubApp(config) === null ? null : await projectInstallation(db, orgId);
    try {
      clients.set(orgId, org === null ? null : (await installationClient(config, org.installationId)).octokit);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 404 && status !== 403) throw err;
      clients.set(orgId, null);
    }
  }
  return clients;
}

/** Takes one recorded account out of one repository, or says why there is nothing to take. Throws when GitHub refuses. */
async function revokeGrant(octokit: Octokit | null, repo: RepoRow, grant: GrantRow): Promise<Revoked> {
  const skipped = (reason: SkipReason, login = grant.githubLogin): Revoked => ({ outcome: "skipped", login, reason });
  if (repo.deletedAt !== null || repo.fullName === null) return skipped("repo_deleted");
  if (octokit === null) return skipped("app_not_installed");
  // The account invited, by its immutable id: its login of today.
  const login = await currentLogin(octokit, grant.githubUserId);
  if (login === null) return skipped("account_gone");
  const { owner, repo: name } = ownerRepo(repo.fullName);
  try {
    return { outcome: "ok", login, ...(await revokeCollaborator(octokit, owner, name, login)) };
  } catch (err) {
    // The repository is gone from GitHub: nobody reaches it any more.
    if ((err as { status?: number }).status === 404) return skipped("repo_deleted", login);
    throw err;
  }
}

/**
 * The provisioned repositories of the line's classroom it reaches with no
 * account ever recorded: its copy groups' and its user's own. What the
 * audit reports as skipped, `not_invited` (P1). (The backfill of 0067
 * recorded the individual repositories' students linked at the migration;
 * one who had unlinked before it is reported here too.)
 */
async function uninvitedRepos(db: Db, enrollmentId: string): Promise<RepoRow[]> {
  const [line] = await db.select().from(enrollments).where(eq(enrollments.id, enrollmentId));
  if (!line) return [];
  const rows = await db
    .select({ repo: projectRepos })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(
      and(
        eq(projects.classroomId, line.classroomId),
        eq(projectRepos.provisionStatus, "ok"),
        or(
          inArray(
            projectRepos.groupId,
            db.select({ groupId: projectGroupMembers.groupId }).from(projectGroupMembers).where(eq(projectGroupMembers.enrollmentId, enrollmentId)),
          ),
          line.userId === null ? undefined : and(isNull(projectRepos.groupId), eq(projectRepos.userId, line.userId)),
        ),
        notExists(
          db
            .select({ id: projectRepoAccess.id })
            .from(projectRepoAccess)
            .where(and(eq(projectRepoAccess.repoId, projectRepos.id), eq(projectRepoAccess.enrollmentId, enrollmentId))),
        ),
      ),
    );
  return rows.map((r) => r.repo);
}

/**
 * Takes every recorded account of roster line `enrollmentId` out of every
 * repository it was let into (a group's or the student's own), a pending
 * invitation then the collaborator seat, before the caller removes the
 * line or detaches its account. Each account is marked revoked and audited
 * as it goes, so a retry resumes where GitHub stopped; a repository left
 * with no live account has its invitation state cleared (`none`). For a
 * removal (`roster.remove`) the revoked rows are then deleted, so that the
 * line's delete passes its foreign key — unless an account was recorded
 * in between, which fails it (`revoke_failed`, retried).
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
  const failed = (err: unknown, repo: RepoRow | null) => {
    ctx.log.error({ err, repo: repo?.id, enrollmentId }, "revoking a repository access failed");
    return rosterRefusal("revoke_failed", { repo: repo?.fullName ?? null });
  };
  const trace = (repo: RepoRow, payload: Record<string, unknown>) =>
    audit(db, {
      ...ctx.actor,
      action: "project_group.repo_revoke",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { repo: repo.fullName, enrollmentId, via: ctx.via, ...payload },
    });

  const clients = await installationClients(
    db,
    config,
    grants.map((g) => g.orgId),
  ).catch((err: unknown) => {
    throw failed(err, null);
  });
  for (const { grant, repo, orgId } of grants) {
    const revoked = await revokeGrant(clients.get(orgId)!, repo, grant).catch((err: unknown) => {
      throw failed(err, repo);
    });
    await db.update(projectRepoAccess).set({ revokedAt: ctx.now }).where(eq(projectRepoAccess.id, grant.id));
    await db
      .update(projectRepos)
      .set({ invitationStatus: "none" })
      .where(
        and(
          eq(projectRepos.id, repo.id),
          notExists(
            db
              .select({ id: projectRepoAccess.id })
              .from(projectRepoAccess)
              .where(and(eq(projectRepoAccess.repoId, repo.id), isNull(projectRepoAccess.revokedAt))),
          ),
        ),
      );
    await trace(repo, revoked);
  }
  // Only once every recorded account is out: the repositories it reached with none.
  for (const repo of await uninvitedRepos(db, enrollmentId)) {
    await trace(repo, { login: null, outcome: "skipped", reason: "not_invited" });
  }
  if (ctx.via === "roster.remove") {
    await db.delete(projectRepoAccess).where(and(eq(projectRepoAccess.enrollmentId, enrollmentId), isNotNull(projectRepoAccess.revokedAt)));
  }
}
