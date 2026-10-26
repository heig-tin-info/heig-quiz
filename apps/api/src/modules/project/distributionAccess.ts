/**
 * A staff member's own read access to the project's distribution repository
 * (F-PROJ-02 as amended 2026-10-26, #899; ADR-062 amendment). The repository
 * is private and Quiz grants nobody access to it at creation: a staff member
 * asks, on demand, and is invited with `pull` by the login GitHub knows
 * today for the account they linked. On demand because GitHub drops an
 * invitation left unaccepted for seven days, and staff join the course or
 * link their account later; `pull` because the distribution is managed by
 * the App alone (a sync replays the source over it, a restore reads it as
 * the reference). A permission already held, at least `read` (an owner of
 * the organization), is left as it is: an invitation SETS the permission.
 *
 * Nothing follows the staff: no invitation when a seat is added, no
 * revocation when one is removed (as the journal's, F-JRN-02).
 *
 * Reached through `accessibleProject` (the caller's own portal session,
 * `staffAccess` or Super Powers); only a seat on the course staff asks
 * (`403 staff_seat_required`).
 */
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import type { ProjectDistributionAccess } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/linkedLogin.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { courseStaff, githubAccounts, projects } from "../../db/schema.js";
import { githubStatus, installationClient, ownerRepo } from "../../github/app.js";
import { holdsAtLeast, inviteCollaborator } from "../../github/collaborators.js";
import { projectInstallation } from "../github/service.js";
import { ProjectError } from "./errors.js";

type Project = typeof projects.$inferSelect;

/** `POST /app/api/projects/:id/distribution/access`: the caller invited, or already in. */
export async function requestDistributionAccess(
  db: Db,
  config: AppConfig,
  scope: { project: Project; courseId: string },
  userId: string,
  actor: AuditActor,
  log: FastifyBaseLogger,
): Promise<ProjectDistributionAccess> {
  const { project } = scope;
  const [seat] = await db
    .select({ userId: courseStaff.userId })
    .from(courseStaff)
    .where(and(eq(courseStaff.courseId, scope.courseId), eq(courseStaff.userId, userId)))
    .limit(1);
  if (!seat) throw new ProjectError("staff_seat_required", "Only a seat on the course staff may ask for access");
  const fullName = project.distributionFullName;
  if (fullName === null) throw new ProjectError("distribution_missing", "The distribution repository is not built");
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!account) throw new ProjectError("github_not_linked", "Link a GitHub account first");
  const org = await projectInstallation(db, project.orgId);
  if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");

  const { owner, repo } = ownerRepo(fullName);
  let login: string;
  let status: ProjectDistributionAccess["status"];
  try {
    const { octokit } = await installationClient(config, org.installationId);
    const current = await linkedLogin(db, octokit, userId, account);
    if (typeof current !== "string") {
      // GITHUB_ACCOUNT_STALE
      throw new ProjectError("github_account_stale", "The linked GitHub account is gone: relink it");
    }
    login = current;
    status = (await holdsAtLeast(octokit, owner, repo, login, "read"))
      ? "accepted"
      : await inviteCollaborator(octokit, owner, repo, login, "pull");
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    log.warn({ projectId: project.id, repository: fullName, status: githubStatus(err), error: (err as Error)?.name }, "a distribution access invitation failed");
    throw new ProjectError("invite_failed", "GitHub did not take the invitation");
  }

  await audit(db, {
    ...actor,
    action: "project.distribution_access",
    subjectType: "project",
    subjectId: project.id,
    payload: { fullName, login, permission: "pull", status },
  });
  return { status, invitationsUrl: `https://github.com/${owner}/${repo}/invitations` };
}
