/**
 * The grading pipeline of projects (F-PROJ-10, F-PROJ-11, N-SEC-21; merge
 * task M3-04), ported from heig-classroom's `grading.ts` (sync point
 * `ab98cc0`, no later fix): the reads and writes around the pure rules of
 * `@quiz/domain` (`projectRuns.ts`: `runKind`, `receivedLate`,
 * `selectScoreRun`) — which runs count, the score read from the run's GRADE
 * annotation, the current score, the grace-period refresh of the frozen one.
 *
 * ONE ingestion path (ADR-011): the `workflow_run` webhook and the
 * reconciliation of M3-06 both call {@link ingestCompletedRun}, idempotent
 * on (repository, run, attempt) — the UNIQUE of `project_grade_runs`.
 *
 * A run's score is a SCORE, points out of a maximum, never a grade, and it
 * is indicative until the staff release it (F-PROJ-14): a run with several
 * GRADE annotations has none (a student's code could print one), a run on
 * a commit a bot pushed never counts, a run on a head whose protected files
 * were restored never counts, and what decides "before the deadline" is the
 * server's receipt time of the push (ADR-012).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Octokit } from "octokit";
import { z } from "zod";

import {
  effectiveDeadline,
  extractScore,
  GRADING_WORKFLOW_PATH,
  receivedLate,
  runKind,
  selectScoreRun,
  type ScoreParse,
} from "@quiz/domain";

import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { botCommits, gradeDispatches, projectGradeRuns, projectRepos, projects, pushReceipts, reverts } from "../../db/schema.js";
import { ownerRepo } from "../../github/app.js";
import { pushedBy } from "../github/service.js";
import type { RepoContext } from "./repos.js";

/** The raw test counters `score` ≥ 0.7.2 prints beside the score: "passed/total". */
const TESTS_ANNOTATION_TITLE = "TESTS";
/** How much of a malformed annotation is kept as the reason (F-PROJ-10). */
const PARSE_DETAIL_MAX = 500;

/** The raw GRADE message a run keeps: a malformed one's reason, a clamped one's negative score. */
function parseDetailOf(score: ScoreParse | null): string | null {
  if (score?.status === "malformed" || (score?.status === "ok" && score.clamped)) return score.message.slice(0, PARSE_DETAIL_MAX);
  return null;
}

/** A completed run of a workflow, as the webhook or GitHub's run listing (M3-06) describes it. */
export interface CompletedRun {
  workflowRunId: number;
  runAttempt: number;
  headBranch: string;
  headSha: string;
  conclusion: string;
  /** The workflow's path. */
  path: string;
  /** What triggered it: `push`, `repository_dispatch` (the review), ... */
  event: string;
  /**
   * Who triggered it (`pushedBy` of the run's `triggering_actor` alone; none
   * is a `person`, failing closed): only a review run Quiz's App dispatched —
   * `app` — fills the review slot; a student may dispatch one too, or re-run
   * the App's on a later head (M3-05b).
   */
  triggeredBy: "app" | "workflow" | "person";
  checkSuiteId: number | null;
  /**
   * GitHub's start time of the run (`run_started_at`), or null when unknown:
   * a review run fills the slot only when it started after the freeze and
   * after the final review was asked (M3-05b); unknown never does.
   */
  startedAt: Date | null;
  /** GitHub's completion time. */
  completedAt: Date;
}

/**
 * A workflow run as GitHub describes it, in a `workflow_run` delivery and
 * in the listing of a repository's runs alike: the fields the ingestion
 * reads, nothing else validated (every other field is GitHub's business).
 */
export const RawWorkflowRun = z.object({
  // Octokit's types declare GitHub's ids `number | bigint` (I62); they stay below 2^53.
  id: z.union([z.number().int(), z.bigint()]),
  run_attempt: z.number().int().nullish(),
  head_branch: z.string().nullish(),
  head_sha: z.string(),
  conclusion: z.string().nullish(),
  path: z.string().nullish(),
  event: z.string().nullish(),
  check_suite_id: z.union([z.number().int(), z.bigint()]).nullish(),
  updated_at: z.string().nullish(),
  run_started_at: z.string().nullish(),
  triggering_actor: z.object({ login: z.string() }).nullish(),
});
export type RawWorkflowRun = z.infer<typeof RawWorkflowRun>;

/** `iso` as a date, or null when absent or unreadable. */
function dateOrNull(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * THE mapping of GitHub's run into the ingestion's (ADR-011 §1: the webhook
 * and the reconciliation build the same event). `receivedAt` stands for a
 * completion time GitHub left out — the delivery's receipt, or the
 * reconciliation's clock.
 */
export function completedRun(config: AppConfig, raw: RawWorkflowRun, receivedAt: Date): CompletedRun {
  return {
    workflowRunId: Number(raw.id),
    runAttempt: raw.run_attempt ?? 1,
    headBranch: raw.head_branch ?? "",
    headSha: raw.head_sha,
    conclusion: raw.conclusion ?? "unknown",
    path: raw.path ?? "",
    event: raw.event ?? "",
    // A re-run's triggering actor is who re-ran it; none at all counts as a person's (fail closed).
    triggeredBy: pushedBy(config, raw.triggering_actor?.login),
    checkSuiteId: raw.check_suite_id == null ? null : Number(raw.check_suite_id),
    startedAt: dateOrNull(raw.run_started_at),
    completedAt: dateOrNull(raw.updated_at) ?? receivedAt,
  };
}

/**
 * A run counts on a handed-out branch, on a head commit no bot pushed: not
 * in `bot_commits` (the App's restores, deadline commits and syncs, the
 * workflows' own commits), nor received as a bot's push (`push_receipts.is_bot`,
 * the defence in depth when a bot commit was not recorded). A review run
 * skips the bot check: a dispatched run runs on the default branch's head,
 * which may be a deadline commit or an earlier review's.
 */
export async function isEligible(
  db: Db,
  ctx: RepoContext,
  run: Pick<CompletedRun, "headBranch" | "headSha" | "event" | "path">,
): Promise<boolean> {
  if (!run.headBranch || !run.headSha || !ctx.project.branches.includes(run.headBranch)) return false;
  if (runKind(run) === "review") return true;
  const [[bot], [botPush]] = await Promise.all([
    db
      .select({ sha: botCommits.sha })
      .from(botCommits)
      .where(and(eq(botCommits.repoId, ctx.repo.id), eq(botCommits.sha, run.headSha)))
      .limit(1),
    ctx.repo.githubRepoId === null
      ? []
      : db
          .select({ id: pushReceipts.id })
          .from(pushReceipts)
          .where(
            and(
              eq(pushReceipts.githubRepoId, ctx.repo.githubRepoId),
              eq(pushReceipts.headSha, run.headSha),
              eq(pushReceipts.isBot, true),
            ),
          )
          .limit(1),
  ]);
  return bot === undefined && botPush === undefined;
}

/**
 * The commit whose CI state the repository shows (F-PROJ-10): the student's
 * last commit (`last_commit_sha`, never moved by a bot's push), or any while
 * none is known. The ONE rule for `pending` and for the aggregated state.
 */
export function isLastStudentCommit(ctx: RepoContext, sha: string): boolean {
  return ctx.repo.lastCommitSha === null || ctx.repo.lastCommitSha === sha;
}

/** The server's receipt time of `headSha` on the repository, or null when none was written. */
async function receiptOf(db: Db, ctx: RepoContext, headSha: string): Promise<Date | null> {
  if (ctx.repo.githubRepoId === null) return null;
  const [receipt] = await db
    .select({ receivedAt: pushReceipts.receivedAt })
    .from(pushReceipts)
    .where(and(eq(pushReceipts.githubRepoId, ctx.repo.githubRepoId), eq(pushReceipts.headSha, headSha)))
    .limit(1);
  return receipt?.receivedAt ?? null;
}

/**
 * The heads a restore covered (F-PROJ-08): their runs used the student's
 * copy of the protected files and never count. For each restore, the
 * tampering push's head (`reverts.head_sha`), the head the restore was
 * built on (`covered_sha`), and every head received on the restore's branch
 * (`reverts.branch`; the receipt's branch on the rows written before) from
 * the tampering push's receipt to the later of the restore (`created_at`,
 * taken before the branch was read) and the covered head's receipt — a
 * student pushing S, S1, S2 before S's delivery is handled ran the altered
 * files in all three, and S2's receipt may land after the restore began
 * (M3-06b). Derived from the receipts the intake wrote, no GitHub read; a
 * push after the restore builds on it and counts again.
 *
 * A row without a restore (`revert_sha` null, M3-06b): after a move GitHub
 * refused, the attempt had read the branch (`covered_sha`), so the row
 * covers the heads up to it, bounded by its `created_at` — taken before the
 * branch was read, so the fix pushed after it has a later receipt and stays
 * outside; a push whose head was already overtaken by a clean head when its
 * delivery was handled (`covered_sha` null, nothing was restored) covers its
 * head alone.
 */
export async function restoredHeads(db: Db | Tx, ctx: { repo: Pick<RepoContext["repo"], "id" | "githubRepoId"> }): Promise<Set<string>> {
  const tampering = alias(pushReceipts, "tampering");
  const covered = alias(pushReceipts, "covered");
  const between = alias(pushReceipts, "between");
  const [rows, window] = await Promise.all([
    db.select({ head: reverts.headSha, covered: reverts.coveredSha }).from(reverts).where(eq(reverts.repoId, ctx.repo.id)),
    ctx.repo.githubRepoId === null
      ? []
      : db
          .select({ head: between.headSha })
          .from(reverts)
          .innerJoin(tampering, and(eq(tampering.githubRepoId, ctx.repo.githubRepoId), eq(tampering.headSha, reverts.headSha)))
          // No receipt yet (or ever) for the covered head: `GREATEST` skips the null.
          .leftJoin(covered, and(eq(covered.githubRepoId, tampering.githubRepoId), eq(covered.headSha, reverts.coveredSha)))
          .innerJoin(
            between,
            and(
              eq(between.githubRepoId, tampering.githubRepoId),
              eq(between.branch, sql`COALESCE(${reverts.branch}, ${tampering.branch})`),
              gte(between.receivedAt, tampering.receivedAt),
              // A null upper bound (a head alone) matches nothing.
              lte(
                between.receivedAt,
                sql`CASE WHEN ${reverts.revertSha} IS NOT NULL THEN GREATEST(${reverts.createdAt}, ${covered.receivedAt})
                  WHEN ${reverts.coveredSha} IS NOT NULL THEN ${reverts.createdAt} END`,
              ),
            ),
          )
          .where(eq(reverts.repoId, ctx.repo.id)),
  ]);
  return new Set([
    ...rows.flatMap((r) => [r.head, r.covered].filter((sha): sha is string => sha !== null)),
    ...window.map((r) => r.head),
  ]);
}

/**
 * The current score reselected (`selectScoreRun` of `@quiz/domain`) and,
 * while the repository's deadline is applied but its freeze not yet
 * definitive (the grace, F-PROJ-11), the frozen one with it: a run on a
 * commit received in time may still improve it. The grace is judged on the
 * row as the write finds it, never on the caller's copy, so a refresh
 * racing the ticker's definitive freeze never moves a frozen score (M3-05a).
 *
 * The stored `to_verify` of a run on a restored head follows the set here
 * (F-PROJ-08): a run ingested before the restore, or before a late receipt
 * widened its window (M3-06b), is flagged at the next reselection — the
 * score itself never waited for the flag, it reads the set.
 */
export async function refreshScoreSelection(
  db: Db | Tx,
  ctx: { repo: Pick<RepoContext["repo"], "id" | "githubRepoId"> },
): Promise<void> {
  const [runs, restored] = await Promise.all([
    db.select().from(projectGradeRuns).where(eq(projectGradeRuns.repoId, ctx.repo.id)),
    restoredHeads(db, ctx),
  ]);
  const lagging = runs.filter((r) => !r.toVerify && restored.has(r.headSha)).map((r) => r.id);
  if (lagging.length > 0) await db.update(projectGradeRuns).set({ toVerify: true }).where(inArray(projectGradeRuns.id, lagging));
  const selected = selectScoreRun(runs, restored);
  await db
    .update(projectRepos)
    .set({
      currentGradeRunId: selected,
      frozenGradeRunId: sql`CASE WHEN ${projectRepos.deadlineAppliedAt} IS NOT NULL AND ${projectRepos.frozenAt} IS NULL
        THEN ${selected}::uuid ELSE ${projectRepos.frozenGradeRunId} END`,
    })
    .where(eq(projectRepos.id, ctx.repo.id));
}

/**
 * The GRADE and TESTS notices of the run's own check suite (a run of
 * another workflow on the same commit never lends its annotations).
 */
async function readAnnotations(
  octokit: Octokit,
  fullName: string,
  headSha: string,
  checkSuiteId: number | null,
): Promise<{ score: ScoreParse; tests: { passed: number; total: number } | null }> {
  const { owner, repo } = ownerRepo(fullName);
  const { data: checks } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
    owner,
    repo,
    ref: headSha,
    per_page: 100,
  });
  const notices: { title: string | null; message: string | null }[] = [];
  let tests: { passed: number; total: number } | null = null;
  for (const check of checks.check_runs) {
    if (checkSuiteId !== null && check.check_suite?.id !== checkSuiteId) continue;
    if (!check.output?.annotations_count) continue;
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations", {
      owner,
      repo,
      check_run_id: check.id,
      per_page: 100,
    });
    for (const a of data) {
      if (a.annotation_level !== "notice") continue;
      if (a.title === TESTS_ANNOTATION_TITLE) {
        const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(a.message ?? "");
        if (m) tests = { passed: Number(m[1]), total: Number(m[2]) };
      } else {
        notices.push({ title: a.title ?? null, message: a.message ?? null });
      }
    }
  }
  return { score: extractScore(notices), tests };
}

/** Pass / fail over every run of a commit (F-PROJ-10): the CI state of a repository. */
export async function aggregateCiStatus(
  octokit: Octokit,
  fullName: string,
  headSha: string,
): Promise<"none" | "pending" | "pass" | "fail"> {
  const { owner, repo } = ownerRepo(fullName);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs", {
    owner,
    repo,
    head_sha: headSha,
    per_page: 50,
  });
  const runs = data.workflow_runs;
  if (runs.length === 0) return "none";
  const completed = runs.filter((r) => r.status === "completed");
  const failed = (c: string | null) => c !== null && !["success", "skipped", "neutral"].includes(c);
  if (completed.some((r) => failed(r.conclusion))) return "fail";
  return completed.length < runs.length ? "pending" : "pass";
}

/**
 * Ingests a completed run, idempotently: the id of the grade run created,
 * or null when the run does not count or was already ingested (a replay
 * reads no annotation again). A `ci` run reselects the current score; a
 * `review` run fills the review slot only once it parsed, succeeded, was
 * triggered by Quiz's App (M3-05b) and the repository's freeze is
 * definitive (`project_repos.frozen_at`, M3-05a): a checkpoint's review
 * before it, or a review a student dispatched, is a trace, never the final
 * review (F-PROJ-11 as amended, M3-04, M3-05b).
 *
 * `to_verify`: ingested while the repository's protection is suspended, or
 * on a head whose protected files were restored (F-PROJ-08).
 */
export async function ingestCompletedRun(
  app: FastifyInstance,
  octokit: Octokit,
  ctx: RepoContext,
  run: CompletedRun,
): Promise<string | null> {
  const db = app.db;
  const kind = runKind(run);
  if (!ctx.repo.fullName || !(await isEligible(db, ctx, run))) return null;
  const [existing] = await db
    .select({ id: projectGradeRuns.id })
    .from(projectGradeRuns)
    .where(
      and(
        eq(projectGradeRuns.repoId, ctx.repo.id),
        eq(projectGradeRuns.workflowRunId, run.workflowRunId),
        eq(projectGradeRuns.runAttempt, run.runAttempt),
      ),
    )
    .limit(1);
  if (existing) return null;

  const { score, tests } =
    run.path === GRADING_WORKFLOW_PATH
      ? await readAnnotations(octokit, ctx.repo.fullName, run.headSha, run.checkSuiteId)
      : { score: null, tests: null };
  const restored = (await restoredHeads(db, ctx)).has(run.headSha);
  const toVerify = ctx.repo.protectionSuspendedAt !== null || restored;
  const receivedAt = await receiptOf(db, ctx, run.headSha);
  const id = randomUUID();
  // `after_deadline` on the deadlines as they stand when the run is written,
  // the project's and the repository's rows read under a share lock: a
  // deadline moving meanwhile (which takes them for update) either comes
  // first and is read here, or waits and requalifies this run (M3-05a).
  const inserted = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ deadlineAt: projects.deadlineAt })
      .from(projects)
      .where(eq(projects.id, ctx.project.id))
      .for("share");
    const [repo] = await tx
      .select({ deadlineAt: projectRepos.deadlineAt })
      .from(projectRepos)
      .where(eq(projectRepos.id, ctx.repo.id))
      .for("share");
    if (!project || !repo) return undefined;
    const [row] = await tx
      .insert(projectGradeRuns)
      .values({
        id,
        repoId: ctx.repo.id,
        workflowRunId: run.workflowRunId,
        runAttempt: run.runAttempt,
        headBranch: run.headBranch,
        headSha: run.headSha,
        conclusion: run.conclusion,
        points: score?.status === "ok" ? score.points : null,
        max: score?.status === "ok" ? score.max : null,
        testsPassed: tests?.passed ?? null,
        testsTotal: tests?.total ?? null,
        // Another workflow than grading.yml: a pass / fail run, no score.
        parseStatus: score?.status ?? "fallback",
        // Kept for a malformed score, and for a clamped one (M3-14n): the raw message.
        parseDetail: parseDetailOf(score),
        kind,
        // The repository's own deadline when its staff extended it (D13 amended).
        afterDeadline: receivedLate(receivedAt, effectiveDeadline(repo, project), app.clock.now()),
        toVerify,
        completedAt: run.completedAt,
      })
      .onConflictDoNothing()
      .returning({ id: projectGradeRuns.id });
    return row;
  });
  if (!inserted) return null; // another worker ingested it meanwhile, or the repository is gone

  if (kind === "review") {
    // The final review only: a failed run (grading.yml's fallback "1/6"
    // when the review step dies) is a trace, never the review's score; so
    // is a review the App did not trigger (M3-05b) — a student's own
    // dispatch, or their re-run of the App's —, one whose protected files
    // may have been altered (`to_verify`), and one that started before
    // this freeze or before its final review was asked (a checkpoint's, or
    // one from before a reopen): judged on the row as the write finds it.
    if (score?.status === "ok" && run.conclusion === "success" && run.triggeredBy === "app" && !toVerify && run.startedAt) {
      const started = sql`${run.startedAt.toISOString()}::timestamptz`;
      await db
        .update(projectRepos)
        .set({ reviewGradeRunId: id })
        .where(
          and(
            eq(projectRepos.id, ctx.repo.id),
            sql`${projectRepos.frozenAt} <= ${started}`,
            sql`EXISTS (SELECT 1 FROM ${gradeDispatches} WHERE ${gradeDispatches.repoId} = ${projectRepos.id}
              AND ${gradeDispatches.trigger} = 'deadline' AND ${gradeDispatches.createdAt} <= ${started})`,
          ),
        );
    }
    return id;
  }

  await refreshScoreSelection(db, ctx);
  if (isLastStudentCommit(ctx, run.headSha)) {
    try {
      const ciStatus = await aggregateCiStatus(octokit, ctx.repo.fullName, run.headSha);
      await db.update(projectRepos).set({ ciStatus }).where(eq(projectRepos.id, ctx.repo.id));
    } catch (err) {
      app.log.warn({ err, repo: ctx.repo.id }, "the CI state of a repository could not be read");
    }
  }
  return id;
}
