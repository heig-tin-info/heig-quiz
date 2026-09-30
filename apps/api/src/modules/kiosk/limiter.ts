/**
 * A fixed-window counter per key, in the process's memory: what keeps the
 * public attestation routes — each call of which reaches Google — from being
 * a free way to spend the platform's Verified Access quota. Best effort: a
 * restart forgets it, and a second process would count apart.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Counts a hit; null when it is allowed, else the seconds until the window reopens. */
  hit(key: string, nowMs: number): number | null {
    this.prune(nowMs);
    const current = this.windows.get(key);
    if (!current || nowMs - current.start >= this.windowMs) {
      this.windows.set(key, { start: nowMs, count: 1 });
      return null;
    }
    if (current.count >= this.limit) {
      return Math.max(1, Math.ceil((current.start + this.windowMs - nowMs) / 1000));
    }
    current.count += 1;
    return null;
  }

  /** Forgets the closed windows, so the map holds only the callers of the last window. */
  private prune(nowMs: number) {
    for (const [key, w] of this.windows) {
      if (nowMs - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
