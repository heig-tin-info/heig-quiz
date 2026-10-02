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
 *   ingestion (`ingestCompletedRun`, `grading.ts`), the path M3-06's
 *   reconciliation takes too.
 * - `member` added: the student accepted the invitation.
 * - `repository`: renamed (the name follows the immutable id — a student's
 *   repository, a project's source or distribution) or deleted (terminal).
 * - `organization` renamed: the `<org>/` prefix of every name stored for
 *   the organization's projects; the organization row is `github`'s own
 *   handler's.
 *
 * Every change to a student's repository is hinted to its students' `user:`
 * topics and its course's staff, never to the classroom (`events.ts`).
 *
 * Out of this task: a push on a source repository (source ahead) and
 * `pull_request` on `sync/*` (M3-07); the live-state cache's reads (M3-08);
 * notices, notifications and mails (M3-09).
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

import { githubOrganizations, projectRepos, projects, botCommits } from "../../db/schema.js";
import { installationClient, isZeroSha, ownerRepo } from "../../github/app.js";
import { forgetRepoLiveState } from "../../github/metrics.js";
import { onEvent, onReceipt, projectInstallation, pushedBy, type WebhookHandler } from "../github/service.js";
import { ingestCompletedRun, isEligible, isLastStudentCommit, type CompletedRun } from "./grading.js";
import { protectFiles } from "./protection.js";
import { hintRepo, markRepoDeleted, repoContext, tracksRepo } from "./repos.js";

const BRANCH_REF = /^refs\/heads\/(.+)$/;

const PushEvent = z.object({
  ref: z.string(),
  before: z.string().optional(),
  after: z.string(),
  forced: z.boolean().optional(),
  repository: z.object({ id: z.number().int() }),
  sender: z.object({ login: z.string() }).optional(),
  head_commit: z.object({ timestamp: z.string().optional() }).nullish(),
  commits: z
    .array(
      z.object({
        added: z.array(z.string()).optional(),
        modified: z.array(z.string()).optional(),
        removed: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

/**
 * A push on a student's repository. A deleted branch changes nothing. Only
 * a person's push is the student's last commit — the commit whose CI state
 * the repository shows (`isLastStudentCommit`). A workflow's commit
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

  const by = pushedBy(config, sender?.login);
  if (by === "workflow") {
    await app.db.insert(botCommits).values({ repoId: ctx.repo.id, sha: after, kind: "grader" }).onConflictDoNothing();
  } else if (by === "person") {
    const at = head_commit?.timestamp ? new Date(head_commit.timestamp) : delivery.receivedAt;
    await app.db
      .update(projectRepos)
      .set({ lastCommitSha: after, lastCommitAt: Number.isNaN(at.getTime()) ? delivery.receivedAt : at })
      .where(eq(projectRepos.id, ctx.repo.id));
  }
  if (by !== "app") {
    await protectFiles(app, config, ctx, { branch, before, after, forced: forced ?? false, commits: commits ?? [] });
  }
  await hintRepo(app.db, ctx);
};

const WorkflowRunEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int() }),
  workflow_run: z.object({
    id: z.number().int(),
    run_attempt: z.number().int().optional(),
    head_branch: z.string().nullish(),
    head_sha: z.string(),
    conclusion: z.string().nullish(),
    path: z.string().optional(),
    event: z.string().optional(),
    check_suite_id: z.number().int().nullish(),
    updated_at: z.string().optional(),
  }),
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
  const raw = event.data.workflow_run;
  const completedAt = raw.updated_at ? new Date(raw.updated_at) : delivery.receivedAt;
  const run: CompletedRun = {
    workflowRunId: raw.id,
    runAttempt: raw.run_attempt ?? 1,
    headBranch: raw.head_branch ?? "",
    headSha: raw.head_sha,
    conclusion: raw.conclusion ?? "unknown",
    path: raw.path ?? "",
    event: raw.event ?? "",
    checkSuiteId: raw.check_suite_id ?? null,
    completedAt: Number.isNaN(completedAt.getTime()) ? delivery.receivedAt : completedAt,
  };
  if (event.data.action !== "completed") {
    if (!isLastStudentCommit(ctx, run.headSha) || !(await isEligible(app.db, ctx, run))) return;
    await app.db.update(projectRepos).set({ ciStatus: "pending" }).where(eq(projectRepos.id, ctx.repo.id));
  } else {
    const org = await projectInstallation(app.db, ctx.project.orgId);
    if (!org) return; // the App gone: the reconciliation catches up once it is back
    const { octokit } = await installationClient(config, org.installationId);
    if ((await ingestCompletedRun(app, octokit, ctx, run)) === null) return;
  }
  await hintRepo(app.db, ctx);
};

const MemberEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int() }),
});

/** `member` added: the invitation was accepted (F-PROJ-07); the daily reconciliation is the fallback. */
const member: WebhookHandler = async (app, _config, delivery) => {
  const event = MemberEvent.safeParse(delivery.payload);
  if (!event.success || event.data.action !== "added") return;
  const ctx = await repoContext(app.db, event.data.repository.id);
  if (!ctx || ctx.repo.invitationStatus === "accepted") return;
  await app.db.update(projectRepos).set({ invitationStatus: "accepted" }).where(eq(projectRepos.id, ctx.repo.id));
  await hintRepo(app.db, ctx);
};

const RepositoryEvent = z.object({
  action: z.string(),
  repository: z.object({ id: z.number().int(), full_name: z.string().min(1) }),
  /** A rename's old name (the repository's, without the owner). */
  changes: z.object({ repository: z.object({ name: z.object({ from: z.string().min(1) }) }) }).optional(),
});

/**
 * `repository` renamed or deleted (F-PROJ-18). GitHub's id is the
 * reference: a rename refreshes the stored names — a student's repository,
 * and a project's source or distribution repository, which the restores
 * and the sync read by name — only where the stored name is the one the
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
    const from = `${ownerRepo(repo.full_name).owner}/${changes.repository.name.from}`;
    await app.db
      .update(projects)
      .set({ sourceFullName: repo.full_name })
      .where(and(eq(projects.sourceRepoId, repo.id), eq(projects.sourceFullName, from)));
    await app.db
      .update(projects)
      .set({ distributionFullName: repo.full_name })
      .where(and(eq(projects.distributionRepoId, repo.id), eq(projects.distributionFullName, from)));
    if (!ctx) return;
    const [renamed] = await app.db
      .update(projectRepos)
      .set({ fullName: repo.full_name })
      .where(and(eq(projectRepos.id, ctx.repo.id), eq(projectRepos.fullName, from)))
      .returning({ id: projectRepos.id });
    if (!renamed) return;
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
}
