/**
 * The staff's resend of a student's invitation (F-PROJ-07; merge task
 * M3-08b, product owner's decision 5 of 2026-10-02): on a live repository
 * (`409 repo_unavailable` otherwise), a PENDING invitation only (`409
 * invitation_not_pending`), at most once a minute per repository (`429
 * resend_too_soon`, claimed on the row before GitHub is called and given
 * back when GitHub's part fails), with the `push` permission and never
 * more (N-SEC-21), audited `project_repo.invite_resent`.
 *
 * The student is named by the login GitHub knows TODAY for the immutable
 * account id they linked (`linkedLogin`, as Accept does): a stored login
 * renamed away may belong to somebody else now, who would be invited with
 * push. Apart from the reconciliation's daily re-invite (M3-06), which
 * reads none of this: two paths, one rule each.
 *
 * The student's own resend is the project's student view's (M3-09).
 *
 * Whom (M3-15b): the repository's readers (`repoMembers`) — an
 * individual repository's student seat (none: `409 repo_unavailable`), a
 * group's members of the copy, never `project_repos.user_id` (N-SEC-20).
 * The staff's resend on a group's re-invites the members still out: an
 * invitation pending on GitHub, or no account recorded; a member whose
 * account cannot be invited is skipped. A student's own resend invites
 * them alone. Each invitation goes through `inviteAccount` (recorded
 * first, what a departure revokes).
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Octokit } from "octokit";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectInvitationResent } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { iso } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { projectRepoAccess, projectRepos } from "../../db/schema.js";
import { installationClient, ownerRepo } from "../../github/app.js";
import { pendingInvitees } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { inviteAccount } from "./access.js";
import { liveRepoForUpdate } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { repoMembers, type RepoMember } from "./groupRepos.js";
import type { RepoRow } from "./repos.js";

/** The least time between two resends of one repository's invitation. */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * The members of a group's repository still out: an invitation of theirs
 * pending on GitHub, or no account of theirs recorded (never invited).
 */
async function stillOut(db: Db, octokit: Octokit, repo: RepoRow, members: RepoMember[]): Promise<RepoMember[]> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const pending = new Set((await pendingInvitees(octokit, owner, name)).map((i) => i.login.toLowerCase()));
  const grants = await db
    .select()
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.repoId, repo.id), isNull(projectRepoAccess.revokedAt)));
  return members.filter((m) => {
    const mine = grants.filter((g) => g.enrollmentId === m.enrollmentId);
    return mine.length === 0 || mine.some((g) => pending.has(g.githubLogin.toLowerCase()));
  });
}

/**
 * `POST /app/api/projects/:id/repos/:rid/invite`: the invitation sent
 * again, `invitationStatus` as GitHub answered (`accepted` when the student
 * already is a collaborator: the row follows; a group's is pending while
 * any member's is). `only`: the student's own resend, by their seat.
 */
export async function resendInvitation(
  db: Db,
  config: AppConfig,
  projectId: string,
  repoId: string,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
  only?: string,
): Promise<ProjectInvitationResent> {
  // The minute claimed on the row before GitHub is called.
  const { project, repo } = await db.transaction(async (tx) => {
    const found = await liveRepoForUpdate(tx, projectId, repoId);
    if (found.repo.invitationStatus !== "pending") throw new ProjectError("invitation_not_pending", "The invitation is not pending");
    if (found.repo.invitationResentAt !== null && now.getTime() - found.repo.invitationResentAt.getTime() < RESEND_INTERVAL_MS) {
      throw new ProjectError("resend_too_soon", "The invitation was resent less than a minute ago");
    }
    await tx.update(projectRepos).set({ invitationResentAt: now }).where(eq(projectRepos.id, found.repo.id));
    return found;
  });

  // GitHub's part: a failure here means the resend did not happen, and the minute is given back.
  const invited: { login: string; invitation: "pending" | "accepted" }[] = [];
  try {
    const org = await projectInstallation(db, project.orgId);
    if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
    const { octokit } = await installationClient(config, org.installationId);
    const members = await repoMembers(db, repo, project.classroomId);
    const group = repo.groupId !== null && only === undefined;
    const targets = only !== undefined ? members.filter((m) => m.enrollmentId === only) : group ? await stillOut(db, octokit, repo, members) : members;
    if (targets.length === 0) {
      throw group
        ? new ProjectError("invitation_not_pending", "Every member of the group is in")
        : new ProjectError("repo_unavailable", "The repository has no student on the roster to invite");
    }
    const stale = new ProjectError("github_account_stale", "The student's GitHub account is gone or renamed: they must relink it");
    let refusal: unknown = stale;
    for (const member of targets) {
      try {
        if (member.account === null) throw stale;
        const ctx = { actor, now, log, via: "resend", failure: "invite_failed" } as const;
        const done = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, ctx);
        if (typeof done === "object") invited.push(done);
      } catch (err) {
        // A group's member whose account cannot be invited is skipped; GitHub failing fails the resend.
        if (!group || !(err instanceof ProjectError && err.code === "github_account_stale")) throw err;
        refusal = err;
      }
    }
    if (invited.length === 0) throw refusal;
  } catch (err) {
    await db
      .update(projectRepos)
      .set({ invitationResentAt: repo.invitationResentAt })
      .where(and(eq(projectRepos.id, repo.id), eq(projectRepos.invitationResentAt, now)));
    throw err;
  }

  // GitHub accepted: the row follows its answer, audited with it — one
  // member's own answer never speaks for the rest of their group.
  const invitationStatus = invited.some((i) => i.invitation === "pending") ? "pending" : "accepted";
  await db.transaction(async (tx) => {
    if (repo.groupId === null || only === undefined) {
      await tx.update(projectRepos).set({ invitationStatus }).where(eq(projectRepos.id, repo.id));
    }
    await audit(tx, {
      ...actor,
      action: "project_repo.invite_resent",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { logins: invited.map((i) => i.login), invitationStatus },
    });
  });
  return { invitationStatus, resentAt: iso(now) };
}
