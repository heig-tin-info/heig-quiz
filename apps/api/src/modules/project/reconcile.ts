/**
 * The reconciliations of projects (N-RES-08, ADR-011 and its addendum of
 * 2026-10-05; merge task M3-06a), ported from heig-classroom's `tasks.ts`
 * (`reconcileGrades`, `reconcileRepos`, sync point `ab98cc0`) as two
 * scheduled tasks of the catalog (D10, `RECONCILE_TASKS`): the `system.task`
 * worker runs them, never a tick (invariant 5), and without Quiz's App they
 * skip. Every step is the webhook's own, idempotent path (ADR-011 §1).
 *
 * - `reconcile.grades` (every 15 minutes): the last 20 completed runs of
 *   every repository in scope that is QUIET — no push received and no run
 *   completed for 30 minutes (while the webhooks flow there is nothing to
 *   catch up) — through `ingestRun` (`ingestCompletedRun`, or a schema-3
 *   project's graded run, `ci.ts`): a run already known reads and
 *   writes nothing (the UNIQUE of `project_grade_runs`). A reconciled run
 *   has no receipt: late once the deadline passed (GR-14.3).
 * - `reconcile.repos` (daily): each member's invitation (a student's own
 *   repository's or a group's, ADR-070's amendment of 2026-11-19) found
 *   accepted meanwhile, or, gone from GitHub, re-invited at most once a day
 *   per member (`project_repo_access.reinvited_at`, claimed before GitHub is
 *   called) until the repository is frozen; the default branch's head, moved only when it
 *   is a person's — not in `bot_commits`, its author and committer both
 *   named by GitHub and neither a bot: the reconciliation knows no pusher —
 *   with its CI state. It writes no push receipt (the intake's alone,
 *   ADR-012) and restores nothing (the push webhook's). Before them, a repository left
 *   WITHOUT its `hgc-protect` ruleset (`ruleset_id` null: provisioned on a
 *   plan that served none) gets it applied once the plan allows it — live,
 *   not archived, its effective deadline still ahead on the server's clock —
 *   through `protectStudentRepo`, provisioning's own idempotent step, audited
 *   `project_repo.protected` (M3-14k, ADR-011's addendum of 2026-10-06); a
 *   plan that still refuses leaves it null, tried again the next day.
 *
 * Both locate each repository by its immutable id first: a 404 there, once
 * the installation's token was obtained, is the repository gone
 * (`markRepoDeleted`, `via: reconcile`); a 404 anywhere else never is. A
 * name GitHub changed is followed as the `repository.renamed` webhook
 * follows it (`followRepoRename`).
 *
 * SCOPE (product owner, 2026-10-05; `reconciles` of `@quiz/domain`): the
 * live repositories (`LIVE`), until 24 hours after their definitive freeze
 * — longer only while a final review was asked and not answered. GitHub's
 * quota (N-PERF-07): a finished project costs nothing after a day.
 *
 * A RATE LIMIT STOPS THE PASS at once (`failFast`: `noRateLimitWait` on
 * every request) instead of waiting it out inside the task — a run of 30
 * minutes is taken for dead and claimed again (`RUNNING_STALE_MINUTES`) —
 * and the next period resumes it. Any other failure of one repository is
 * logged and the pass goes on to the next.
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { effectiveDeadline, isQuiet, reconciles } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, classrooms, gradeDispatches, projectGradeRuns, projectRepoAccess, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { failFast, githubApp, githubStatus, ownerRepo, rateLimitReset } from "../../github/app.js";
import { forgetRepoLiveState } from "../../github/metrics.js";
import { protectStudentRepo } from "../../github/provision.js";
import type { ScheduledTask } from "../../ticker.js";
import { pushedBy } from "../github/service.js";
import { followInvitation, installationClients, inviteAccount, notRecorded } from "./access.js";
import { ciPassOpen, ingestRun, purgeCiResults } from "./ci.js";
import { LIVE } from "./deadline.js";
import { purgeEvidenceFiles } from "./evidence.js";
import { ProjectError } from "./errors.js";
import { aggregateCiStatus, completedRun, refreshScoreSelection } from "./grading.js";
import { repoMembers } from "./groupRepos.js";
import { checkGrants } from "./memberAccess.js";
import { followRepoRename, hintRepo, markRepoDeleted, moveLastCommit, repoWithProject, type RepoContext } from "./repos.js";

/** The completed runs read per repository (heig-classroom's figure): the lost webhooks of a quiet half hour fit in far fewer. */
const RUNS_PER_REPO = 20;
/** The least time between two re-invites of one member's invitation (F-PROJ-07: at most once a day). */
export const REINVITE_INTERVAL_MS = 24 * 3_600_000;

type TaskKey = "reconcile.grades" | "reconcile.repos";

/** What one pass changed: the audit's payload beside the repositories read, and the summary's figures. */
interface Counts {
  runsIngested: number;
  reinvited: number;
  accepted: number;
  heads: number;
  renamed: number;
  deleted: number;
  protected: number;
}

/** A repository in scope, as the pass read it. */
type Candidate = RepoContext;

/** The repository as GitHub names it today. */
interface Located {
  fullName: string;
  defaultBranch: string;
}

interface Step {
  app: FastifyInstance;
  config: AppConfig;
  octokit: Octokit;
  ctx: Candidate;
  located: Located;
  counts: Counts;
  now: Date;
}

/** A failure GitHub answered for its rate limit: the pass stops on it. */
const rateLimited = (err: unknown): boolean => rateLimitReset(err, Date.now()) !== null;

/** The live repositories in scope (`reconciles`), with their project and course; one read. */
async function candidates(db: Db, now: Date): Promise<Candidate[]> {
  // A CI final review asked: an `auto` project's only — a `criteria` project's `deadline` row is
  // its platform pass (ADR-106 §6), whose review slot never fills —, or a schema-3 project's CI pass
  // still waiting for its graded run (ADR-119 §6): its runs are read until the pass settles.
  const reviewAsked = sql<boolean>`(EXISTS (SELECT 1 FROM ${gradeDispatches}
    WHERE ${gradeDispatches.repoId} = ${projectRepos.id} AND ${gradeDispatches.trigger} = 'deadline'
    AND ${projects.gradingMode} = 'auto') OR ${ciPassOpen(db)})`.mapWith(Boolean);
  const rows = await repoWithProject(db, { courseId: classrooms.courseId, reviewAsked })
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(LIVE)
    .orderBy(asc(projects.id), asc(projectRepos.id));
  return rows.filter((r) => reconciles(r.repo, r.reviewAsked, now)).map(({ reviewAsked: _asked, ...ctx }) => ctx);
}

/**
 * The candidates QUIET for 30 minutes (`isQuiet`): nothing happened to them
 * — the latest of their push receipts and of their runs' completion (GitHub's
 * clock, never the row's `created_at`: the two clocks do not mix) is older
 * than that, or there was none.
 */
async function quietCandidates(db: Db, now: Date): Promise<Candidate[]> {
  const rows = await candidates(db, now);
  if (rows.length === 0) return rows;
  const ids = rows.map((r) => r.repo.id);
  const latest = (column: typeof pushReceipts.receivedAt | typeof projectGradeRuns.completedAt) =>
    sql<string | Date>`max(${column})`.mapWith((v: string | Date) => new Date(v));
  const [receipts, runs] = await Promise.all([
    db
      .select({ id: projectRepos.id, at: latest(pushReceipts.receivedAt) })
      .from(pushReceipts)
      .innerJoin(projectRepos, eq(projectRepos.githubRepoId, pushReceipts.githubRepoId))
      .where(inArray(projectRepos.id, ids))
      .groupBy(projectRepos.id),
    db
      .select({ id: projectGradeRuns.repoId, at: latest(projectGradeRuns.completedAt) })
      .from(projectGradeRuns)
      .where(inArray(projectGradeRuns.repoId, ids))
      .groupBy(projectGradeRuns.repoId),
  ]);
  const activity = new Map<string, Date>();
  for (const { id, at } of [...receipts, ...runs]) {
    const known = activity.get(id);
    if (!known || known < at) activity.set(id, at);
  }
  return rows.filter((r) => isQuiet(activity.get(r.repo.id) ?? null, now));
}

/**
 * The repository by its immutable id: gone (a 404 here, the token in hand)
 * is terminal, and audited once; a name GitHub changed is followed. Null
 * when there is nothing left to reconcile.
 */
async function locate(app: FastifyInstance, octokit: Octokit, ctx: Candidate, counts: Counts): Promise<Located | null> {
  let data: unknown;
  try {
    ({ data } = await octokit.request("GET /repositories/{repository_id}", { repository_id: ctx.repo.githubRepoId!, request: { retries: 0 } }));
  } catch (err) {
    if (githubStatus(err) !== 404) throw err;
    if (await markRepoDeleted(app.db, ctx.repo.id, app.clock.now(), "reconcile")) {
      counts.deleted += 1;
      forgetRepoLiveState(ctx.repo.fullName);
      await hintRepo(app.db, ctx);
    }
    return null;
  }
  const { full_name: fullName, default_branch: defaultBranch } = data as { full_name: string; default_branch: string };
  if (fullName !== ctx.repo.fullName && (await followRepoRename(app.db, ctx.repo.githubRepoId!, fullName, ownerRepo(ctx.repo.fullName!).repo))) {
    counts.renamed += 1;
    forgetRepoLiveState(ctx.repo.fullName);
    ctx.repo = { ...ctx.repo, fullName };
    await hintRepo(app.db, ctx);
  }
  return { fullName, defaultBranch };
}

/**
 * One pass: the repositories `select` returns, located then `settle`d, with
 * one fail-fast client per organization Quiz's App acts on
 * (`installationClients`); a rate limit stops it, any other failure of a
 * repository is logged. Audited `project.reconciled` when it changed
 * something or stopped; the summary is the task's last message.
 */
async function pass(
  app: FastifyInstance,
  config: AppConfig,
  task: TaskKey,
  select: (db: Db, now: Date) => Promise<Candidate[]>,
  settle: (step: Step) => Promise<void>,
  summary: (repos: number, counts: Counts) => string,
): Promise<string> {
  if (!githubApp(config)) return "GitHub App not configured";
  const now = app.clock.now();
  const rows = await select(app.db, now);
  const clients = await installationClients(
    app.db,
    config,
    rows.map((r) => r.project.orgId),
  );
  const counts: Counts = { runsIngested: 0, reinvited: 0, accepted: 0, heads: 0, renamed: 0, deleted: 0, protected: 0 };
  let repos = 0;
  let stopped = false;
  for (const ctx of rows) {
    const client = clients.get(ctx.project.orgId);
    if (!client) continue;
    const octokit = failFast(client);
    repos += 1;
    try {
      const located = await locate(app, octokit, ctx, counts);
      if (located) await settle({ app, config, octokit, ctx, located, counts, now });
    } catch (err) {
      if (rateLimited(err)) {
        app.log.warn({ task, repo: ctx.repo.fullName }, "reconciliation stopped on GitHub's rate limit; the next period resumes it");
        stopped = true;
        break;
      }
      app.log.warn({ err, task, repo: ctx.repo.fullName }, "reconciliation: a repository failed");
    }
  }
  if (stopped || Object.values(counts).some((n) => n > 0)) {
    await audit(app.db, {
      ...SYSTEM_ACTOR,
      action: "project.reconciled",
      subjectType: "scheduled_task",
      subjectId: task,
      payload: { repos, ...counts, stoppedOnRateLimit: stopped },
    });
  }
  return summary(repos, counts) + (stopped ? ", stopped on GitHub's rate limit" : "");
}

// ---------------------------------------------------------------- reconcile.grades

/** The last completed runs of the repository through the one ingestion path; a 404 here is no deletion. */
async function ingestRuns({ app, config, octokit, ctx, located, counts, now }: Step): Promise<void> {
  const { owner, repo } = ownerRepo(located.fullName);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs", { owner, repo, status: "completed", per_page: RUNS_PER_REPO });
  let ingested = 0;
  for (const raw of data.workflow_runs) {
    if ((await ingestRun(app, octokit, ctx, completedRun(config, raw, now))) !== null) ingested += 1;
  }
  // A run on a restored head whose stored `to_verify` lags (a receipt that
  // widened the window after it was ingested, M3-06b) is caught up here,
  // with no new run and no GitHub call: the column follows the set.
  await refreshScoreSelection(app.db, ctx);
  if (ingested === 0) return;
  counts.runsIngested += ingested;
  forgetRepoLiveState(located.fullName);
  await hintRepo(app.db, ctx);
}

/** `reconcile.grades`: the runs of the quiet repositories in scope. */
export function reconcileGrades(app: FastifyInstance, config: AppConfig): Promise<string> {
  return pass(app, config, "reconcile.grades", quietCandidates, ingestRuns, (repos, c) => `${repos} quiet repositories checked, ${c.runsIngested} runs ingested`);
}

// ---------------------------------------------------------------- reconcile.repos

/** The day's re-invite of one member claimed on their grant: live, not revoking, not known in, none for a day. */
async function claimReinvite(db: Db, grantId: string, now: Date): Promise<boolean> {
  const claimed = await db
    .update(projectRepoAccess)
    .set({ reinvitedAt: now })
    .where(
      and(
        eq(projectRepoAccess.id, grantId),
        isNull(projectRepoAccess.revokedAt),
        isNull(projectRepoAccess.revokingAt),
        isNull(projectRepoAccess.acceptedAt),
        or(isNull(projectRepoAccess.reinvitedAt), lte(projectRepoAccess.reinvitedAt, new Date(now.getTime() - REINVITE_INTERVAL_MS))),
      ),
    )
    .returning({ id: projectRepoAccess.id });
  return claimed.length > 0;
}

/**
 * Each member's invitation of the repository (F-PROJ-07, ADR-070's
 * amendment of 2026-11-19), a student's own or a group's alike. Its live
 * grants not known in are looked at on GitHub (`checkGrants`: one listing
 * of the collaborators and one of the invitations, none without such a
 * grant), since GitHub sends no event for an invitation accepted late: a
 * collaborator's grant is joined, and the row `accepted` (a group's once one
 * member is in). A member found neither in nor invited (the invitation
 * expired or declined) is re-invited when the day's claim on their grant
 * is taken (once a day per member, never once the repository is frozen):
 * by the login GitHub knows today for their linked account (`inviteAccount`,
 * as Accept and the resends do; none linked, another account linked since,
 * or the account gone: skipped, the claim stands), with the permission of
 * the work mode, audited `project_group.repo_invite`; a student's own
 * repository's row follows GitHub's answer, a group's only to `accepted`
 * (`followInvitation`). A repository whose access a revocation is taking
 * away (`revoking_at`, M3-15b-2) is neither re-invited nor read: the
 * revocation's answer settles it.
 */
async function reconcileInvitation({ app, octokit, ctx, located, counts, now }: Step): Promise<void> {
  const db = app.db;
  const { repo } = ctx;
  const [revoking] = await db
    .select({ id: projectRepoAccess.id })
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.repoId, repo.id), isNotNull(projectRepoAccess.revokingAt)))
    .limit(1);
  if (revoking) return;
  const { joined, absent } = await checkGrants(db, octokit, repo.id, located.fullName, now);
  let changed = joined.length > 0;
  if (changed) {
    counts.accepted += joined.length;
    await followInvitation(db, repo, "accepted");
  }
  if (repo.frozenAt === null && absent.length > 0) {
    const members = await repoMembers(db, repo, ctx.project.classroomId);
    for (const grant of absent) {
      if (!(await claimReinvite(db, grant.id, now))) continue;
      const member = members.find((m) => m.enrollmentId === grant.enrollmentId);
      if (!member?.account || member.account.githubUserId !== grant.githubUserId) {
        app.log.info({ repo: located.fullName }, "reconcile.repos: an invitation gone, and no linked account of its grant to re-invite");
        continue;
      }
      let invited: Awaited<ReturnType<typeof inviteAccount>>;
      try {
        invited = await inviteAccount(db, octokit, repo, { ...member, account: member.account }, {
          actor: SYSTEM_ACTOR,
          now,
          log: app.log,
          via: "reconcile",
          failure: "invite_failed",
        });
      } catch (err) {
        // The account gone or renamed away, or GitHub refusing it: the student relinks; the claim stands.
        if (!(err instanceof ProjectError)) throw err;
        app.log.warn({ code: err.code, repo: located.fullName }, "reconcile.repos: a re-invite was refused");
        continue;
      }
      if (notRecorded(invited)) continue;
      counts.reinvited += 1;
      if (invited.invitation === "accepted") counts.accepted += 1;
      await followInvitation(db, repo, invited.invitation);
      changed = true;
    }
  }
  if (changed) await hintRepo(db, ctx);
}

/** A GitHub account on a commit, as the API attaches it: a user named, or nobody (null, or an empty object: an e-mail GitHub knows no account for). */
type CommitAccount = { login?: string; type?: string } | null | undefined;

/** A person's account: named, a `User` (never a `Bot`), and neither Quiz's App nor a workflow (`pushedBy`). */
function isPerson(config: AppConfig, account: CommitAccount): boolean {
  if (typeof account?.login !== "string") return false;
  return (account.type === undefined || account.type === "User") && pushedBy(config, account.login) === "person";
}

/**
 * The default branch's head as the student's last commit (F-PROJ-10): moved
 * only when the head is a person's — not recorded as a bot commit, its
 * author AND its committer both named by GitHub and both persons — and then
 * its CI state read again. The reconciliation knows no pusher, so a head
 * GitHub attributes to nobody, or only half (the App's own commits carry no
 * account; one it made with a person's authorship has none as committer),
 * never moves it: no pusher means no head move. No receipt is written: the
 * receipt is the intake's (ADR-012).
 */
async function refreshHead({ app, config, octokit, ctx, located, counts, now }: Step): Promise<void> {
  const db = app.db;
  const { owner, repo } = ownerRepo(located.fullName);
  let head;
  try {
    ({
      data: [head],
    } = await octokit.request("GET /repos/{owner}/{repo}/commits", { owner, repo, sha: located.defaultBranch, per_page: 1, request: { retries: 0 } }));
  } catch (err) {
    if (githubStatus(err) === 409) return; // an empty repository
    throw err;
  }
  if (!head || head.sha === ctx.repo.lastCommitSha) return;
  const [bot] = await db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .where(and(eq(botCommits.repoId, ctx.repo.id), eq(botCommits.sha, head.sha)))
    .limit(1);
  if (bot || !isPerson(config, head.author) || !isPerson(config, head.committer)) return;
  await moveLastCommit(db, ctx.repo.id, head.sha, head.commit.committer?.date ?? head.commit.author?.date, now);
  counts.heads += 1;
  try {
    const ciStatus = await aggregateCiStatus(octokit, located.fullName, head.sha);
    await db.update(projectRepos).set({ ciStatus }).where(eq(projectRepos.id, ctx.repo.id));
  } catch (err) {
    if (rateLimited(err)) throw err;
    app.log.warn({ err, repo: located.fullName }, "the CI state of a repository could not be read");
  }
  forgetRepoLiveState(located.fullName);
  await hintRepo(db, ctx);
}

/**
 * The `hgc-protect` ruleset of a repository provisioned without it (M3-14k):
 * for a live repository, not archived (read-only), still before its effective
 * deadline on the server's clock. The id is stored by a write that holds only
 * while the row is still unprotected and unarchived, and audited with it; a
 * plan that still serves no ruleset leaves the row for tomorrow.
 */
async function protectRepo({ app, octokit, ctx, located, counts }: Step): Promise<void> {
  const { repo, project } = ctx;
  if (repo.rulesetId !== null || repo.archivedAt !== null || effectiveDeadline(repo, project) <= app.clock.now()) return;
  const { owner, repo: name } = ownerRepo(located.fullName);
  const rulesetId = await protectStudentRepo(octokit, owner, name);
  if (rulesetId === null) return;
  // A ruleset created on a row that changed meanwhile stays on GitHub with no stored id: harmless, the next provisioning or lock adopts it by name.
  const stored = await app.db.transaction(async (tx) => {
    const updated = await tx
      .update(projectRepos)
      .set({ rulesetId })
      .where(and(eq(projectRepos.id, repo.id), isNull(projectRepos.rulesetId), isNull(projectRepos.archivedAt)))
      .returning({ id: projectRepos.id });
    if (updated.length === 0) return false;
    await audit(tx, {
      ...SYSTEM_ACTOR,
      action: "project_repo.protected",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { projectId: project.id, rulesetId, via: "reconcile" },
    });
    return true;
  });
  if (!stored) return;
  counts.protected += 1;
  ctx.repo = { ...repo, rulesetId };
  await hintRepo(app.db, ctx);
}

/** A repository's daily refresh: its protection, its invitation, then its head. */
async function refreshRepo(step: Step): Promise<void> {
  try {
    await protectRepo(step);
  } catch (err) {
    // A rate limit stops the pass; any other failure costs the repository only this step today.
    if (rateLimited(err)) throw err;
    step.app.log.warn({ err, repo: step.located.fullName }, "reconciliation: the protection ruleset could not be applied");
  }
  await reconcileInvitation(step);
  await refreshHead(step);
}

/** `reconcile.repos`: every repository in scope, quiet or not; then the evidence files past their retention (ADR-106 §3). */
export async function reconcileRepos(app: FastifyInstance, config: AppConfig): Promise<string> {
  const summary = await pass(
    app,
    config,
    "reconcile.repos",
    candidates,
    refreshRepo,
    (repos, c) =>
      `${repos} repositories checked, ${c.reinvited} re-invited, ${c.accepted} invitations accepted, ${c.heads} heads moved, ${c.renamed} renamed, ${c.deleted} deleted, ${c.protected} protected`,
  );
  const now = app.clock.now();
  return `${summary}; ${await purgeEvidenceFiles(app.db, now)} evidence files purged; ${await purgeCiResults(app.db, now)} CI results purged`;
}

/** The two tasks, in the catalog whether or not the App is configured (the catalog is static): without it they return at once. */
export const RECONCILE_TASKS: readonly ScheduledTask[] = [
  { key: "reconcile.grades", defaultIntervalMinutes: 15, run: reconcileGrades },
  { key: "reconcile.repos", defaultIntervalMinutes: 24 * 60, run: reconcileRepos },
];
