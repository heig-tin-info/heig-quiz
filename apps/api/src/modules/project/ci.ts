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
 * Regrade claims a `regrade` row ({@link claimRegrades}) and retires the
 * nonce of the pass it replaces. Each pass is queued on `project.ci` at a
 * slot of its App installation's pace — one dispatch every
 * {@link DISPATCH_PACE_MS} (choice f, {@link sendCiPasses}).
 *
 * **The dispatch** ({@link runCiDispatch}, the `project.ci` job): the
 * target commit — the last student push received by the effective deadline
 * (by the checkpoint's date for a milestone, `lastStudentPush`) — recorded
 * on the row before GitHub is called (at most once: a row whose `sha` is
 * set is never sent again), then `repository_dispatch` `quiz-grade` with
 * `{ sha, nonce, pass, milestone? }`. No commit, a repository gone, or one
 * that cannot run Actions (archived as its lock, GitHub's refusal) settles
 * the pass at once with its reason (`no_commit`, `repo_missing`,
 * `ci_unavailable`); a call whose answer never came is left unconfirmed,
 * its 24 h then settle it.
 *
 * **The intake** ({@link intakeGradedRun}), from the ONE ingestion path
 * (`ingestCompletedRun`: the `workflow_run` webhook, and the
 * reconciliation's listing of a quiet repository's runs, ADR-011 — no poll
 * of its own): a run is accepted only if its workflow is
 * `.github/workflows/grading.yml`, its event `repository_dispatch`, its
 * triggering actor the App's bot, its attempt the first, and its name
 * carries the nonce of a live pass of the repository; anything else is
 * ignored. Accepted, its protected files are compared with the
 * distribution's at one sha the distribution handed out (its head, choice
 * c) — `criteria.yml` and the project's protected list at the target
 * commit, the grading workflow at the run's head — and a difference settles
 * the pass `ci_tampered` (audited `project_repo.ci_tampered`). Otherwise
 * its `results` artifact is read (`github/artifact.ts`: the signed blob URL
 * never leaves it), validated by `ResultsFile`, stored
 * (`project_ci_results`, the logs staff-only), and mapped onto the pass's
 * automatic criteria (`checkOutcomes`): one proposed `auto` row each,
 * `no_result` for a criterion the file does not answer. A refused or
 * missing artifact settles the pass `no_result`.
 *
 * **The 24 h** ({@link expireCiPasses}, the ticker's, on the server's
 * clock): a pass with no accepted run 24 h after its dispatch is settled
 * `no_result`.
 *
 * A graded run is never a review nor a score (`runKind(run, true)` is
 * `graded`): it fills neither the review slot nor the `GRADE` one.
 * Settling writes through the single writer (`writeCriterionGrades`),
 * never over a held criterion. The LLM pass of a schema-3 project is L-06c's.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { Octokit } from "octokit";

import { CheckResult, CriterionId, ResultsFile, snapshotSettings } from "@quiz/contracts";
import {
  checkOutcomes,
  classifyCriterion,
  effectiveDeadline,
  GRADING_WORKFLOW_PATH,
  RESULT_LOG_MAX_BYTES,
  RESULTS_FILE_MAX_BYTES,
  tailUtf8,
  type CheckResults,
  type CriteriaLeaf,
  type CriterionReason,
  type ParsedCriteria,
} from "@quiz/domain";

import { audit, SYSTEM_ACTOR } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import {
  githubOrganizations,
  gradeDispatches,
  projectCiResults,
  projectCriteria,
  projectDispatchSlots,
  projectRepos,
  projects,
} from "../../db/schema.js";
import { branchHead, githubStatus, installationClient, ownerRepo } from "../../github/app.js";
import { fetchResultsArtifact } from "../../github/artifact.js";
import { PROJECT_CI_QUEUE } from "../../jobs.js";
import { projectInstallation } from "../github/service.js";
import { CRITERIA_FILE } from "./criteria.js";
import { heldCriteria, writeCriterionGrades, type CriterionGradeInput } from "./criterionGrades.js";
import type { CompletedRun } from "./grading.js";
import { ciNonce, passScope, type PassScope } from "./milestone.js";
import { hintProjectStaff, markRepoDeleted, type RepoContext, type RepoRow } from "./repos.js";
import { lastStudentPush } from "./review.js";
import type { ProjectRow } from "./views.js";

/** The `repository_dispatch` event a graded run answers. */
export const QUIZ_GRADE_EVENT = "quiz-grade";
/** One dispatch per App installation this often, at most (choice f): the CI runners are shared. */
export const DISPATCH_PACE_MS = 15_000;
/** A pass with no accepted run this long after its dispatch is settled `no_result` (choice d). */
export const RESULT_WAIT_MS = 24 * 3_600_000;
/** The stored results' retention after the release (N-DATA-03), as the runner's evidence files. */
const RESULTS_MONTHS = 6;

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
  scope: PassScope<CriteriaLeaf>;
}

/** A pass of a project still graded by criteria on a schema-3 snapshot, with its scope; null otherwise. */
async function loadPass(db: Db | Tx, passId: string): Promise<LoadedPass | null> {
  const [row] = await db
    .select({ pass: gradeDispatches, repo: projectRepos, project: projects, snapshot: projectCriteria.criteria })
    .from(gradeDispatches)
    .innerJoin(projectRepos, eq(projectRepos.id, gradeDispatches.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(projectCriteria, eq(projectCriteria.projectId, projects.id))
    .where(eq(gradeDispatches.id, passId));
  if (!row || row.pass.nonce === null || row.project.gradingMode !== "criteria" || row.snapshot.schemaVersion !== 3) return null;
  const scope = await passScope(db, row.project.id, row.snapshot.leaves, row.pass.checkpointId ?? undefined);
  return scope ? { ...row, scope } : null;
}

/** A pass still waiting for its run: neither retired nor settled. */
const WAITING = and(isNotNull(gradeDispatches.nonce), isNull(gradeDispatches.retiredAt), isNull(gradeDispatches.settledAt))!;

// ---------------------------------------------------------------- claims and pace

/**
 * A Regrade's passes (ADR-119 §6: always a new dispatch, with a new nonce),
 * one `regrade` row per repository, each retiring the live final pass or
 * earlier Regrade of its repository (a milestone's stays). The pass ids.
 */
export async function claimRegrades(db: Db, repoIds: readonly string[], now: Date): Promise<string[]> {
  if (repoIds.length === 0) return [];
  return db.transaction(async (tx) => {
    await tx
      .update(gradeDispatches)
      .set({ retiredAt: now })
      .where(and(inArray(gradeDispatches.repoId, [...repoIds]), isNull(gradeDispatches.checkpointId), WAITING));
    const rows = await tx
      .insert(gradeDispatches)
      .values(repoIds.map((repoId) => ({ id: randomUUID(), repoId, trigger: "regrade" as const, sha: "", nonce: ciNonce(), createdAt: now })))
      .returning({ id: gradeDispatches.id });
    return rows.map((r) => r.id);
  });
}

/**
 * The next dispatch slot of an installation, reserved in one upsert: now
 * when the last is {@link DISPATCH_PACE_MS} behind, else that much after it.
 */
export async function reserveSlot(db: Db, installationId: number, now: Date): Promise<Date> {
  const pace = sql`make_interval(secs => ${DISPATCH_PACE_MS / 1000})`;
  const [row] = await db
    .insert(projectDispatchSlots)
    .values({ installationId, nextAt: new Date(now.getTime() + DISPATCH_PACE_MS) })
    .onConflictDoUpdate({
      target: projectDispatchSlots.installationId,
      set: { nextAt: sql`greatest(${projectDispatchSlots.nextAt}, ${now.toISOString()}::timestamptz) + ${pace}` },
    })
    .returning({ nextAt: projectDispatchSlots.nextAt });
  return new Date(row!.nextAt.getTime() - DISPATCH_PACE_MS);
}

/**
 * The passes queued on `project.ci`, each at its installation's next slot
 * (`startAfter`); without a queue (`JOBS_DISABLED=1`: a Regrade in the
 * tests), dispatched here, one after the other. The ticker sends nothing
 * without a queue: its passes wait for their 24 h, or a Regrade.
 */
export async function sendCiPasses(app: FastifyInstance, config: AppConfig, passIds: readonly string[]): Promise<void> {
  if (passIds.length === 0) return;
  if (!app.boss) {
    for (const passId of passIds) {
      await runCiDispatch(app, config, { passId }).catch((err: unknown) => app.log.error({ err, pass: passId }, "ci dispatch failed"));
    }
    return;
  }
  const rows = await app.db
    .select({ id: gradeDispatches.id, installationId: githubOrganizations.installationId })
    .from(gradeDispatches)
    .innerJoin(projectRepos, eq(projectRepos.id, gradeDispatches.repoId))
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .innerJoin(githubOrganizations, eq(githubOrganizations.id, projects.orgId))
    .where(inArray(gradeDispatches.id, [...passIds]));
  for (const row of rows) {
    const now = app.clock.now();
    const slot = row.installationId === null ? now : await reserveSlot(app.db, row.installationId, now);
    const job: CiDispatchJob = { passId: row.id };
    await app.boss.send(PROJECT_CI_QUEUE, job, slot > now ? { startAfter: slot } : undefined);
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
 * The pass settled — at most once, by a conditional write that a retired
 * pass loses too — and its automatic criteria's rows written, proposed
 * (`writeCriterionGrades`: a held criterion is left alone): 0 points with
 * the reason, or each criterion's points from the results (`no_result` for
 * one the file does not answer), its rationale the fraction. The results
 * are stored first, the logs staff-only. False when another settled it.
 */
async function settle(app: FastifyInstance, loaded: LoadedPass, settlement: Settlement): Promise<boolean> {
  const db = app.db;
  const now = app.clock.now();
  const { pass, scope } = loaded;
  const [won] = await db
    .update(gradeDispatches)
    .set({ settledAt: now })
    .where(and(eq(gradeDispatches.id, pass.id), WAITING))
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
    await db.insert(projectCiResults).values({ passId: pass.id, repoId: pass.repoId, workflowRunId, results, createdAt: now }).onConflictDoNothing();
    const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
    inputs = checkOutcomes(leaves, results).map((outcome) =>
      "reason" in outcome
        ? row(byId.get(outcome.id)!, { points: 0, reason: outcome.reason })
        : row(byId.get(outcome.id)!, { points: outcome.points, rationale: fraction(results.criteria[outcome.id]!.score), reason: null }),
    );
  }
  // Not held, nor already this pass's (a settle replayed); the writer checks again under its lock.
  const held = await heldCriteria(db, pass.repoId, pass.id);
  await writeCriterionGrades(
    db,
    pass.repoId,
    inputs.filter((input) => !held.has(input.criterionId)),
    now,
  );
  await hintProjectStaff(db, [loaded.project.id]);
  return true;
}

// ---------------------------------------------------------------- the dispatch

/** What became of a pass's dispatch. */
export type CiDispatchOutcome = "dispatched" | "unconfirmed" | "settled" | "none";

/**
 * The `project.ci` job: one pass's `quiz-grade` dispatch. Nothing for a
 * pass gone, retired, settled, already claimed (its `sha` set), or whose
 * project left `criteria` or schema 3. Audited per dispatch sent:
 * `project.review_dispatched` (the final pass, a Regrade) or
 * `project.checkpoint_dispatched` (a milestone).
 */
export async function runCiDispatch(app: FastifyInstance, config: AppConfig, job: CiDispatchJob): Promise<CiDispatchOutcome> {
  const db = app.db;
  const loaded = await loadPass(db, job.passId);
  if (!loaded || loaded.pass.sha !== "" || loaded.pass.retiredAt !== null || loaded.pass.settledAt !== null) return "none";
  const { pass, repo, project, scope } = loaded;
  const target = repo.githubRepoId === null ? null : await lastStudentPush(db, repo.githubRepoId, project.branches, scope.dueAt ?? effectiveDeadline(repo, project));
  const settled = async (reason: CriterionReason) => ((await settle(app, loaded, { reason })) ? "settled" : "none");
  if (target === null) return settled("no_commit");
  if (repo.deletedAt !== null || repo.fullName === null) return settled("repo_missing");
  // Archived (as its lock, H8): Actions cannot run there, nothing is dispatched; the teacher grades.
  if (repo.archivedAt !== null) return settled("ci_unavailable");
  const org = await projectInstallation(db, project.orgId);
  if (!org) return settled("ci_unavailable");
  // The claim: the target recorded before GitHub is called, so a pass is never sent twice.
  const [claimed] = await db
    .update(gradeDispatches)
    .set({ sha: target })
    .where(and(eq(gradeDispatches.id, pass.id), eq(gradeDispatches.sha, ""), WAITING))
    .returning({ id: gradeDispatches.id });
  if (!claimed) return "none";
  const { octokit } = await installationClient(config, org.installationId);
  const outcome = await sendDispatch(app, octokit, loaded, target);
  const action = pass.trigger === "checkpoint" ? "project.checkpoint_dispatched" : "project.review_dispatched";
  await audit(db, {
    ...SYSTEM_ACTOR,
    action,
    subjectType: "project",
    subjectId: project.id,
    payload: { repoId: repo.id, passId: pass.id, trigger: pass.trigger, checkpointId: pass.checkpointId, sha: target, outcome },
  });
  return outcome === "dispatched" || outcome === "unconfirmed" ? outcome : "settled";
}

/**
 * The dispatch sent. Accepted: `dispatched_at`. No answer, or a 5xx GitHub
 * may have acted on: unconfirmed, never sent again (its 24 h settle it). A
 * 404: the repository gone (terminal), `repo_missing`. Any other refusal
 * (Actions off, the repository archived on GitHub): `ci_unavailable`.
 */
async function sendDispatch(
  app: FastifyInstance,
  octokit: Octokit,
  loaded: LoadedPass,
  sha: string,
): Promise<"dispatched" | "unconfirmed" | "repo_missing" | "ci_unavailable"> {
  const { pass, repo, scope } = loaded;
  const { owner, repo: name } = ownerRepo(repo.fullName!);
  try {
    await octokit.request("POST /repos/{owner}/{repo}/dispatches", {
      owner,
      repo: name,
      event_type: QUIZ_GRADE_EVENT,
      client_payload: {
        sha,
        nonce: pass.nonce!,
        pass: scope.milestone === null ? "final" : "milestone",
        ...(scope.milestone === null ? {} : { milestone: scope.milestone }),
      },
      // At most once: Octokit's retry would send it again after a 5xx GitHub may have acted on.
      request: { retries: 0 },
    });
  } catch (err) {
    const answered = (err as { response?: unknown } | null)?.response !== undefined;
    const status = githubStatus(err) ?? 500;
    if (!answered || status >= 500) {
      app.log.error({ err, repo: repo.fullName }, "ci dispatch: not confirmed, never sent again");
      return "unconfirmed";
    }
    if (status === 404) {
      await markRepoDeleted(app.db, repo.id, app.clock.now(), "dispatch");
      await settle(app, loaded, { reason: "repo_missing" });
      return "repo_missing";
    }
    await settle(app, loaded, { reason: "ci_unavailable" });
    return "ci_unavailable";
  }
  await app.db.update(gradeDispatches).set({ dispatchedAt: app.clock.now() }).where(eq(gradeDispatches.id, pass.id));
  return "dispatched";
}

// ---------------------------------------------------------------- the intake

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
 * A completed graded run of a schema-3 project's repository, from the
 * ingestion (`ingestCompletedRun`). Ignored unless {@link mayBeGradedRun}
 * and its name carries the nonce of a pass of the repository still
 * waiting; then the protected files, the artifact, and the pass settled.
 * GitHub failing throws: the delivery is retried, the reconciliation reads
 * the run again, and the 24 h end it. Idempotent: a settled pass accepts
 * nothing more.
 */
export async function intakeGradedRun(app: FastifyInstance, octokit: Octokit, ctx: RepoContext, run: CompletedRun): Promise<IntakeOutcome> {
  if (!mayBeGradedRun(run) || ctx.repo.fullName === null) return "ignored";
  const [found] = await app.db
    .select({ id: gradeDispatches.id })
    .from(gradeDispatches)
    .where(
      and(eq(gradeDispatches.repoId, ctx.repo.id), WAITING, ne(gradeDispatches.sha, ""), sql`strpos(${run.title}, ${gradeDispatches.nonce}) > 0`),
    )
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
  const results = typeof bytes === "string" ? null : readResults(bytes);
  await settle(app, loaded, results === null ? { reason: "no_result" } : { results, workflowRunId: run.workflowRunId });
  return results === null ? "no_result" : "accepted";
}

/**
 * A `results.json` validated (`ResultsFile`, ADR-119 §4): null when it is
 * over its cap, not UTF-8 JSON, or has no `criteria` object — no result at
 * all. An entry that is malformed (or whose id is not a criterion id) is
 * dropped alone: its criterion gets `no_result`. `$schema` and any other
 * key are never read. Each log keeps its tail.
 */
export function readResults(bytes: Uint8Array): CheckResults | null {
  if (bytes.length > RESULTS_FILE_MAX_BYTES) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(data) || !isObject(data.criteria)) return null;
  const valid = Object.entries(data.criteria).filter(([id, entry]) => CriterionId.safeParse(id).success && CheckResult.safeParse(entry).success);
  const file = ResultsFile.safeParse({ criteria: Object.fromEntries(valid) });
  if (!file.success) return null;
  const criteria: CheckResults["criteria"] = {};
  for (const [id, { score, log }] of Object.entries(file.data.criteria)) {
    criteria[id] = log === undefined ? { score } : { score, log: tailUtf8(log, RESULT_LOG_MAX_BYTES) };
  }
  return { criteria };
}

/** A commit's blobs by path (`mode:sha`, so a link in a file's place differs), or null when GitHub truncated the listing. */
async function treeOf(octokit: Octokit, fullName: string, sha: string): Promise<Map<string, string> | null> {
  const { owner, repo } = ownerRepo(fullName);
  const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", { owner, repo, commit_sha: sha });
  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: commit.tree.sha,
    recursive: "true",
  });
  if (tree.truncated) return null;
  return new Map(tree.tree.filter((e) => e.type === "blob" && e.path).map((e) => [e.path!, `${e.mode}:${e.sha}`]));
}

/**
 * The protected paths whose blobs differ between `tree` and the
 * distribution's `reference` (choice c: all from one sha): a path, or
 * everything under a directory — a file added under one makes them differ.
 * A truncated listing knows nothing of what it left out: every path counts
 * as differing.
 */
function differing(tree: Map<string, string> | null, reference: Map<string, string> | null, paths: readonly string[]): string[] {
  if (tree === null || reference === null) return [...paths];
  const covered = (path: string) => paths.some((p) => path === p || path.startsWith(`${p}/`));
  const all = new Set([...tree.keys(), ...reference.keys()].filter(covered));
  return [...all].filter((path) => tree.get(path) !== reference.get(path)).sort();
}

/**
 * What differs from the distribution's head (the one sha it last handed
 * out, choice c): at the pass's target commit, `criteria.yml` and the
 * project's protected list — the commands and the code the tool read —;
 * at the run's head (the default branch's, which GitHub ran), the grading
 * workflow itself.
 */
async function tamperedPaths(octokit: Octokit, { pass, repo, project }: LoadedPass, headSha: string): Promise<{ target: string[]; head: string[] }> {
  const distribution = project.distributionFullName!;
  const { owner, repo: name } = ownerRepo(distribution);
  const reference = await branchHead(octokit, owner, name, project.branches[0]!);
  if (reference === null) throw new Error("the distribution repository has no handed-out branch");
  const distributionTree = await treeOf(octokit, distribution, reference);
  const atTarget = await treeOf(octokit, repo.fullName!, pass.sha);
  const atHead = headSha === pass.sha ? atTarget : await treeOf(octokit, repo.fullName!, headSha);
  return {
    target: differing(atTarget, distributionTree, [...new Set([CRITERIA_FILE, ...project.protectedFiles])]),
    head: differing(atHead, distributionTree, [GRADING_WORKFLOW_PATH]),
  };
}

// ---------------------------------------------------------------- the 24 h, retention

/**
 * The ticker's sweep (the server's clock): every pass still waiting
 * {@link RESULT_WAIT_MS} after its dispatch (its claim, never dispatched)
 * settled `no_result`. No HTTP. The passes settled.
 */
export async function expireCiPasses(app: FastifyInstance, now: Date): Promise<number> {
  const due = await app.db
    .select({ id: gradeDispatches.id })
    .from(gradeDispatches)
    .where(and(WAITING, lt(sql`coalesce(${gradeDispatches.dispatchedAt}, ${gradeDispatches.createdAt})`, new Date(now.getTime() - RESULT_WAIT_MS))));
  let settled = 0;
  for (const { id } of due) {
    const loaded = await loadPass(app.db, id);
    if (loaded) {
      if (await settle(app, loaded, { reason: "no_result" })) settled += 1;
    } else {
      // Its project left `criteria` (or its checkpoint is gone): nothing to write, the pass ends.
      await app.db.update(gradeDispatches).set({ settledAt: now }).where(and(eq(gradeDispatches.id, id), WAITING));
    }
  }
  return settled;
}

/** Retention (N-DATA-03, ADR-119 §6): the stored results of the projects released more than six months ago. Run by `reconcile.repos`. */
export async function purgeCiResults(db: Db, now: Date): Promise<number> {
  const before = new Date(now);
  before.setUTCMonth(before.getUTCMonth() - RESULTS_MONTHS);
  const released = db
    .select({ id: projectRepos.id })
    .from(projectRepos)
    .innerJoin(projects, eq(projects.id, projectRepos.projectId))
    .where(lt(projects.releasedAt, before));
  const purged = await db.delete(projectCiResults).where(inArray(projectCiResults.repoId, released)).returning({ passId: projectCiResults.passId });
  return purged.length;
}

/** A CI pass of a repository still waiting for its run, over a `project_repos` row: the reconciliation keeps reading its runs. */
export const CI_PASS_WAITING = sql`EXISTS (SELECT 1 FROM ${gradeDispatches} WHERE ${gradeDispatches.repoId} = ${projectRepos.id}
  AND ${gradeDispatches.nonce} IS NOT NULL AND ${gradeDispatches.settledAt} IS NULL AND ${gradeDispatches.retiredAt} IS NULL)`;
