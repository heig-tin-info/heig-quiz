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
 * Individual repositories only: a group project answers `409 no_group`
 * until merge task M3-15. The staff's notification of a failure is M3-09's;
 * this task marks the one failure that will notify (`payload.notify` of
 * `project.accept_failed`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull, lt, ne, or } from "drizzle-orm";

import type { ProjectAcceptance } from "@quiz/contracts";
import { repoName } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubAccounts, githubOrganizations, projectRepos } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { isInvitationRefused } from "../../github/collaborators.js";
import { provisionStudentRepo } from "../../github/provision.js";
import { redactTokens } from "../../redact.js";
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

/**
 * Takes the right to provision a row, atomically: true for exactly one of
 * several concurrent Accepts. Claimable: a failed row, or a pending one with
 * no claim or a claim older than {@link PROVISION_CLAIM_STALE_MS} by the
 * server's clock. A provisioned row, or a dead one, never.
 */
async function claimProvisioning(db: Db, rowId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - PROVISION_CLAIM_STALE_MS);
  const claimed = await db
    .update(projectRepos)
    .set({ provisionStatus: "pending", provisionClaimedAt: now })
    .where(
      and(
        eq(projectRepos.id, rowId),
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
    .returning({ id: projectRepos.id });
  return claimed.length > 0;
}

/**
 * Records a failed provisioning, unless the row got provisioned meanwhile (a
 * stale claim taken over, a replay): a late failure never turns a working
 * repository back into an error. True for the row's FIRST failure only — no
 * earlier error recorded since it was created —, the one the staff hear of
 * (F-NOTIF-13): a student's every Retry never tells them again.
 */
export async function markProvisionFailed(db: Db, rowId: string, error: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ status: projectRepos.provisionStatus, error: projectRepos.provisionError })
      .from(projectRepos)
      .where(eq(projectRepos.id, rowId))
      .for("update");
    if (!before || before.status === "ok") return false;
    await tx
      .update(projectRepos)
      .set({ provisionStatus: "error", provisionError: error.slice(0, 500) })
      .where(and(eq(projectRepos.id, rowId), ne(projectRepos.provisionStatus, "ok")));
    return before.error === null;
  });
}

/**
 * May this row adopt the existing GitHub repository `githubRepoId` (the 422
 * of a creation replayed)? Not when another row records it: that is somebody
 * else's repository.
 */
async function adoptableBy(db: Db, rowId: string, githubRepoId: number): Promise<boolean> {
  const [other] = await db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(and(eq(projectRepos.githubRepoId, githubRepoId), ne(projectRepos.id, rowId)))
    .limit(1);
  return other === undefined;
}

export interface AcceptInput {
  project: ProjectRow;
  org: typeof githubOrganizations.$inferSelect;
  userId: string;
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
}

/**
 * `POST /app/api/student/projects/:id/accept` on a project the caller may
 * accept (`studentProject`, `guards.ts`). The row first: provisioned or
 * dead, it is the answer. Then the refusals, all `409`: `not_started`,
 * `deadline_passed` (the project's dates, `now`, no grace), `no_group`,
 * `distribution_missing`, `github_not_linked`, `app_not_installed`,
 * `github_account_stale`, `provision_in_progress`; a failure on GitHub is
 * `502 provision_failed`, retried by the student.
 */
export async function acceptProject(db: Db, config: AppConfig, input: AcceptInput): Promise<ProjectAcceptance> {
  const { project, org, userId, now, log } = input;
  const mine = and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, userId), isNull(projectRepos.groupId));
  const [existing] = await db.select().from(projectRepos).where(mine).limit(1);
  if (existing && (existing.provisionStatus === "ok" || existing.deletedAt !== null)) return acceptance(existing);

  if (now.getTime() < project.startAt.getTime()) throw new ProjectError("not_started", "The project has not started");
  if (now.getTime() >= project.deadlineAt.getTime()) throw new ProjectError("deadline_passed", "The deadline has passed");
  if (project.groupMode) throw new ProjectError("no_group", "This project is done in groups");
  const distribution = project.distributionFullName?.split("/")[1];
  if (!distribution) throw new ProjectError("distribution_missing", "The project has nothing to hand out");
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId));
  if (!account) throw new ProjectError("github_not_linked", "Link your GitHub account first");
  if (org.installationId === null || org.status !== "active") {
    throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
  }
  const client = await installationClient(config, org.installationId);

  // A renamed account is followed through its immutable id; GitHub
  // unreachable is not fatal, the stored login usually still holds.
  let login = account.login;
  try {
    const current = await linkedLogin(db, client.octokit, userId);
    if (typeof current !== "string") throw new ProjectError("github_account_stale", "Relink your GitHub account");
    login = current;
  } catch (err) {
    if (err instanceof ProjectError) throw err;
    log.warn({ err }, "GitHub login lookup failed: going on with the stored login");
  }

  if (!existing) {
    await db
      .insert(projectRepos)
      .values({ id: randomUUID(), projectId: project.id, userId, acceptedAt: now })
      .onConflictDoNothing();
  }
  const [row] = await db.select().from(projectRepos).where(mine).limit(1);
  if (!(await claimProvisioning(db, row!.id, now))) {
    const [current] = await db.select().from(projectRepos).where(eq(projectRepos.id, row!.id));
    if (current && (current.provisionStatus === "ok" || current.deletedAt !== null)) return acceptance(current);
    throw new ProjectError("provision_in_progress", "Your repository is being created: try again in a moment");
  }

  try {
    const result = await provisionStudentRepo({
      octokit: client.octokit,
      token: client.token,
      org: org.login,
      squashedRepo: distribution,
      targetRepo: repoName(project.slug, login),
      branches: project.branches,
      defaultBranch: project.branches[0]!,
      studentLogin: login,
      canAdopt: (id) => adoptableBy(db, row!.id, id),
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
      .where(eq(projectRepos.id, row!.id))
      .returning();
    await audit(db, {
      ...input.actor,
      action: "project.accept",
      subjectType: "project_repo",
      subjectId: row!.id,
      // `protected: false`: a plan without rulesets, the repository is not
      // shielded from force pushes (heig-classroom's degraded mode H8).
      payload: { repo: result.fullName, invitation: result.invitationStatus, protected: result.rulesetId !== null },
    });
    return acceptance(updated!);
  } catch (err) {
    log.error({ err, repo: row!.id }, "provisioning a student repository failed");
    // Only the student can fix a refused invitation (an account renamed
    // away, flagged or deleted): the staff are not told of it.
    const refused = isInvitationRefused(err);
    const first = await markProvisionFailed(db, row!.id, redactTokens(String(err)));
    await audit(db, {
      ...input.actor,
      action: "project.accept_failed",
      subjectType: "project_repo",
      subjectId: row!.id,
      payload: { notify: first && !refused },
    });
    if (refused) throw new ProjectError("github_account_stale", "GitHub refused to invite your account: relink it");
    throw new ProjectError("provision_failed", "Creating your repository failed: try again");
  }
}
