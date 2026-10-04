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
 * **A group project** (ADR-048 lot 2, ADR-070 §4; merge task M3-15b): the
 * student's group is their copy group (`project_group_members`), `409
 * no_group` without one. The first member to accept claims the group's row
 * (the partial UNIQUE (project, group): two Accepts at once insert one) and
 * provisions `<project slug>-<group slug>` — disambiguated by the group's id
 * when another tracked row bears that name —, then every other member with
 * a linked account is invited (best effort); a later member's Accept only
 * invites them (idempotent). Every account invited is recorded
 * (`access.ts`), what a departure revokes.
 *
 * The staff's notification of a failure is M3-09's; this task marks the one
 * failure that will notify (`payload.notify` of `project.accept_failed`).
 */
import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import { and, eq, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";

import type { ProjectAcceptance } from "@quiz/contracts";
import { acceptRefusal, groupRepoName, isLiveIndividualRepo, repoName } from "@quiz/domain";

import { audit, type AuditActor } from "../../audit.js";
import { linkedLogin } from "../../auth/githubLink.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { githubAccounts, projectRepos } from "../../db/schema.js";
import { installationClient, ownerRepo, type InstallationClient } from "../../github/app.js";
import { isInvitationRefused } from "../../github/collaborators.js";
import { provisionStudentRepo, RepoNameTaken } from "../../github/provision.js";
import { redactTokens } from "../../redact.js";
import { projectInstallation, type InstalledOrg } from "../github/service.js";
import { inviteMember, markGroupInvitationPending, recordGrant } from "./access.js";
import { ProjectError } from "./errors.js";
import { copyGroupOf, groupMembers, groupRepoWhere, individualHolders, type GroupRow } from "./groupRepos.js";
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
  /** The caller's student seat (`studentProject`): their place in a group project's copy, the line an invitation is recorded for. */
  enrollmentId: string;
  actor: AuditActor;
  now: Date;
  log: FastifyBaseLogger;
}

/** What Accept needs of GitHub before it writes anything: the organization, a client, the student's login of today. */
interface GithubSide {
  org: InstalledOrg;
  client: InstallationClient;
  githubUserId: number;
  login: string;
}

/**
 * The student's side on GitHub, or the refusal: `github_not_linked`,
 * `app_not_installed`, `github_account_stale`, `provision_failed` when
 * GitHub cannot tell the login. The login is followed to today's through
 * the immutable id, or nothing is named: a stored login renamed away may
 * belong to somebody else now, who would be invited with push.
 */
async function githubSide(db: Db, config: AppConfig, input: AcceptInput): Promise<GithubSide> {
  const [account] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, input.userId));
  if (!account) throw new ProjectError("github_not_linked", "Link your GitHub account first");
  const org = await projectInstallation(db, input.project.orgId);
  if (!org) throw new ProjectError("app_not_installed", "Quiz's GitHub App no longer acts on the project's organization");
  const client = await installationClient(config, org.installationId);
  const login = await linkedLogin(db, client.octokit, input.userId, account).catch((err: unknown) => {
    input.log.warn({ err }, "GitHub login lookup failed");
    throw new ProjectError("provision_failed", "GitHub cannot be reached: try again");
  });
  if (typeof login !== "string") throw new ProjectError("github_account_stale", "Relink your GitHub account");
  return { org, client, githubUserId: account.githubUserId, login };
}

/**
 * `POST /app/api/student/projects/:id/accept` on a project the caller may
 * accept (`studentProject`, `guards.ts`). The row first: provisioned or
 * dead, it is the answer. Then the refusals, all `409`: the project's
 * (`acceptRefusal` of `@quiz/domain`: `not_started`, `deadline_passed`,
 * `distribution_missing`), `no_group` (a group project's copy places the
 * student nowhere), `github_not_linked`, `app_not_installed`,
 * `github_account_stale`, `provision_in_progress`, `repo_name_taken`;
 * GitHub failing (its login lookup included) is `502 provision_failed`,
 * retried by the student.
 */
export async function acceptProject(db: Db, config: AppConfig, input: AcceptInput): Promise<ProjectAcceptance> {
  const { project, userId, now } = input;
  const mine = and(eq(projectRepos.projectId, project.id), eq(projectRepos.userId, userId), isNull(projectRepos.groupId));
  const [existing] = await db.select().from(projectRepos).where(mine).limit(1);
  // In a group project, only a live individual repository (heig-classroom's lot 1) is the student's own.
  if (project.groupMode ? existing !== undefined && isLiveIndividualRepo(existing) : settled(existing)) return acceptance(existing!);
  if (project.groupMode) return acceptGroup(db, config, input);

  const refusal = acceptRefusal(project, now);
  if (refusal) throw new ProjectError(refusal);
  const github = await githubSide(db, config, input);

  await db.insert(projectRepos).values({ id: randomUUID(), projectId: project.id, userId, acceptedAt: now }).onConflictDoNothing();
  const row = await claimProvisioning(db, mine, now);
  if (!row) {
    const [current] = await db.select().from(projectRepos).where(mine).limit(1);
    if (settled(current)) return acceptance(current);
    throw new ProjectError("provision_in_progress", "Your repository is being created: try again in a moment");
  }
  return acceptance(await provision(db, input, row, github, repoName(project.slug, github.login)));
}

/**
 * A group project's Accept (ADR-048 lot 2): the student's copy group's
 * repository — made by the first member, every other member invited;
 * joined by a later one, who is invited on it.
 */
async function acceptGroup(db: Db, config: AppConfig, input: AcceptInput): Promise<ProjectAcceptance> {
  const { project, userId, now } = input;
  const group = await copyGroupOf(db, project.id, input.enrollmentId);
  if (!group) throw new ProjectError("no_group", "You are in no group of this project: ask your teacher to place you");
  const where = groupRepoWhere(project.id, group.id);
  const [found] = await db.select().from(projectRepos).where(where).limit(1);
  if (found?.provisionStatus === "ok" && found.deletedAt === null) return joinGroupRepo(db, config, input, found);
  if (settled(found)) return acceptance(found);

  const refusal = acceptRefusal(project, now);
  if (refusal) throw new ProjectError(refusal);
  const github = await githubSide(db, config, input);

  // The first member's row: `user_id` records who created it, nothing more (N-SEC-20).
  await db.insert(projectRepos).values({ id: randomUUID(), projectId: project.id, userId, groupId: group.id, acceptedAt: now }).onConflictDoNothing();
  const row = await claimProvisioning(db, where, now);
  if (!row) {
    const [current] = await db.select().from(projectRepos).where(where).limit(1);
    if (current?.provisionStatus === "ok" && current.deletedAt === null) return joinGroupRepo(db, config, input, current);
    if (settled(current)) return acceptance(current);
    throw new ProjectError("provision_in_progress", "Your group's repository is being created: try again in a moment");
  }
  const made = await provision(db, input, row, github, await groupRepoNameFor(db, project, group, github.org.login, row));
  return acceptance(await inviteGroup(db, input, made, github));
}

/**
 * The name of a group's repository: `<project slug>-<group slug>`, the
 * group's id appended when another row Quiz tracks already bears it (two
 * classrooms of one organization with the same project slug both have a
 * `group-1`). Deterministic: two members accepting together, or a retry,
 * compute the same name. The provisioning adopts an existing repository
 * of that name only when this row recorded its id (`repo_name_taken`
 * otherwise).
 */
async function groupRepoNameFor(db: Db, project: ProjectRow, group: GroupRow, orgLogin: string, row: RepoRow): Promise<string> {
  const base = groupRepoName(project.slug, group.slug);
  const [taken] = await db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .where(and(sql`lower(${projectRepos.fullName}) = lower(${`${orgLogin}/${base}`})`, ne(projectRepos.id, row.id)))
    .limit(1);
  return taken ? groupRepoName(project.slug, group.slug, group.id.slice(0, 8)) : base;
}

/**
 * Provisions `row` as `targetRepo` for the Accept that claimed it, the
 * accepting student invited (and their account recorded); audited
 * `project.accept`, or `project.accept_failed` and the refusal.
 */
async function provision(db: Db, input: AcceptInput, row: RepoRow, github: GithubSide, targetRepo: string): Promise<RepoRow> {
  const { project, now, log } = input;
  try {
    const result = await provisionStudentRepo({
      octokit: github.client.octokit,
      token: github.client.token,
      org: github.org.login,
      squashedRepo: ownerRepo(project.distributionFullName!).repo,
      targetRepo,
      branches: project.branches,
      defaultBranch: project.branches[0]!,
      studentLogin: github.login,
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
    await recordGrant(db, row.id, { enrollmentId: input.enrollmentId, githubUserId: github.githubUserId, login: github.login }, now);
    await audit(db, {
      ...input.actor,
      action: "project.accept",
      subjectType: "project_repo",
      subjectId: row.id,
      // `protected: false`: a plan without rulesets, the repository is not
      // shielded from force pushes (heig-classroom's degraded mode H8).
      payload: { repo: result.fullName, invitation: result.invitationStatus, protected: result.rulesetId !== null },
    });
    return updated!;
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

/**
 * Every other member of the group's new repository with a linked account,
 * invited — best effort: a member GitHub refuses (an account renamed away)
 * never deprives the others of their access, and is invited when they
 * accept or relink. The members are read AFTER the provisioning, so one
 * who left meanwhile is not invited from a stale list; a holder of a live
 * individual repository keeps theirs. The row's invitation is then pending
 * while any member's is.
 */
async function inviteGroup(db: Db, input: AcceptInput, repo: RepoRow, github: GithubSide): Promise<RepoRow> {
  const holders = await individualHolders(db, repo.projectId);
  let pending = false;
  for (const member of await groupMembers(db, repo.groupId!)) {
    if (member.enrollmentId === input.enrollmentId || member.account === null || holders.has(member.userId!)) continue;
    try {
      const login = await linkedLogin(db, github.client.octokit, member.userId!, member.account);
      if (typeof login !== "string") continue;
      const account = { enrollmentId: member.enrollmentId, githubUserId: member.account.githubUserId, login };
      const invitation = await inviteMember(db, github.client.octokit, repo, account, { actor: input.actor, now: input.now, via: "accept" });
      pending ||= invitation === "pending";
    } catch (err) {
      input.log.warn({ err, repo: repo.id, enrollmentId: member.enrollmentId }, "inviting a group member failed");
    }
  }
  if (!pending || repo.invitationStatus === "pending") return repo;
  await markGroupInvitationPending(db, repo.id);
  return { ...repo, invitationStatus: "pending" };
}

/**
 * A later member's Accept on their group's provisioned repository: they are
 * invited (idempotent on GitHub's side), and the answer is THEIR invitation.
 * Refused as a first Accept would be on their account (`github_not_linked`,
 * `github_account_stale`) or the App (`app_not_installed`); GitHub failing
 * is `provision_failed`, retried.
 */
async function joinGroupRepo(db: Db, config: AppConfig, input: AcceptInput, repo: RepoRow): Promise<ProjectAcceptance> {
  const github = await githubSide(db, config, input);
  const account = { enrollmentId: input.enrollmentId, githubUserId: github.githubUserId, login: github.login };
  let invitation: "pending" | "accepted";
  try {
    invitation = await inviteMember(db, github.client.octokit, repo, account, { actor: input.actor, now: input.now, via: "accept" });
  } catch (err) {
    if (isInvitationRefused(err)) throw new ProjectError("github_account_stale", "GitHub refused to invite your account: relink it");
    input.log.error({ err, repo: repo.id }, "inviting a group member failed");
    throw new ProjectError("provision_failed", "GitHub failed: try again");
  }
  if (invitation === "pending") await markGroupInvitationPending(db, repo.id);
  return { status: repo.provisionStatus, fullName: repo.fullName, invitationStatus: invitation };
}
