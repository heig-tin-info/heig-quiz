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
 * The route's loader admits a seat on the course staff only (`403
 * staff_seat_required` for Super Powers without one, `routes.ts`).
 */
import type { FastifyBaseLogger } from "fastify";

import type { ProjectDistributionAccess } from "@quiz/contracts";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/linkedLogin.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import type { projects } from "../../db/schema.js";
import { githubStatus, ownerRepo } from "../../github/app.js";
import { holdsAtLeast, inviteCollaborator, isInvitationRefused } from "../../github/collaborators.js";
import { githubSide } from "./accept.js";
import { ProjectError } from "./errors.js";

type Project = typeof projects.$inferSelect;

const stale = () => new ProjectError("github_account_stale", "The linked GitHub account was not found: relink it");

/** `POST /app/api/projects/:id/distribution/access`: the caller invited, or already in. */
export async function requestDistributionAccess(
  db: Db,
  config: AppConfig,
  project: Project,
  userId: string,
  actor: AuditActor,
  log: FastifyBaseLogger,
): Promise<ProjectDistributionAccess> {
  const fullName = project.distributionFullName;
  if (fullName === null) throw new ProjectError("distribution_missing", "The distribution repository is not built");
  const { account, client } = await githubSide(db, config, userId, project.orgId);

  const { owner, repo } = ownerRepo(fullName);
  let login: string;
  let status: ProjectDistributionAccess["status"];
  try {
    const current = await linkedLogin(db, client.octokit, userId, account);
    if (typeof current !== "string") throw stale(); // GITHUB_ACCOUNT_STALE
    login = current;
    status = (await holdsAtLeast(client.octokit, owner, repo, login, "read"))
      ? "accepted"
      : await inviteCollaborator(client.octokit, owner, repo, login, "pull");
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    // GitHub refusing the account itself (renamed away) is answered as Accept's invitation is.
    if (isInvitationRefused(err)) throw stale();
    const code = githubStatus(err);
    // Any other refusal of GitHub's (a 4xx: an organization forbidding outside collaborators) is no outage.
    const refused = code !== undefined && code >= 400 && code < 500;
    log.warn({ projectId: project.id, repository: fullName, status: code, error: (err as Error)?.name }, "a distribution access invitation failed");
    if (refused) throw new ProjectError("invite_refused", "GitHub refused the invitation");
    throw new ProjectError("invite_failed", "GitHub did not answer: try again");
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
