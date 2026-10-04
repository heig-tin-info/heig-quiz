/**
 * What applies a project's deadline (F-PROJ-03, F-PROJ-09, F-PROJ-11,
 * N-PERF-07, N-RES-08; merge task M3-05a, ADR-064), ported from
 * heig-classroom's `ticker.ts` and `deadline.ts` (sync point `ab98cc0`) and
 * reshaped around claims and leases instead of queue singletons (#273). The
 * rules it applies are `deadline.ts`.
 *
 * **The ticker** ({@link PROJECT_TASKS}, every 20 s on the 1-s loop) only
 * claims and enqueues, never calls GitHub (invariant 5), each step a
 * conditional write on the server's clock (`app.clock`), so two processes
 * never both do it and a restart catches up (ADR-006):
 *
 * 1. the scheduled drafts whose start has come are published by
 *    `publishProject`, its guards included: an incomplete group project
 *    stays a draft, silently, until its groups are complete;
 * 2. a project whose deadline has come is `locked`;
 * 3. a repository whose effective deadline has come gets its provisional
 *    freeze (`frozen_grade_run_id` := the current score's run) and
 *    `deadline_applied_at` (audited `project_repo.deadline_applied`);
 * 4. a repository past its effective deadline + the grace is frozen for
 *    good (`frozen_at`, audited `project_repo.frozen`; one archived as its
 *    lock or with its protection suspended is audited
 *    `project_repo.review_skipped`, M3-05b);
 * 5. with a queue only, a project with GitHub work left (`NEEDS_WORK`) has
 *    its LEASE taken (`deadline_job_at`, null or ten minutes old) and one
 *    `project.deadline` job sent;
 * 6. with a queue only, a project with a review dispatch due (a final
 *    review, a checkpoint: `review.ts`, M3-05b) has its OTHER lease taken
 *    (`dispatch_job_at`) and one `project.dispatch` job sent.
 *
 * Steps 3 to 6 cover the repositories that take deadline work (`LIVE`):
 * provisioned, not deleted, of a project not archived. The leases are
 * `lease.ts`'s.
 *
 * **The job** ({@link runDeadlineJob}) settles every repository of its
 * project that needs it, four at a time, each re-reading its row before
 * every step (a reopen, a moved extension, a staff's hand win), renews the
 * lease after each repository, and gives it back once all are settled. A
 * failure backdates the lease so that the next tick, some 30 s on, claims
 * the work again; a crash keeps it until it expires, ten minutes after its
 * last renewal (no queue retry: it would carry a stale lease). Without a
 * queue the tick claims nothing: a job never runs in the ticker's process.
 * A 404 is the repository deleted on GitHub: terminal (`markRepoDeleted`).
 * The `commit` strategy is best effort (N-PERF-07 binds
 * `lock`): one empty commit of the App per handed-out branch, recorded in
 * `bot_commits(deadline)` BEFORE its ref moves; the score never depends on
 * it — the receipt time does (ADR-012).
 */
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { deadlineWantsLock, effectiveDeadline, zonedIso } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { botCommits, classrooms, projectRepos, projects } from "../../db/schema.js";
import { githubApp, githubStatus, ownerRepo } from "../../github/app.js";
import { pushEmptyCommit } from "../../github/commit.js";
import { lockStudentRepo, setRepoArchived, unlockStudentRepo } from "../../github/lock.js";
import { isPlanRestriction } from "../../github/provision.js";
import { PROJECT_DEADLINE_QUEUE, PROJECT_DISPATCH_QUEUE, type JobQueue } from "../../jobs.js";
import type { TickTask } from "../../ticker.js";
import { DomainError } from "../http.js";
import { COMMIT_DUE, EFFECTIVE_DEADLINE, LIVE, NEEDS_WORK, ts } from "./deadline.js";
import { claimLeases, runLeased, type ProjectJob } from "./lease.js";
import { publishProject } from "./lifecycle.js";
import { hintProjectStaff, hintRepo, markRepoDeleted, type RepoRow } from "./repos.js";
import { claimReviewWork, runReviewJob } from "./review.js";
import type { ProjectRow } from "./views.js";

/** How often the ticker looks (N-PERF-07: a deadline starts applying within 60 s). */
export const PROJECT_TICK_MS = 20_000;
/** Steps one repository may take in one job (a lock, then the unlock asked meanwhile, ...). */
const MAX_STEPS = 3;

// ---------------------------------------------------------------- the ticker: claim and enqueue

/**
 * Step 1: the scheduled drafts whose start has come, published by
 * `publishProject` — the ONE publication, its guards included, audited
 * `project.auto_publish` for the system. Its row lock and its refusals are
 * the claim: of two processes, one publishes, the other meets `not_draft`;
 * a group project with a student in no group meets `unassigned_students`
 * and stays a draft, silently, until its groups are complete.
 */
async function publishScheduled(db: Db, now: Date): Promise<string[]> {
  const due = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.state, "draft"),
        eq(projects.publishMode, "scheduled"),
        isNull(projects.archivedAt),
        isNotNull(projects.distributionFullName),
        sql`${projects.startAt} <= ${ts(now)}`,
        sql`${projects.deadlineAt} > ${ts(now)}`,
      ),
    );
  const published: string[] = [];
  for (const { id } of due) {
    try {
      published.push((await publishProject(db, id, now, SYSTEM_ACTOR)).id);
    } catch (err) {
      if (!(err instanceof DomainError)) throw err;
    }
  }
  return published;
}

/** Steps 2 and 3: the projects locked, and the repositories whose effective deadline came given their provisional freeze. */
async function applyDeadlines(db: Db, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = and(
      eq(projects.state, "published"),
      isNull(projects.deadlineAppliedAt),
      isNull(projects.archivedAt),
      sql`${projects.deadlineAt} <= ${ts(now)}`,
    );
    // The rows first, in id order: the order of a group set's write
    // (`followingCopies`), which locks the same rows, so the two never
    // deadlock (ADR-070 §4).
    const ids = (await tx.select({ id: projects.id }).from(projects).where(due).orderBy(asc(projects.id)).for("update")).map((r) => r.id);
    const locked =
      ids.length === 0
        ? []
        : await tx
            .update(projects)
            // The groups stop with the deadline, for good (ADR-070 §4): a reopen
            // never clears it, so a copy stopped once keeps its first stop.
            .set({ state: "locked", deadlineAppliedAt: now, groupsStoppedAt: sql`coalesce(${projects.groupsStoppedAt}, ${ts(now)})` })
            .where(and(inArray(projects.id, ids), due))
            .returning({ id: projects.id, deadlineAt: projects.deadlineAt });
    for (const row of locked) {
      await audit(tx, {
        ...SYSTEM_ACTOR,
        action: "project.deadline_applied",
        subjectType: "project",
        subjectId: row.id,
        payload: { deadlineAt: row.deadlineAt.toISOString() },
      });
    }
    const applied = await tx
      .update(projectRepos)
      .set({ deadlineAppliedAt: now, frozenGradeRunId: sql`${projectRepos.currentGradeRunId}` })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectRepos.projectId),
          LIVE,
          isNull(projectRepos.deadlineAppliedAt),
          sql`${EFFECTIVE_DEADLINE} <= ${ts(now)}`,
        ),
      )
      .returning({ id: projectRepos.id, projectId: projectRepos.projectId, deadlineAt: EFFECTIVE_DEADLINE.mapWith(projects.deadlineAt) });
    await auditRepos(tx, "project_repo.deadline_applied", applied);
    return [...locked.map((r) => r.id), ...applied.map((r) => r.projectId)];
  });
}

/** One audit entry per repository of a step, `payload.deadlineAt` its effective deadline. */
async function auditRepos(
  tx: Tx,
  action: "project_repo.deadline_applied" | "project_repo.frozen",
  rows: { id: string; projectId: string; deadlineAt: Date }[],
): Promise<void> {
  for (const row of rows) {
    await audit(tx, {
      ...SYSTEM_ACTOR,
      action,
      subjectType: "project_repo",
      subjectId: row.id,
      payload: { projectId: row.projectId, deadlineAt: row.deadlineAt.toISOString() },
    });
  }
}

/** Step 4: the definitive freeze of each repository, at its effective deadline + the grace. */
async function freezeDue(db: Db, now: Date): Promise<string[]> {
  return db.transaction(async (tx) => {
    const frozen = await tx
      .update(projectRepos)
      .set({ frozenAt: now })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectRepos.projectId),
          LIVE,
          isNotNull(projectRepos.deadlineAppliedAt),
          isNull(projectRepos.frozenAt),
          sql`${EFFECTIVE_DEADLINE} + make_interval(mins => ${projects.graceMinutes}) <= ${ts(now)}`,
        ),
      )
      .returning({
        id: projectRepos.id,
        projectId: projectRepos.projectId,
        deadlineAt: EFFECTIVE_DEADLINE.mapWith(projects.deadlineAt),
        archivedAt: projectRepos.archivedAt,
        protectionSuspendedAt: projectRepos.protectionSuspendedAt,
        gradingMode: projects.gradingMode,
      });
    await auditRepos(tx, "project_repo.frozen", frozen);
    for (const repo of frozen) {
      if (repo.gradingMode !== "auto") continue;
      if (repo.archivedAt !== null) await auditReviewSkipped(tx, repo, "archived");
      else if (repo.protectionSuspendedAt !== null) await auditReviewSkipped(tx, repo, "protection_suspended");
    }
    return frozen.map((r) => r.projectId);
  });
}

/**
 * `project_repo.review_skipped` (M3-05b): a repository frozen for good gets
 * no final review — archived as its lock (H8; never un-archived for a
 * review), or its protected files no longer restored (F-PROJ-08; its
 * teacher's score settles it). Said at the freeze, or when the archive
 * comes after it.
 */
async function auditReviewSkipped(
  db: Db | Tx,
  repo: { id: string; projectId: string },
  reason: "archived" | "protection_suspended",
): Promise<void> {
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: "project_repo.review_skipped",
    subjectType: "project_repo",
    subjectId: repo.id,
    payload: { projectId: repo.projectId, reason },
  });
}

/**
 * Step 5, and a staff action's request: the lease of every project with
 * GitHub work left (or of `projectId` only), taken when it is free or
 * expired.
 */
function claimDeadlineWork(db: Db, now: Date, projectId?: string): Promise<ProjectJob[]> {
  const work = sql`EXISTS (SELECT 1 FROM ${projectRepos} WHERE ${projectRepos.projectId} = ${projects.id} AND ${LIVE} AND ${NEEDS_WORK})`;
  return claimLeases(db, "deadlineJobAt", now, work, projectId);
}

/**
 * Sends the claimed deadline jobs to the queue, or — without one
 * (`JOBS_DISABLED=1`, a queue down at boot), for a staff action only — runs
 * them here, in the request. The ticker never gets here without a queue
 * ({@link projectTick}).
 */
async function sendDeadlineJobs(app: FastifyInstance, config: AppConfig, jobs: ProjectJob[]): Promise<void> {
  for (const job of jobs) {
    if (app.boss) {
      await app.boss.send(PROJECT_DEADLINE_QUEUE, job);
      continue;
    }
    await runDeadlineJob(app, config, job).catch((err: unknown) =>
      app.log.error({ err, project: job.projectId }, "project deadline job failed"),
    );
  }
}

/**
 * One pass of the ticker over the projects: claims and sends, never a call
 * to GitHub. Without a queue it claims no GitHub work at all — the job
 * would run in the ticker's own process — and leaves the deadline's to a
 * staff action, the reviews' to a process with a queue.
 */
export async function projectTick(app: FastifyInstance, config: AppConfig): Promise<void> {
  // Without Quiz's App there is no project to drive: the task skips, no retry loop.
  if (!githubApp(config)) return;
  const now = app.clock.now();
  const changed = [
    ...(await publishScheduled(app.db, now)),
    ...(await applyDeadlines(app.db, now)),
    ...(await freezeDue(app.db, now)),
  ];
  await hintProjectStaff(app.db, changed);
  if (!app.boss) return;
  await sendDeadlineJobs(app, config, await claimDeadlineWork(app.db, now));
  // The final reviews and the checkpoints due (M3-05b): their own lease, their own queue.
  for (const job of await claimReviewWork(app.db, now)) await app.boss.send(PROJECT_DISPATCH_QUEUE, job);
}

/** The project's deadline work, asked by a staff action: claimed and run unless a job already holds it. */
export async function requestDeadlineWork(app: FastifyInstance, config: AppConfig, projectId: string): Promise<void> {
  await sendDeadlineJobs(app, config, await claimDeadlineWork(app.db, app.clock.now(), projectId));
}

/** The ticker's project task (ADR-006 addendum): clock-bound, neither configurable nor disableable. */
export const PROJECT_TASKS: readonly TickTask[] = [{ name: "project.deadlines", everyMs: PROJECT_TICK_MS, run: projectTick }];

/** The workers of `project.deadline` and `project.dispatch`, registered only with Quiz's App (`app.ts`). */
export async function registerProjectJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(PROJECT_DEADLINE_QUEUE, { retryLimit: 0 });
  await queue.work<ProjectJob>(PROJECT_DEADLINE_QUEUE, (job) => runDeadlineJob(app, config, job));
  await queue.createQueue(PROJECT_DISPATCH_QUEUE, { retryLimit: 0 });
  await queue.work<ProjectJob>(PROJECT_DISPATCH_QUEUE, (job) => runReviewJob(app, config, job));
}

// ---------------------------------------------------------------- the job

/** A repository as one step reads it: the row, its project, and what the rules say of it now. */
interface RepoState {
  repo: RepoRow;
  project: ProjectRow;
  courseId: string;
  wantsLock: boolean;
  commitDue: boolean;
}

async function repoState(db: Db, repoId: string): Promise<RepoState | null> {
  const [row] = await db
    .select({
      repo: projectRepos,
      project: projects,
      courseId: classrooms.courseId,
      commitDue: sql<boolean>`${COMMIT_DUE}`.mapWith(Boolean),
    })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(and(eq(projectRepos.id, repoId), LIVE))
    .limit(1);
  return row ? { ...row, wantsLock: deadlineWantsLock(row.repo, row.project.deadlineStrategy) } : null;
}

type Step = "locked" | "archived" | "unlocked" | "committed";
/** The counts of `project.deadline_enforced`: an archive is a lock (its own audit says it is degraded). */
type Tally = Record<"locked" | "unlocked" | "committed" | "deleted", number>;

/**
 * Locks on GitHub: the deadline's ruleset, or the archive H8 stands for
 * it — where the repository was provisioned without a ruleset (a plan
 * without them), or GitHub refuses one for the plan. Any other failure (a
 * 5xx, a rate limit) throws: the work is claimed again, never archived on it.
 * True when it archived.
 */
async function lockOnGithub(octokit: Octokit, repo: RepoRow): Promise<boolean> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  if (repo.rulesetId !== null) {
    try {
      await lockStudentRepo(octokit, owner, name);
      return false;
    } catch (err) {
      if (!isPlanRestriction(err)) throw err;
    }
  }
  await setRepoArchived(octokit, owner, name, true);
  return true;
}

/** Unlocks on GitHub: un-archived first (an archived repository takes no change), then the ruleset removed. */
async function unlockOnGithub(octokit: Octokit, repo: RepoRow): Promise<void> {
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  if (repo.archivedAt !== null) await setRepoArchived(octokit, owner, name, false);
  try {
    await unlockStudentRepo(octokit, owner, name);
  } catch (err) {
    // A plan without rulesets holds no lock ruleset: nothing more to lift.
    if (!isPlanRestriction(err)) throw err;
  }
}

/**
 * The deadline's empty commit on every handed-out branch of the repository
 * (best effort, F-PROJ-09): a branch whose head already is one for this
 * deadline is left; each commit recorded as `bot_commits(deadline)` before
 * its ref moves. A repository with none of the branches is probed: a 404 is
 * the repository gone.
 */
async function commitOnGithub(db: Db, octokit: Octokit, state: RepoState, now: Date): Promise<void> {
  const { repo, project } = state;
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  const deadline = effectiveDeadline(repo, project);
  let found = false;
  for (const branch of project.branches) {
    const outcome = await pushEmptyCommit({
      octokit,
      org: owner,
      repo: name,
      branch,
      message: `chore(deadline): deadline reached — ${project.name} (${zonedIso(deadline)})`,
      isDone: async (head) => {
        const [mark] = await db
          .select({ sha: botCommits.sha })
          .from(botCommits)
          .where(
            and(
              eq(botCommits.repoId, repo.id),
              eq(botCommits.sha, head),
              eq(botCommits.kind, "deadline"),
              sql`${botCommits.createdAt} >= ${ts(deadline)}`,
            ),
          )
          .limit(1);
        return mark !== undefined;
      },
      beforeMove: async (sha) => {
        await db.insert(botCommits).values({ repoId: repo.id, sha, kind: "deadline", createdAt: now }).onConflictDoNothing();
      },
    });
    if (outcome !== null) found = true;
  }
  if (!found) await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name });
}

/**
 * One repository settled: each step re-reads the row — a reopen, a moved
 * extension, a staff's hand may have landed meanwhile — makes GitHub hold
 * what it should, and records the fact. A lock is written as made whatever
 * changed since: the next step then lifts it if it is no longer wanted.
 */
async function settleRepo(app: FastifyInstance, octokit: Octokit, repoId: string): Promise<Step[]> {
  const db = app.db;
  const steps: Step[] = [];
  for (let n = 0; n < MAX_STEPS; n++) {
    const state = await repoState(db, repoId);
    if (!state) break;
    const { repo, project } = state;
    const now = app.clock.now();
    const locked = repo.lockedAt !== null;
    if (state.wantsLock && !locked) {
      const archived = await lockOnGithub(octokit, repo);
      await db.update(projectRepos).set({ lockedAt: now, archivedAt: archived ? now : null }).where(eq(projectRepos.id, repo.id));
      if (archived) {
        await audit(db, {
          ...SYSTEM_ACTOR,
          action: "project_repo.archived",
          subjectType: "project_repo",
          subjectId: repo.id,
          payload: { projectId: project.id, protected: repo.rulesetId !== null },
        });
        // Archived after its freeze (a staff lock): a final review not asked yet never comes; audited even when it was asked.
        if (repo.frozenAt !== null && project.gradingMode === "auto") await auditReviewSkipped(db, repo, "archived");
      }
      steps.push(archived ? "archived" : "locked");
    } else if (!state.wantsLock && locked) {
      await unlockOnGithub(octokit, repo);
      await db.update(projectRepos).set({ lockedAt: null, archivedAt: null }).where(eq(projectRepos.id, repo.id));
      steps.push("unlocked");
    } else if (state.commitDue) {
      await commitOnGithub(db, octokit, state, now);
      // For this application of the deadline only: a reopen meanwhile leaves it to the next.
      await db
        .update(projectRepos)
        .set({ deadlineCommittedAt: now })
        .where(and(eq(projectRepos.id, repo.id), eq(projectRepos.deadlineAppliedAt, repo.deadlineAppliedAt!)));
      steps.push("committed");
    } else {
      break;
    }
    await hintRepo(db, state);
  }
  return steps;
}

/**
 * The `project.deadline` job, in the leased frame (`runLeased`): every
 * repository of the project with GitHub work left settled, four at a time.
 * A 404 is the repository deleted: terminal, never retried (F-PROJ-18); any
 * other failure fails the job once the others are done.
 */
export async function runDeadlineJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  await runLeased(app, config, "deadlineJobAt", job, "project deadline", async ({ project, octokit, each }) => {
    const repos = await db
      .select({ id: projectRepos.id, fullName: projectRepos.fullName })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(and(eq(projectRepos.projectId, project.id), LIVE, NEEDS_WORK));
    const tally: Tally = { locked: 0, unlocked: 0, committed: 0, deleted: 0 };
    const failed = await each(repos, async (repo) => {
      try {
        for (const step of await settleRepo(app, octokit, repo.id)) tally[step === "archived" ? "locked" : step] += 1;
      } catch (err) {
        if (githubStatus(err) !== 404) throw err;
        if (await markRepoDeleted(db, repo.id, app.clock.now(), "deadline")) tally.deleted += 1;
      }
    });
    // One entry per pass that changed something: a retry that only fails again stays in the log.
    if (Object.values(tally).some((n) => n > 0)) {
      await audit(db, {
        ...SYSTEM_ACTOR,
        action: "project.deadline_enforced",
        subjectType: "project",
        subjectId: project.id,
        payload: { strategy: project.deadlineStrategy, ...tally, failed },
      });
    }
  });
}
