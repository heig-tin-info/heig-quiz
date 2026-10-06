/**
 * The staff's project page (F-PROJ-13, F-PROJ-14; merge task M3-08a),
 * ported from heig-classroom's `modules/assignments/detail.ts` and the
 * final-score rule of its `grades.ts`: one row per student of the roster
 * with their repository, its scores and flags, and the history of a
 * repository's runs.
 *
 * STAFF ONLY (N-SEC-20): the routes load the project through
 * `accessibleProject` / `accessibleProjectRepo` (invariant 6), and nothing
 * here is reused nor filtered for a student — the student's projection is
 * the project's student view (M3-09), its one exit.
 *
 * **A page view never waits for GitHub** (F-PROJ-13, N-PERF-07, I51). The
 * stored state (the last student commit and its CI status, written by the
 * webhooks) is the page; the live state (`readRepoLiveState`: one minute's
 * cache, served stale up to fifteen, a rate-limited installation skipped
 * until its reset) only adds the counters. Never for a repository known
 * deleted, and never written back: the head GitHub shows may be the App's
 * (a restore, a deadline commit), and the stored one is the student's
 * (M3-04). The reads go {@link LIVE_CONCURRENCY} at a time within
 * {@link LIVE_BUDGET_MS}: past it the page answers with what it has and
 * `liveStale`, the reads under way finish into the cache, and the next view
 * (the client refetches shortly) finds them warm. A cold page of 100
 * repositories therefore costs at most eight requests to GitHub in flight
 * and 1.5 s, and fills over a few refetches.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import {
  GRADE_RUN_LIST_LIMIT,
  type GradeRunList,
  type GradeRunView,
  type ProjectDetail,
  type ProjectDetailGroup,
  type ProjectDetailRow,
  type ProjectRepoLive,
  type ProjectRepoReview,
  type ProjectRepoScores,
  type ProjectRepoSync,
  type ProjectRepoView,
  type ProjectSlotScore,
  type ProjectStudent,
} from "@quiz/contracts";
import { changedAfterRelease, projectPrimaryAction, resolveFinalScore, reviewState, scoreGrade, type ProjectScale } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db, Tx } from "../../db/client.js";
import { enrollments, githubAccounts, gradeDispatches, projectGradeRuns, projectGroups, projectRepos, users } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { isRateLimited, readRepoLiveState, type LiveRead } from "../../github/metrics.js";
import { projectInstallation } from "../github/service.js";
import { countedReceipts, repoCommitCount } from "./commits.js";
import { isLive, releaseCounts, repoDeadlineState } from "./deadline.js";
import { reposWithAccessToRevoke } from "./groupCopy.js";
import { groupsDrifted, groupSyncOwed } from "./groupResync.js";
import { seatRepos } from "./groupRepos.js";
import { forEachLimit } from "./lease.js";
import { studentRepos, type RepoRow } from "./repos.js";
import { projectSyncState, repoSyncViews } from "./sync.js";
import { projectSummary, type ProjectRow } from "./views.js";

/** Live-state reads in flight for one page view. */
export const LIVE_CONCURRENCY = 8;
/** How long a page view gives the live state, the installation's token included. */
export const LIVE_BUDGET_MS = 1_500;

type RunRow = typeof projectGradeRuns.$inferSelect;
/** The repository's `deadline` row of the dispatch ledger (F-PROJ-11, M3-05b). */
type DispatchRow = { sha: string; dispatchedAt: Date | null };

/**
 * The live state of `repos` read within `budgetMs`, by repository id: a
 * repository missing from the map is served from its stored state. Never
 * throws: GitHub failing is logged and leaves the map partial.
 */
async function liveStates(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  repos: RepoRow[],
  log: FastifyBaseLogger,
  budgetMs: number,
): Promise<{ live: Map<string, LiveRead>; complete: boolean }> {
  const live = new Map<string, LiveRead>();
  if (repos.length === 0) return { live, complete: true };
  let expired = false;
  let done = false;
  const read = async () => {
    const org = await projectInstallation(db, project.orgId);
    // Under GitHub's rate limit every read answers null: not even a token.
    if (!org || isRateLimited(org.installationId)) return;
    const { octokit } = await installationClient(config, org.installationId);
    await forEachLimit(
      repos,
      LIVE_CONCURRENCY,
      async (repo) => {
        try {
          const got = await readRepoLiveState(octokit, org.installationId, repo.fullName!);
          if (!expired) live.set(repo.id, got);
        } catch (err) {
          log.warn({ err, repo: repo.fullName }, "project detail: live state read failed");
        }
      },
      () => expired,
    );
  };
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
    timer.unref();
  });
  await Promise.race([
    read()
      .catch((err: unknown) => log.warn({ err, project: project.id }, "project detail: no live state"))
      .finally(() => (done = true)),
    budget,
  ]);
  clearTimeout(timer);
  expired = true;
  return { live, complete: done };
}

function slotScore(run: RunRow | undefined, scale: ProjectScale): ProjectSlotScore | null {
  if (!run) return null;
  return {
    runId: run.id,
    points: run.points,
    max: run.max,
    grade: scoreGrade(run.points, run.max, scale),
  };
}

interface RunFacts {
  multiple: boolean;
  malformed: string | null;
}

/**
 * What the page reads of a repository's runs besides its slots, by
 * repository id, in one pass: whether any run printed several `GRADE`
 * annotations, and the latest run's parse detail when it is malformed.
 */
async function runFacts(db: Db, repoIds: string[]): Promise<Map<string, RunFacts>> {
  if (repoIds.length === 0) return new Map();
  const latest = (column: SQL) => sql`(array_agg(${column} ORDER BY ${projectGradeRuns.completedAt} DESC))[1]`;
  const rows = await db
    .select({
      repoId: projectGradeRuns.repoId,
      multiple: sql<boolean>`bool_or(${projectGradeRuns.parseStatus} = 'multiple')`,
      latestStatus: sql<string>`${latest(sql`${projectGradeRuns.parseStatus}`)}`,
      latestDetail: sql<string | null>`${latest(sql`${projectGradeRuns.parseDetail}`)}`,
    })
    .from(projectGradeRuns)
    .where(inArray(projectGradeRuns.repoId, repoIds))
    .groupBy(projectGradeRuns.repoId);
  return new Map(
    rows.map((r) => [
      r.repoId,
      { multiple: r.multiple, malformed: r.latestStatus === "malformed" ? (r.latestDetail ?? "") : null },
    ]),
  );
}

function liveView(read: LiveRead | undefined): ProjectRepoLive | null {
  if (!read?.state) return null;
  const { commitCount, checksPassed, checksTotal } = read.state;
  return { commitCount, checksPassed, checksTotal, stale: read.stale };
}

/** The runs filling the three slots of `repos`, by id (M3-08b: shared with the score's write). */
export async function slotRuns(db: Db | Tx, repos: readonly RepoRow[]): Promise<Map<string, RunRow>> {
  const ids = repos.flatMap((repo) =>
    [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].filter((id): id is string => id !== null),
  );
  if (ids.length === 0) return new Map();
  return new Map((await db.select().from(projectGradeRuns).where(inArray(projectGradeRuns.id, ids))).map((r) => [r.id, r]));
}

/** The `deadline` ledger rows of `repoIds`, by repository: the final review's state (M3-05b). */
async function finalDispatches(db: Db, repoIds: string[]): Promise<Map<string, DispatchRow>> {
  if (repoIds.length === 0) return new Map();
  const rows = await db
    .select({ repoId: gradeDispatches.repoId, sha: gradeDispatches.sha, dispatchedAt: gradeDispatches.dispatchedAt })
    .from(gradeDispatches)
    .where(and(inArray(gradeDispatches.repoId, repoIds), eq(gradeDispatches.trigger, "deadline")));
  return new Map(rows.map((r) => [r.repoId, { sha: r.sha, dispatchedAt: r.dispatchedAt }]));
}

/**
 * A repository's scores (F-PROJ-14) and whether they moved since the
 * release: the three slots, the teacher's score with the maximum it was
 * written with, the final score resolved and graded by the project's scale,
 * the release's snapshot. The one computation behind the page's rows and
 * the score's write (M3-08b); `runs` holds the repository's slot runs
 * ({@link slotRuns}).
 */
export function repoScores(project: ProjectRow, repo: RepoRow, runs: Map<string, RunRow>): ProjectRepoScores {
  const scale = project.gradingScale;
  const [current, frozen, review] = slots(repo, runs);
  const final = resolveFinalScore({
    teacherPoints: repo.teacherPoints,
    teacherMax: repo.teacherMax,
    reviewScore: review ?? null,
    frozenScore: frozen ?? null,
    score: current ?? null,
  });
  const released = project.releasedAt !== null;
  return {
    scores: {
      current: slotScore(current, scale),
      frozen: slotScore(frozen, scale),
      review: slotScore(review, scale),
      teacher:
        repo.teacherPoints === null
          ? null
          : { points: repo.teacherPoints, max: repo.teacherMax, comment: repo.teacherComment, gradedAt: isoOrNull(repo.teacherGradedAt) },
      final: final && { ...final, grade: scoreGrade(final.points, final.max, scale) },
      scoreMax: teacherRunMax(repo, runs),
    },
    released: released ? { points: repo.releasedPoints, max: repo.releasedMax } : null,
    changedAfterRelease: changedAfterRelease(released, releasableScore(project, repo, final), {
      points: repo.releasedPoints,
      max: repo.releasedMax,
    }),
  };
}

/**
 * The maximum a teacher's score is held to (`teacherScoreMax`, F-PROJ-14,
 * product owner 2026-10-02): that of the run the final score would come
 * from without the teacher — the review's, else the frozen, else the
 * current — unless that run is to verify (F-PROJ-08), which is no scored
 * run at all: null, and the teacher gives their own maximum. ONE rule for
 * the write (`grades.ts`) and for the page (`scores.scoreMax`, which the
 * sheet's form reads to show the maximum field, M3-12b).
 */
export function teacherRunMax(repo: RepoRow, runs: Map<string, RunRow>): number | null {
  const [current, frozen, review] = slots(repo, runs);
  const scored = resolveFinalScore({ reviewScore: review ?? null, frozenScore: frozen ?? null, score: current ?? null });
  return scored && !scored.toVerify ? scored.max : null;
}

/**
 * What the release writes of a final score (M3-08b, review round 2): the
 * score itself — except a score to verify on a repository that is no longer
 * live (deleted on GitHub, or of an archived project), which never freezes
 * and so can never be settled by the teacher: released as NO score, so that
 * it neither blocks the release nor shows "changed after release" forever.
 * A live repository's score to verify is the release's `to_verify` refusal
 * instead (`grades.ts`).
 */
export function releasableScore<T extends { toVerify: boolean }>(project: ProjectRow, repo: RepoRow, final: T | null): T | null {
  return final !== null && final.toVerify && !isLive(repo, project) ? null : final;
}

/** The repository's three slot runs — current, frozen, review — from {@link slotRuns}'s map. */
function slots(repo: RepoRow, runs: Map<string, RunRow>): (RunRow | undefined)[] {
  return [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].map((id) => (id === null ? undefined : runs.get(id)));
}

/** The final review's state of a repository, from its row and its ledger row (`reviewState`, `@quiz/domain`). */
function reviewView(project: ProjectRow, repo: RepoRow, dispatch: DispatchRow | undefined): ProjectRepoReview {
  const state = reviewState({ ...repo, gradingMode: project.gradingMode, dispatch: dispatch ?? null });
  return { ...state, askedAt: isoOrNull(state.askedAt) };
}

/** One repository's row, from its stored state, its slot runs, its runs' facts, its ledger row, its sync and its live read. */
function repoView(
  project: ProjectRow,
  repo: RepoRow,
  runs: Map<string, RunRow>,
  facts: RunFacts | undefined,
  dispatch: DispatchRow | undefined,
  sync: ProjectRepoSync,
  read: LiveRead | undefined,
  commits: number,
  toRevoke: ReadonlySet<string>,
): ProjectRepoView {
  const { scores, released, changedAfterRelease: changed } = repoScores(project, repo, runs);
  return {
    ...repoDeadlineState(repo, project),
    provisionStatus: repo.provisionStatus,
    provisionError: repo.provisionError,
    invitationStatus: repo.invitationStatus,
    acceptedAt: iso(repo.acceptedAt),
    lastCommit: repo.lastCommitSha === null ? null : { sha: repo.lastCommitSha, at: isoOrNull(repo.lastCommitAt) },
    ciStatus: repo.ciStatus,
    commits,
    live: liveView(read),
    scores,
    review: reviewView(project, repo, dispatch),
    sync,
    released,
    flags: {
      protectionSuspended: repo.protectionSuspendedAt !== null,
      toVerify: slots(repo, runs).some((r) => r?.toVerify === true),
      multiple: facts?.multiple ?? false,
      malformed: facts?.malformed ?? null,
      deleted: repo.deletedAt !== null || read?.state?.missing === true,
      changedAfterRelease: changed,
    },
    accessToRevoke: toRevoke.has(repo.id),
  };
}

/** The groups of a group project's copy (ADR-070 §4; M3-16b), by id; none for an individual project. */
async function copyGroups(db: Db, project: ProjectRow): Promise<Map<string, ProjectDetailGroup>> {
  if (!project.groupMode) return new Map();
  const groups = await db
    .select({ id: projectGroups.id, name: projectGroups.name, stoppedAt: projectGroups.stoppedAt })
    .from(projectGroups)
    .where(eq(projectGroups.projectId, project.id));
  return new Map(groups.map((g) => [g.id, { id: g.id, name: g.name, stopped: g.stoppedAt !== null }]));
}

export interface DetailOptions {
  log: FastifyBaseLogger;
  /** {@link LIVE_BUDGET_MS} unless a test shortens it. */
  budgetMs?: number;
}

/**
 * `GET /app/api/projects/:id` (F-PROJ-13): the project's summary, its
 * counts, its primary action, and one row per student of the roster
 * (staff seats excepted) with their repository — their group's in a group
 * project, null when there is none yet — and, in a group project, the copy
 * group they are in (M3-16b: the page draws one row per group from them),
 * then the repositories no student of the roster reads any more, a group's
 * with its group (R1's group kept with no member). A
 * repository of a user who holds a STAFF seat of the classroom is a TEST
 * repository (ADR-077): a row of its own, `staff`, after the students' —
 * and in no count nor in the release's readiness (`studentRepos`,
 * `releaseCounts`: the release reads the same): a staff seat is never a
 * student's (ADR-018).
 * The project was loaded under `staffAccess` by the route (invariant 6).
 */
export async function projectDetail(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  now: Date,
  opts: DetailOptions,
): Promise<ProjectDetail> {
  const roster = await db
    .select({
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      claimedAt: enrollments.claimedAt,
      staff: enrollments.staff,
      githubLogin: githubAccounts.login,
    })
    .from(enrollments)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(eq(enrollments.classroomId, project.classroomId))
    .orderBy(enrollments.staff, enrollments.nom, enrollments.prenom, enrollments.id);
  // Whose repository: a student's own, or their copy group's (`seatRepos`,
  // N-SEC-20: never the group repository's creator for having created it);
  // one row per student, each member reading the group's. A staff seat reads
  // its own individual repository only: a teacher's TEST repository (ADR-077).
  const [seats, copy] = await Promise.all([seatRepos(db, [project]), copyGroups(db, project)]);
  // "Counted" is `studentRepos`; "shown" adds the staff seats' test repositories.
  const repos = await studentRepos(db, project);
  const tests = roster.flatMap((s) => (s.staff ? [seats.of(project.id, s.enrollmentId)] : [])).filter((r) => r !== null);
  const shownRepos = [...repos, ...tests];
  const repoIds = shownRepos.map((repo) => repo.id);
  const [runs, facts, dispatches, syncs, receipts] = await Promise.all([
    slotRuns(db, shownRepos),
    runFacts(db, repoIds),
    finalDispatches(db, repoIds),
    repoSyncViews(db, project, shownRepos),
    // The student's own count (M3-14m): the same receipts and rule as their card.
    countedReceipts(db, shownRepos.flatMap((repo) => (repo.githubRepoId === null ? [] : [repo.githubRepoId]))),
  ]);
  const liveRepos = repos.filter((repo) => isLive(repo, project));
  const shownLive = shownRepos.filter((repo) => isLive(repo, project));
  const { live, complete } = await liveStates(db, config, project, shownLive, opts.log, opts.budgetMs ?? LIVE_BUDGET_MS);
  const toRevoke = await reposWithAccessToRevoke(db, project.id);

  const views = new Map(
    shownRepos.map((repo) => [
      repo.id,
      repoView(project, repo, runs, facts.get(repo.id), dispatches.get(repo.id), syncs.get(repo.id)!, live.get(repo.id), repoCommitCount(project, repo, receipts), toRevoke),
    ]),
  );
  const groupOf = (groupId: string | null) => (groupId === null ? null : (copy.get(groupId) ?? null));
  const shown = new Set<string>();
  const rows: ProjectDetailRow[] = roster.flatMap((s) => {
    const { repo, groupId } = seats.seat(project.id, s.enrollmentId);
    const view = repo === null ? undefined : views.get(repo.id);
    // A staff seat is a row only once it holds a test repository.
    if (s.staff && !view) return [];
    if (view) shown.add(repo!.id);
    return [
      {
        group: groupOf(groupId),
        student: {
          enrollmentId: s.enrollmentId,
          userId: s.userId,
          nom: s.nom,
          prenom: s.prenom,
          email: s.email,
          claimed: s.claimedAt !== null && s.userId !== null,
          githubLogin: s.githubLogin,
        },
        repo: view ?? null,
        staff: s.staff,
      },
    ];
  });
  // The repositories no student of the roster reads any more — their
  // student left it, or every member left their group —, by the account
  // that accepted them.
  const unread = repos.filter((repo) => !shown.has(repo.id));
  if (unread.length > 0) {
    const accounts = await db
      .select({ user: users, githubLogin: githubAccounts.login })
      .from(users)
      .leftJoin(githubAccounts, eq(githubAccounts.userId, users.id))
      .where(inArray(users.id, [...new Set(unread.map((repo) => repo.userId))]));
    const byUser = new Map(accounts.map((a) => [a.user.id, a]));
    for (const repo of unread) {
      const { user, githubLogin } = byUser.get(repo.userId)!;
      const student: ProjectStudent = {
        enrollmentId: null,
        userId: user.id,
        nom: user.familyName,
        prenom: user.givenName,
        email: user.email,
        claimed: false,
        githubLogin,
      };
      rows.push({ student, repo: views.get(repo.id)!, group: groupOf(repo.groupId), staff: false });
    }
  }

  // Counted over the students' repositories only: a test repository is no acceptance (ADR-077).
  const accepted = repos.map((repo) => views.get(repo.id)!);
  const counts = releaseCounts(project, repos);
  // ONE predicate for the primary action and the page's Sync button: the sync's own `ahead` (M3-07).
  const sync = projectSyncState(project, repos, now);
  return {
    ...(await projectSummary(db, project, now)),
    releasedAt: isoOrNull(project.releasedAt),
    groupsDrifted: await groupsDrifted(db, project, now),
    groupSyncPending: groupSyncOwed(project),
    primaryAction: projectPrimaryAction({
      state: project.state,
      archived: project.archivedAt !== null,
      gradingMode: project.gradingMode,
      sourceAhead: sync.ahead !== null,
      ...counts,
      // Over the live repositories only: a non-live one never freezes, so its score to verify is released as none.
      unverified: liveRepos.filter((repo) => views.get(repo.id)!.scores.final?.toVerify === true).length,
      released: project.releasedAt !== null,
      changedAfterRelease: accepted.filter((v) => v.flags.changedAfterRelease).length,
    }),
    sync,
    counts: {
      students: roster.filter((s) => !s.staff).length,
      accepted: accepted.length,
      groups: copy.size,
      ...counts,
      toVerify: accepted.filter((v) => v.flags.toVerify).length,
      alerts: accepted.filter((v) => v.flags.multiple || v.flags.protectionSuspended).length,
    },
    liveStale: !complete || [...live.values()].some((read) => read.stale),
    rows,
  };
}

function runView(r: RunRow): GradeRunView {
  return {
    id: r.id,
    workflowRunId: r.workflowRunId,
    runAttempt: r.runAttempt,
    kind: r.kind,
    conclusion: r.conclusion,
    headBranch: r.headBranch,
    headSha: r.headSha,
    points: r.points,
    max: r.max,
    testsPassed: r.testsPassed,
    testsTotal: r.testsTotal,
    parseStatus: r.parseStatus,
    parseDetail: r.parseDetail,
    clamped: r.parseStatus === "ok" && r.parseDetail !== null,
    afterDeadline: r.afterDeadline,
    toVerify: r.toVerify,
    completedAt: iso(r.completedAt),
  };
}

/**
 * `GET /app/api/projects/:id/repos/:rid/runs` (F-PROJ-13): the repository's
 * runs, the newest first, and the ids of its three slots. The repository
 * was loaded with its project under `staffAccess` (invariant 6). Database
 * only: no GitHub call.
 */
export async function repoRuns(db: Db, repo: RepoRow): Promise<GradeRunList> {
  const rows = await db
    .select()
    .from(projectGradeRuns)
    .where(eq(projectGradeRuns.repoId, repo.id))
    .orderBy(desc(projectGradeRuns.completedAt), desc(projectGradeRuns.createdAt))
    .limit(GRADE_RUN_LIST_LIMIT);
  return {
    currentGradeRunId: repo.currentGradeRunId,
    frozenGradeRunId: repo.frozenGradeRunId,
    reviewGradeRunId: repo.reviewGradeRunId,
    runs: rows.map(runView),
  };
}
