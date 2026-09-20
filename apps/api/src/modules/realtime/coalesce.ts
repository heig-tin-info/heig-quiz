/**
 * Time-window coalescing for the noisy live events (PLAN-MVP §4.8).
 *
 * A dashboard with 200 students autosaving every 300 ms would push ~700
 * `dashboard.cell` frames per second down every teacher connection. The
 * coalescer collapses that to ONE frame per window and per key — the key of
 * `dashboard.cell` being `(attemptId, itemId)`, so no cell ever hides
 * another.
 *
 * Trailing edge on purpose: the window opens on the first push and emits the
 * LATEST value when it closes. A student typing a word does not make the grid
 * flash through four intermediate states; the teacher sees the last one.
 *
 * The timer functions are injectable so a test can close a window without
 * waiting for it.
 */

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // A pending window must never hold the process open at shutdown.
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

export class Coalescer<T> {
  private readonly pending = new Map<string, T>();
  private readonly windows = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly windowMs: number,
    private readonly emit: (value: T) => void,
    private readonly timers: TimerApi = realTimers,
  ) {}

  /** Records `value` for `key`; at most one emission per window and per key. */
  push(key: string, value: T): void {
    this.pending.set(key, value);
    if (this.windows.has(key)) return;
    if (this.windowMs <= 0) {
      this.release(key);
      return;
    }
    this.windows.set(
      key,
      this.timers.setTimeout(() => this.release(key), this.windowMs),
    );
  }

  /** Emits everything that is waiting, right now. Used at shutdown and in tests. */
  flush(): void {
    for (const key of [...this.pending.keys()]) this.release(key);
  }

  /** Drops everything without emitting. */
  clear(): void {
    for (const handle of this.windows.values()) this.timers.clearTimeout(handle);
    this.windows.clear();
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }

  private release(key: string): void {
    const handle = this.windows.get(key);
    if (handle !== undefined) {
      this.timers.clearTimeout(handle);
      this.windows.delete(key);
    }
    const value = this.pending.get(key);
    if (value === undefined) return;
    this.pending.delete(key);
    this.emit(value);
  }
}
