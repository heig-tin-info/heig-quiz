/**
 * The CI's evidence of a project graded by criteria whose snapshot is
 * schema 3 (ADR-119 §6, card L-06b): the repository's own CI runs the
 * criteria's commands and uploads a `results.json`; the platform asks for
 * the run, accepts it only when it is provably the one it asked for, and
 * reads the automatic criteria's points from it. A schema-2 snapshot keeps
 * the runner's evidence (`evidence.ts`, ADR-106 §3) unchanged (§11).
 *
 * **The pass** is a row of `grade_dispatches` with a `nonce` (128 random
 * bits): the final pass and a milestone's are claimed by the ticker
 * (`claimPasses`, `milestone.ts`: claim and enqueue only, invariant 5); a
 * Regrade claims a `regrade` row ({@link claimRegrades}) and closes the
 * pass it replaces. A batch of passes is queued on `project.ci`, each
 * installation's spread {@link DISPATCH_PACE_MS} apart (choice f,
 * {@link sendCiPasses}).
 *
 * **The dispatch** ({@link runCiDispatch}, the `project.ci` job): the
 * target commit — the last student push received by the effective deadline
 * (by the checkpoint's date for a milestone, `passTarget`) —, then its
 * **graded commit** (ADR-132 §2, `github/graft.ts`): the target with the
 * protected list (`criteria.yml` included) of the distribution commit the
 * criteria snapshot was read at, pushed to a ref that is never a branch —
 * none when the target already holds them. Both are recorded on the row
 * before GitHub is called (at most once: a row whose `sha` is set is never
 * sent again), then `repository_dispatch` `quiz-grade` with
 * `{ sha, nonce, pass, milestone? }`, `sha` the graded commit
 * (`postDispatch`). The queue retries nothing: a graft that fails is tried
 * again in the job, then settles the pass `ci_unavailable` (audited
 * `project_repo.grade_graft_failed`). No commit, a repository gone, or one
 * that cannot be written or run Actions (archived as its lock, no
 * installation, above the graft's size ceiling, GitHub's refusal) settles
 * the pass at once with its reason (`no_commit`, `repo_missing`,
 * `ci_unavailable`); a call whose answer never came is left unconfirmed,
 * its 24 h then settle it. A pass whose scope holds no automatic criterion
 * (no leaf with a `command`) gets its graded commit but is never
 * dispatched: nothing from a run would be read, so it is settled at once —
 * no row written — and its LLM review queued, which reads the graded
 * commit (`reviewPass.ts`); one settled before its claim takes its target
 * from `passTarget` itself.
 *
 * **The intake** ({@link ingestRun}: the ONE entry of a completed run, from
 * the `workflow_run` webhook and the reconciliation's daily listing of a
 * repository's runs, ADR-011 — no poll of its own): a dispatched run of a
 * schema-3 project goes to {@link intakeGradedRun}, never to
 * `ingestCompletedRun` — it is no review and no score, and fills neither
 * slot. A run is accepted only if its workflow is
 * `.github/workflows/grading.yml`, its event `repository_dispatch`, its
 * triggering actor the App's bot, its attempt the first, and its name
 * carries the nonce of an open pass of the repository; anything else is
 * ignored. Accepted, its protected files are compared with what the pass
 * handed out (choice c as amended by ADR-132 §3) — `criteria.yml` and the
 * project's protected list at the graded commit against the distribution
 * commit it grafted from, the grading workflow at the run's head against
 * every version the distribution's history holds — and a difference settles
 * the pass `ci_tampered` (audited `project_repo.ci_tampered`). Otherwise
 * its `results` artifact is read (`github/artifact.ts`: the signed blob URL
 * never leaves it), validated (`readResults`), stored
 * (`project_ci_results`, the logs staff-only), and mapped onto the pass's
 * automatic criteria (`checkOutcomes`): one proposed `auto` row each,
 * `no_result` for a criterion the file does not answer. A refused or
 * missing artifact settles the pass `no_result`.
 *
 * **The 24 h** ({@link expireCiPasses}, the ticker's, on the server's
 * clock): a pass with no accepted run 24 h after its dispatch is settled
 * `no_result`.
 *
 * Settling writes through the single writer (`writeCriterionGrades`),
 * never over a held criterion — a Regrade's results over a validated
 * machine row included (ADR-132 §5) —; once settled, the pass's LLM review
 * is queued (`project.review`, `reviewPass.ts`, ADR-119 §7).
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, exists, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { readResults, snapshotSettings } from "@quiz/contracts";
import { decodeUtf8 } from "@quiz/core/tar";
import {
  checkOutcomes,
  classifyCriterion,
  GRADING_WORKFLOW_PATH,
  isProtected,
  runKind,
  treeDifference,
  type CheckResults,
  type CollectionTreeEntry,
  type CriteriaLeaf,
  type CriterionReason,
  type ParsedCriteria,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { Clock } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { githubOrganizations, gradeDispatches, projectCiResults, projectCriteria, projectRepos, projects } from "../../db/schema.js";
import { branchHead, ownerRepo, unless404 } from "../../github/app.js";
import { fetchResultsArtifact } from "../../github/artifact.js";
import { buildGradedCommit, type Graft } from "../../github/graft.js";
import { referenceBlob } from "../../github/revert.js";
import { PROJECT_CI_QUEUE, PROJECT_REVIEW_QUEUE } from "../../jobs.js";
import { ciGraded } from "./criteria.js";
import { ProjectError, requireReleasedOwner } from "./errors.js";
import type { GradeWriter } from "./grades.js";
import { writeCriterionGrades, type CriterionGradeInput } from "./criterionGrades.js";
import { projectClient } from "./evidence.js";
import { ingestCompletedRun, type CompletedRun } from "./grading.js";
import { CI_SNAPSHOT, ciNonce, passScope, type PassScope } from "./milestone.js";
import { hintProjectStaff, markRepoDeleted, releasedBefore, type RepoContext, type RepoRow } from "./repos.js";
import { passTarget, postDispatch } from "./review.js";
import type { ReviewJob } from "./reviewPass.js";
import type { ProjectRow } from "./views.js";

/** The `repository_dispatch` event a graded run answers. */
export const QUIZ_GRADE_EVENT = "quiz-grade";
/** One dispatch per App installation this often, at most (choice f): the CI runners are shared. */
export const DISPATCH_PACE_MS = 15_000;
/** A pass with no accepted run this long after its dispatch is settled `no_result` (choice d). */
export const RESULT_WAIT_MS = 24 * 3_600_000;

/** The `project.ci` job's data. */
export interface CiDispatchJob {
  passId: string;
}

type PassRow = typeof gradeDispatches.$inferSelect;

/** A pass as its dispatch, its intake and its settling read it. */
interface LoadedPass {
  pass: PassRow;
  repo: RepoRow;
  project: ProjectRow;
  snapshot: ParsedCriteria;
  /** The distribution commit the snapshot was read at (`project_criteria.source_sha`): what a graft takes (ADR-132 §2). */
  sourceSha: string;
  scope: PassScope<CriteriaLeaf>;
}

/** A CI pass still open: it accepts its run (neither settled nor retired). */
const OPEN = and(isNotNull(gradeDispatches.nonce), isNull(gradeDispatches.closedAt))!;

/** A CI pass of a project still graded by criteria on a schema-3 snapshot (`CI_SNAPSHOT`), with its scope; null otherwise. */
async function loadPass(db: Db | Tx, passId: string): Promise<LoadedPass | null> {
  const [row] = await db
    .select({ pass: gradeDispatches, repo: projectRepos, project: projects, snapshot: projectCriteria.criteria, sourceSha: projectCriteria.sourceSha })
    .from(gradeDispatches)
    .innerJoin(projectRepos, eq(projectRepos.id, gradeDispatches.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(projectCriteria, eq(projectCriteria.projectId, projects.id))
    .where(and(eq(gradeDispatches.id, passId), isNotNull(gradeDispatches.nonce), eq(projects.gradingMode, "criteria"), CI_SNAPSHOT));
  if (!row) return null;
  const scope = await passScope(db, row.project.id, row.snapshot.leaves, row.pass.checkpointId ?? undefined);
  return scope ? { ...row, scope } : null;
}

// ---------------------------------------------------------------- claims and pace

/**
 * A Regrade's passes (ADR-119 §6: always a new dispatch, with a new nonce),
 * one `regrade` row per repository, each closing the open final pass or
 * earlier Regrade of its repository (a milestone's stays). Under the
 * project's row, share-locked first (a release's order), its `released_at`
 * re-read: released, the claim is the course owner's (`403
 * owner_required`, ADR-139 §13) and needs the acknowledgement (`409
 * regrade_released`, ADR-132 §5); its `created_at` read from `clock` once
 * the lock is held, so a release is stamped before it or after it commits.
 * The pass ids, and whether the project was released.
 */
export async function claimRegrades(
  db: Db,
  projectId: string,
  repoIds: readonly string[],
  clock: Clock,
  acknowledged: boolean,
  staff: Pick<GradeWriter, "owner">,
): Promise<{ passIds: string[]; afterRelease: boolean }> {
  return db.transaction(async (tx) => {
    const [project] = await tx.select({ releasedAt: projects.releasedAt }).from(projects).where(eq(projects.id, projectId)).for("share");
    // Released, a Regrade replaces validated rows: the owner's alone (ADR-139 §13), read again here under the lock.
    requireReleasedOwner(project, staff);
    const afterRelease = project?.releasedAt != null;
    if (afterRelease && !acknowledged) {
      throw new ProjectError("regrade_released", "The project is released: a regrade replaces validated rows, confirm it");
    }
    const now = clock.now();
    await tx
      .update(gradeDispatches)
      .set({ closedAt: now })
      .where(and(inArray(gradeDispatches.repoId, [...repoIds]), isNull(gradeDispatches.checkpointId), OPEN));
    const rows = await tx
      .insert(gradeDispatches)
      .values(repoIds.map((repoId) => ({ id: randomUUID(), repoId, trigger: "regrade" as const, sha: "", nonce: ciNonce(), createdAt: now })))
      .returning({ id: gradeDispatches.id });
    return { passIds: rows.map((r) => r.id), afterRelease };
  });
}

/**
 * A batch of passes queued on `project.ci`, each installation's spread
 * {@link DISPATCH_PACE_MS} apart (`startAfter`, the n-th of an
 * installation at n × the pace). Without a queue nothing is sent: the
 * passes wait for their 24 h, or a Regrade.
 */
export async function sendCiPasses(app: FastifyInstance, passIds: readonly string[]): Promise<void> {
  if (passIds.length === 0 || !app.boss) return;
  const rows = await app.db
    .select({ id: gradeDispatches.id, installationId: githubOrganizations.installationId })
    .from(gradeDispatches)
    .innerJoin(projectRepos, eq(projectRepos.id, gradeDispatches.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, projects.orgId))
    .where(inArray(gradeDispatches.id, [...passIds]));
  const now = app.clock.now().getTime();
  const seen = new Map<number | null, number>();
  for (const row of rows) {
    const index = seen.get(row.installationId) ?? 0;
    seen.set(row.installationId, index + 1);
    const job: CiDispatchJob = { passId: row.id };
    await app.boss.send(PROJECT_CI_QUEUE, job, index === 0 ? undefined : { startAfter: new Date(now + index * DISPATCH_PACE_MS) });
  }
}

// ---------------------------------------------------------------- settling

/** What settles a pass: a reason for every automatic criterion, or an accepted run's results. */
type Settlement = { reason: CriterionReason } | { results: CheckResults; workflowRunId: number };

/** The automatic criteria of a pass: those carrying a `command` (schema 3 classifies by the file alone). */
const automaticLeaves = ({ project, snapshot, scope }: LoadedPass) =>
  scope.leaves.filter((leaf) => classifyCriterion(leaf, snapshotSettings(project, snapshot.schemaVersion)) === "automatic");

/** A check's `n/m` as a row's rationale (choice h): the fraction, without its spaces. */
const fraction = (score: string) => score.replace(/\s+/g, "");

/**
 * The pass settled — at most once, by a conditional write that a closed
 * pass loses — and its automatic criteria's rows written, proposed
 * (`writeCriterionGrades`: a held criterion is left alone): 0 points with
 * the reason, or each criterion's points from the results (`no_result` for
 * one the file does not answer), its rationale the fraction — a Regrade's
 * results over a validated row too, its failures over no machine row
 * (ADR-132 §5, the writer's rule, which records such a failure on the
 * pass). The results are stored first, the logs staff-only. False when
 * another settled it.
 */
async function settle(app: FastifyInstance, loaded: LoadedPass, settlement: Settlement): Promise<boolean> {
  const db = app.db;
  const now = app.clock.now();
  const { pass, scope } = loaded;
  const [won] = await db
    .update(gradeDispatches)
    .set({ closedAt: now })
    .where(and(eq(gradeDispatches.id, pass.id), OPEN))
    .returning({ id: gradeDispatches.id });
  if (!won) return false;
  const leaves = automaticLeaves(loaded);
  const row = (leaf: CriteriaLeaf, more: Pick<CriterionGradeInput, "points" | "rationale" | "reason">): CriterionGradeInput => ({
    criterionId: leaf.id,
    max: leaf.maxPoints,
    source: "auto",
    state: "proposed",
    passId: pass.id,
    ...more,
    ...scope.lock(now),
  });
  let inputs: CriterionGradeInput[];
  if ("reason" in settlement) {
    inputs = leaves.map((leaf) => row(leaf, { points: 0, reason: settlement.reason }));
  } else {
    const { results, workflowRunId } = settlement;
    await db.insert(projectCiResults).values({ passId: pass.id, workflowRunId, results, createdAt: now }).onConflictDoNothing();
    const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
    inputs = checkOutcomes(leaves, results).map((outcome) =>
      "reason" in outcome
        ? row(byId.get(outcome.id)!, { points: 0, reason: outcome.reason })
        : row(byId.get(outcome.id)!, { points: outcome.points, rationale: fraction(results.criteria[outcome.id]!.score), reason: null }),
    );
  }
  // The writer leaves a held criterion alone (`holdsCriterion`), under its lock; a settle runs once (`won`).
  await writeCriterionGrades(db, pass.repoId, inputs, now);
  await hintProjectStaff(db, [loaded.project.id]);
  // The pass's LLM review follows (ADR-119 §7), on its results' logs or, without any, the sources alone.
  // A queue's job: without `app.boss` the review is not run, as the dispatch is not sent (`sendCiPasses`).
  const review: ReviewJob = { repoId: pass.repoId, passId: pass.id, checkpointId: pass.checkpointId ?? undefined };
  if (app.boss) await app.boss.send(PROJECT_REVIEW_QUEUE, review);
  return true;
}

// ---------------------------------------------------------------- the dispatch

/** What became of a pass's dispatch. */
export type CiDispatchOutcome = "dispatched" | "unconfirmed" | "settled" | "none";

/** A student repository above this size (GitHub's `size`, KB) is not grafted: the pass settles `ci_unavailable`. */
export const GRAFT_REPO_MAX_KB = 200 * 1024;
/** Tries of a graft within one `project.ci` job (the queue retries nothing), and the wait before the n-th retry, × n. */
const GRAFT_TRIES = 3;
const GRAFT_RETRY_MS = 2_000;
/** A graded commit's paths kept in its audit entry, at most, by count and by total length. */
const GRAFT_AUDIT_PATHS = 100;
const GRAFT_AUDIT_CHARS = 8 * 1024;

/**
 * The distribution commit a pass grafts from (ADR-132 §2): the snapshot's
 * (`source_sha`), or — a snapshot read from the source while no
 * distribution existed, a sha the distribution lacks — the distribution's
 * head of its first branch.
 */
async function distributionCommit(octokit: Octokit, { project, sourceSha }: LoadedPass): Promise<string> {
  const { owner, repo } = ownerRepo(project.distributionFullName!);
  const known = await unless404(
    async () => (await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: sourceSha })).data.sha,
  );
  if (known !== null) return known;
  const head = await branchHead(octokit, owner, repo, project.branches[0]!);
  if (head === null) throw new Error("the distribution repository has no handed-out branch");
  return head;
}

/** A pass's graft: its graded commit (null: the target already holds the graded paths), or why it has none. */
type GraftOutcome = { graft: Graft | null; distributionSha: string | null } | { failed: "missing" | "too_large" | "failed" };

/**
 * The pass's graded commit (ADR-132 §2), built before its claim: the
 * target with the protected list of the distribution commit. The
 * repository is read first — gone (`missing`), or above
 * {@link GRAFT_REPO_MAX_KB} (`too_large`) —; any failure, GitHub's, git's or
 * one the student's tree causes, is tried again up to {@link GRAFT_TRIES}
 * times in the job, each try with a fresh installation client (a token
 * near its expiry would fail them all), then is `failed`.
 */
async function graftPass(app: FastifyInstance, config: AppConfig, loaded: LoadedPass, target: string): Promise<GraftOutcome> {
  const { pass, repo, project } = loaded;
  if (project.distributionFullName === null) return { graft: null, distributionSha: null };
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  for (let attempt = 1; ; attempt++) {
    try {
      const client = await projectClient(app.db, config, project, app.log);
      if (!client) throw new Error("graft: no installation client");
      const size = await unless404(async () => (await client.octokit.request("GET /repos/{owner}/{repo}", { owner, repo: name })).data.size);
      if (size === null) return { failed: "missing" };
      if (size > GRAFT_REPO_MAX_KB) return { failed: "too_large" };
      const distributionSha = await distributionCommit(client.octokit, loaded);
      const graft = await buildGradedCommit({
        token: client.token,
        studentRepo: repo.fullName!,
        distributionRepo: project.distributionFullName,
        target,
        distributionSha,
        paths: project.protectedFiles,
        passId: pass.id,
        at: pass.createdAt,
      });
      return { graft, distributionSha };
    } catch (err) {
      app.log.warn({ err, repo: repo.id, pass: pass.id, attempt }, "graft: the graded commit could not be built");
      if (attempt >= GRAFT_TRIES) return { failed: "failed" };
      await new Promise((resolve) => setTimeout(resolve, GRAFT_RETRY_MS * attempt));
    }
  }
}

/** A graded commit's paths as the audit and the staff's line keep them (ADR-132 §6): their count, and the first ones, capped by count and length. */
function cappedPaths(paths: readonly string[]): { count: number; paths: string[] } {
  let chars = 0;
  return { count: paths.length, paths: paths.slice(0, GRAFT_AUDIT_PATHS).filter((path) => (chars += path.length) <= GRAFT_AUDIT_CHARS) };
}

/** A graft's audit entry (ADR-132 §6): its shas and paths, the paths capped by count and length; or why it failed. */
async function auditGraft(db: Db | Tx, { pass, repo, project }: LoadedPass, target: string, outcome: GraftOutcome): Promise<void> {
  const base = { ...SYSTEM_ACTOR, subjectType: "project_repo" as const, subjectId: repo.id };
  if ("failed" in outcome) {
    await audit(db, { ...base, action: "project_repo.grade_graft_failed", payload: { projectId: project.id, passId: pass.id, target, cause: outcome.failed } });
    return;
  }
  if (!outcome.graft) return;
  await audit(db, {
    ...base,
    action: "project_repo.grade_grafted",
    payload: { projectId: project.id, passId: pass.id, target, gradedSha: outcome.graft.sha, distributionSha: outcome.distributionSha, ...cappedPaths(outcome.graft.paths) },
  });
}

/**
 * The `project.ci` job: one pass's graded commit (ADR-132 §2) and its
 * `quiz-grade` dispatch. Nothing for a pass gone, closed, already claimed
 * (its `sha` set), or whose project left `criteria` or schema 3. A pass
 * whose scope holds no automatic criterion gets its graded commit, for its
 * review, but no dispatch. A graft that cannot be built settles the pass
 * at once: `repo_missing` for a repository GitHub lost, else
 * `ci_unavailable` (audited `project_repo.grade_graft_failed` when that
 * settled it), never a 24 h silence. Audited per graft
 * (`project_repo.grade_grafted`, in the claim's transaction) and per
 * dispatch sent, the one entry of a CI pass's dispatch:
 * `project.review_dispatched` (the final pass, a Regrade) or
 * `project.checkpoint_dispatched` (a milestone).
 */
export async function runCiDispatch(app: FastifyInstance, config: AppConfig, job: CiDispatchJob): Promise<CiDispatchOutcome> {
  const db = app.db;
  const loaded = await loadPass(db, job.passId);
  if (!loaded || loaded.pass.sha !== "" || loaded.pass.closedAt !== null) return "none";
  const settled = async (reason: CriterionReason) => ((await settle(app, loaded, { reason })) ? "settled" : "none");
  const { pass, repo, project, scope } = loaded;
  /** GitHub no longer has the repository: terminal, marked deleted. */
  const gone = async () => {
    await markRepoDeleted(db, repo.id, app.clock.now(), "dispatch");
    return settled("repo_missing");
  };
  // Without an automatic criterion in scope a reason writes no row: whatever settles such a pass, its review follows.
  const target = await passTarget(db, repo, project, scope);
  if (target === null) return settled("no_commit");
  if (repo.deletedAt !== null || repo.fullName === null) return settled("repo_missing");
  // Archived (as its lock, H8): Actions cannot run there, nothing is written nor dispatched; the teacher grades.
  if (repo.archivedAt !== null) return settled("ci_unavailable");
  // No installation, or its client cannot be made: nothing is written nor dispatched, the teacher grades.
  const client = await projectClient(db, config, project, app.log);
  if (!client) return settled("ci_unavailable");
  const grafted = await graftPass(app, config, loaded, target);
  if ("failed" in grafted && grafted.failed === "missing") return gone();
  if ("failed" in grafted) {
    // Audited only when this settled the pass: a Regrade may have closed it meanwhile.
    const outcome = await settled("ci_unavailable");
    if (outcome === "settled") await auditGraft(db, loaded, target, grafted);
    return outcome;
  }
  const { graft, distributionSha } = grafted;
  // The claim: the target and its graded commit recorded before GitHub is called, so a pass is never sent twice;
  // the graft's audit in the same transaction, so no pushed graft goes unaudited.
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(gradeDispatches)
      .set({ sha: target, gradedSha: graft?.sha ?? null, distributionSha, graftedPaths: graft ? cappedPaths(graft.paths) : null })
      .where(and(eq(gradeDispatches.id, pass.id), eq(gradeDispatches.sha, ""), OPEN))
      .returning({ id: gradeDispatches.id });
    if (row) await auditGraft(tx, loaded, target, grafted);
    return row !== undefined;
  });
  if (!claimed) return "none";
  // No automatic criterion in scope: a run would be read for nothing; settled now, the review reads the graded commit.
  if (automaticLeaves(loaded).length === 0) return settled("no_result");
  const payload = {
    sha: graft?.sha ?? target,
    nonce: pass.nonce!,
    pass: scope.milestone === null ? "final" : "milestone",
    ...(scope.milestone === null ? {} : { milestone: scope.milestone }),
  };
  const sent = await postDispatch(app, client.octokit, repo.fullName, QUIZ_GRADE_EVENT, payload, pass.id);
  await audit(db, {
    ...SYSTEM_ACTOR,
    action: pass.trigger === "checkpoint" ? "project.checkpoint_dispatched" : "project.review_dispatched",
    subjectType: "project",
    subjectId: project.id,
    payload: { repoId: repo.id, passId: pass.id, trigger: pass.trigger, checkpointId: pass.checkpointId, sha: target, outcome: sent },
  });
  // A 404: the repository gone (terminal); any other refusal (Actions off, archived on GitHub): the CI is unavailable.
  if (sent === "missing") return gone();
  if (sent === "refused") return settled("ci_unavailable");
  return sent;
}

// ---------------------------------------------------------------- the intake

/**
 * THE entry of a completed run (the `workflow_run` webhook, the
 * reconciliation): a dispatched run of a project graded by criteria on a
 * schema-3 snapshot is its CI's graded run, handed to
 * {@link intakeGradedRun} — never a review nor a score; any other goes to
 * `ingestCompletedRun`. The grade run's id, or null.
 */
export async function ingestRun(app: FastifyInstance, octokit: Octokit, ctx: RepoContext, run: CompletedRun): Promise<string | null> {
  if (runKind(run) === "review" && (await ciGraded(app.db, ctx.project))) {
    await intakeGradedRun(app, octokit, ctx, run);
    return null;
  }
  return ingestCompletedRun(app, octokit, ctx, run);
}

/** What became of a completed graded run. */
export type IntakeOutcome = "ignored" | "accepted" | "ci_tampered" | "no_result";

/**
 * A run that may be a pass's graded run, by what the run itself says
 * (ADR-119 §6): the grading workflow, dispatched, by the App's bot, its
 * first attempt — a student's own dispatch, a re-run, another workflow
 * are never one.
 */
export function mayBeGradedRun(run: Pick<CompletedRun, "path" | "event" | "triggeredBy" | "runAttempt">): boolean {
  return run.path === GRADING_WORKFLOW_PATH && run.event === "repository_dispatch" && run.triggeredBy === "app" && run.runAttempt === 1;
}

/**
 * A completed graded run of a schema-3 project's repository. Ignored unless
 * {@link mayBeGradedRun} and its name carries the nonce of an open pass of
 * the repository; then the protected files, the artifact, and the pass
 * settled. GitHub failing throws: the delivery is retried, the
 * reconciliation reads the run again, and the 24 h end it. Idempotent: a
 * settled pass accepts nothing more.
 */
export async function intakeGradedRun(app: FastifyInstance, octokit: Octokit, ctx: RepoContext, run: CompletedRun): Promise<IntakeOutcome> {
  if (!mayBeGradedRun(run) || ctx.repo.fullName === null) return "ignored";
  const [found] = await app.db
    .select({ id: gradeDispatches.id })
    .from(gradeDispatches)
    .where(and(eq(gradeDispatches.repoId, ctx.repo.id), OPEN, ne(gradeDispatches.sha, ""), sql`strpos(${run.title}, ${gradeDispatches.nonce}) > 0`))
    .limit(1);
  const loaded = found ? await loadPass(app.db, found.id) : null;
  if (!loaded || !loaded.project.distributionFullName) return "ignored";
  const tampered = await tamperedPaths(octokit, loaded, run.headSha);
  if (tampered.target.length + tampered.head.length > 0) {
    if (await settle(app, loaded, { reason: "ci_tampered" })) {
      await audit(app.db, {
        ...SYSTEM_ACTOR,
        action: "project_repo.ci_tampered",
        subjectType: "project_repo",
        subjectId: ctx.repo.id,
        payload: { projectId: loaded.project.id, passId: loaded.pass.id, workflowRunId: run.workflowRunId, ...tampered },
      });
    }
    return "ci_tampered";
  }
  const { owner, repo } = ownerRepo(ctx.repo.fullName);
  const bytes = await fetchResultsArtifact(octokit, owner, repo, run.workflowRunId);
  // Not UTF-8: no result. Within the inflation budget: `RESULTS_FILE_MAX_BYTES`.
  const results = typeof bytes === "string" ? null : readResults(decodeUtf8(bytes) ?? "");
  await settle(app, loaded, results === null ? { reason: "no_result" } : { results, workflowRunId: run.workflowRunId });
  return results === null ? "no_result" : "accepted";
}

/** A commit's blobs and links (`ls-tree -r`), or null when GitHub truncated the listing. */
async function treeOf(octokit: Octokit, fullName: string, sha: string): Promise<CollectionTreeEntry[] | null> {
  const { owner, repo } = ownerRepo(fullName);
  const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: sha });
  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "true",
  });
  if (tree.truncated) return null;
  return tree.tree.filter((e) => e.type === "blob" && e.path).map((e) => ({ mode: e.mode ?? "", sha: e.sha ?? "", path: e.path! }));
}

/**
 * The protected paths whose entry differs between `tree` and the
 * distribution's `reference` (choice c: all from one sha): a path, or
 * everything under a directory — a file added under one makes them differ.
 * A truncated listing knows nothing of what it left out: every path counts
 * as differing.
 */
function differing(tree: CollectionTreeEntry[] | null, reference: CollectionTreeEntry[] | null, paths: readonly string[]): string[] {
  if (tree === null || reference === null) return [...paths];
  return treeDifference(tree, reference).filter((path) => isProtected(path, paths));
}

/** The distribution's commits that changed the grading workflow, read at most: a longer history is not read further. */
const WORKFLOW_HISTORY_MAX = 100;

/**
 * Whether the run's head holds a grading workflow a `squash` distribution
 * handed out (ADR-132 §3), where every commit of its branch was handed out
 * (the build and each sync): the reference's, else one of the versions its
 * history holds (GitHub's list of the commits that changed the file). A
 * link in the file's place never is one; a truncated listing knows nothing
 * of it.
 */
async function handedOutWorkflow(
  octokit: Octokit,
  distribution: string,
  branch: string,
  atHead: CollectionTreeEntry[] | null,
  reference: CollectionTreeEntry[] | null,
): Promise<boolean> {
  if (atHead === null) return false;
  if (differing(atHead, reference, [GRADING_WORKFLOW_PATH]).length === 0) return true;
  const entry = atHead.find((e) => e.path === GRADING_WORKFLOW_PATH);
  if (entry === undefined || (entry.mode !== "100644" && entry.mode !== "100755")) return false;
  const { owner, repo } = ownerRepo(distribution);
  const { data: commits } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner,
    repo,
    sha: branch,
    path: GRADING_WORKFLOW_PATH,
    per_page: WORKFLOW_HISTORY_MAX,
  });
  for (const commit of commits) {
    if ((await referenceBlob(octokit, owner, repo, GRADING_WORKFLOW_PATH, commit.sha))?.sha === entry.sha) return true;
  }
  return false;
}

/**
 * What differs from what the pass handed out (ADR-119 choice c as amended
 * by ADR-132 §3): at the pass's graded commit (its target when nothing was
 * grafted), the project's protected list (`criteria.yml` included) against
 * the distribution commit it grafted from — a sanity check of the graft —;
 * at the run's head (the default branch's, which GitHub ran), the grading
 * workflow, which must be one the distribution handed out: under `squash`
 * any version of its branch's history, under `whole` (whose history is the
 * source's, drafts included) its live head's only. A pass claimed before
 * ADR-132 has no recorded distribution commit: the distribution's head
 * stands for it. The distribution's branch is the snapshot's, its first.
 */
async function tamperedPaths(octokit: Octokit, { pass, repo, project }: LoadedPass, headSha: string): Promise<{ target: string[]; head: string[] }> {
  const distribution = project.distributionFullName!;
  const { owner, repo: name } = ownerRepo(distribution);
  const branch = project.branches[0]!;
  const liveHead = async () => {
    const head = await branchHead(octokit, owner, name, branch);
    if (head === null) throw new Error("the distribution repository has no handed-out branch");
    return head;
  };
  const distributionTree = await treeOf(octokit, distribution, pass.distributionSha ?? (await liveHead()));
  const graded = pass.gradedSha ?? pass.sha;
  const atGraded = await treeOf(octokit, repo.fullName!, graded);
  const atHead = headSha === graded ? atGraded : await treeOf(octokit, repo.fullName!, headSha);
  const workflowHandedOut =
    project.sourceStrategy === "squash"
      ? await handedOutWorkflow(octokit, distribution, branch, atHead, distributionTree)
      : differing(atHead, await treeOf(octokit, distribution, await liveHead()), [GRADING_WORKFLOW_PATH]).length === 0;
  return {
    target: differing(atGraded, distributionTree, project.protectedFiles),
    head: workflowHandedOut ? [] : [GRADING_WORKFLOW_PATH],
  };
}

// ---------------------------------------------------------------- the 24 h, retention, scope

/**
 * The ticker's sweep (the server's clock): every pass still open
 * {@link RESULT_WAIT_MS} after its dispatch (its claim, never dispatched)
 * settled `no_result`. No HTTP. The passes settled.
 */
export async function expireCiPasses(app: FastifyInstance, now: Date): Promise<number> {
  const due = await app.db
    .select({ id: gradeDispatches.id })
    .from(gradeDispatches)
    .where(and(OPEN, lt(sql`coalesce(${gradeDispatches.dispatchedAt}, ${gradeDispatches.createdAt})`, new Date(now.getTime() - RESULT_WAIT_MS))));
  let settled = 0;
  for (const { id } of due) {
    const loaded = await loadPass(app.db, id);
    if (loaded) {
      if (await settle(app, loaded, { reason: "no_result" })) settled += 1;
    } else {
      // Its project left `criteria` (or its checkpoint is gone): nothing to write, the pass closes.
      await app.db.update(gradeDispatches).set({ closedAt: now }).where(and(eq(gradeDispatches.id, id), OPEN));
    }
  }
  return settled;
}

/** Retention (N-DATA-03, ADR-119 §6): the stored results of the projects released long enough ago (`releasedBefore`). Run by `reconcile.repos`. */
export async function purgeCiResults(db: Db, now: Date): Promise<number> {
  const passes = db
    .select({ id: gradeDispatches.id })
    .from(gradeDispatches)
    .where(inArray(gradeDispatches.repoId, releasedBefore(db, now)));
  const purged = await db.delete(projectCiResults).where(inArray(projectCiResults.passId, passes)).returning({ passId: projectCiResults.passId });
  return purged.length;
}

/**
 * A CI pass of the repository still open, over a `project_repos` row: the
 * reconciliation keeps reading its runs. With `dispatchedIn`, only a pass
 * whose dispatch GitHub accepted within one of these spans `(from, to]`: its
 * run is overdue, its webhook may be lost (`reconcile.ci`, ADR-011's
 * addendum of 2026-11-22).
 */
export const ciPassOpen = (db: Db | Tx, dispatchedIn?: readonly (readonly [Date, Date])[]) =>
  exists(
    db
      .select({ id: gradeDispatches.id })
      .from(gradeDispatches)
      .where(
        and(
          eq(gradeDispatches.repoId, projectRepos.id),
          OPEN,
          dispatchedIn === undefined
            ? undefined
            : or(...dispatchedIn.map(([from, to]) => and(gt(gradeDispatches.dispatchedAt, from), lte(gradeDispatches.dispatchedAt, to)))),
        ),
      ),
  );

/** The oldest dispatch of the repository's open CI passes, over a `project_repos` row: `reconcile.ci` reads the oldest first. */
export const oldestOpenCiDispatch = sql`(SELECT min(${gradeDispatches.dispatchedAt}) FROM ${gradeDispatches}
  WHERE ${gradeDispatches.repoId} = ${projectRepos.id} AND ${gradeDispatches.nonce} IS NOT NULL AND ${gradeDispatches.closedAt} IS NULL)`;
