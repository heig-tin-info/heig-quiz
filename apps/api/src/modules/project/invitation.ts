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
 */
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectInvitationResent } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import { iso } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { projectRepos } from "../../db/schema.js";
import { installationClient, ownerRepo } from "../../github/app.js";
import { inviteCollaborator, isInvitationRefused } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { liveRepoForUpdate } from "./deadline.js";
import { ProjectError } from "./errors.js";

/** The least time between two resends of one repository's invitation. */
export const RESEND_INTERVAL_MS = 60_000;

/**
 * `POST /app/api/projects/:id/repos/:rid/invite`: the invitation sent
 * again, `invitationStatus` as GitHub answered (`accepted` when the student
 * already is a collaborator: the row follows).
 */
export async function resendInvitation(
  db: Db,
  config: AppConfig,
  projectId: string,
  repoId: string,
  actor: AuditActor,
  now: Date,
  log: FastifyBaseLogger,
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
  let login: string;
  let invitationStatus: "pending" | "accepted";
  try {
    const org = await projectInstallation(db, project.orgId);
    if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
    const { octokit } = await installationClient(config, org.installationId);
    const found = await linkedLogin(db, octokit, repo.userId).catch((err: unknown) => {
      log.warn({ err, repo: repo.id }, "GitHub login lookup failed");
      throw new ProjectError("invite_failed", "GitHub cannot be reached: try again");
    });
    if (typeof found !== "string") {
      throw new ProjectError("github_account_stale", "The student's GitHub account is gone or renamed: they must relink it");
    }
    login = found;
    const { owner, repo: name } = ownerRepo(repo.fullName!);
    try {
      invitationStatus = await inviteCollaborator(octokit, owner, name, login, "push");
    } catch (err) {
      if (isInvitationRefused(err)) {
        throw new ProjectError("github_account_stale", "GitHub refused to invite the student's account: they must relink it");
      }
      log.error({ err, repo: repo.id }, "resending an invitation failed");
      throw new ProjectError("invite_failed", "GitHub refused the invitation: try again");
    }
  } catch (err) {
    await db
      .update(projectRepos)
      .set({ invitationResentAt: repo.invitationResentAt })
      .where(and(eq(projectRepos.id, repo.id), eq(projectRepos.invitationResentAt, now)));
    throw err;
  }

  // GitHub accepted: the row follows its answer, audited with it.
  await db.transaction(async (tx) => {
    await tx.update(projectRepos).set({ invitationStatus }).where(eq(projectRepos.id, repo.id));
    await audit(tx, {
      ...actor,
      action: "project_repo.invite_resent",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { login, invitationStatus },
    });
  });
  return { invitationStatus, resentAt: iso(now) };
}
