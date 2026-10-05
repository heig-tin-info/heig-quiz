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
 *   catch up) — through `ingestCompletedRun`: a run already known reads and
 *   writes nothing (the UNIQUE of `project_grade_runs`). A reconciled run
 *   has no receipt: late once the deadline passed (GR-14.3).
 * - `reconcile.repos` (daily): a pending invitation of a student's own
 *   repository re-invited at most once a day (`invitation_reinvited_at`,
 *   claimed before GitHub is called) until the repository is frozen, or
 *   found accepted meanwhile; the default branch's head, moved only when it
 *   is a person's — not in `bot_commits`, neither authored nor committed by
 *   a bot: the reconciliation knows no pusher — with its CI state. It writes
 *   no push receipt (the intake's alone, ADR-012) and restores nothing (the
 *   push webhook's). A group's invitations wait for ADR-070's per-member
 *   follow-up (M3-15b); its head and runs are reconciled like any row's.
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
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { isQuiet, reconciles } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { botCommits, classrooms, gradeDispatches, projectGradeRuns, projectRepoAccess, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { failFast, githubApp, githubStatus, installationClient, ownerRepo, rateLimitReset } from "../../github/app.js";
import { forgetRepoLiveState } from "../../github/metrics.js";
import type { ScheduledTask } from "../../ticker.js";
import { projectInstallation, pushedBy } from "../github/service.js";
import { followInvitation, inviteAccount } from "./access.js";
import { LIVE } from "./deadline.js";
import { ProjectError } from "./errors.js";
import { aggregateCiStatus, completedRun, ingestCompletedRun } from "./grading.js";
import { repoMembers } from "./groupRepos.js";
import { followRepoRename, hintRepo, markRepoDeleted, type RepoContext } from "./repos.js";

/** The completed runs read per repository (heig-classroom's figure): the lost webhooks of a quiet half hour fit in far fewer. */
const RUNS_PER_REPO = 20;
/** The least time between two re-invites of one repository's invitation (F-PROJ-07: at most once a day). */
export const REINVITE_INTERVAL_MS = 24 * 3_600_000;

type TaskKey = "reconcile.grades" | "reconcile.repos";

/** What one pass counted: the audit's payload, and the summary's figures. */
interface Counts {
  repos: number;
  runsIngested: number;
  reinvited: number;
  accepted: number;
  heads: number;
  renamed: number;
  deleted: number;
}

/** A repository in scope, as the pass read it, with what the scope rule needs. */
interface Candidate extends RepoContext {
  lastActivityAt: Date | null;
  reviewAsked: boolean;
}

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

/**
 * The live repositories in scope (`reconciles`), the quiet ones only when
 * `quiet`, with their project and course; one read.
 */
async function candidates(db: Db, now: Date, quiet: boolean): Promise<Candidate[]> {
  const lastActivityAt = sql<string | Date | null>`greatest(
    (SELECT max(${pushReceipts.receivedAt}) FROM ${pushReceipts} WHERE ${pushReceipts.githubRepoId} = ${projectRepos.githubRepoId}),
    (SELECT max(${projectGradeRuns.completedAt}) FROM ${projectGradeRuns} WHERE ${projectGradeRuns.repoId} = ${projectRepos.id}))`.mapWith(
    (v: string | Date | null) => (v === null ? null : new Date(v)),
  );
  const reviewAsked = sql<boolean>`EXISTS (SELECT 1 FROM ${gradeDispatches}
    WHERE ${gradeDispatches.repoId} = ${projectRepos.id} AND ${gradeDispatches.trigger} = 'deadline')`.mapWith(Boolean);
  const rows = await db
    .select({ repo: projectRepos, project: projects, courseId: classrooms.courseId, lastActivityAt, reviewAsked })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(LIVE)
    .orderBy(asc(projects.id), asc(projectRepos.id));
  return rows.filter((r) => reconciles(r.repo, r.reviewAsked, now) && (!quiet || isQuiet(r.lastActivityAt, now)));
}

/**
 * The fail-fast client of a project's organization, or null when Quiz's App
 * does not act on it — not installed, suspended, or gone without our
 * hearing of it (GitHub answers the token's request 404 or 403).
 */
async function clientFor(db: Db, config: AppConfig, orgId: string): Promise<Octokit | null> {
  const org = await projectInstallation(db, orgId);
  if (!org) return null;
  try {
    return failFast((await installationClient(config, org.installationId)).octokit);
  } catch (err) {
    const status = githubStatus(err);
    if (status !== 404 && status !== 403) throw err;
    return null;
  }
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
 * One pass: every repository in scope located, then `settle`d, one
 * organization's client at a time; a rate limit stops it, any other failure
 * of a repository is logged. Audited `project.reconciled` when it changed
 * something or stopped; the summary is the task's last message.
 */
async function pass(
  app: FastifyInstance,
  config: AppConfig,
  task: TaskKey,
  quiet: boolean,
  settle: (step: Step) => Promise<void>,
  summary: (counts: Counts) => string,
): Promise<string> {
  if (!githubApp(config)) return "GitHub App not configured";
  const now = app.clock.now();
  const counts: Counts = { repos: 0, runsIngested: 0, reinvited: 0, accepted: 0, heads: 0, renamed: 0, deleted: 0 };
  const clients = new Map<string, Octokit | null>();
  let stopped = false;
  for (const ctx of await candidates(app.db, now, quiet)) {
    let octokit = clients.get(ctx.project.orgId);
    if (octokit === undefined) {
      octokit = await clientFor(app.db, config, ctx.project.orgId);
      clients.set(ctx.project.orgId, octokit);
    }
    if (octokit === null) continue;
    counts.repos += 1;
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
  if (stopped || Object.entries(counts).some(([key, n]) => key !== "repos" && n > 0)) {
    await audit(app.db, {
      ...SYSTEM_ACTOR,
      action: "project.reconciled",
      subjectType: "scheduled_task",
      subjectId: task,
      payload: { ...counts, stoppedOnRateLimit: stopped },
    });
  }
  return summary(counts) + (stopped ? ", stopped on GitHub's rate limit" : "");
}

// ---------------------------------------------------------------- reconcile.grades

/** The last completed runs of the repository through the one ingestion path; a 404 here is no deletion. */
async function ingestRuns({ app, config, octokit, ctx, located, counts, now }: Step): Promise<void> {
  const { owner, repo } = ownerRepo(located.fullName);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs", { owner, repo, status: "completed", per_page: RUNS_PER_REPO });
  let ingested = 0;
  for (const raw of data.workflow_runs) {
    if ((await ingestCompletedRun(app, octokit, ctx, completedRun(config, raw, now))) !== null) ingested += 1;
  }
  if (ingested === 0) return;
  counts.runsIngested += ingested;
  forgetRepoLiveState(located.fullName);
  await hintRepo(app.db, ctx);
}

/** `reconcile.grades`: the runs of the quiet repositories in scope. */
export function reconcileGrades(app: FastifyInstance, config: AppConfig): Promise<string> {
  return pass(app, config, "reconcile.grades", true, ingestRuns, (c) => `${c.repos} quiet repositories checked, ${c.runsIngested} runs ingested`);
}

// ---------------------------------------------------------------- reconcile.repos

/** The day's re-invite claimed on the row: a student's own repository, pending, not frozen, none for a day. */
async function claimReinvite(db: Db, repoId: string, now: Date): Promise<boolean> {
  const claimed = await db
    .update(projectRepos)
    .set({ invitationReinvitedAt: now })
    .where(
      and(
        eq(projectRepos.id, repoId),
        eq(projectRepos.invitationStatus, "pending"),
        isNull(projectRepos.groupId),
        isNull(projectRepos.frozenAt),
        or(isNull(projectRepos.invitationReinvitedAt), lte(projectRepos.invitationReinvitedAt, new Date(now.getTime() - REINVITE_INTERVAL_MS))),
      ),
    )
    .returning({ id: projectRepos.id });
  return claimed.length > 0;
}

/** Whether `login` is a collaborator of the repository today (GitHub's 204; a pending invitation is not one, 404). */
async function isCollaborator(octokit: Octokit, fullName: string, login: string): Promise<boolean> {
  const { owner, repo } = ownerRepo(fullName);
  try {
    await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}", { owner, repo, username: login, request: { retries: 0 } });
    return true;
  } catch (err) {
    if (githubStatus(err) === 404) return false;
    throw err;
  }
}

/**
 * A pending invitation of a student's own repository (F-PROJ-07): re-invited
 * when the day's claim is taken — the student named by the login GitHub
 * knows today for their linked account (`inviteAccount`, as Accept and the
 * staff's resend do; none linked, or gone: skipped, the claim stands) and
 * the row following GitHub's answer; otherwise (frozen, or re-invited within
 * the day) looked for among the collaborators by the login recorded at the
 * invitation, since GitHub sends no event for an invitation accepted late.
 */
async function reconcileInvitation({ app, octokit, ctx, located, counts, now }: Step): Promise<void> {
  const db = app.db;
  const { repo } = ctx;
  if (await claimReinvite(db, repo.id, now)) {
    const [member] = await repoMembers(db, repo, ctx.project.classroomId);
    if (!member?.account) {
      app.log.info({ repo: located.fullName }, "reconcile.repos: a pending invitation with no linked account to re-invite");
      return;
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
      return;
    }
    if (!invited) return;
    counts.reinvited += 1;
    if (invited.invitation === "accepted") counts.accepted += 1;
    await followInvitation(db, repo, invited.invitation);
    await hintRepo(db, ctx);
    return;
  }
  const grants = await db
    .select({ login: projectRepoAccess.githubLogin })
    .from(projectRepoAccess)
    .where(and(eq(projectRepoAccess.repoId, repo.id), isNull(projectRepoAccess.revokedAt)));
  for (const { login } of grants) {
    if (!(await isCollaborator(octokit, located.fullName, login))) continue;
    counts.accepted += 1;
    await followInvitation(db, repo, "accepted");
    await hintRepo(db, ctx);
    return;
  }
}

/**
 * The default branch's head as the student's last commit (F-PROJ-10): moved
 * only when the head is a person's — not recorded as a bot commit, its
 * author and committer named by GitHub and neither Quiz's App nor a
 * workflow — and then its CI state read again. The reconciliation knows no
 * pusher, so a head GitHub attributes to nobody (the App's own commits
 * carry no account) never moves it: no pusher means no head move. No
 * receipt is written: the receipt is the intake's (ADR-012).
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
  const logins = [head.author?.login, head.committer?.login].filter((login): login is string => typeof login === "string");
  if (bot || logins.length === 0 || logins.some((login) => pushedBy(config, login) !== "person")) return;
  const date = head.commit.committer?.date ?? head.commit.author?.date;
  const at = date ? new Date(date) : now;
  await db
    .update(projectRepos)
    .set({ lastCommitSha: head.sha, lastCommitAt: Number.isNaN(at.getTime()) ? now : at })
    .where(eq(projectRepos.id, ctx.repo.id));
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

/** A repository's daily refresh: its invitation, then its head. */
async function refreshRepo(step: Step): Promise<void> {
  if (step.ctx.repo.groupId === null && step.ctx.repo.invitationStatus === "pending") await reconcileInvitation(step);
  await refreshHead(step);
}

/** `reconcile.repos`: every repository in scope, quiet or not. */
export function reconcileRepos(app: FastifyInstance, config: AppConfig): Promise<string> {
  return pass(
    app,
    config,
    "reconcile.repos",
    false,
    refreshRepo,
    (c) =>
      `${c.repos} repositories checked, ${c.reinvited} re-invited, ${c.accepted} invitations accepted, ${c.heads} heads moved, ${c.renamed} renamed, ${c.deleted} deleted`,
  );
}

/** The two tasks, in the catalog whether or not the App is configured (the catalog is static): without it they return at once. */
export const RECONCILE_TASKS: readonly ScheduledTask[] = [
  { key: "reconcile.grades", defaultIntervalMinutes: 15, run: reconcileGrades },
  { key: "reconcile.repos", defaultIntervalMinutes: 24 * 60, run: reconcileRepos },
];
