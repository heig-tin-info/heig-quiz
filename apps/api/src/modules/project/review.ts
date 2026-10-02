/**
 * The review dispatches of a project (F-PROJ-11, D17; merge task M3-05b,
 * ADR-064 addendum), ported from heig-classroom's `dispatch.ts` and the
 * dispatch duties of its `ticker.ts` (sync point `ab98cc0`), on the claims
 * and leases of `jobs.ts` instead of queue singletons.
 *
 * - **The final review**: once a repository's freeze is definitive (ITS
 *   `frozen_at`, at its effective deadline + the grace), one
 *   `repository_dispatch` `grade-final` carrying the frozen run's commit and
 *   the repository's EFFECTIVE deadline. Its `grading.yml` runs the LLM
 *   review on the organization's key, whose run comes back through the
 *   ordinary ingestion (`grading.ts`) and fills the review slot — only when
 *   Quiz's App triggered it. Never for a project graded `none`, a
 *   repository without a frozen run (nothing to review), nor one archived
 *   as its lock (H8: skipped without a ledger row, audited degraded,
 *   never un-archived for a review). Dispatched even when the
 *   organization's `ANTHROPIC_API_KEY` is missing (F-GH-03 warns only).
 * - **A review checkpoint**: at its date, while it lies before the
 *   project's deadline (a checkpoint left behind by a deadline moved
 *   earlier is void and never fires), one `grade-milestone` dispatch to
 *   every live repository whose deadline has not come yet (one with a later
 *   own deadline included), on the last commit received before the date
 *   that no bot pushed. Never for the score.
 *
 * **At most once** (product owner, 2026-10-02): every dispatch is claimed in
 * the `grade_dispatches` ledger (`ON CONFLICT DO NOTHING`, the sha it sends
 * recorded) BEFORE GitHub is called, in a transaction that re-reads the
 * repository under its row lock — a reopen landing meanwhile wins. A ledger
 * row is never sent again: one left without `dispatched_at` (a crash between
 * the claim and the call, or an answer that never came) shows as "not
 * confirmed" to the staff (M3-08). Only an error GitHub answered gives the
 * claim back, for the next pass; a 404 is the repository deleted, terminal.
 *
 * **The tick claims, the job acts** (invariant 5): {@link claimReviewWork}
 * takes `projects.dispatch_job_at` — a lease of its own, so a deadline's
 * locks never wait for a review — of each project with a dispatch due, and
 * the ticker sends `project.dispatch`; {@link runReviewJob} works under that
 * lease as the deadline job does (renewed, backdated on a failure, given
 * back), four repositories at a time.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Octokit } from "octokit";

import {
  effectiveDeadline,
  planCheckpointReviewDispatch,
  planFinalReviewDispatch,
  type CheckpointReviewDispatch,
  type FinalReviewDispatch,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { gradeDispatches, projectCheckpoints, projectGradeRuns, projectRepos, projects, pushReceipts } from "../../db/schema.js";
import { githubStatus, installationClient, ownerRepo } from "../../github/app.js";
import { projectInstallation } from "../github/service.js";
import { LIVE, ts } from "./deadline.js";
import { claimLeases, forEachLimit, heldLease, REPO_CONCURRENCY, type ProjectJob } from "./lease.js";
import { hintProjectStaff, markRepoDeleted } from "./repos.js";

// ---------------------------------------------------------------- what is due, in SQL

/** A project that reviews: graded `auto`, not archived. Over `projects`. */
const REVIEWS = sql`(${projects.gradingMode} = 'auto' AND ${projects.archivedAt} IS NULL)`;

/**
 * A repository's final review is due: live, frozen for good with a frozen
 * run, not archived as its lock, and no `deadline` row in the ledger. Over a
 * `project_repos` row joined to its project.
 */
const FINAL_REVIEW_DUE = and(
  LIVE,
  REVIEWS,
  isNotNull(projectRepos.frozenAt),
  isNotNull(projectRepos.frozenGradeRunId),
  isNull(projectRepos.archivedAt),
  sql`NOT EXISTS (SELECT 1 FROM ${gradeDispatches} WHERE ${gradeDispatches.repoId} = ${projectRepos.id} AND ${gradeDispatches.trigger} = 'deadline')`,
)!;

/**
 * A checkpoint fires: its date has come, it is not dispatched, and it lies
 * before its project's deadline (else it is void), on a published or
 * locked project that reviews. Over a `project_checkpoints` row joined to
 * its project.
 */
const checkpointDue = (now: Date): SQL =>
  sql`(${projectCheckpoints.dispatchedAt} IS NULL AND ${projectCheckpoints.dueAt} <= ${ts(now)}
    AND ${projectCheckpoints.dueAt} < ${projects.deadlineAt} AND ${projects.state} <> 'draft' AND ${REVIEWS})`;

/**
 * The ticker's claim (no HTTP): the dispatch lease of every project with a
 * final review or a checkpoint due, taken when free or expired.
 */
export function claimReviewWork(db: Db, now: Date): Promise<ProjectJob[]> {
  const work = sql`(EXISTS (SELECT 1 FROM ${projectRepos} WHERE ${projectRepos.projectId} = ${projects.id} AND ${FINAL_REVIEW_DUE})
    OR EXISTS (SELECT 1 FROM ${projectCheckpoints} WHERE ${projectCheckpoints.projectId} = ${projects.id} AND ${checkpointDue(now)}))`;
  return claimLeases(db, "dispatchJobAt", now, work);
}

/** `project_repo.review_skipped`: repositories archived as their lock (H8), which get no final review. */
export async function auditReviewSkipped(db: Db | Tx, repos: readonly { id: string; projectId: string }[]): Promise<void> {
  for (const repo of repos) {
    await audit(db, {
      ...SYSTEM_ACTOR,
      action: "project_repo.review_skipped",
      subjectType: "project_repo",
      subjectId: repo.id,
      payload: { projectId: repo.projectId, reason: "archived" },
    });
  }
}

// ---------------------------------------------------------------- one dispatch

/** A dispatch claimed in the ledger, to send. */
interface Claim {
  dispatchId: string;
  repoId: string;
  fullName: string;
  plan: FinalReviewDispatch | CheckpointReviewDispatch;
}

/** What became of one repository's dispatch. */
type Outcome = "dispatched" | "deleted" | "unconfirmed" | "failed" | "none";

/** The ledger row claimed — or null when it already exists, whatever its state: at most once. */
async function claimDispatch(
  tx: Tx,
  repoId: string,
  plan: FinalReviewDispatch | CheckpointReviewDispatch,
  checkpointId: string | null,
  now: Date,
): Promise<string | null> {
  const [row] = await tx
    .insert(gradeDispatches)
    .values({
      id: randomUUID(),
      repoId,
      trigger: checkpointId === null ? "deadline" : "checkpoint",
      checkpointId,
      sha: plan.sha,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: gradeDispatches.id });
  return row?.id ?? null;
}

/**
 * The claimed dispatch sent. Accepted: `dispatched_at`. GitHub answered an
 * error: the claim given back for the next pass, or, a 404, the repository
 * marked deleted. No answer (a timeout, a connection reset): it may have
 * been accepted, so the row stays unconfirmed, never sent again.
 */
async function send(app: FastifyInstance, octokit: Octokit, claim: Claim): Promise<Outcome> {
  const db = app.db;
  const { owner, repo } = ownerRepo(claim.fullName);
  try {
    await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
      owner,
      repo,
      event_type: claim.plan.eventType,
      client_payload: claim.plan.clientPayload,
      // At most once: Octokit's retry plugin would send it again after a 5xx GitHub may have acted on.
      request: { retries: 0 },
    });
  } catch (err) {
    // Octokit gives a request that got no response a status 500 too: only `response` tells GitHub answered.
    if ((err as { response?: unknown } | null)?.response === undefined) {
      app.log.error({ err, repo: claim.fullName }, "review dispatch: no answer from GitHub, left unconfirmed");
      return "unconfirmed";
    }
    await db.delete(gradeDispatches).where(eq(gradeDispatches.id, claim.dispatchId));
    if (githubStatus(err) === 404) {
      // Gone from GitHub: terminal, never retried (F-PROJ-18).
      await markRepoDeleted(db, claim.repoId, app.clock.now(), "dispatch");
      return "deleted";
    }
    app.log.error({ err, repo: claim.fullName }, "review dispatch: GitHub refused it");
    return "failed";
  }
  await db.update(gradeDispatches).set({ dispatchedAt: app.clock.now() }).where(eq(gradeDispatches.id, claim.dispatchId));
  return "dispatched";
}

/**
 * The project's row read under a share lock, then the repository's under
 * an update lock (the order every writer of both takes), and the
 * repository's row as it now stands: whatever moved since the job's list was
 * read — a reopen, an extension, a deletion — is seen here.
 */
async function lockedRepo(tx: Tx, projectId: string, repoId: string) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("share");
  const [row] = await tx
    .select({ repo: projectRepos, frozenSha: projectGradeRuns.headSha })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .leftJoin(projectGradeRuns, eq(projectGradeRuns.id, projectRepos.frozenGradeRunId))
    .where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, projectId), LIVE, REVIEWS))
    .for("update", { of: projectRepos });
  return project && row ? { project, ...row } : null;
}

/** One repository's final review: re-read, claimed, sent. */
async function dispatchFinal(app: FastifyInstance, octokit: Octokit, projectId: string, repoId: string): Promise<Outcome> {
  const now = app.clock.now();
  const claim = await app.db.transaction(async (tx): Promise<Claim | null> => {
    const found = await lockedRepo(tx, projectId, repoId);
    if (!found || found.repo.frozenAt === null) return null; // reopened, deleted, or no longer reviewed
    const { project, repo } = found;
    if (repo.archivedAt !== null) {
      await auditReviewSkipped(tx, [repo]);
      return null;
    }
    const plan = planFinalReviewDispatch({ id: project.id, deadlineAt: effectiveDeadline(repo, project) }, found.frozenSha);
    if (!plan) return null;
    const dispatchId = await claimDispatch(tx, repo.id, plan, null, now);
    return dispatchId === null ? null : { dispatchId, repoId: repo.id, fullName: repo.fullName!, plan };
  });
  return claim ? send(app, octokit, claim) : "none";
}

type CheckpointRow = typeof projectCheckpoints.$inferSelect;

/**
 * The commit a checkpoint reviews: the last push received on a handed-out
 * branch at or before its date that no bot made (`is_bot` false: neither
 * the App's nor a workflow's) — the server's receipt, as for the freeze.
 */
async function checkpointSha(tx: Tx, githubRepoId: number, branches: string[], before: Date): Promise<string | null> {
  const [row] = await tx
    .select({ sha: pushReceipts.headSha })
    .from(pushReceipts)
    .where(
      and(
        eq(pushReceipts.githubRepoId, githubRepoId),
        eq(pushReceipts.isBot, false),
        inArray(pushReceipts.branch, branches),
        lte(pushReceipts.receivedAt, before),
      ),
    )
    .orderBy(desc(pushReceipts.receivedAt))
    .limit(1);
  return row?.sha ?? null;
}

/**
 * One repository's dispatch of a checkpoint: the checkpoint re-read under
 * a share lock (its deletion waits, or wins), still due and not void; the
 * repository still before its deadline — a repository frozen, even
 * provisionally, has its final review coming, and a checkpoint's run
 * arriving after the freeze must never be taken for it.
 */
async function dispatchCheckpoint(
  app: FastifyInstance,
  octokit: Octokit,
  projectId: string,
  checkpointId: string,
  repoId: string,
): Promise<Outcome> {
  const now = app.clock.now();
  const claim = await app.db.transaction(async (tx): Promise<Claim | null> => {
    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("share");
    const [checkpoint] = await tx
      .select({ checkpoint: projectCheckpoints })
      .from(projectCheckpoints)
      .innerJoin(projects, eq(projects.id, projectCheckpoints.projectId))
      .where(and(eq(projectCheckpoints.id, checkpointId), checkpointDue(now)))
      .for("share", { of: projectCheckpoints });
    if (!project || !checkpoint) return null;
    const found = await lockedRepo(tx, projectId, repoId);
    if (!found || found.repo.deadlineAppliedAt !== null) return null;
    const { repo } = found;
    const sha = await checkpointSha(tx, repo.githubRepoId!, project.branches, checkpoint.checkpoint.dueAt);
    const plan = planCheckpointReviewDispatch(project.id, checkpoint.checkpoint, sha);
    if (!plan) return null;
    const dispatchId = await claimDispatch(tx, repo.id, plan, checkpointId, now);
    return dispatchId === null ? null : { dispatchId, repoId: repo.id, fullName: repo.fullName!, plan };
  });
  return claim ? send(app, octokit, claim) : "none";
}

// ---------------------------------------------------------------- the job

/** The counts of a pass, and the repositories GitHub refused. */
interface Tally {
  dispatched: number;
  deleted: number;
  unconfirmed: number;
  failed: string[];
}
const newTally = (): Tally => ({ dispatched: 0, deleted: 0, unconfirmed: 0, failed: [] });
const changed = (t: Tally) => t.dispatched + t.deleted + t.unconfirmed > 0;

/**
 * `repos` through `dispatchOne`, four at a time, the lease renewed after
 * each; a throw (the database, never GitHub's answer) counts as failed.
 */
async function dispatchAll(
  app: FastifyInstance,
  lease: ReturnType<typeof heldLease>,
  repos: readonly { id: string; fullName: string | null }[],
  dispatchOne: (repoId: string) => Promise<Outcome>,
): Promise<Tally> {
  const tally = newTally();
  await forEachLimit(
    repos,
    REPO_CONCURRENCY,
    async (repo) => {
      let outcome: Outcome;
      try {
        outcome = await dispatchOne(repo.id);
      } catch (err) {
        app.log.error({ err, repo: repo.fullName }, "review dispatch: a repository failed");
        outcome = "failed";
      }
      if (outcome === "failed") tally.failed.push(repo.fullName!);
      else if (outcome !== "none") tally[outcome] += 1;
      await lease.renew();
    },
    lease.lost,
  );
  return tally;
}

/**
 * The `project.dispatch` job: the final review of every repository whose
 * freeze is definitive, then each checkpoint due, under the dispatch lease
 * (renewed after each repository, given back once all is done). Nothing
 * when the lease is no longer the job's; it stops as soon as a renewal
 * finds it taken over. Without the App on the organization it waits, the
 * lease kept, for the sweep ten minutes on. A repository GitHub refused
 * throws once the others are done: its claim was given back, the lease is
 * backdated, and the next tick resumes. A checkpoint is marked dispatched
 * once a pass met no refusal for it.
 */
export async function runReviewJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  const [project] = await db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!project || project.dispatchJobAt?.toISOString() !== job.lease) return;
  const lease = heldLease(app, "dispatchJobAt", project.id, project.dispatchJobAt);
  const org = await projectInstallation(db, project.orgId);
  if (!org) return;
  const { octokit } = await installationClient(config, org.installationId);
  const failed: string[] = [];

  const finals = await db
    .select({ id: projectRepos.id, fullName: projectRepos.fullName })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepos.projectId, project.id), FINAL_REVIEW_DUE));
  const final = await dispatchAll(app, lease, finals, (repoId) => dispatchFinal(app, octokit, project.id, repoId));
  failed.push(...final.failed);
  if (changed(final)) {
    await audit(db, { ...SYSTEM_ACTOR, action: "project.review_dispatched", subjectType: "project", subjectId: project.id, payload: { ...final } });
  }

  const checkpoints: CheckpointRow[] = (
    await db
      .select({ checkpoint: projectCheckpoints })
      .from(projectCheckpoints)
      .innerJoin(projects, eq(projects.id, projectCheckpoints.projectId))
      .where(and(eq(projectCheckpoints.projectId, project.id), checkpointDue(app.clock.now())))
  ).map((r) => r.checkpoint);
  const open = await db
    .select({ id: projectRepos.id, fullName: projectRepos.fullName })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(and(eq(projectRepos.projectId, project.id), LIVE, isNull(projectRepos.deadlineAppliedAt)));
  for (const checkpoint of checkpoints) {
    if (lease.lost()) break;
    const tally = await dispatchAll(app, lease, open, (repoId) => dispatchCheckpoint(app, octokit, project.id, checkpoint.id, repoId));
    failed.push(...tally.failed);
    if (changed(tally)) {
      await audit(db, {
        ...SYSTEM_ACTOR,
        action: "project.checkpoint_dispatched",
        subjectType: "project",
        subjectId: project.id,
        payload: { checkpointId: checkpoint.id, name: checkpoint.name, ...tally },
      });
    }
    if (tally.failed.length === 0 && !lease.lost()) {
      await db
        .update(projectCheckpoints)
        .set({ dispatchedAt: app.clock.now() })
        .where(and(eq(projectCheckpoints.id, checkpoint.id), isNull(projectCheckpoints.dispatchedAt)));
    }
  }

  await hintProjectStaff(db, [project.id]);
  if (lease.lost()) return; // the job that took over finishes the work
  if (failed.length > 0) {
    await lease.expireSoon();
    throw new Error(`review dispatch incomplete: ${failed.join(", ")}`);
  }
  await lease.release();
}
