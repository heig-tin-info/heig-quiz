/**
 * The rules of the student's side of a project (F-PROJ-04, F-PROJ-15,
 * N-SEC-20; merge task M3-09a): the one status word of their card and view,
 * the group of the Activities their project falls in, and which of their
 * repository's runs they read before the release. The `project` module
 * reads the rows; these decide.
 */
import type { DeadlineStrategyName } from "./projectRuns.js";
import { weekOf, type IsoDate } from "./drillProgress.js";
import { localDate } from "./zone.js";

/**
 * The spec's words (F-PROJ-04), plus `released` once the scores are out
 * (F-PROJ-14): to accept (or not yet open, which `startAt` tells), in
 * progress once the repository exists, locked after the student's effective
 * deadline — or while GitHub holds the repository locked for them. Under
 * the `commit` deadline strategy the deadline locks nothing (#958): past
 * it, a repository GitHub does not hold locked reads `deadline_passed`.
 */
export const STUDENT_PROJECT_STATUSES = ["to_accept", "in_progress", "locked", "deadline_passed", "released"] as const;
export type StudentProjectStatus = (typeof STUDENT_PROJECT_STATUSES)[number];

export interface StudentProjectFacts {
  startAt: Date;
  /** The student's EFFECTIVE deadline (`effectiveDeadline`): their own, else the project's. */
  deadlineAt: Date;
  /** The project's scores were released (F-PROJ-14). */
  released: boolean;
  /** The student's repository is provisioned. */
  accepted: boolean;
  /** GitHub holds the repository locked (the deadline's lock, or the staff's hand). */
  locked: boolean;
  /** The project's deadline strategy (F-PROJ-09): `lock` locks the repository at the deadline, `commit` leaves it open. */
  deadlineStrategy: DeadlineStrategyName;
}

/** The status word of `facts` at `now`. */
export function studentProjectStatus(facts: StudentProjectFacts, now: Date): StudentProjectStatus {
  if (facts.released) return "released";
  if (facts.locked) return "locked";
  if (now.getTime() >= facts.deadlineAt.getTime()) return facts.deadlineStrategy === "commit" ? "deadline_passed" : "locked";
  return facts.accepted ? "in_progress" : "to_accept";
}

export type StudentActivityGroup = "open" | "upcoming" | "past";

/**
 * The group of the student's Activities a project falls in, by its dates
 * (F-ORG-15): Upcoming until it starts, Past once it is locked, its deadline
 * passed — a repository the `commit` strategy leaves open included: the work
 * is over and a later push never moves the frozen score (F-PROJ-11) — or
 * released for this student, Open now between the two.
 */
export function studentProjectGroup(facts: StudentProjectFacts, now: Date): StudentActivityGroup {
  if (now.getTime() < facts.startAt.getTime()) return "upcoming";
  const status = studentProjectStatus(facts, now);
  return status === "in_progress" || status === "to_accept" ? "open" : "past";
}

/**
 * The run a student reads before the release (F-PROJ-15, N-SEC-20): the
 * frozen slot once their deadline is applied — never a run after it, even
 * while the grace still moves the frozen one —, the current slot before.
 * Never the review's nor the teacher's: those reach them with the release.
 * `frozen` says which it was.
 */
export function studentScoreRun<T>(repo: {
  deadlineAppliedAt: Date | null;
  current: T | null;
  frozen: T | null;
}): { run: T; frozen: boolean } | null {
  if (repo.deadlineAppliedAt !== null) return repo.frozen === null ? null : { run: repo.frozen, frozen: true };
  return repo.current === null ? null : { run: repo.current, frozen: false };
}

/** Pass / fail of a repository without `grading.yml` (F-PROJ-10), as the webhooks store it and a student reads it. */
export const CI_STATUSES = ["none", "pending", "pass", "fail"] as const;
export type CiStatusName = (typeof CI_STATUSES)[number];

export interface StudentCiReading {
  /** The commit the view stands on; `at` null when it is a run's head, whose push time is not the run's. */
  lastCommit: { sha: string; at: Date | null } | null;
  ciStatus: CiStatusName;
}

/**
 * The commit and CI state a student reads (F-PROJ-15, N-SEC-20). Before
 * their deadline: the last push of theirs and its checks as the webhooks
 * stored them. Once the deadline is OVER — applied by the ticker, or passed
 * on the server's clock while the ticker has not yet applied it — the
 * selected run alone (`studentScoreRun`): its head, and its conclusion read
 * as pass or fail (`success` passes; anything else — a failure, a
 * cancellation, a skip — fails), or nothing without a selected run. Never
 * the row's head, which a repository left open keeps moving after the
 * deadline.
 */
export function studentCiReading(
  repo: { deadlineAppliedAt: Date | null; lastCommitSha: string | null; lastCommitAt: Date | null; ciStatus: CiStatusName },
  run: { headSha: string; conclusion: string } | null,
  deadlineAt: Date,
  now: Date,
): StudentCiReading {
  const over = repo.deadlineAppliedAt !== null || now.getTime() >= deadlineAt.getTime();
  if (!over) {
    return {
      lastCommit: repo.lastCommitSha === null ? null : { sha: repo.lastCommitSha, at: repo.lastCommitAt },
      ciStatus: repo.ciStatus,
    };
  }
  if (run === null) return { lastCommit: null, ciStatus: "none" };
  return { lastCommit: { sha: run.headSha, at: null }, ciStatus: run.conclusion === "success" ? "pass" : "fail" };
}

/** A push receipt as the student's commit count reads it: when the server received it, and the commits it brought. */
export interface CountedReceipt {
  receivedAt: Date;
  /** The push's distinct commits no bot authored; null on a receipt written before they were counted (M3-14i). */
  commits: number | null;
}

/**
 * The number of commits a student pushed (M3-14i): the commits their own
 * pushes brought — the caller passes the receipts no bot pushed — summed
 * over the receipts received by their effective deadline, the freeze's
 * rule (`receivedLate`): a push after the deadline is never shown
 * (N-SEC-20). A receipt from before the count existed counts one, the
 * least a push carries.
 */
export function studentCommitCount(receipts: readonly CountedReceipt[], deadlineAt: Date): number {
  let n = 0;
  for (const r of countedBy(receipts, deadlineAt)) n += receiptCommits(r);
  return n;
}

/** The receipts {@link studentCommitCount} counts: received by the deadline (`receivedLate`'s rule). */
const countedBy = <R extends CountedReceipt>(receipts: readonly R[], deadlineAt: Date): R[] =>
  receipts.filter((r) => r.receivedAt.getTime() <= deadlineAt.getTime());

/** What a receipt counts: its commits, one for a receipt from before they were counted. */
const receiptCommits = (r: CountedReceipt): number => r.commits ?? 1;

/** Commits of one push resolved to one linked GitHub account, by its immutable id (ADR-136). */
export interface CommitAuthor {
  id: number;
  n: number;
}

/** A counted receipt with its commits' authors: null on a receipt written before they were recorded (ADR-136). */
export interface AttributedReceipt extends CountedReceipt {
  authors: readonly CommitAuthor[] | null;
}

/** Commits by the week of their receipt: its Monday (`weekOf`, the school's days), the weeks in order, none empty. */
export interface CommitWeek {
  weekStart: IsoDate;
  n: number;
}

/** A count of commits and its weeks: `n` is the sum of `weeks`. */
export interface CommitSeries {
  n: number;
  weeks: CommitWeek[];
}

/** A repository's counted commits, by member (keyed `K`) and unattributed: {@link commitAttribution}. */
export interface CommitAttribution<K> {
  total: number;
  members: Map<K, CommitSeries>;
  unattributed: CommitSeries;
}

/**
 * Who authored the commits {@link studentCommitCount} counts (ADR-136,
 * staff only): over the same receipts — no bot's, no collection's (the
 * caller's), received by `deadlineAt` —, the total, each member's commits,
 * those attributed to their linked GitHub account's id (`members`, null
 * without one), and the rest, unattributed: the total minus the members' —
 * a receipt from before the authors were recorded, an author GitHub matched
 * to no linked account, or one who is not a member (the staff included).
 * Each series by the week of the receipt (the server's clock), never the
 * commit's own date. The members' and the unattributed counts sum to
 * `total`, which is {@link studentCommitCount}.
 */
export function commitAttribution<K>(
  receipts: readonly AttributedReceipt[],
  deadlineAt: Date,
  members: ReadonlyMap<K, number | null>,
): CommitAttribution<K> {
  // A GitHub id is one account's (`github_accounts.github_user_id` is unique): one member at most.
  const owner = new Map([...members].flatMap(([key, id]) => (id === null ? [] : [[id, key] as const])));
  const weeks = new Map<K | null, Map<IsoDate, number>>();
  const add = (key: K | null, week: IsoDate, n: number) => {
    if (n <= 0) return;
    const of = weeks.get(key) ?? new Map<IsoDate, number>();
    of.set(week, (of.get(week) ?? 0) + n);
    weeks.set(key, of);
  };
  let total = 0;
  for (const r of countedBy(receipts, deadlineAt)) {
    const week = weekOf(localDate(r.receivedAt));
    let attributed = 0;
    for (const a of r.authors ?? []) {
      const key = owner.get(a.id);
      if (key === undefined) continue;
      add(key, week, a.n);
      attributed += a.n;
    }
    total += receiptCommits(r);
    add(null, week, receiptCommits(r) - attributed);
  }
  const series = (key: K | null): CommitSeries => {
    const list = [...(weeks.get(key) ?? [])].map(([weekStart, n]) => ({ weekStart, n })).sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    return { n: list.reduce((sum, w) => sum + w.n, 0), weeks: list };
  };
  return { total, members: new Map([...members.keys()].map((key) => [key, series(key)])), unattributed: series(null) };
}
