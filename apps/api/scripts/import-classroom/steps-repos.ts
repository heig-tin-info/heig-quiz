/**
 * The repositories of the projects and what hangs on them (merge task
 * M8-01b): `student_repos` → `project_repos`, then the runs, the bot commits,
 * the review ledger, the restores and the push receipts. Individual
 * repositories only: a group repository, and every row under one, waits for
 * M8-01c (`repoLeftOut`, one rule, lists them in the parity report as left
 * out on purpose; the row's `group_id` is already read from the group map).
 *
 * The freeze is a repository's in Quiz (M3-05a), classroom's an assignment's:
 * each repository of an applied assignment takes its `deadline_applied_at`,
 * of a frozen one its `frozen_at`; `deadline_committed_at` is read from the
 * `deadline` bot commit. A released project's repositories carry the final
 * score at the import as `released_points` / `released_max` (so nothing reads
 * "changed after release"); `teacher_max` stays null on an imported row
 * (the CI's maximum is read, `resolveFinalScore`). The runs, commits,
 * ledger, restores and receipts are insert-only and immutable: a row present
 * is left alone, whoever wrote it, and parity looks them up by their natural
 * key, so a run Quiz's own ingestion already took is no loss.
 */
import { randomUUID } from "node:crypto";

import { isLiveIndividualRepo, resolveFinalScore, type ScoreLike } from "@quiz/domain";
import { getTableName, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  botCommits,
  gradeDispatches,
  projectGradeRuns,
  projectRepos,
  projectSyncPrs,
  pushReceipts,
  reverts,
} from "../../src/db/schema.js";
import { note, tally, target, written, type Ctx, type OwnedRow } from "./ctx.js";
import type { SourceAssignment, SourceStudentRepo } from "./source.js";
import { assignmentsInScope, carryOwned, repoLeftOut, reposInScope } from "./steps-projects.js";

const CHUNK = 500;
/** Ids per `IN (…)`, for every read of Quiz by a list of ids (here and in the checks). */
export const IN_CHUNK = 2000;

/** The columns of a carried repository the parity checks read back. */
export const REPO_COLUMNS = {
  id: projectRepos.id,
  projectId: projectRepos.projectId,
  teacherPoints: projectRepos.teacherPoints,
  currentGradeRunId: projectRepos.currentGradeRunId,
  frozenGradeRunId: projectRepos.frozenGradeRunId,
  reviewGradeRunId: projectRepos.reviewGradeRunId,
};

/** Why a repository's rows cannot be carried: `repoLeftOut`, or its own row did not make it. */
function childLeftOut(ctx: Ctx, repo: SourceStudentRepo): string | null {
  return repoLeftOut(ctx, repo) ?? (ctx.known.get("student_repos")?.has(repo.id) ? null : "its repository was not carried");
}

/** Inserts in chunks, unless present; the number of rows written. */
async function insertAll<T extends PgTable>(ctx: Ctx, table: T, rows: T["$inferInsert"][], label: string = getTableName(table)): Promise<number> {
  let n = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const done = await ctx.db.insert(table).values(rows.slice(i, i + CHUNK)).onConflictDoNothing().returning();
    n += done.length;
  }
  written(ctx, label, n);
  return n;
}

/** The natural keys Quiz now holds for these ids, read in chunks. */
export async function presentKeys<K extends string | number>(ids: readonly K[], read: (ids: K[]) => Promise<string[]>): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) for (const k of await read(ids.slice(i, i + IN_CHUNK))) found.add(k);
  return found;
}

/** The latest of some timestamped rows: by time, then id (ids are kept, so both sides agree). */
export function latest<T extends { id: string }>(rows: Iterable<T>, at: (row: T) => Date): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (!best || at(row) > at(best) || (at(row).getTime() === at(best).getTime() && row.id > best.id)) best = row;
  }
  return best;
}

interface ChildSpec<T extends { studentRepoId: string }, P extends PgTable, K extends string | number> {
  table: P;
  /** The parity table's name (classroom's). */
  parity: string;
  rows: readonly T[];
  /** The row's natural key, in Quiz and in the source alike. */
  key: (row: T) => string;
  /** A reason to leave a row of a carried repository out, or null. */
  keep?: (row: T) => string | null;
  insert: (row: T) => P["$inferInsert"];
  /** What the read of Quiz is keyed on (the repository's id, or GitHub's). */
  scope: (row: T) => K;
  read: (ids: K[]) => Promise<string[]>;
  label?: string;
}

/**
 * One insert-only child table, end to end: the rows of the repositories in
 * scope, split into carried and left out, inserted unless present, and
 * tallied by looking their keys up in Quiz.
 */
async function carryChild<T extends { studentRepoId: string }, P extends PgTable, K extends string | number>(ctx: Ctx, spec: ChildSpec<T, P, K>) {
  const repos = new Map(reposInScope(ctx).map((r) => [r.id, r]));
  const carry: T[] = [];
  const leftOut = new Map<string, string>();
  let total = 0;
  for (const row of spec.rows) {
    const repo = repos.get(row.studentRepoId);
    if (!repo) continue;
    total += 1;
    const why = childLeftOut(ctx, repo) ?? spec.keep?.(row) ?? null;
    if (why) leftOut.set(spec.key(row), why);
    else carry.push(row);
  }
  await insertAll(ctx, spec.table, carry.map(spec.insert), spec.label);
  const present = await presentKeys([...new Set(carry.map(spec.scope))], spec.read);
  tally(ctx, spec.parity, {
    source: total,
    carried: carry.filter((r) => present.has(spec.key(r))).length,
    leftOut: [...leftOut].map(([k, why]) => `${k}: ${why}`),
  });
  return { carry, leftOut };
}

/** The first `deadline` bot commit of each repository: the deadline commit's trace (strategy `commit`). */
function deadlineCommits(ctx: Ctx): Map<string, Date> {
  const first = new Map<string, Date>();
  for (const b of ctx.snapshot.botCommits) {
    if (b.kind !== "deadline") continue;
    const seen = first.get(b.studentRepoId);
    if (!seen || b.createdAt < seen) first.set(b.studentRepoId, b.createdAt);
  }
  return first;
}

/** What `project_repos` holds of one carried repository: the columns the import owns. */
function repoRow(
  ctx: Ctx,
  r: SourceStudentRepo,
  a: SourceAssignment,
  facts: { scored: (id: string | null) => ScoreLike | null; committed: Map<string, Date> },
): OwnedRow {
  const student = ctx.usersById.get(r.userId);
  const released = a.gradesValidatedAt !== null;
  const final = released
    ? resolveFinalScore({
        teacherPoints: r.teacherPoints,
        teacherMax: null,
        reviewScore: facts.scored(r.llmGradeRunId),
        frozenScore: facts.scored(r.frozenGradeRunId),
        score: facts.scored(r.currentGradeRunId),
      })
    : null;
  return {
    sourceTable: "student_repos",
    sourceId: r.id,
    table: projectRepos,
    label: `${a.name} / ${student ? `${student.givenName} ${student.familyName}` : r.userId}`,
    values: {
      projectId: a.id,
      userId: target(ctx, r.userId),
      groupId: r.groupId === null ? null : (ctx.known.get("assignment_groups")?.get(r.groupId) ?? null),
      githubRepoId: r.githubRepoId,
      fullName: r.fullName,
      defaultBranch: r.defaultBranch,
      provisionStatus: r.provisionStatus,
      provisionError: r.provisionError,
      provisionClaimedAt: r.provisionClaimedAt,
      acceptedAt: r.acceptedAt,
      invitationStatus: r.invitationStatus,
      deadlineAppliedAt: a.deadlineAppliedAt,
      frozenAt: a.frozenAt,
      deadlineCommittedAt: a.deadlineAppliedAt === null ? null : (facts.committed.get(r.id) ?? null),
      lockedAt: r.lockedAt,
      rulesetId: r.rulesetId,
      lastCommitSha: r.lastCommitSha,
      lastCommitAt: r.lastCommitAt,
      ciStatus: r.ciStatus,
      currentGradeRunId: r.currentGradeRunId,
      frozenGradeRunId: r.frozenGradeRunId,
      reviewGradeRunId: r.llmGradeRunId,
      teacherPoints: r.teacherPoints,
      teacherMax: null,
      teacherComment: r.teacherComment,
      teacherGradedBy: target(ctx, r.teacherGradedBy) ?? null,
      teacherGradedAt: r.teacherGradedAt,
      releasedPoints: final?.points ?? null,
      releasedMax: final?.max ?? null,
      releasedComment: released ? r.teacherComment : null,
      deletedAt: r.deletedAt,
    },
  };
}

/** `student_repos` → `project_repos`, then the sync pull requests. */
export async function importRepos(ctx: Ctx) {
  const runs = new Map(ctx.snapshot.gradeRuns.map((r) => [r.id, r]));
  const facts = {
    scored: (id: string | null): ScoreLike | null => {
      const run = id === null ? undefined : runs.get(id);
      return run ? { points: run.gradePoints, max: run.gradeMax, parseStatus: run.parseStatus } : null;
    },
    committed: deadlineCommits(ctx),
  };
  const assignments = new Map(assignmentsInScope(ctx).map((a) => [a.id, a]));
  const inScope = reposInScope(ctx);
  const leftOut = new Map<string, string>();
  const rows: OwnedRow[] = [];
  let commitOwed = 0;

  for (const r of inScope) {
    const why = repoLeftOut(ctx, r);
    if (why) {
      leftOut.set(r.id, why);
      continue;
    }
    const a = assignments.get(r.assignmentId)!;
    const row = repoRow(ctx, r, a, facts);
    if (a.groupMode) {
      // A leftover from before acceptance knew about groups (M3-08): live, its student keeps working in it.
      const live = isLiveIndividualRepo({ groupId: null, provisionStatus: r.provisionStatus, fullName: r.fullName, deletedAt: r.deletedAt });
      note(
        ctx,
        "projects",
        `${row.label}: an individual repository inside a group project, ${live ? "live: carried, its student keeps working in it (isLiveIndividualRepo)" : "not live: carried, it gives way to the group's repository"}`,
      );
    }
    if (a.deadlineStrategy === "commit" && row.values.deadlineAppliedAt !== null && row.values.deadlineCommittedAt === null && r.deletedAt === null) commitOwed += 1;
    rows.push(row);
  }
  await carryOwned(ctx, rows, () => "not carried: Quiz already holds this GitHub repository, or this student's repository in the project");
  if (commitOwed > 0) {
    note(ctx, "projects", `${commitOwed} repository(ies) of a "commit" project applied without a deadline bot commit in classroom: Quiz's deadline job will make it`);
  }
  const known = ctx.known.get("student_repos");
  tally(ctx, "student_repos", {
    source: inScope.length,
    carried: inScope.filter((r) => known?.has(r.id)).length,
    leftOut: [...leftOut].map(([id, why]) => `${id}: ${why}`),
  });
  await importSyncPrs(ctx, inScope.filter((r) => r.syncPrNumber !== null), assignments);
}

/** classroom's one sync pull request per repository is Quiz's row for the default branch (F-PROJ-12). */
async function importSyncPrs(ctx: Ctx, withPr: SourceStudentRepo[], assignments: Map<string, SourceAssignment>) {
  const mapped = ctx.known.get("student_repos");
  const branchOf = (r: SourceStudentRepo) => r.defaultBranch ?? assignments.get(r.assignmentId)?.branches[0] ?? "main";
  const carried = withPr.filter((r) => mapped?.has(r.id));
  await insertAll(
    ctx,
    projectSyncPrs,
    carried.map((r) => ({
      repoId: r.id,
      branch: branchOf(r),
      prNumber: r.syncPrNumber!,
      state: (r.syncPrState ?? "open") as "open" | "merged" | "closed",
      updatedAt: ctx.now,
    })),
  );
  const present = await presentKeys(
    carried.map((r) => r.id),
    async (ids) => (await ctx.db.select({ repoId: projectSyncPrs.repoId, branch: projectSyncPrs.branch }).from(projectSyncPrs).where(inArray(projectSyncPrs.repoId, ids))).map((x) => `${x.repoId}:${x.branch}`),
  );
  tally(ctx, "student_repos.sync_pr_number", {
    source: withPr.length,
    carried: carried.filter((r) => present.has(`${r.id}:${branchOf(r)}`)).length,
    leftOut: withPr.filter((r) => !mapped?.has(r.id)).map((r) => `${r.id}: its repository was not carried`),
  });
}

/** `grade_runs` → `project_grade_runs`: `llm` → `review`, `to_verify` false, no parse detail (M3-04). */
export async function importGradeRuns(ctx: Ctx) {
  await carryChild(ctx, {
    table: projectGradeRuns,
    parity: "grade_runs",
    rows: ctx.snapshot.gradeRuns,
    key: (r) => `${r.studentRepoId}:${r.workflowRunId}:${r.runAttempt}`,
    insert: (r) => ({
      id: r.id,
      repoId: r.studentRepoId,
      workflowRunId: r.workflowRunId,
      runAttempt: r.runAttempt,
      headBranch: r.headBranch,
      headSha: r.headSha,
      conclusion: r.conclusion,
      points: r.gradePoints,
      max: r.gradeMax,
      testsPassed: r.testsPassed,
      testsTotal: r.testsTotal,
      parseStatus: r.parseStatus as "ok",
      parseDetail: null,
      kind: r.kind === "llm" ? ("review" as const) : ("ci" as const),
      afterDeadline: r.afterDeadline,
      toVerify: false,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    }),
    scope: (r) => r.studentRepoId,
    read: async (ids) =>
      (await ctx.db.select({ r: projectGradeRuns.repoId, w: projectGradeRuns.workflowRunId, a: projectGradeRuns.runAttempt }).from(projectGradeRuns).where(inArray(projectGradeRuns.repoId, ids))).map((x) => `${x.r}:${x.w}:${x.a}`),
  });
}

export async function importBotCommits(ctx: Ctx) {
  await carryChild(ctx, {
    table: botCommits,
    parity: "bot_commits",
    rows: ctx.snapshot.botCommits,
    key: (b) => `${b.studentRepoId}:${b.sha}`,
    insert: (b) => ({ repoId: b.studentRepoId, sha: b.sha, kind: b.kind as "revert", createdAt: b.createdAt }),
    scope: (b) => b.studentRepoId,
    read: async (ids) => (await ctx.db.select({ r: botCommits.repoId, s: botCommits.sha }).from(botCommits).where(inArray(botCommits.repoId, ids))).map((x) => `${x.r}:${x.s}`),
  });
}

/**
 * The review ledger (M3-05b). `milestone` → `checkpoint`; a row left
 * unconfirmed in classroom (`dispatched_at` null, which it would have
 * retried) is imported as it is: Quiz never sends it again, its staff see it
 * "not confirmed". Then the synthetic rows: Quiz's ticker dispatches a
 * `grade-final` to EVERY live repository frozen with a frozen run and no
 * `deadline` row of a project graded `auto`, so a repository of an
 * assignment whose `llm_dispatched_at` is set, with a frozen run and no
 * `deadline` row (a row lost, or older than the ledger), gets a confirmed
 * one — `sha` the frozen run's head, `dispatched_at` the assignment's — and
 * is not reviewed twice.
 */
export async function importDispatches(ctx: Ctx) {
  const checkpoints = ctx.known.get("assignment_milestones");
  const triggerOf = (d: { trigger: string }) => (d.trigger === "milestone" ? "checkpoint" : "deadline");
  const { carry } = await carryChild(ctx, {
    table: gradeDispatches,
    parity: "grade_dispatches",
    rows: ctx.snapshot.dispatches,
    key: (d) => `${d.studentRepoId}:${triggerOf(d)}:${d.milestoneId ?? ""}`,
    keep: (d) =>
      triggerOf(d) === "deadline" || (d.milestoneId !== null && checkpoints?.has(d.milestoneId))
        ? null
        : d.milestoneId === null ? "a milestone dispatch without a milestone" : "its milestone was not carried",
    insert: (d) => ({
      id: d.id,
      repoId: d.studentRepoId,
      trigger: triggerOf(d) as "deadline" | "checkpoint",
      checkpointId: triggerOf(d) === "checkpoint" ? d.milestoneId : null,
      sha: d.sha,
      dispatchedAt: d.dispatchedAt,
      createdAt: d.createdAt,
    }),
    scope: (d) => d.studentRepoId,
    read: async (ids) =>
      (await ctx.db.select({ r: gradeDispatches.repoId, t: gradeDispatches.trigger, c: gradeDispatches.checkpointId }).from(gradeDispatches).where(inArray(gradeDispatches.repoId, ids))).map((x) => `${x.r}:${x.t}:${x.c ?? ""}`),
  });
  const unconfirmed = carry.filter((d) => d.dispatchedAt === null).length;
  if (unconfirmed > 0) note(ctx, "projects", `${unconfirmed} review dispatch(es) not confirmed in classroom: imported as they are, Quiz never sends them again (its staff see them not confirmed)`);

  // The synthetic `deadline` rows.
  const withDeadlineRow = new Set(ctx.snapshot.dispatches.filter((d) => d.trigger === "deadline").map((d) => d.studentRepoId));
  const runs = new Map(ctx.snapshot.gradeRuns.map((r) => [r.id, r]));
  const assignments = new Map(assignmentsInScope(ctx).map((a) => [a.id, a]));
  const synthetic: (typeof gradeDispatches.$inferInsert)[] = [];
  for (const r of reposInScope(ctx)) {
    const a = assignments.get(r.assignmentId)!;
    const frozen = r.frozenGradeRunId === null ? undefined : runs.get(r.frozenGradeRunId);
    if (a.llmDispatchedAt === null || a.gradingMode !== "auto" || !frozen || withDeadlineRow.has(r.id) || childLeftOut(ctx, r) !== null) continue;
    synthetic.push({ id: randomUUID(), repoId: r.id, trigger: "deadline", checkpointId: null, sha: frozen.headSha, dispatchedAt: a.llmDispatchedAt, createdAt: a.llmDispatchedAt });
  }
  const made = await insertAll(ctx, gradeDispatches, synthetic, "grade_dispatches (synthetic)");
  if (made > 0) note(ctx, "projects", `${made} repository(ies) frozen with a final review already dispatched in classroom but no ledger row: a confirmed synthetic row recorded, so Quiz does not review them again`);
}

/** `reverts` → `reverts`: `head_sha`, `covered_sha` and `branch` null (M3-04, M3-06b), counted like any restore. */
export async function importReverts(ctx: Ctx) {
  await carryChild(ctx, {
    table: reverts,
    parity: "reverts",
    rows: ctx.snapshot.reverts,
    key: (r) => r.id,
    insert: (r) => ({ id: r.id, repoId: r.studentRepoId, revertSha: r.revertSha, files: r.files, headSha: null, coveredSha: null, branch: null, createdAt: r.createdAt }),
    scope: (r) => r.studentRepoId,
    read: async (ids) => (await ctx.db.select({ id: reverts.id }).from(reverts).where(inArray(reverts.repoId, ids))).map((x) => x.id),
  });
}

/**
 * `push_receipts`: keyed on GitHub's repository id in Quiz, from
 * `student_repos.github_repo_id`; a receipt whose repository has none is
 * dropped and counted. Ids kept; a receipt of the same sha Quiz took itself
 * counts as carried.
 */
export async function importPushReceipts(ctx: Ctx) {
  const repos = new Map(reposInScope(ctx).map((r) => [r.id, r]));
  const githubId = (p: { studentRepoId: string }) => repos.get(p.studentRepoId)!.githubRepoId!;
  let dropped = 0;
  await carryChild(ctx, {
    table: pushReceipts,
    parity: "push_receipts",
    rows: ctx.snapshot.pushReceipts,
    key: (p) => `${repos.get(p.studentRepoId)?.githubRepoId}:${p.headSha}`,
    keep: (p) => {
      if (repos.get(p.studentRepoId)!.githubRepoId !== null) return null;
      dropped += 1;
      return "its repository has no GitHub id";
    },
    insert: (p) => ({ id: p.id, githubRepoId: githubId(p), branch: p.branch, headSha: p.headSha, receivedAt: p.receivedAt, isBot: p.isBot, forced: p.forced }),
    scope: githubId,
    read: async (ids) => (await ctx.db.select({ g: pushReceipts.githubRepoId, s: pushReceipts.headSha }).from(pushReceipts).where(inArray(pushReceipts.githubRepoId, ids))).map((x) => `${x.g}:${x.s}`),
  });
  if (dropped > 0) note(ctx, "projects", `${dropped} push receipt(s) dropped: their repository has no GitHub id`);
}
