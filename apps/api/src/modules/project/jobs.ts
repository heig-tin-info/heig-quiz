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
 *    good (`frozen_at`, audited `project_repo.frozen`);
 * 5. with a queue only, a project with GitHub work left (`NEEDS_WORK`) has
 *    its LEASE taken (`deadline_job_at`, null or ten minutes old) and one
 *    `project.deadline` job sent.
 *
 * Steps 3 to 5 cover the repositories that take deadline work (`LIVE`):
 * provisioned, not deleted, of a project not archived.
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
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { deadlineWantsLock, effectiveDeadline, zonedIso } from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { botCommits, classrooms, projectRepos, projects } from "../../db/schema.js";
import { githubApp, githubStatus, installationClient, ownerRepo } from "../../github/app.js";
import { pushEmptyCommit } from "../../github/commit.js";
import { lockStudentRepo, setRepoArchived, unlockStudentRepo } from "../../github/lock.js";
import { isPlanRestriction } from "../../github/provision.js";
import { PROJECT_DEADLINE_QUEUE, type JobQueue } from "../../jobs.js";
import type { TickTask } from "../../ticker.js";
import { projectInstallation } from "../github/service.js";
import { DomainError } from "../http.js";
import { COMMIT_DUE, EFFECTIVE_DEADLINE, LIVE, NEEDS_WORK, ts } from "./deadline.js";
import { projectsChanged } from "./events.js";
import { publishProject } from "./lifecycle.js";
import { hintRepo, markRepoDeleted, type RepoRow } from "./repos.js";
import type { ProjectRow } from "./views.js";

/** How often the ticker looks (N-PERF-07: a deadline starts applying within 60 s). */
export const PROJECT_TICK_MS = 20_000;
/** A lease older than this was left by a job that crashed or gave up: the work is claimed again. */
export const DEADLINE_LEASE_MS = 10 * 60_000;
/** A job that failed leaves its work to be claimed again this soon (N-PERF-07: 100 repositories in 5 minutes). */
export const FAILED_RETRY_MS = 30_000;
/** Repositories a job settles at once: GitHub's secondary limits frown on more parallel writes. */
const REPO_CONCURRENCY = 4;
/** Steps one repository may take in one job (a lock, then the unlock asked meanwhile, ...). */
const MAX_STEPS = 3;

// ---------------------------------------------------------------- the ticker: claim and enqueue

/** One project's deadline work, as the queue carries it: the lease it was claimed under. */
export interface DeadlineJob {
  projectId: string;
  /** `projects.deadline_job_at` as the claim set it (ISO). */
  lease: string;
}

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
    const locked = await tx
      .update(projects)
      .set({ state: "locked", deadlineAppliedAt: now })
      .where(
        and(
          eq(projects.state, "published"),
          isNull(projects.deadlineAppliedAt),
          isNull(projects.archivedAt),
          sql`${projects.deadlineAt} <= ${ts(now)}`,
        ),
      )
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
      .returning({ id: projectRepos.id, projectId: projectRepos.projectId, deadlineAt: EFFECTIVE_DEADLINE.mapWith(projects.deadlineAt) });
    await auditRepos(tx, "project_repo.frozen", frozen);
    return frozen.map((r) => r.projectId);
  });
}

/**
 * Step 5, and a staff action's request: the lease of every project with
 * GitHub work left (or of `projectId` only), taken when it is free or
 * expired. One conditional UPDATE: two claimers never both get it.
 */
async function claimDeadlineWork(db: Db, now: Date, projectId?: string): Promise<DeadlineJob[]> {
  const rows = await db
    .update(projects)
    .set({ deadlineJobAt: now })
    .where(
      and(
        projectId === undefined ? undefined : eq(projects.id, projectId),
        or(isNull(projects.deadlineJobAt), lt(projects.deadlineJobAt, new Date(now.getTime() - DEADLINE_LEASE_MS))),
        sql`EXISTS (SELECT 1 FROM ${projectRepos} WHERE ${projectRepos.projectId} = ${projects.id} AND ${LIVE} AND ${NEEDS_WORK})`,
      ),
    )
    .returning({ projectId: projects.id, lease: projects.deadlineJobAt });
  return rows.map((r) => ({ projectId: r.projectId, lease: r.lease!.toISOString() }));
}

/**
 * Sends the claimed jobs to the queue, or — without one (`JOBS_DISABLED=1`,
 * a queue down at boot), for a staff action only — runs them here, in the
 * request. The ticker never gets here without a queue ({@link projectTick}).
 */
async function dispatch(app: FastifyInstance, config: AppConfig, jobs: DeadlineJob[]): Promise<void> {
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

/** The staff of the projects `ids` hear of them (course topics only). */
async function hintStaff(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .selectDistinct({ courseId: classrooms.courseId })
    .from(projects)
    .innerJoin(classrooms, eq(classrooms.id, projects.classroomId))
    .where(inArray(projects.id, [...new Set(ids)]));
  projectsChanged(rows.map((r) => r.courseId));
}

/**
 * One pass of the ticker over the projects: claims and sends, never a call
 * to GitHub. Without a queue it claims no GitHub work at all — the job
 * would run in the ticker's own process — and leaves it to a staff action
 * or to a process with a queue.
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
  await hintStaff(app.db, changed);
  if (app.boss) await dispatch(app, config, await claimDeadlineWork(app.db, now));
}

/** The project's deadline work, asked by a staff action: claimed and run unless a job already holds it. */
export async function requestDeadlineWork(app: FastifyInstance, config: AppConfig, projectId: string): Promise<void> {
  await dispatch(app, config, await claimDeadlineWork(app.db, app.clock.now(), projectId));
}

/** The ticker's project task (ADR-006 addendum): clock-bound, neither configurable nor disableable. */
export const PROJECT_TASKS: readonly TickTask[] = [{ name: "project.deadlines", everyMs: PROJECT_TICK_MS, run: projectTick }];

/** The worker of `project.deadline`, registered only with Quiz's App (`app.ts`). */
export async function registerProjectJobs(app: FastifyInstance, queue: JobQueue, config: AppConfig): Promise<void> {
  await queue.createQueue(PROJECT_DEADLINE_QUEUE, { retryLimit: 0 });
  await queue.work<DeadlineJob>(PROJECT_DEADLINE_QUEUE, (job) => runDeadlineJob(app, config, job));
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

/** `items` through `run`, `limit` at a time. */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
  stopped: () => boolean,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The lease a job holds, renewed after each repository it settles — so a
 * long job is never taken over while it works — one renewal at a time.
 * Lost when a renewal finds the row holding another lease: another job
 * took the work over (this one outlived its lease), and this one stops.
 */
function heldLease(app: FastifyInstance, projectId: string, lease: Date) {
  let held = lease;
  let lost = false;
  let queue: Promise<void> = Promise.resolve();
  const whileHeld = (write: (held: Date) => Promise<unknown[]>, next: () => Date | null) =>
    (queue = queue.then(async () => {
      if (lost) return;
      const rows = await write(held);
      if (rows.length === 0) lost = true;
      else held = next() ?? held;
    }));
  const owned = (at: Date) => and(eq(projects.id, projectId), eq(projects.deadlineJobAt, at));
  return {
    lost: () => lost,
    renew: () => {
      const now = app.clock.now();
      return whileHeld(
        (at) => app.db.update(projects).set({ deadlineJobAt: now }).where(owned(at)).returning({ id: projects.id }),
        () => now,
      );
    },
    release: () =>
      whileHeld(
        (at) => app.db.update(projects).set({ deadlineJobAt: null }).where(owned(at)).returning({ id: projects.id }),
        () => null,
      ),
    /**
     * After a failure: the lease kept but backdated, so that it expires
     * {@link FAILED_RETRY_MS} from now and the next tick claims the work
     * again — within N-PERF-07's five minutes, not ten.
     */
    expireSoon: () => {
      const at = new Date(app.clock.now().getTime() - DEADLINE_LEASE_MS + FAILED_RETRY_MS);
      return whileHeld(
        (held) => app.db.update(projects).set({ deadlineJobAt: at }).where(owned(held)).returning({ id: projects.id }),
        () => at,
      );
    },
  };
}

/**
 * The `project.deadline` job: every repository of the project with GitHub
 * work left settled, the lease renewed after each, then given back.
 * Nothing when the lease is no longer the job's (given back, or taken over
 * after it expired), and it stops as soon as a renewal finds it taken
 * over. Without the App on the organization it waits, the lease kept, for
 * the sweep ten minutes on — no retry loop. A repository that fails throws
 * once the others are done: the lease is backdated, and the next tick resumes.
 */
export async function runDeadlineJob(app: FastifyInstance, config: AppConfig, job: DeadlineJob): Promise<void> {
  const db = app.db;
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!project || project.deadlineJobAt?.toISOString() !== job.lease) return;
  const org = await projectInstallation(db, project.orgId);
  if (!org) return;
  const { octokit } = await installationClient(config, org.installationId);
  const repos = await db
    .select({ id: projectRepos.id, fullName: projectRepos.fullName })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepos.projectId, project.id), LIVE, NEEDS_WORK));

  const lease = heldLease(app, project.id, project.deadlineJobAt);
  const tally: Tally = { locked: 0, unlocked: 0, committed: 0, deleted: 0 };
  const failed: string[] = [];
  const settle = async (repo: (typeof repos)[number]) => {
    try {
      for (const step of await settleRepo(app, octokit, repo.id)) tally[step === "archived" ? "locked" : step] += 1;
    } catch (err) {
      if (githubStatus(err) === 404) {
        // Gone from GitHub: terminal, never retried (F-PROJ-18).
        if (await markRepoDeleted(db, repo.id, app.clock.now(), "deadline")) tally.deleted += 1;
      } else {
        app.log.error({ err, repo: repo.fullName }, "project deadline: a repository failed");
        failed.push(repo.fullName!);
      }
    }
    await lease.renew();
  };
  await forEachLimit(repos, REPO_CONCURRENCY, settle, lease.lost);
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
  if (lease.lost()) return; // the job that took over finishes the work
  if (failed.length > 0) {
    await lease.expireSoon();
    throw new Error(`project deadline incomplete: ${failed.join(", ")}`);
  }
  await lease.release();
}
