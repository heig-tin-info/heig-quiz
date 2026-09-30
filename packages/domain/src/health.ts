/**
 * The thresholds of the system status (N-OPS-03, ADR-055): when a measured
 * value is `ok`, needs a look (`warn`) or needs the operator now (`fail`).
 * The server's check registry (`apps/api/src/modules/system/health.ts`)
 * measures; these rules judge. Every instant is injected (invariant 8).
 *
 * `unknown` is not a verdict of these rules: a check that cannot measure
 * (no ticker in this process, no backup report configured) says so itself.
 */

/**
 * Mirrors `CHECK_STATUSES` of `@quiz/contracts` on purpose: the domain
 * depends on no schema package, and the API assigns one to the other, so a
 * drift is a compile error there.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export const HEALTH_THRESHOLDS = {
  /** The ticker's last completed pass older than this is a dead clock (never under 3 periods). */
  tickerStaleMs: 10_000,
  /**
   * Margin past the moment the ticker should have acted (deadline + grace)
   * before an attempt or an evaluation still open counts as a symptom: a
   * slow tick is not a dead one.
   */
  overdueMarginMs: 60_000,
  /** Free share of a disk under which it warns, then fails. */
  diskWarnFree: 0.15,
  diskFailFree: 0.05,
  /** Age of the last dump: a daily job, so one missed day warns and two fail. */
  backupWarnMs: 26 * 3_600_000,
  backupFailMs: 50 * 3_600_000,
  /** A scheduled task with no successful run for this many periods is overdue. */
  taskOverduePeriods: 2,
  /** `SELECT 1` slower than this, on one idle VM, says the database is struggling. */
  dbLatencyWarnMs: 250,
  /** Share of `max_connections` in use. */
  connectionsWarn: 0.8,
  connectionsFail: 0.95,
  /** A job waiting this long in a queue that has workers is stuck. */
  jobWaitWarnMs: 10 * 60_000,
} as const;

const T = HEALTH_THRESHOLDS;

/** The worst of several verdicts; `unknown` only when nothing else is known. */
export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  for (const s of ["fail", "warn", "ok"] as const) if (statuses.includes(s)) return s;
  return "unknown";
}

/** The ticker's lag: time since its last completed pass. */
export function tickerStatus(lagMs: number, tickMs: number): CheckStatus {
  return lagMs > Math.max(T.tickerStaleMs, 3 * tickMs) ? "fail" : "ok";
}

/** Attempts or evaluations the ticker should have closed a minute ago. */
export function overdueStatus(count: number): CheckStatus {
  return count > 0 ? "fail" : "ok";
}

/** A disk by its free bytes over its size. */
export function diskStatus(freeBytes: number, totalBytes: number): CheckStatus {
  if (totalBytes <= 0) return "unknown";
  const free = freeBytes / totalBytes;
  if (free < T.diskFailFree) return "fail";
  if (free < T.diskWarnFree) return "warn";
  return "ok";
}

export interface BackupReport {
  finishedAt: Date;
  ok: boolean;
}

/** The last dump: failed, or too old, or fine. */
export function backupStatus(report: BackupReport, now: Date): CheckStatus {
  if (!report.ok) return "fail";
  const age = now.getTime() - report.finishedAt.getTime();
  if (age > T.backupFailMs) return "fail";
  if (age > T.backupWarnMs) return "warn";
  return "ok";
}

export interface TaskState {
  enabled: boolean;
  lastStatus: "running" | "ok" | "error" | null;
  lastOkAt: Date | null;
  intervalMinutes: number;
}

/**
 * Why a scheduled task needs a look, or `null`: its last run failed, or it
 * has had no successful run for `taskOverduePeriods` periods. A disabled task
 * is an administrator's choice, and a task that never ran has nothing to be
 * late on yet (a dead ticker is the ticker's line, not this one).
 */
export function taskAttention(task: TaskState, now: Date): "error" | "overdue" | null {
  if (!task.enabled) return null;
  if (task.lastStatus === "error") return "error";
  if (task.lastOkAt === null) return null;
  const late = now.getTime() - task.lastOkAt.getTime();
  return late > T.taskOverduePeriods * task.intervalMinutes * 60_000 ? "overdue" : null;
}

export function dbLatencyStatus(ms: number): CheckStatus {
  return ms > T.dbLatencyWarnMs ? "warn" : "ok";
}

export function connectionsStatus(used: number, max: number): CheckStatus {
  if (max <= 0) return "unknown";
  const share = used / max;
  if (share >= T.connectionsFail) return "fail";
  if (share >= T.connectionsWarn) return "warn";
  return "ok";
}

/** A job queue: failures in the last day, and the wait of its oldest ready job. */
export function jobsStatus(failed24h: number, oldestWaitMs: number | null): CheckStatus {
  if (oldestWaitMs !== null && oldestWaitMs > T.jobWaitWarnMs) return "warn";
  return failed24h > 0 ? "warn" : "ok";
}
