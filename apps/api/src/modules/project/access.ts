/**
 * Who GitHub lets into a project repository (ADR-048 lot 2, ADR-070 §4–§5,
 * F-PROJ-17; merge task M3-15b): every account Quiz invites is RECORDED
 * (`project_repo_access`: the repository, the roster line, the account's
 * immutable id and the login it was invited under), and a departure revokes
 * the recorded accounts — never the line's link of today, which the
 * student may have changed since.
 *
 * - `recordGrant` — the account written BEFORE GitHub is asked, the line
 *   locked FOR SHARE and still its user's seat (a student's, or a staff
 *   seat on its own individual repository, ADR-077): a line removed,
 *   unclaimed or moved to another address meanwhile is never invited;
 * - `releaseLine` — the other side of that lock: a roster write that takes
 *   a line or its account away, in its transaction, refuses while an
 *   account recorded for it is still live (`RevokeFailed`);
 * - `inviteAccount` — the one invitation: the login of today, the grant
 *   recorded, the `push` invitation (never more, N-SEC-21), the grant
 *   taken back when GitHub refuses, and, when the line's grant was revoked
 *   while GitHub was being asked, the invitation taken back too;
 * - `inviteOnGithubLink` — a student who links their account is invited on
 *   their groups' existing repositories (best effort);
 * - `revokeDeparture` — the `group.sync` job's one-repository version of
 *   `revokeEnrollmentAccess`: a member the set moves out of a group with a
 *   repository, or a stray access (M3-15b-2);
 * - `revokeEnrollmentAccess` — what the roster's writes call FIRST when a
 *   line leaves, or loses its account (F-PROJ-17, ADR-070 §5): every
 *   recorded account of the line taken out of every repository of the
 *   classroom's projects, a pending invitation cancelled first, or `502
 *   revoke_failed` with nothing changed by the caller. GitHub out of reach
 *   (the App gone, the repository or the account deleted) is no refusal:
 *   there is nothing left to take, and the audit says so (product owner,
 *   2026-10-05, P1).
 *
 * A grant is revoked only once GitHub confirmed it (M3-15b-2):
 * `revoking_at` while GitHub is asked, `revoked_at` after its answer; until
 * then it is live for every check (`assertNoLiveGrant`).
 *
 * The `org` module calls `revokeEnrollmentAccess` and `releaseLine` through
 * `service.ts` and words `RevokeFailed` as its `502 revoke_failed`; it never
 * reads nor writes these tables itself.
 */
import { randomUUID } from "node:crypto";

import { and, eq, isNotNull, isNull, ne, notExists, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Octokit } from "octokit";

import { collaboratorPermission } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { enrollments, githubAccounts, projectGroupMembers, projectRepoAccess, projectRepos, projects } from "../../db/schema.js";
import { githubApp, installationClient, ownerRepo, unless404 } from "../../github/app.js";
import { currentLogin, inviteCollaborator, isInvitationRefused, revokeCollaborator } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { ProjectError } from "./errors.js";
import { seatRepos, type RepoMember } from "./groupRepos.js";
import { provisioningNow, type RepoRow } from "./repos.js";

/** The account invited: its line and the line's user, its immutable id and the login GitHub knew it by then. */
export interface InvitedAccount {
  enrollmentId: string;
  userId: string;
  githubUserId: number;
  login: string;
}

/**
 * A grant written: its id, how to take it back if GitHub refuses the
 * invitation, and whether it LET THE ACCOUNT IN — a row made, or a revoked
 * one brought back — rather than finding it live already (a repeat).
 */
interface Grant {
  id: string;
  undo: () => Promise<void>;
  fresh: boolean;
}

/**
 * Why no grant was recorded: the line's move out of the repository's group
 * waits for GitHub (`departing`, M3-15b-2: try again once it is done), or
 * the line is no longer that repository's (`gone`).
 */
export type NotRecorded = "departing" | "gone";

/** Nobody was let in: {@link recordGrant}'s and {@link inviteAccount}'s answer when they record no grant. */
export const notRecorded = (answer: object | NotRecorded): answer is NotRecorded => typeof answer === "string";

/**
 * The account let into `repo`, written BEFORE GitHub is asked, in one short
 * transaction that locks the line FOR SHARE: only while the line is still
 * claimed by `account.userId` (a student's seat or, for its own test
 * repository only, a staff seat, ADR-077) — otherwise nobody is invited. A
 * roster write that takes the line or its account away waits for this lock
 * and then finds the row (`releaseLine`). A group's
 * repository also locks the line's member row of the copy FOR SHARE
 * (M3-15b-2): only a member of that group whose departure is not pending is
 * let in — a set's write marking it waits for this lock, and the
 * `group.sync` job then revokes what it finds. A row already there is
 * brought back (a new login, `revoking_at` and `revoked_at` cleared).
 */
export async function recordGrant(db: Db, repo: RepoRow, account: InvitedAccount, now: Date): Promise<Grant | NotRecorded> {
  return db.transaction(async (tx) => {
    const [line] = await tx
      .select({ userId: enrollments.userId, staff: enrollments.staff })
      .from(enrollments)
      .where(eq(enrollments.id, account.enrollmentId))
      .for("share");
    if (!line || line.userId !== account.userId) return "gone";
    // A staff seat reads its own individual repository only, never a group's (ADR-077).
    if (line.staff && repo.groupId !== null) return "gone";
    if (repo.groupId !== null) {
      const [member] = await tx
        .select({ groupId: projectGroupMembers.groupId, departingAt: projectGroupMembers.departingAt })
        .from(projectGroupMembers)
        .where(and(eq(projectGroupMembers.projectId, repo.projectId), eq(projectGroupMembers.enrollmentId, account.enrollmentId)))
        .for("share");
      if (member?.groupId !== repo.groupId) return "gone";
      if (member.departingAt !== null) return "departing";
    }
    const repoId = repo.id;
    const key = and(
      eq(projectRepoAccess.repoId, repoId),
      eq(projectRepoAccess.enrollmentId, account.enrollmentId),
      eq(projectRepoAccess.githubUserId, account.githubUserId),
    );
    const [before] = await tx.select().from(projectRepoAccess).where(key).for("update");
    const fields = { githubLogin: account.login, invitedAt: now, revokingAt: null, revokedAt: null };
    if (!before) {
      const id = randomUUID();
      await tx.insert(projectRepoAccess).values({ id, repoId, enrollmentId: account.enrollmentId, githubUserId: account.githubUserId, ...fields });
      return { id, undo: async () => void (await db.delete(projectRepoAccess).where(eq(projectRepoAccess.id, id))), fresh: true };
    }
    await tx.update(projectRepoAccess).set(fields).where(eq(projectRepoAccess.id, before.id));
    const undo = async () => {
      if (before.revokedAt !== null || before.revokingAt !== null) {
        await db.update(projectRepoAccess).set({ revokedAt: before.revokedAt, revokingAt: before.revokingAt }).where(eq(projectRepoAccess.id, before.id));
      }
    };
    return { id: before.id, undo, fresh: before.revokedAt !== null };
  });
}

/** A revocation GitHub did not do, or an account recorded since it ran: the roster's `502 revoke_failed`, to retry. */
export class RevokeFailed extends Error {
  constructor(
    readonly repo: string | null,
    options?: { cause?: unknown },
  ) {
    super(`a GitHub access${repo === null ? "" : ` to ${repo}`} could not be revoked`, options);
    this.name = "RevokeFailed";
  }
}

/**
 * {@link RevokeFailed} while an account of line `enrollmentId` (on
 * repository `repoId` only, when given) is not revoked — live, or its
 * revocation not confirmed by GitHub yet (`revoking_at`: a job asking, or
 * one that crashed asking).
 */
export async function assertNoLiveGrant(tx: Tx, enrollmentId: string, repoId?: string): Promise<void> {
  const [live] = await tx
    .select({ repo: projectRepos.fullName })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .where(
      and(
        eq(projectRepoAccess.enrollmentId, enrollmentId),
        repoId === undefined ? undefined : eq(projectRepoAccess.repoId, repoId),
        isNull(projectRepoAccess.revokedAt),
      ),
    )
    .limit(1);
  if (live) throw new RevokeFailed(live.repo);
}

/**
 * In the transaction of a roster write that takes line `enrollmentId` or
 * its account away, after `revokeEnrollmentAccess`: the line locked FOR
 * UPDATE (an invitation recording an account for it waits, then finds it
 * changed), and {@link RevokeFailed} while an account recorded for it is
 * not revoked — recorded since the revocation read them, or still being
 * revoked by the `group.sync` job. The write is then refused whole, and
 * its retry revokes that account.
 */
export async function releaseLine(tx: Tx, enrollmentId: string): Promise<void> {
  await tx.select({ id: enrollments.id }).from(enrollments).where(eq(enrollments.id, enrollmentId)).for("update");
  await assertNoLiveGrant(tx, enrollmentId);
}

/**
 * How an invitation came: an Accept (one's own, or a fellow member's), a link, a resend, the set's move (`group.sync`),
 * a resync's (`group.resync`), the daily reconciliation (`reconcile`, M3-06).
 */
export type InviteVia = "accept" | "link" | "resend" | "group.sync" | "group.resync" | "reconcile";

export interface InviteContext {
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
  via: InviteVia;
  /** The code of GitHub failing: Accept's `provision_failed`, a resend's `invite_failed`. */
  failure: "provision_failed" | "invite_failed";
}

/**
 * Invites `member` (who has a link) on `repo` with the permission of its
 * project's work mode (`push`, `pull` online; `409 not_invitable` under
 * Safe Exam Browser, ADR-047 §2): the login of
 * today for their immutable id (`linkedLogin`: a stored login renamed away
 * may be somebody else's now), the grant recorded first, the invitation
 * (idempotent on GitHub's side: 204 for a collaborator), the grant taken
 * back if GitHub refuses it. Audited `project_group.repo_invite` (a resend
 * audits itself). {@link NotRecorded} when nobody was let in. Refusals:
 * `github_account_stale` (the account deleted, renamed away or refused),
 * `ctx.failure`.
 */
export async function inviteAccount(
  db: Db,
  octokit: Octokit,
  repo: RepoRow,
  member: Omit<RepoMember, "staff"> & { account: NonNullable<RepoMember["account"]> },
  ctx: InviteContext,
): Promise<{ login: string; invitation: "pending" | "accepted"; fresh: boolean } | NotRecorded> {
  const login = await linkedLogin(db, octokit, member.userId, member.account).catch((err: unknown) => {
    ctx.log.warn({ err, repo: repo.id }, "GitHub login lookup failed");
    throw new ProjectError(ctx.failure, "GitHub cannot be reached: try again");
  });
  if (typeof login !== "string") throw new ProjectError("github_account_stale", "The GitHub account is gone or renamed: relink it");
  const account = { enrollmentId: member.enrollmentId, userId: member.userId, githubUserId: member.account.githubUserId, login };
  // The permission of the project's work mode (ADR-047 §2): `pull` online;
  // under Safe Exam Browser nobody is invited — Accept never calls this then.
  const [{ workMode } = { workMode: "free" as const }] = await db
    .select({ workMode: projects.workMode })
    .from(projects)
    .where(eq(projects.id, repo.projectId));
  const permission = collaboratorPermission(workMode);
  if (permission === null) throw new ProjectError("not_invitable", "This project's work mode invites nobody on GitHub");
  const grant = await recordGrant(db, repo, account, ctx.now);
  if (notRecorded(grant)) return grant;
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  let invitation: "pending" | "accepted";
  try {
    invitation = await inviteCollaborator(octokit, owner, name, login, permission);
  } catch (err) {
    await grant.undo();
    if (isInvitationRefused(err)) throw new ProjectError("github_account_stale", "GitHub refused to invite the account: relink it");
    ctx.log.error({ err, repo: repo.id }, "an invitation failed");
    throw new ProjectError(ctx.failure, "GitHub failed: try again");
  }
  // The line's grant being revoked or revoked (its line leaving, losing its
  // account, or moved out of the group) while GitHub was asked: the
  // revocation may have run before this invitation landed — take it back.
  // (A removed line took its grant with it: the row gone, the invitation is
  // taken back all the same.)
  const [live] = await db
    .select({ id: projectRepoAccess.id })
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.id, grant.id), isNull(projectRepoAccess.revokedAt), isNull(projectRepoAccess.revokingAt)));
  if (!live) {
    try {
      await revokeCollaborator(octokit, owner, name, login);
    } catch (err) {
      // Still let in: the grant live again — a revocation still asking will
      // not confirm it —, and a group's project due, for the `group.sync`
      // job to take this stray access (`STRAY_GRANT`).
      await db.update(projectRepoAccess).set({ revokedAt: null, revokingAt: null }).where(eq(projectRepoAccess.id, grant.id));
      if (repo.groupId !== null) {
        await db
          .update(projects)
          .set({ groupSyncDueAt: sql`coalesce(${projects.groupSyncDueAt}, ${ctx.now.toISOString()}::timestamptz)` })
          .where(eq(projects.id, repo.projectId));
      }
      const { status, message } = err as { status?: number; message?: string };
      ctx.log.error({ status, message, repo: repo.fullName, login }, "taking back the invitation of a line that left failed");
    }
    return "gone";
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
  // `fresh`: the account was let in by THIS call — what a notification of the invitation keys on.
  return { login, invitation, fresh: grant.fresh };
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
      if (!notRecorded(invited)) await followInvitation(db, repo, invited.invitation);
    } catch (err) {
      ctx.log.warn({ err, repo: repo.id }, "a group repository's invitation on link failed");
    }
  }
}

/** Why a revocation had nothing to take (P1): the audit's `reason`. */
type SkipReason = "app_not_installed" | "repo_deleted" | "not_provisioned" | "account_gone" | "not_invited";

/** The roster write a revocation runs before, or the set's move (`group.sync`), or a resync's (`group.resync`): the audit's `via`. */
export type RevokeVia = "roster.remove" | "roster.unclaim" | "roster.update" | "roster.self_enroll" | "group.sync" | "group.resync";

export interface RevokeContext {
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
  via: RevokeVia;
}

export type GrantRow = typeof projectRepoAccess.$inferSelect;
type Revoked = { outcome: "ok"; login: string; invitationsCancelled: number } | { outcome: "skipped"; login: string; reason: SkipReason };

/**
 * The installation client of an organization, before any revocation: null
 * when Quiz's App is not on it — off, uninstalled, suspended (`installed`
 * forgets those), or gone without our hearing of it (GitHub answers the
 * token's request 404 or 403). Any other failure throws.
 */
export async function revocationClient(db: Db, config: AppConfig, orgId: string): Promise<Octokit | null> {
  const org = githubApp(config) === null ? null : await projectInstallation(db, orgId);
  try {
    return org === null ? null : (await installationClient(config, org.installationId)).octokit;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 404 && status !== 403) throw err;
    return null;
  }
}

/** {@link revocationClient} of each organization. */
export async function installationClients(db: Db, config: AppConfig, orgIds: readonly string[]): Promise<Map<string, Octokit | null>> {
  const clients = new Map<string, Octokit | null>();
  for (const orgId of new Set(orgIds)) clients.set(orgId, await revocationClient(db, config, orgId));
  return clients;
}


/** The repository's name on GitHub: the row's, or, for a row whose provisioning failed after GitHub made it, by its id; null when GitHub holds none. */
async function nameOnGithub(octokit: Octokit, repo: RepoRow): Promise<string | null> {
  if (repo.fullName !== null) return repo.fullName;
  if (repo.githubRepoId === null) return null;
  const repoId = repo.githubRepoId;
  return unless404(async () => {
    const { data } = await octokit.request("GET /repositories/{repository_id}", { repository_id: repoId });
    return (data as { full_name: string }).full_name;
  });
}

/**
 * Takes one recorded account out of one repository, or says why there is
 * nothing to take. Throws when GitHub refuses — and while the repository's
 * first provisioning is under way (`pending`, its claim fresh): it may
 * still invite the account after this ran, so the caller retries once it
 * is done. A claim gone stale is a provisioning that died: treated as a
 * failed one, its repository found by its id, if GitHub made it.
 */
async function revokeGrant(octokit: Octokit | null, repo: RepoRow, grant: GrantRow, now: Date): Promise<Revoked> {
  const skipped = (reason: SkipReason, login = grant.githubLogin): Revoked => ({ outcome: "skipped", login, reason });
  if (repo.deletedAt !== null) return skipped("repo_deleted");
  if (octokit === null) return skipped("app_not_installed");
  if (provisioningNow(repo, now)) throw new Error("the repository is being provisioned");
  const fullName = await nameOnGithub(octokit, repo);
  if (fullName === null) return skipped(repo.githubRepoId === null ? "not_provisioned" : "repo_deleted");
  // The account invited, by its immutable id: its login of today.
  const login = await currentLogin(octokit, grant.githubUserId);
  if (login === null) return skipped("account_gone");
  const { owner, repo: name } = ownerRepo(fullName);
  try {
    return { outcome: "ok", login, ...(await revokeCollaborator(octokit, owner, name, login)) };
  } catch (err) {
    // The repository is gone from GitHub: nobody reaches it any more.
    if ((err as { status?: number }).status === 404) return skipped("repo_deleted", login);
    throw err;
  }
}

/**
 * The repositories the line reads (`seatRepos`: its own, or its copy
 * groups', a live individual one first), whatever their provisioning, with
 * no account of it ever recorded: what the audit reports as skipped, `not_invited` (P1). (The
 * backfill of 0067 recorded the individual repositories' students linked
 * at the migration; one who had unlinked before it is reported here too.)
 */
async function uninvitedRepos(db: Db, enrollmentId: string): Promise<RepoRow[]> {
  const [line] = await db.select({ classroomId: enrollments.classroomId }).from(enrollments).where(eq(enrollments.id, enrollmentId));
  if (!line) return [];
  const own = await db.select().from(projects).where(eq(projects.classroomId, line.classroomId));
  const seats = await seatRepos(db, own, [enrollmentId]);
  const granted = new Set(
    (await db.select({ repoId: projectRepoAccess.repoId }).from(projectRepoAccess).where(eq(projectRepoAccess.enrollmentId, enrollmentId))).map(
      (g) => g.repoId,
    ),
  );
  return own.flatMap((p) => {
    const repo = seats.of(p.id, enrollmentId);
    return repo !== null && !granted.has(repo.id) ? [repo] : [];
  });
}

/**
 * Takes every recorded account of roster line `enrollmentId` out of every
 * repository it was let into (a group's or the student's own), a pending
 * invitation then the collaborator seat, before the caller removes the
 * line or detaches its account — those a `group.sync` job is revoking
 * (`revoking_at`) asked again. Each account is confirmed revoked and
 * audited as it goes, so a retry resumes where GitHub stopped; a repository left
 * with no live account has its invitation state cleared (`none`). The
 * caller's write then runs behind {@link releaseLine}.
 *
 * Nothing to take is no refusal (P1): the App no longer on the
 * organization, the repository deleted on GitHub (or known so), the account
 * deleted, no account ever invited — each audited `skipped` with its
 * reason. GitHub refusing a reachable repository, failing, or a first
 * provisioning under way throws {@link RevokeFailed}: the caller then
 * changes nothing.
 */
export async function revokeEnrollmentAccess(db: Db, config: AppConfig, enrollmentId: string, ctx: RevokeContext): Promise<void> {
  const grants = await db
    .select({ grant: projectRepoAccess, repo: projectRepos, orgId: projects.orgId })
    .from(projectRepoAccess)
    .innerJoin(projectRepos, eq(projectRepos.id, projectRepoAccess.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepoAccess.enrollmentId, enrollmentId), isNull(projectRepoAccess.revokedAt)))
    .orderBy(projectRepoAccess.repoId, projectRepoAccess.githubUserId);
  const clients = await installationClients(
    db,
    config,
    grants.map((g) => g.orgId),
  ).catch((err: unknown) => {
    throw revokeFailed(err, null, enrollmentId, ctx);
  });
  await revokeGrants(
    db,
    grants.map(({ grant, repo, orgId }) => ({ grant, repo, client: clients.get(orgId)! })),
    enrollmentId,
    ctx,
  );
  // Only once every recorded account is out: the repositories it reached with none.
  for (const repo of await uninvitedRepos(db, enrollmentId)) {
    await traceRevoke(db, repo, enrollmentId, ctx, { login: null, outcome: "skipped", reason: "not_invited" });
  }
}

/**
 * The `group.sync` job's revocation of line `enrollmentId` on the ONE
 * repository `repo` (ADR-070 §4, M3-15b-2): its `grants`, already marked
 * `revoking_at` by the job under its locks (`beginDeparture`, a stray
 * grant's), taken out as {@link revokeEnrollmentAccess} does — a pending
 * invitation cancelled before the seat, confirmed `revoked_at`, audited
 * `via: "group.sync"` —, `client` null when the App is not on the
 * organization (P1: skipped). No account ever recorded there is audited
 * `not_invited`, whatever the repository's provisioning (product owner,
 * 2026-10-05: the move proceeds). Throws {@link RevokeFailed}, the
 * account live again, when GitHub refuses or fails.
 */
export async function revokeDeparture(
  db: Db,
  client: Octokit | null,
  repo: RepoRow,
  enrollmentId: string,
  grants: readonly GrantRow[],
  ctx: RevokeContext,
): Promise<void> {
  if (grants.length === 0) {
    const [ever] = await db
      .select({ id: projectRepoAccess.id })
      .from(projectRepoAccess)
      .where(and(eq(projectRepoAccess.repoId, repo.id), eq(projectRepoAccess.enrollmentId, enrollmentId)))
      .limit(1);
    if (!ever) await traceRevoke(db, repo, enrollmentId, ctx, { login: null, outcome: "skipped", reason: "not_invited" });
    return;
  }
  await revokeGrants(
    db,
    grants.map((grant) => ({ grant, repo, client })),
    enrollmentId,
    ctx,
  );
}

/** A revocation that did not happen, logged: the caller's {@link RevokeFailed}. */
function revokeFailed(err: unknown, repo: RepoRow | null, enrollmentId: string, ctx: RevokeContext): RevokeFailed {
  ctx.log.error({ err, repo: repo?.id, enrollmentId }, "revoking a repository access failed");
  return new RevokeFailed(repo?.fullName ?? null, { cause: err });
}

/** `project_group.repo_revoke` of one account, or of a repository with none. */
function traceRevoke(db: Db, repo: RepoRow, enrollmentId: string, ctx: RevokeContext, payload: Record<string, unknown>): Promise<void> {
  return audit(db, {
    ...ctx.actor,
    action: "project_group.repo_revoke",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { repo: repo.fullName, enrollmentId, via: ctx.via, ...payload },
  });
}

/**
 * Each grant of `items` not revoked yet taken out of its repository, in
 * order, through its organization's client; {@link RevokeFailed} at the
 * first GitHub refuses, those before it done and audited.
 *
 * **A grant is revoked only once GitHub confirmed it** (or there was
 * nothing to take): `revoking_at` is set before GitHub is asked — an
 * invitation of this account whose re-check (`inviteAccount`) still finds
 * it live landed before this revocation lists the invitations, which then
 * cancels it; one that finds it revoking takes itself back —, `revoked_at`
 * after GitHub's answer, only while still marked (an invitation's failed
 * take-back made it live again meanwhile). Until then it counts as live
 * everywhere (`releaseLine`, `completeDeparture`); a refusal clears the
 * mark, a crash leaves it for the next revocation to ask again.
 */
async function revokeGrants(
  db: Db,
  items: readonly { grant: GrantRow; repo: RepoRow; client: Octokit | null }[],
  enrollmentId: string,
  ctx: RevokeContext,
): Promise<void> {
  for (const { grant, repo, client } of items) {
    const unrevoked = and(eq(projectRepoAccess.id, grant.id), isNull(projectRepoAccess.revokedAt));
    await db.update(projectRepoAccess).set({ revokingAt: ctx.now }).where(unrevoked);
    const revoked = await revokeGrant(client, repo, grant, ctx.now).catch(async (err: unknown) => {
      await db.update(projectRepoAccess).set({ revokingAt: null }).where(unrevoked);
      throw revokeFailed(err, repo, enrollmentId, ctx);
    });
    await db
      .update(projectRepoAccess)
      .set({ revokedAt: ctx.now, revokingAt: null })
      .where(and(unrevoked, isNotNull(projectRepoAccess.revokingAt)));
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
    await traceRevoke(db, repo, enrollmentId, ctx, revoked);
  }
}
