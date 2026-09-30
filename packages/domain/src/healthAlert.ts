/**
 * When a health check mails the administrators (ADR-055 §5): the anti-flap
 * rule of the `health.checks` scheduled task. The task runs the registry
 * every few minutes and keeps, per check, the state below; this rule turns
 * one more observation into the next state and, at most, one notice.
 *
 *  - `failing` when a check has been `fail` for `failRuns` consecutive runs:
 *    one slow run, one restart, one blip of the runner is not news;
 *  - `recovered` when it is `ok` again after an alert was sent — and only
 *    then: a failure nobody was told about recovers silently;
 *  - `still_failing` when it still fails `reminderMs` after the last notice;
 *  - nothing on `warn` (the page shows it; a mail per late dump would train
 *    the reader to ignore the mail), nothing on `unknown` (not a verdict),
 *    and never the same notice twice while nothing changed.
 *
 * Pure (invariant 8): the instant is injected, the storage is the caller's.
 */
import type { CheckStatus } from "./health.js";

export const HEALTH_ALERT = {
  /** Consecutive `fail` runs before the administrators are told. */
  failRuns: 2,
  /** A check still failing this long after the last notice is told again. */
  reminderMs: 24 * 3_600_000,
} as const;

/** What the task keeps of one check between two runs. */
export interface CheckState {
  /** The status of the last run. */
  status: CheckStatus;
  /**
   * When the check took that status (the first run of the streak). While an
   * alert is outstanding, a run that could not measure (`unknown`) does not
   * end the failure: `since` stays the first failed run.
   */
  since: Date;
  /** Runs in a row with that status, this one included. */
  consecutive: number;
  /**
   * The last notice sent about this check: `fail` while an alert is
   * outstanding (recovery owed), `ok` once its recovery was sent, `null`
   * when nobody was ever told.
   */
  notified: "fail" | "ok" | null;
  notifiedAt: Date | null;
}

/** Mirrors `SYSTEM_ALERT_STATES` of `@quiz/contracts` (the domain depends on no schema package). */
export type CheckNotice = "failing" | "still_failing" | "recovered";

/**
 * The next state of a check after one run, and the notice it calls for.
 * `previous` is `null` for a check never recorded (a first run, a new key).
 */
export function nextCheckState(
  previous: CheckState | null,
  status: CheckStatus,
  now: Date,
): { state: CheckState; notice: CheckNotice | null } {
  const streak = previous !== null && previous.status === status;
  // An outstanding alert's failure goes on through runs that measured nothing.
  const stillFailing =
    previous?.notified === "fail" &&
    (status === "fail" || status === "unknown") &&
    (previous.status === "fail" || previous.status === "unknown");
  const state: CheckState = {
    status,
    since: streak || stillFailing ? previous!.since : now,
    consecutive: streak ? previous.consecutive + 1 : 1,
    notified: previous?.notified ?? null,
    notifiedAt: previous?.notifiedAt ?? null,
  };
  const told = (notified: "fail" | "ok", notice: CheckNotice) => ({
    state: { ...state, notified, notifiedAt: now },
    notice,
  });

  if (status === "ok") return state.notified === "fail" ? told("ok", "recovered") : { state, notice: null };
  if (status !== "fail" || state.consecutive < HEALTH_ALERT.failRuns) return { state, notice: null };
  if (state.notified !== "fail") return told("fail", "failing");
  const quiet = now.getTime() - (state.notifiedAt?.getTime() ?? 0);
  return quiet >= HEALTH_ALERT.reminderMs ? told("fail", "still_failing") : { state, notice: null };
}
