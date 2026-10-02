/**
 * The review dispatches of a project (F-PROJ-11, D17; merge task M3-05b,
 * ADR-064 addendum), ported from heig-classroom's `dispatch.ts` and the
 * dispatch duties of its `ticker.ts` (sync point `ab98cc0`), on the claims
 * and leases of `lease.ts` instead of queue singletons.
 *
 * - **The final review**: once a repository's freeze is definitive (ITS
 *   `frozen_at`, at its effective deadline + the grace), one
 *   `repository_dispatch` `grade-final` carrying the frozen run's commit and
 *   the repository's EFFECTIVE deadline. Its `grading.yml` runs the LLM
 *   review on the organization's key, whose run comes back through the
 *   ordinary ingestion (`grading.ts`) and fills the review slot — only when
 *   Quiz's App triggered it, after this dispatch. Never for a project graded
 *   `none`, a repository without a frozen run (nothing to review), one
 *   archived as its lock (H8; never un-archived for a review) nor one whose
 *   protected files are no longer restored (F-PROJ-08; the teacher's score
 *   settles it) — both audited `project_repo.review_skipped` by `jobs.ts`.
 *   Dispatched even when the organization's `ANTHROPIC_API_KEY` is missing
 *   (F-GH-03 warns only).
 * - **A review checkpoint**: at its date, while it lies before the
 *   project's deadline (a checkpoint left behind by a deadline moved
 *   earlier is void and never fires, `checkpointFires`), one
 *   `grade-milestone` dispatch to every live repository whose deadline has
 *   not come yet ({@link CHECKPOINT_TARGET}; one with a later own deadline
 *   included), on the last commit received before the date that no bot
 *   pushed. Never for the score.
 *
 * **At most once** (product owner, 2026-10-02): every dispatch is claimed in
 * the `grade_dispatches` ledger (`ON CONFLICT DO NOTHING`, the sha it sends
 * recorded) BEFORE GitHub is called, in a transaction that re-reads the
 * repository under its row lock — a reopen landing meanwhile wins. A ledger
 * row is never sent again: one left without `dispatched_at` — a crash
 * between the claim and the call, no answer, or a 5xx GitHub may have acted
 * on — shows as "not confirmed" to the staff (M3-08). Only a 4xx gives the
 * claim back, for the next pass; a 404 is the repository deleted, terminal.
 *
 * **The tick claims, the job acts** (invariant 5): {@link claimReviewWork}
 * takes `projects.dispatch_job_at` — a lease of its own, so a deadline's
 * locks never wait for a review — of each project with a dispatch due, and
 * the ticker sends `project.dispatch`; {@link runReviewJob} works in the
 * leased frame (`runLeased`), four repositories at a time.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import type { Octokit } from "octokit";

import {
  checkpointFires,
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
import { githubStatus, ownerRepo } from "../../github/app.js";
import { LIVE, ts } from "./deadline.js";
import { claimLeases, runLeased, type LeasedRun, type ProjectJob } from "./lease.js";
import { hintProjectStaff, markRepoDeleted } from "./repos.js";

// ---------------------------------------------------------------- what is due, in SQL

/** A project that reviews: graded `auto`, not archived. Over `projects`. */
const REVIEWS = sql`(${projects.gradingMode} = 'auto' AND ${projects.archivedAt} IS NULL)`;

/**
 * A repository's final review is due: live, frozen for good with a frozen
 * run, neither archived as its lock nor with its protection suspended, and
 * no `deadline` row in the ledger. Over a `project_repos` row joined to its
 * project.
 */
const FINAL_REVIEW_DUE = and(
  LIVE,
  REVIEWS,
  isNotNull(projectRepos.frozenAt),
  isNotNull(projectRepos.frozenGradeRunId),
  isNull(projectRepos.archivedAt),
  isNull(projectRepos.protectionSuspendedAt),
  sql`NOT EXISTS (SELECT 1 FROM ${gradeDispatches} WHERE ${gradeDispatches.repoId} = ${projectRepos.id} AND ${gradeDispatches.trigger} = 'deadline')`,
)!;

/**
 * A repository a checkpoint goes to: live, and its deadline not applied —
 * a repository frozen even provisionally has its final review coming, and
 * a checkpoint's run must never arrive in its freeze. Over a
 * `project_repos` row joined to its project.
 */
const CHECKPOINT_TARGET = and(LIVE, isNull(projectRepos.deadlineAppliedAt))!;

/**
 * The tick's filter of a checkpoint that fires (`checkpointFires` of
 * `@quiz/domain` is the rule; this its SQL twin, for the claim only). Over
 * a `project_checkpoints` row joined to its project.
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

// ---------------------------------------------------------------- one dispatch

type Plan = FinalReviewDispatch | CheckpointReviewDispatch;

/** A dispatch claimed in the ledger, to send. */
interface Claim {
  dispatchId: string;
  repoId: string;
  fullName: string;
  plan: Plan;
}

/** What became of one repository's dispatch ("failed" is thrown, for the frame to count). */
type Outcome = "dispatched" | "deleted" | "unconfirmed" | "none";

/** The ledger row claimed — or null when it already exists, whatever its state: at most once. */
async function claimDispatch(tx: Tx, repoId: string, plan: Plan, checkpointId: string | null, now: Date): Promise<string | null> {
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
 * The claimed dispatch sent. Accepted: `dispatched_at`. A 4xx: GitHub did
 * not take it — the claim given back for the next pass (thrown), or, a
 * 404, the repository marked deleted. No response, or a 5xx GitHub may
 * have acted on: the row stays unconfirmed, never sent again.
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
    const answered = (err as { response?: unknown } | null)?.response !== undefined;
    const status = githubStatus(err) ?? 500;
    if (!answered || status >= 500) {
      app.log.error({ err, repo: claim.fullName }, "review dispatch: not confirmed, never sent again");
      return "unconfirmed";
    }
    await db.delete(gradeDispatches).where(eq(gradeDispatches.id, claim.dispatchId));
    if (status !== 404) throw err;
    // Gone from GitHub: terminal, never retried (F-PROJ-18).
    await markRepoDeleted(db, claim.repoId, app.clock.now(), "dispatch");
    return "deleted";
  }
  await db.update(gradeDispatches).set({ dispatchedAt: app.clock.now() }).where(eq(gradeDispatches.id, claim.dispatchId));
  return "dispatched";
}

/**
 * The project's row under a share lock, then the repository's under an
 * update lock (the order every writer of both takes), as they now stand,
 * the repository among `target`: whatever moved since the job's list was
 * read — a reopen, an extension, a deletion — is seen here. Read once per
 * transaction.
 */
async function lockedRepo(tx: Tx, projectId: string, repoId: string, target: SQL) {
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for("share");
  const [row] = await tx
    .select({ repo: projectRepos, frozenSha: projectGradeRuns.headSha })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .leftJoin(projectGradeRuns, eq(projectGradeRuns.id, projectRepos.frozenGradeRunId))
    .where(and(eq(projectRepos.id, repoId), eq(projectRepos.projectId, projectId), target))
    .for("update", { of: projectRepos });
  return project && row ? { project, ...row } : null;
}

/** One repository's final review: re-read, claimed, sent. */
async function dispatchFinal(app: FastifyInstance, octokit: Octokit, projectId: string, repoId: string): Promise<Outcome> {
  const now = app.clock.now();
  const claim = await app.db.transaction(async (tx): Promise<Claim | null> => {
    // Reopened, archived, suspended, deleted, no longer reviewed: nothing to send.
    const found = await lockedRepo(tx, projectId, repoId, FINAL_REVIEW_DUE);
    if (!found) return null;
    const { project, repo } = found;
    const plan = planFinalReviewDispatch({ id: project.id, deadlineAt: effectiveDeadline(repo, project) }, found.frozenSha);
    if (!plan) return null;
    const dispatchId = await claimDispatch(tx, repo.id, plan, null, now);
    return dispatchId === null ? null : { dispatchId, repoId: repo.id, fullName: repo.fullName!, plan };
  });
  return claim ? send(app, octokit, claim) : "none";
}

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
 * One repository's dispatch of a checkpoint: the repository re-read among
 * the {@link CHECKPOINT_TARGET}, then the checkpoint under a share lock
 * (its deletion waits, or wins), still firing.
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
    const found = await lockedRepo(tx, projectId, repoId, CHECKPOINT_TARGET);
    if (!found) return null;
    const { project, repo } = found;
    const [checkpoint] = await tx
      .select()
      .from(projectCheckpoints)
      .where(and(eq(projectCheckpoints.id, checkpointId), eq(projectCheckpoints.projectId, projectId)))
      .for("share");
    if (!checkpoint || !checkpointFires(checkpoint, project, now)) return null;
    const sha = await checkpointSha(tx, repo.githubRepoId!, project.branches, checkpoint.dueAt);
    const plan = planCheckpointReviewDispatch(project.id, checkpoint, sha);
    if (!plan) return null;
    const dispatchId = await claimDispatch(tx, repo.id, plan, checkpointId, now);
    return dispatchId === null ? null : { dispatchId, repoId: repo.id, fullName: repo.fullName!, plan };
  });
  return claim ? send(app, octokit, claim) : "none";
}

// ---------------------------------------------------------------- the job

/** The counts of a pass, and the repositories GitHub refused. */
type Tally = Record<"dispatched" | "deleted" | "unconfirmed", number> & { failed: string[] };

/** `repos` through `dispatchOne` in the leased frame: what became of them. */
async function dispatchAll(
  each: LeasedRun["each"],
  repos: readonly { id: string; fullName: string | null }[],
  dispatchOne: (repoId: string) => Promise<Outcome>,
): Promise<Tally> {
  const tally = { dispatched: 0, deleted: 0, unconfirmed: 0 };
  const failed = await each(repos, async (repo) => {
    const outcome = await dispatchOne(repo.id);
    if (outcome !== "none") tally[outcome] += 1;
  });
  return { ...tally, failed };
}

const changed = (t: Tally) => t.dispatched + t.deleted + t.unconfirmed > 0;

/**
 * The `project.dispatch` job, in the leased frame (`runLeased`): the final
 * review of every repository whose freeze is definitive, then each
 * checkpoint that fires. A repository GitHub refused (a 4xx) fails the job
 * once the others are done: its claim was given back, and the next tick
 * resumes. A checkpoint is marked dispatched once a pass met no refusal for
 * it. One audit per pass that changed something.
 */
export async function runReviewJob(app: FastifyInstance, config: AppConfig, job: ProjectJob): Promise<void> {
  const db = app.db;
  await runLeased(app, config, "dispatchJobAt", job, "review dispatch", async ({ project, octokit, lost, each }) => {
    const finals = await db
      .select({ id: projectRepos.id, fullName: projectRepos.fullName })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(and(eq(projectRepos.projectId, project.id), FINAL_REVIEW_DUE));
    const final = await dispatchAll(each, finals, (repoId) => dispatchFinal(app, octokit, project.id, repoId));
    if (changed(final)) {
      await audit(db, { ...SYSTEM_ACTOR, action: "project.review_dispatched", subjectType: "project", subjectId: project.id, payload: final });
    }

    const now = app.clock.now();
    const checkpoints = (
      await db
        .select()
        .from(projectCheckpoints)
        .where(and(eq(projectCheckpoints.projectId, project.id), isNull(projectCheckpoints.dispatchedAt)))
    ).filter((c) => checkpointFires(c, project, now));
    const targets = await db
      .select({ id: projectRepos.id, fullName: projectRepos.fullName })
      .from(projectRepos)
      .innerJoin(projects, eq(projects.id, projectRepos.projectId))
      .where(and(eq(projectRepos.projectId, project.id), CHECKPOINT_TARGET));
    for (const checkpoint of checkpoints) {
      if (lost()) break;
      const tally = await dispatchAll(each, targets, (repoId) => dispatchCheckpoint(app, octokit, project.id, checkpoint.id, repoId));
      if (changed(tally)) {
        await audit(db, {
          ...SYSTEM_ACTOR,
          action: "project.checkpoint_dispatched",
          subjectType: "project",
          subjectId: project.id,
          payload: { checkpointId: checkpoint.id, name: checkpoint.name, ...tally },
        });
      }
      if (tally.failed.length === 0 && !lost()) {
        await db
          .update(projectCheckpoints)
          .set({ dispatchedAt: app.clock.now() })
          .where(and(eq(projectCheckpoints.id, checkpoint.id), isNull(projectCheckpoints.dispatchedAt)));
      }
    }
    await hintProjectStaff(db, [project.id]);
  });
}
