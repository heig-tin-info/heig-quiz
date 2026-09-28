/**
 * What "live" means for an activity (issue #190): students are in the room,
 * or about to be. ONE definition, the deploy guard's
 * (`scripts/live-evaluations.sql`, docs/spec/05 §5.9); this is its TypeScript
 * twin, and `deployGuard.db.test.ts` runs the SQL file and this function on
 * the same rows so the two cannot drift apart.
 *
 *   - `lobby`, `running` or `paused`, touched in the last 12 hours;
 *   - `scheduled`, opening in the next 15 minutes or less than 12 hours ago
 *     (the ticker opens it at once);
 *   - never a take-home exercise ({@link isTakeHome}): it stays open for days
 *     and nobody sits in front of it together.
 *
 * Pure: the instant is the caller's.
 */

/** A `scheduled` activity is live this long before it opens. */
export const LIVE_LEAD_MS = 15 * 60_000;
/** A session untouched this long was left open: nobody is waiting on it. */
export const LIVE_STALE_MS = 12 * 3_600_000;

/**
 * An `exercise` whose waiting room is `skip`: the glossary's exercise, done
 * at home over days (docs/spec/01 §5; `isInClass` in `evaluationConfig.ts`
 * is the same fact seen from the feedback policy). An absent `lobby` is the
 * contract's default, `manual`: in class.
 */
export function isTakeHome(row: { mode: string; lobby: string | null | undefined }): boolean {
  return row.mode === "exercise" && row.lobby === "skip";
}

export interface LiveFacts {
  state: string;
  takeHome: boolean;
  opensAt: Date | string | null;
  /** Set by every transition and every edit. */
  updatedAt: Date | string;
}

const ms = (d: Date | string) => new Date(d).getTime();

/** Whether the deploy guard would name this activity at `now`. */
export function isLiveNow(row: LiveFacts, now: Date | number): boolean {
  if (row.takeHome) return false;
  const t = typeof now === "number" ? now : now.getTime();
  if (row.state === "lobby" || row.state === "running" || row.state === "paused") {
    return ms(row.updatedAt) > t - LIVE_STALE_MS;
  }
  if (row.state === "scheduled" && row.opensAt !== null) {
    const opens = ms(row.opensAt);
    return opens < t + LIVE_LEAD_MS && opens > t - LIVE_STALE_MS;
  }
  return false;
}
