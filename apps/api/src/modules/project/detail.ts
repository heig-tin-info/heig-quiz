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
import { desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";

import {
  GRADE_RUN_LIST_LIMIT,
  type GradeRunList,
  type GradeRunView,
  type ProjectDetail,
  type ProjectDetailRow,
  type ProjectRepoLive,
  type ProjectRepoView,
  type ProjectSlotScore,
  type ProjectStudent,
} from "@quiz/contracts";
import { changedAfterRelease, projectPrimaryAction, resolveFinalScore, scoreGrade, type ProjectScale } from "@quiz/domain";

import { iso, isoOrNull } from "../../clock.js";
import type { AppConfig } from "../../config.js";
import type { Db } from "../../db/client.js";
import { enrollments, githubAccounts, projectGradeRuns, projectRepos, users } from "../../db/schema.js";
import { installationClient } from "../../github/app.js";
import { isRateLimited, readRepoLiveState, type LiveRead } from "../../github/metrics.js";
import { projectInstallation } from "../github/service.js";
import { isLive, repoDeadlineState } from "./deadline.js";
import type { RepoRow } from "./repos.js";
import { projectSummary, type ProjectRow } from "./views.js";

/** Live-state reads in flight for one page view. */
export const LIVE_CONCURRENCY = 8;
/** How long a page view gives the live state, the installation's token included. */
export const LIVE_BUDGET_MS = 1_500;

type RunRow = typeof projectGradeRuns.$inferSelect;

/** `items` through `run`, `limit` at a time, none started once `stopped()` (as `jobs.ts`'s). */
async function forEachLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>, stopped: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stopped()) await run(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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

/** One repository's row, from its stored state, its slot runs, its runs' facts and its live read. */
function repoView(
  project: ProjectRow,
  repo: RepoRow,
  runs: Map<string, RunRow>,
  facts: RunFacts | undefined,
  read: LiveRead | undefined,
): ProjectRepoView {
  const scale = project.gradingScale;
  const run = (id: string | null) => (id === null ? undefined : runs.get(id));
  const [current, frozen, review] = [run(repo.currentGradeRunId), run(repo.frozenGradeRunId), run(repo.reviewGradeRunId)];
  const final = resolveFinalScore({
    teacherPoints: repo.teacherPoints,
    reviewScore: review ?? null,
    frozenScore: frozen ?? null,
    score: current ?? null,
  });
  const released = project.releasedAt !== null;
  return {
    ...repoDeadlineState(repo, project),
    provisionStatus: repo.provisionStatus,
    provisionError: repo.provisionError,
    invitationStatus: repo.invitationStatus,
    acceptedAt: iso(repo.acceptedAt),
    lastCommit: repo.lastCommitSha === null ? null : { sha: repo.lastCommitSha, at: isoOrNull(repo.lastCommitAt) },
    ciStatus: repo.ciStatus,
    live: liveView(read),
    scores: {
      current: slotScore(current, scale),
      frozen: slotScore(frozen, scale),
      review: slotScore(review, scale),
      teacher:
        repo.teacherPoints === null
          ? null
          : { points: repo.teacherPoints, comment: repo.teacherComment, gradedAt: isoOrNull(repo.teacherGradedAt) },
      final: final && { ...final, grade: scoreGrade(final.points, final.max, scale) },
    },
    released: released ? { points: repo.releasedPoints, max: repo.releasedMax } : null,
    flags: {
      protectionSuspended: repo.protectionSuspendedAt !== null,
      toVerify: [current, frozen, review].some((r) => r?.toVerify === true),
      multiple: facts?.multiple ?? false,
      malformed: facts?.malformed ?? null,
      deleted: repo.deletedAt !== null || read?.state?.missing === true,
      changedAfterRelease: changedAfterRelease(released, final, { points: repo.releasedPoints, max: repo.releasedMax }),
    },
  };
}

export interface DetailOptions {
  log: FastifyBaseLogger;
  /** {@link LIVE_BUDGET_MS} unless a test shortens it. */
  budgetMs?: number;
}

/**
 * `GET /app/api/projects/:id` (F-PROJ-13): the project's summary, its
 * counts, its primary action, and one row per student of the roster
 * (staff seats excepted) with their repository — null when they have not
 * accepted —, then the repositories whose student has left the roster. A
 * repository of a user who now holds a STAFF seat of the classroom is left
 * out altogether — rows, counts and the release's readiness: a staff seat
 * is never a student's (ADR-018).
 * The project was loaded under `staffAccess` by the route (invariant 6).
 */
export async function projectDetail(
  db: Db,
  config: AppConfig,
  project: ProjectRow,
  now: Date,
  opts: DetailOptions,
): Promise<ProjectDetail> {
  const seats = await db
    .select({
      staff: enrollments.staff,
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      nom: enrollments.nom,
      prenom: enrollments.prenom,
      email: enrollments.email,
      claimedAt: enrollments.claimedAt,
      githubLogin: githubAccounts.login,
    })
    .from(enrollments)
    .leftJoin(githubAccounts, eq(githubAccounts.userId, enrollments.userId))
    .where(eq(enrollments.classroomId, project.classroomId))
    .orderBy(enrollments.nom, enrollments.prenom, enrollments.id);
  const roster = seats.filter((s) => !s.staff);
  const staffUsers = new Set(seats.filter((s) => s.staff).map((s) => s.userId));
  // Individual repositories (M3-03); a group's rows join their members with M3-15.
  const repos = (
    await db
      .select({ repo: projectRepos, user: users, githubLogin: githubAccounts.login })
      .from(projectRepos)
      .innerJoin(users, eq(users.id, projectRepos.userId))
      .leftJoin(githubAccounts, eq(githubAccounts.userId, projectRepos.userId))
      .where(eq(projectRepos.projectId, project.id))
  ).filter(({ repo }) => !staffUsers.has(repo.userId));

  const slotIds = repos.flatMap(({ repo }) =>
    [repo.currentGradeRunId, repo.frozenGradeRunId, repo.reviewGradeRunId].filter((id): id is string => id !== null),
  );
  const runs = new Map(
    (slotIds.length === 0 ? [] : await db.select().from(projectGradeRuns).where(inArray(projectGradeRuns.id, slotIds))).map(
      (r) => [r.id, r],
    ),
  );
  const facts = await runFacts(
    db,
    repos.map(({ repo }) => repo.id),
  );
  const liveRepos = repos.map(({ repo }) => repo).filter((repo) => isLive(repo, project));
  const { live, complete } = await liveStates(db, config, project, liveRepos, opts.log, opts.budgetMs ?? LIVE_BUDGET_MS);

  const views = new Map(repos.map(({ repo }) => [repo.userId, repoView(project, repo, runs, facts.get(repo.id), live.get(repo.id))]));
  const rows: ProjectDetailRow[] = roster.map((s) => ({
    student: {
      enrollmentId: s.enrollmentId,
      userId: s.userId,
      nom: s.nom,
      prenom: s.prenom,
      email: s.email,
      claimed: s.claimedAt !== null && s.userId !== null,
      githubLogin: s.githubLogin,
    },
    repo: (s.userId !== null && views.get(s.userId)) || null,
  }));
  const onRoster = new Set(roster.map((s) => s.userId));
  for (const { repo, user, githubLogin } of repos) {
    if (onRoster.has(repo.userId)) continue;
    const student: ProjectStudent = {
      enrollmentId: null,
      userId: user.id,
      nom: user.familyName,
      prenom: user.givenName,
      email: user.email,
      claimed: false,
      githubLogin,
    };
    rows.push({ student, repo: views.get(repo.userId)! });
  }

  const accepted = [...views.values()];
  const frozen = liveRepos.filter((r) => r.frozenAt !== null).length;
  const changed = accepted.filter((v) => v.flags.changedAfterRelease).length;
  return {
    ...(await projectSummary(db, project, now)),
    releasedAt: isoOrNull(project.releasedAt),
    primaryAction: projectPrimaryAction({
      state: project.state,
      archived: project.archivedAt !== null,
      gradingMode: project.gradingMode,
      sourceAhead: project.sourceAheadSha !== null,
      live: liveRepos.length,
      frozen,
      released: project.releasedAt !== null,
      changedAfterRelease: changed,
    }),
    counts: {
      students: roster.length,
      accepted: accepted.length,
      live: liveRepos.length,
      frozen,
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
