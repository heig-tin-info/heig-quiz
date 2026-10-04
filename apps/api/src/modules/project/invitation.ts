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
 * A group's repository (M3-15b): the members are read from the project's
 * copy, never `project_repos.user_id` (N-SEC-20). The staff's resend
 * re-invites every member with a linked account (GitHub answers 204 for one
 * who already accepted; a member whose account cannot be invited is
 * skipped); a student's own resend invites that student alone. Every
 * account invited is recorded (`recordGrant`), what a departure revokes.
 */
import { and, eq } from "drizzle-orm";
import type { Octokit } from "octokit";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectInvitationResent } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import { iso } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { enrollments, githubAccounts, projectRepos } from "../../db/schema.js";
import { installationClient, ownerRepo } from "../../github/app.js";
import { inviteCollaborator, isInvitationRefused } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { recordGrant } from "./access.js";
import { liveRepoForUpdate } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { groupMembers, individualHolders } from "./groupRepos.js";
import type { RepoRow } from "./repos.js";

/** The least time between two resends of one repository's invitation. */
export const RESEND_INTERVAL_MS = 60_000;

/** Whom a resend invites: an account behind a roster line (null: a student who left the roster, nothing recorded). */
interface Invitee {
  userId: string;
  enrollmentId: string | null;
}

/**
 * Whom a resend of `repo` invites: `only` (a student's own resend), the
 * student of an individual repository, or every member of a group's with
 * an account (a holder of a live individual repository keeps theirs).
 */
async function invitees(db: Db, repo: RepoRow, classroomId: string, only: Invitee | undefined): Promise<Invitee[]> {
  if (only) return [only];
  if (repo.groupId === null) {
    const [line] = await db
      .select({ id: enrollments.id })
      .from(enrollments)
      .where(and(eq(enrollments.classroomId, classroomId), eq(enrollments.userId, repo.userId), eq(enrollments.staff, false)));
    return [{ userId: repo.userId, enrollmentId: line?.id ?? null }];
  }
  const holders = await individualHolders(db, repo.projectId);
  return (await groupMembers(db, repo.groupId))
    .filter((m) => m.account !== null && !holders.has(m.userId!))
    .map((m) => ({ userId: m.userId!, enrollmentId: m.enrollmentId }));
}

/** One invitee invited with `push` under their login of today, and recorded; the refusals of a single resend. */
async function inviteOne(
  db: Db,
  octokit: Octokit,
  repo: RepoRow,
  invitee: Invitee,
  now: Date,
  log: FastifyBaseLogger,
): Promise<{ login: string; status: "pending" | "accepted" }> {
  const found = await linkedLogin(db, octokit, invitee.userId).catch((err: unknown) => {
    log.warn({ err, repo: repo.id }, "GitHub login lookup failed");
    throw new ProjectError("invite_failed", "GitHub cannot be reached: try again");
  });
  if (typeof found !== "string") {
    throw new ProjectError("github_account_stale", "The student's GitHub account is gone or renamed: they must relink it");
  }
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  let status: "pending" | "accepted";
  try {
    status = await inviteCollaborator(octokit, owner, name, found, "push");
  } catch (err) {
    if (isInvitationRefused(err)) {
      throw new ProjectError("github_account_stale", "GitHub refused to invite the student's account: they must relink it");
    }
    log.error({ err, repo: repo.id }, "resending an invitation failed");
    throw new ProjectError("invite_failed", "GitHub refused the invitation: try again");
  }
  if (invitee.enrollmentId !== null) {
    const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, invitee.userId));
    if (account) await recordGrant(db, repo.id, { enrollmentId: invitee.enrollmentId, githubUserId: account.githubUserId, login: found }, now);
  }
  return { login: found, status };
}

/**
 * `POST /app/api/projects/:id/repos/:rid/invite`: the invitation sent
 * again, `invitationStatus` as GitHub answered (`accepted` when the student
 * already is a collaborator: the row follows; a group's is pending while
 * any member's is). `only`: the student's own resend, who alone is invited.
 */
export async function resendInvitation(
  db: Db,
  config: AppConfig,
  projectId: string,
  repoId: string,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
  only?: Invitee,
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
  const invited: { login: string; status: "pending" | "accepted" }[] = [];
  try {
    const org = await projectInstallation(db, project.orgId);
    if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
    const { octokit } = await installationClient(config, org.installationId);
    const targets = await invitees(db, repo, project.classroomId, only);
    let refusal: unknown = new ProjectError("github_account_stale", "No member's GitHub account can be invited: they must relink it");
    for (const invitee of targets) {
      try {
        invited.push(await inviteOne(db, octokit, repo, invitee, now, log));
      } catch (err) {
        // A group's member whose account cannot be invited is skipped; GitHub failing fails the resend.
        if (targets.length === 1 || !(err instanceof ProjectError && err.code === "github_account_stale")) throw err;
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

  // GitHub accepted: the row follows its answer, audited with it — but one
  // member's own answer never speaks for the rest of their group.
  const invitationStatus = invited.some((i) => i.status === "pending") ? "pending" : "accepted";
  const logins = invited.map((i) => i.login);
  await db.transaction(async (tx) => {
    if (repo.groupId === null || only === undefined) {
      await tx.update(projectRepos).set({ invitationStatus }).where(eq(projectRepos.id, repo.id));
    }
    await audit(tx, {
      ...actor,
      action: "project_repo.invite_resent",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: repo.groupId === null ? { login: logins[0], invitationStatus } : { logins, invitationStatus },
    });
  });
  return { invitationStatus, resentAt: iso(now) };
}
