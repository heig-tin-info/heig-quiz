/**
 * A student's Accept (F-PROJ-05, merge task M3-03), ported from
 * heig-classroom's `modules/student.ts` and `group-repos.ts` (sync point
 * `ab98cc0`): the student's own repository `<slug>-<login>`, provisioned IN
 * the request (N-PERF-07, under 60 s) by `provisionStudentRepo`, every step
 * of which checks GitHub's state first, so a replay after a failure is safe.
 *
 * Idempotent (F-PROJ-05): one row per student and project (the partial
 * UNIQUE `project_repos_project_user_uq`); a provisioned row is answered as
 * it is, with no call to GitHub; a row whose repository was deleted on
 * GitHub stays dead (product owner, 2026-10-02). One Accept provisions a
 * row at a time ({@link claimProvisioning}); a failure is recorded without
 * ever undoing a repository that works ({@link markProvisionFailed}).
 *
 * **A repository is the row's only if the row made it.** The name is the
 * student's choice (their login), so `<slug>-<login>` may name any
 * repository of the organization — a distribution, a source, another
 * student's. The row records GitHub's id of the repository it creates
 * before anything is pushed to it; a name already taken is adopted only
 * when it is that very repository (a replay), and refused otherwise
 * (`409 repo_name_taken`), nothing touched on it.
 *
 * Individual repositories only: a group project answers `409 no_group`
 * until merge task M3-15. The staff's notification of a failure is M3-09's;
 * this task marks the one failure that will notify (`payload.notify` of
 * `project.accept_failed`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull, lt, ne, or, type SQL } from "drizzle-orm";

import type { ProjectAcceptance } from "@quiz/contracts";
import { acceptRefusal, repoName } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubAccounts, projectRepos } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { isInvitationRefused } from "../../github/collaborators.js";
import { provisionStudentRepo, RepoNameTaken } from "../../github/provision.js";
import { redactTokens } from "../../redact.js";
import { projectInstallation } from "../github/service.js";
import { ProjectError } from "./errors.js";
import type { ProjectRow } from "./views.js";

type RepoRow = typeof projectRepos.$inferSelect;

/** A claim older than this is taken over: the request that held it died. */
const PROVISION_CLAIM_STALE_MS = 5 * 60_000;

/** The student's view of their row: their own repository, nothing of the project's (N-SEC-20). */
const acceptance = (row: RepoRow): ProjectAcceptance => ({
  status: row.provisionStatus,
  fullName: row.fullName,
  invitationStatus: row.invitationStatus,
});

/** A row Accept answers as it stands: provisioned, or dead (deleted on GitHub). */
const settled = (row: RepoRow | undefined): row is RepoRow =>
  row !== undefined && (row.provisionStatus === "ok" || row.deletedAt !== null);

/**
 * Takes the right to provision the row `where` selects, atomically: the row
 * for exactly one of several concurrent Accepts, undefined for the others.
 * Claimable: a failed row, or a pending one with no claim or a claim older
 * than {@link PROVISION_CLAIM_STALE_MS} by the server's clock. A provisioned
 * row, or a dead one, never. The claim's time is `now`: the holder's mark.
 */
async function claimProvisioning(db: Db, where: SQL | undefined, now: Date): Promise<RepoRow | undefined> {
  const staleBefore = new Date(now.getTime() - PROVISION_CLAIM_STALE_MS);
  const [claimed] = await db
    .update(projectRepos)
    .set({ provisionStatus: "pending", provisionClaimedAt: now })
    .where(
      and(
        where,
        isNull(projectRepos.deletedAt),
        or(
          eq(projectRepos.provisionStatus, "error"),
          and(
            eq(projectRepos.provisionStatus, "pending"),
            or(isNull(projectRepos.provisionClaimedAt), lt(projectRepos.provisionClaimedAt, staleBefore)),
          ),
        ),
      ),
    )
    .returning();
  return claimed;
}

/**
 * Records a failed provisioning by the holder of the claim taken at
 * `claimedAt` — never over a row provisioned meanwhile, nor over the state
 * of a newer holder that took a stale claim over. True for the row's FIRST
 * failure only (no error recorded since it was created), the one the staff
 * hear of (F-NOTIF-13): a student's every Retry never tells them again.
 */
export async function markProvisionFailed(db: Db, rowId: string, claimedAt: Date, error: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(projectRepos).where(eq(projectRepos.id, rowId)).for("update");
    if (!before || before.provisionStatus === "ok" || before.provisionClaimedAt?.getTime() !== claimedAt.getTime()) {
      return false;
    }
    await tx
      .update(projectRepos)
      .set({ provisionStatus: "error", provisionError: error.slice(0, 500) })
      .where(and(eq(projectRepos.id, rowId), ne(projectRepos.provisionStatus, "ok")));
    return before.provisionError === null;
  });
}

export interface AcceptInput {
  project: ProjectRow;
  userId: string;
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
}

/**
 * `POST /app/api/student/projects/:id/accept` on a project the caller may
 * accept (`studentProject`, `guards.ts`). The row first: provisioned or
 * dead, it is the answer. Then the refusals, all `409`: the project's
 * (`acceptRefusal` of `@quiz/domain`: `not_started`, `deadline_passed`,
 * `no_group`, `distribution_missing`), `github_not_linked`,
 * `app_not_installed`, `github_account_stale`, `provision_in_progress`,
 * `repo_name_taken`; GitHub failing (its login lookup included) is `502
 * provision_failed`, retried by the student.
 */
export async function acceptProject(db: Db, config: AppConfig, input: AcceptInput): Promise<ProjectAcceptance> {
  const { project, userId, now, log } = input;
  const mine = and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, userId), isNull(projectRepos.groupId));
  const [existing] = await db.select().from(projectRepos).where(mine).limit(1);
  if (settled(existing)) return acceptance(existing);

  const refusal = acceptRefusal(project, now);
  if (refusal) throw new ProjectError(refusal);
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!account) throw new ProjectError("github_not_linked", "Link your GitHub account first");
  const org = await projectInstallation(db, project.orgId);
  if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
  const client = await installationClient(config, org.installationId);

  // The login is followed to today's through the immutable id, or nothing
  // is named: a stored login renamed away may belong to somebody else now,
  // who would be invited with push.
  const login = await linkedLogin(db, client.octokit, userId, account).catch((err: unknown) => {
    log.warn({ err }, "GitHub login lookup failed");
    throw new ProjectError("provision_failed", "GitHub cannot be reached: try again");
  });
  if (typeof login !== "string") throw new ProjectError("github_account_stale", "Relink your GitHub account");

  await db.insert(projectRepos).values({ id: randomUUID(), projectId: project.id, userId, acceptedAt: now }).onConflictDoNothing();
  const row = await claimProvisioning(db, mine, now);
  if (!row) {
    const [current] = await db.select().from(projectRepos).where(mine).limit(1);
    if (settled(current)) return acceptance(current);
    throw new ProjectError("provision_in_progress", "Your repository is being created: try again in a moment");
  }

  try {
    const result = await provisionStudentRepo({
      octokit: client.octokit,
      token: client.token,
      org: org.login,
      squashedRepo: project.distributionFullName!.split("/")[1]!,
      targetRepo: repoName(project.slug, login),
      branches: project.branches,
      defaultBranch: project.branches[0]!,
      studentLogin: login,
      claim: async (repoId, created) => {
        if (!created) return repoId === row.githubRepoId;
        await db.update(projectRepos).set({ githubRepoId: repoId }).where(eq(projectRepos.id, row.id));
        return true;
      },
    });
    const [updated] = await db
      .update(projectRepos)
      .set({
        githubRepoId: result.repoId,
        fullName: result.fullName,
        defaultBranch: result.defaultBranch,
        provisionStatus: "ok",
        provisionError: null,
        rulesetId: result.rulesetId,
        invitationStatus: result.invitationStatus,
      })
      .where(eq(projectRepos.id, row.id))
      .returning();
    await audit(db, {
      ...input.actor,
      action: "project.accept",
      subjectType: "project_repo",
      subjectId: row.id,
      // `protected: false`: a plan without rulesets, the repository is not
      // shielded from force pushes (heig-classroom's degraded mode H8).
      payload: { repo: result.fullName, invitation: result.invitationStatus, protected: result.rulesetId !== null },
    });
    return acceptance(updated!);
  } catch (err) {
    log.error({ err, repo: row.id }, "provisioning a student repository failed");
    // Only the student can fix a refused invitation (an account renamed
    // away, flagged or deleted): the staff are not told of it.
    const refused = isInvitationRefused(err);
    const first = await markProvisionFailed(db, row.id, now, redactTokens(String(err)));
    await audit(db, {
      ...input.actor,
      action: "project.accept_failed",
      subjectType: "project_repo",
      subjectId: row.id,
      payload: { notify: first && !refused },
    });
    if (err instanceof RepoNameTaken) throw new ProjectError("repo_name_taken", "A repository of that name exists already");
    if (refused) throw new ProjectError("github_account_stale", "GitHub refused to invite your account: relink it");
    throw new ProjectError("provision_failed", "Creating your repository failed: try again");
  }
}
