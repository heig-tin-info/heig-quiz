/**
 * What GitHub's webhooks do to projects (spec 05 §5.11, F-PROJ-08, -10,
 * -18, -21; merge task M3-04), ported from heig-classroom's
 * `modules/webhooks.ts` (sync point `ab98cc0`). The `github` module stores
 * every delivery and calls these handlers from its registry (`onEvent`,
 * `onReceipt`; it never imports this module, I30), retried whole on a
 * failure and replayed by the reconciliation: each is idempotent (ADR-011).
 *
 * - `push` on a student's repository: its last commit, a workflow's commit
 *   recorded as a bot commit (`grader`), the protected files
 *   (`protection.ts`). The receipt itself was written by the intake,
 *   before the 200 (ADR-012), for the repositories {@link tracksRepo} claims.
 * - `workflow_run`: `pending` while an eligible run runs; completed, ONE
 *   ingestion (`ingestRun`, `ci.ts`: `ingestCompletedRun`, or a schema-3
 *   project's graded run), the path M3-06's
 *   reconciliation takes too.
 * - `member` added: the student accepted the invitation (their grant
 *   joined); removed: their grant no longer is.
 * - `repository`: renamed (the name follows the immutable id — a student's
 *   repository, a project's source or distribution) or deleted (terminal).
 * - `organization` renamed: the `<org>/` prefix of every name stored for
 *   the organization's projects; the organization row is `github`'s own
 *   handler's.
 *
 * Every change to a student's repository is hinted to its students' `user:`
 * topics and its course's staff, never to the classroom (`events.ts`).
 *
 * A push on a SOURCE repository (the source ahead) and `pull_request` on
 * `sync/*` are `sync.ts`'s handlers (M3-07), registered here beside these.
 * Out of this file: the live-state cache's reads (M3-08); the worded
 * notices (M3-09c). The notifications are `notify.ts`'s, at the writes they
 * announce (M3-09b): none of these handlers sends one.
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import { runKind } from "@quiz/domain";

import { githubOrganizations, projectRepoAccess, projectRepos, projects, botCommits } from "../../db/schema.js";
import { installationClient, isZeroSha } from "../../github/app.js";
import { forgetRepoLiveState } from "../../github/metrics.js";
import { onEvent, onReceipt, projectInstallation, pushAuthor, type WebhookHandler } from "../github/service.js";
import { ingestRun } from "./ci.js";
import { completedRun, isEligible, isLastStudentCommit, RawWorkflowRun } from "./grading.js";
import { protectFiles } from "./protection.js";
import { BRANCH_REF, followRepoRename, hintRepo, markRepoDeleted, moveLastCommit, PushEvent, repoContext, tracksRepo } from "./repos.js";
import { pullRequest, sourcePush } from "./sync.js";

/**
 * A push on a student's repository. A deleted branch changes nothing. Only
 * a person's push is the student's last commit — the commit whose CI state
 * the repository shows (`isLastStudentCommit`) —, a relayed push of the
 * online workspace whose head the portal declared included (`pushAuthor`,
 * ADR-078 §6). A workflow's commit
 * (`github-actions[bot]`, the review's `GRADING.yml`) is recorded as a bot
 * commit and checked; the App's own push (a restore, a deadline commit, a
 * sync) recorded its bot commit before it moved the branch, and is never
 * checked.
 */
const push: WebhookHandler = async (app, config, delivery) => {
  const event = PushEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { ref, before, after, forced, repository, sender, head_commit, commits } = event.data;
  const branch = BRANCH_REF.exec(ref)?.[1];
  if (!branch || isZeroSha(after)) return;
  const ctx = await repoContext(app.db, repository.id);
  if (!ctx || ctx.repo.deletedAt !== null) return;
  forgetRepoLiveState(ctx.repo.fullName);

  // A relayed push of the online workspace is the App's sender but the student's work (ADR-078 §6).
  const by = await pushAuthor(app.db, config, { senderLogin: sender?.login, githubRepoId: repository.id, after });
  if (by === "workflow") {
    await app.db.insert(botCommits).values({ repoId: ctx.repo.id, sha: after, kind: "grader" }).onConflictDoNothing();
  } else if (by === "person" || by === "collection") {
    await moveLastCommit(app.db, ctx.repo.id, after, head_commit?.timestamp, delivery.receivedAt);
  }
  // A collection kept the protected files from the branch's head, checked before it was signed (ADR-130 §4.3).
  if (by === "person" || by === "workflow") {
    await protectFiles(app, config, ctx, { branch, before, after, forced: forced ?? false, commits: commits ?? [] });
  }
  await hintRepo(app.db, ctx);
};

const WorkflowRunEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int() }),
  workflow_run: RawWorkflowRun,
});

/**
 * A run of a student's repository: `requested` and `in_progress` of an
 * eligible run on the student's last commit mark the repository `pending`
 * (the same commit `ingestCompletedRun` aggregates the state of, so a
 * pending state always ends); `completed` ingests it, eligibility included.
 */
const workflowRun: WebhookHandler = async (app, config, delivery) => {
  const event = WorkflowRunEvent.safeParse(delivery.payload);
  if (!event.success || !["requested", "in_progress", "completed"].includes(event.data.action)) return;
  const ctx = await repoContext(app.db, event.data.repository.id);
  if (!ctx || ctx.repo.deletedAt !== null) return;
  forgetRepoLiveState(ctx.repo.fullName);
  // The one mapping, the reconciliation's too (ADR-011 §1).
  const run = completedRun(config, event.data.workflow_run, delivery.receivedAt);
  if (event.data.action !== "completed") {
    // A dispatched run (a review, a graded run) is not the student's CI (`ciStatusOf`): it never marks pending.
    if (runKind(run) !== "ci" || !isLastStudentCommit(ctx, run.headSha) || !(await isEligible(app.db, ctx, run))) return;
    await app.db.update(projectRepos).set({ ciStatus: "pending" }).where(eq(projectRepos.id, ctx.repo.id));
  } else {
    const org = await projectInstallation(app.db, ctx.project.orgId);
    if (!org) return; // the App gone: the reconciliation catches up once it is back
    const { octokit } = await installationClient(config, org.installationId);
    if ((await ingestRun(app, octokit, ctx, run)) === null) return;
  }
  await hintRepo(app.db, ctx);
};

const MemberEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int() }),
  /** The account added or removed, by its immutable id. */
  member: z.object({ id: z.number().int() }),
});

/**
 * `member` added: an invitation was accepted (F-PROJ-07) — the account's
 * live grant is `accepted_at` (the receipt's time, kept on a replay) and
 * the repository's row `accepted` (a group's once one member is in,
 * ADR-070's amendment of 2026-11-19), only when the account is one Quiz
 * invited there: a collaborator the staff added on GitHub changes nothing.
 * `removed`: the account is out again, its grant no longer joined; the row,
 * the group's aggregate, is left as it is. The daily reconciliation is the
 * fallback of both.
 */
const member: WebhookHandler = async (app, _config, delivery) => {
  const event = MemberEvent.safeParse(delivery.payload);
  if (!event.success || !["added", "removed"].includes(event.data.action)) return;
  const ctx = await repoContext(app.db, event.data.repository.id);
  if (!ctx) return;
  const added = event.data.action === "added";
  const grants = await app.db
    .update(projectRepoAccess)
    .set(added ? { acceptedAt: sql`coalesce(${projectRepoAccess.acceptedAt}, ${delivery.receivedAt.toISOString()}::timestamptz)`, absentAt: null } : { acceptedAt: null })
    .where(
      and(
        eq(projectRepoAccess.repoId, ctx.repo.id),
        eq(projectRepoAccess.githubUserId, event.data.member.id),
        isNull(projectRepoAccess.revokedAt),
      ),
    )
    .returning({ id: projectRepoAccess.id });
  const row = added && grants.length > 0 && ctx.repo.invitationStatus !== "accepted";
  if (row) await app.db.update(projectRepos).set({ invitationStatus: "accepted" }).where(eq(projectRepos.id, ctx.repo.id));
  if (row || grants.length > 0) await hintRepo(app.db, ctx);
};

const RepositoryEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int(), full_name: z.string().min(1) }),
  /** A rename's old name (the repository's, without the owner). */
  changes: z.object({ repository: z.object({ name: z.object({ from: z.string().min(1) }) }) }).optional(),
});

/**
 * `repository` renamed or deleted (F-PROJ-18). GitHub's id is the
 * reference: a rename refreshes the stored names (`followRepoRename`, the
 * reconciliation's path too) only where the stored name is the one the
 * rename left (`changes.repository.name.from`), so a stale rename replayed
 * after a later one changes nothing. A student's repository deleted is
 * marked so, terminal; a source or distribution deleted is left to the
 * staff (M3-07).
 */
const repository: WebhookHandler = async (app, _config, delivery) => {
  const event = RepositoryEvent.safeParse(delivery.payload);
  if (!event.success) return;
  const { action, repository: repo, changes } = event.data;
  const ctx = await repoContext(app.db, repo.id);
  if (action === "renamed") {
    if (!changes) return;
    if (!(await followRepoRename(app.db, repo.id, repo.full_name, changes.repository.name.from)) || !ctx) return;
  } else if (action === "deleted") {
    if (!ctx || !(await markRepoDeleted(app.db, ctx.repo.id, app.clock.now(), "webhook"))) return;
  } else {
    return;
  }
  forgetRepoLiveState(ctx.repo.fullName);
  await hintRepo(app.db, ctx);
};

const OrganizationEvent = z.object({
  action: z.string(),
  organization: z.object({ id: z.number().int(), login: z.string().min(1) }),
  /** A rename's old login. */
  changes: z.object({ login: z.object({ from: z.string().min(1) }) }).optional(),
});

/**
 * `organization` renamed (F-PROJ-18): the `<org>/` prefix of every name
 * stored for the organization's projects becomes the new login — only on
 * names under the login the rename left (`changes.login.from`), so a stale
 * rename replayed after a later one changes nothing. Keyed on the
 * organization's immutable id; the `github` module's own handler renames
 * the organization row, in either order. (Storing names without their
 * owner would make this handler unnecessary: a follow-up, card M3-08.)
 */
const organization: WebhookHandler = async (app, _config, delivery) => {
  const event = OrganizationEvent.safeParse(delivery.payload);
  if (!event.success || event.data.action !== "renamed" || !event.data.changes) return;
  const { id, login } = event.data.organization;
  const from = event.data.changes.login.from;
  const orgIds = app.db.select({ id: githubOrganizations.id }).from(githubOrganizations).where(eq(githubOrganizations.githubOrgId, id));
  const theirs = app.db.select({ id: projects.id }).from(projects).where(inArray(projects.orgId, orgIds));
  /** `login/<name>`, from a stored `<from>/<name>`. */
  const renamed = (column: AnyPgColumn) => sql`${login} || substr(${column}, strpos(${column}, '/'))`;
  const under = (column: AnyPgColumn) => sql`split_part(${column}, '/', 1) = ${from}`;
  await app.db
    .update(projects)
    .set({ sourceFullName: renamed(projects.sourceFullName) })
    .where(and(inArray(projects.orgId, orgIds), under(projects.sourceFullName)));
  await app.db
    .update(projects)
    .set({ distributionFullName: renamed(projects.distributionFullName) })
    .where(and(inArray(projects.orgId, orgIds), isNotNull(projects.distributionFullName), under(projects.distributionFullName)));
  await app.db
    .update(projectRepos)
    .set({ fullName: renamed(projectRepos.fullName) })
    .where(and(inArray(projectRepos.projectId, theirs), isNotNull(projectRepos.fullName), under(projectRepos.fullName)));
};

/** Called once per app by the module's plugin; registering twice changes nothing. */
export function registerProjectHandlers(): void {
  onReceipt(tracksRepo);
  onEvent("push", push);
  onEvent("workflow_run", workflowRun);
  onEvent("member", member);
  onEvent("repository", repository);
  onEvent("organization", organization);
  // The source's sync (M3-07): a push on a SOURCE repository, the App's pull requests.
  onEvent("push", sourcePush);
  onEvent("pull_request", pullRequest);
}
