/**
 * A per-minute budget of actions by key, in memory: per process and lost on
 * restart, which is the right weight for a guard against a held-down button
 * or a double click, not against a determined user. Used by the preview's
 * runs, compilations and gradings (`modules/preview`), and by the admin's
 * test e-mail (`modules/admin`, ADR-055 §6).
 */
export class Budget {
  private readonly hits = new Map<string, number[]>();

  /** Spends one unit of `key` if fewer than `limit` were spent in the last minute; false otherwise. */
  spend(key: string, limit: number, now: Date): boolean {
    const since = now.getTime() - 60_000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now.getTime());
    this.hits.set(key, recent);
    // Keep the map from growing with every user who ever pressed a button.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.every((t) => t <= since)) this.hits.delete(k);
    }
    return true;
  }
}

/** A refused spend waits at most this long: the window's width. */
export const BUDGET_RETRY_AFTER_S = 60;
