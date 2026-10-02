/**
 * The grading pipeline of projects (F-PROJ-10, F-PROJ-11, N-SEC-21; merge
 * task M3-04), ported from heig-classroom's `grading.ts` (sync point
 * `ab98cc0`, no later fix): which runs count, the score read from the
 * run's GRADE annotation, the current score, the grace-period refresh of
 * the frozen one.
 *
 * ONE ingestion path (ADR-011): the `workflow_run` webhook and the
 * reconciliation of M3-06 both call {@link ingestCompletedRun}, idempotent
 * on (repository, run, attempt) — the UNIQUE of `project_grade_runs`.
 *
 * A run's score is a SCORE, points out of a maximum, never a grade, and it
 * is indicative until the staff release it (F-PROJ-14): a run with several
 * GRADE annotations has none (a student's code could print one), a run on
 * a commit the App pushed never counts, and what decides "before the
 * deadline" is the server's receipt time of the push (ADR-012).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, desc, eq, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import type { GRADE_RUN_KINDS } from "@quiz/contracts";
import { extractScore, type ScoreParse } from "@quiz/domain";

import type { Db } from "../../db/client.js";
import { botCommits, projectGradeRuns, projectRepos, pushReceipts } from "../../db/schema.js";
import type { RepoContext } from "./repos.js";

type GradeRunKind = (typeof GRADE_RUN_KINDS)[number];

/** The workflow whose runs carry a score (a wire name, I16). */
export const GRADING_WORKFLOW_PATH = ".github/workflows/grading.yml";
/** The raw test counters `score` ≥ 0.7.2 prints beside the score: "passed/total". */
const TESTS_ANNOTATION_TITLE = "TESTS";
/** How much of a malformed annotation is kept as the reason (F-PROJ-10). */
const PARSE_DETAIL_MAX = 500;

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
  checkSuiteId: number | null;
  /** GitHub's completion time. */
  completedAt: Date;
}

/**
 * The review dispatched by Quiz (`grade-final`, `grade-milestone`, M3-05) is
 * a `review` run; every other run is the indicative `ci` tier.
 */
export function runKind(run: Pick<CompletedRun, "event" | "path">): GradeRunKind {
  return run.event === "repository_dispatch" && run.path === GRADING_WORKFLOW_PATH ? "review" : "ci";
}

/**
 * A run counts on a handed-out branch, on a head commit that is not a bot
 * commit (`bot_commits`: the App's restores, deadline commits and syncs,
 * and the workflows' own commits). A review run skips the bot check: a
 * dispatched run runs on the default branch's head, which may be a deadline
 * commit or an earlier review's.
 */
export async function isEligible(
  db: Db,
  ctx: RepoContext,
  headBranch: string | null | undefined,
  headSha: string | null | undefined,
  kind: GradeRunKind,
): Promise<boolean> {
  if (!headBranch || !headSha || !ctx.project.branches.includes(headBranch)) return false;
  if (kind === "review") return true;
  const [bot] = await db
    .select({ sha: botCommits.sha })
    .from(botCommits)
    .where(and(eq(botCommits.repoId, ctx.repo.id), eq(botCommits.sha, headSha)))
    .limit(1);
  return bot === undefined;
}

/**
 * Whether `headSha` came in after the deadline, by the server's receipt of
 * its push (ADR-012), never the commit's date. Unknown receipt — a lost
 * webhook, a run reconciled after the fact — is late once the deadline has
 * passed (GR-14.3, ADR-011 §4); ahead of it, it is on time.
 */
export async function isAfterDeadline(db: Db, ctx: RepoContext, headSha: string, now: Date): Promise<boolean> {
  const deadline = ctx.project.deadlineAt.getTime();
  const [receipt] =
    ctx.repo.githubRepoId === null
      ? []
      : await db
          .select({ receivedAt: pushReceipts.receivedAt })
          .from(pushReceipts)
          .where(and(eq(pushReceipts.githubRepoId, ctx.repo.githubRepoId), eq(pushReceipts.headSha, headSha)))
          .limit(1);
  if (receipt) return receipt.receivedAt.getTime() > deadline;
  return now.getTime() > deadline;
}

/**
 * The current score's run (F-PROJ-10; product owner, 2026-10-02): the
 * latest counted `ci` run, by GitHub's completion time, on a commit received
 * before the deadline, with a score (`ok`). A pass / fail `fallback` run
 * (a workflow other than `grading.yml`) counts only when the repository has
 * no `grading.yml` run at all: a build workflow beside the grading one never
 * displaces the score.
 */
export async function selectScoreRun(db: Db, repoId: string): Promise<string | null> {
  const r = projectGradeRuns;
  const [row] = await db
    .select({ id: r.id })
    .from(r)
    .where(
      and(
        eq(r.repoId, repoId),
        eq(r.kind, "ci"),
        eq(r.afterDeadline, false),
        or(
          eq(r.parseStatus, "ok"),
          and(
            eq(r.parseStatus, "fallback"),
            sql`NOT EXISTS (SELECT 1 FROM project_grade_runs g WHERE g.repo_id = ${repoId} AND g.parse_status <> 'fallback')`,
          ),
        ),
      ),
    )
    .orderBy(desc(r.completedAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The current score reselected and, while the deadline is applied but the
 * freeze not yet definitive (the grace, F-PROJ-11), the frozen one with it:
 * a run on a commit received in time may still improve it. Inert until the
 * deadline is applied (M3-05).
 */
export async function refreshScoreSelection(db: Db, ctx: RepoContext): Promise<void> {
  const selected = await selectScoreRun(db, ctx.repo.id);
  const inGrace = ctx.project.deadlineAppliedAt !== null && ctx.project.frozenAt === null;
  await db
    .update(projectRepos)
    .set({ currentGradeRunId: selected, ...(inGrace ? { frozenGradeRunId: selected } : {}) })
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
  const [owner, repo] = fullName.split("/") as [string, string];
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
async function aggregateCiStatus(
  octokit: Octokit,
  fullName: string,
  headSha: string,
): Promise<"none" | "pending" | "pass" | "fail"> {
  const [owner, repo] = fullName.split("/") as [string, string];
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
 * `review` run fills the review slot only once it parsed, succeeded and the
 * freeze is definitive (`frozen_at`): a checkpoint's review before it is a
 * trace, never the final review (F-PROJ-11 as amended, M3-04).
 *
 * A run ingested while the repository's protection is suspended
 * (F-PROJ-08) is marked `to_verify`: its `grading.yml` may be the student's.
 */
export async function ingestCompletedRun(
  app: FastifyInstance,
  octokit: Octokit,
  ctx: RepoContext,
  run: CompletedRun,
): Promise<string | null> {
  const db = app.db;
  const kind = runKind(run);
  if (!ctx.repo.fullName || !(await isEligible(db, ctx, run.headBranch, run.headSha, kind))) return null;
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

  const grading = run.path === GRADING_WORKFLOW_PATH;
  const { score, tests } = grading
    ? await readAnnotations(octokit, ctx.repo.fullName, run.headSha, run.checkSuiteId)
    : { score: null, tests: null };
  const id = randomUUID();
  const [inserted] = await db
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
      parseDetail: score?.status === "malformed" ? score.message.slice(0, PARSE_DETAIL_MAX) : null,
      kind,
      afterDeadline: await isAfterDeadline(db, ctx, run.headSha, app.clock.now()),
      toVerify: ctx.repo.protectionSuspendedAt !== null,
      completedAt: run.completedAt,
    })
    .onConflictDoNothing()
    .returning({ id: projectGradeRuns.id });
  if (!inserted) return null; // another worker ingested it meanwhile

  if (kind === "review") {
    // The final review only: a failed run (grading.yml's fallback "1/6"
    // when the review step dies) is a trace, never the review's score.
    if (score?.status === "ok" && run.conclusion === "success" && ctx.project.frozenAt !== null) {
      await db.update(projectRepos).set({ reviewGradeRunId: id }).where(eq(projectRepos.id, ctx.repo.id));
    }
    return id;
  }

  await refreshScoreSelection(db, ctx);
  // The CI state of the repository's last known commit only.
  if (!ctx.repo.lastCommitSha || ctx.repo.lastCommitSha === run.headSha) {
    try {
      const ciStatus = await aggregateCiStatus(octokit, ctx.repo.fullName, run.headSha);
      await db.update(projectRepos).set({ ciStatus }).where(eq(projectRepos.id, ctx.repo.id));
    } catch (err) {
      app.log.warn({ err, repo: ctx.repo.id }, "the CI state of a repository could not be read");
    }
  }
  return id;
}
