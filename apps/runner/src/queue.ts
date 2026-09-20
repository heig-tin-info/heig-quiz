import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

/**
 * Two queues, one pool.
 *
 * `interactive` is a student waiting in front of their screen for the Run
 * button to answer; `grading` is a background pass that pg-boss will happily
 * retry in thirty seconds. So interactive always goes first, and a grading
 * pass can never starve a classroom: the ordering is absolute, not weighted.
 *
 * Beyond `queueMax` waiting requests the answer is `429` with a `Retry-After`
 * (queue.ts never blocks a caller it cannot serve). The HTTP client of the API
 * turns that into `RunnerBusy`, which the grading job lets pg-boss retry and
 * the interactive path shows as "try again in a moment". It is never retried
 * inside the runner: retrying a full queue is how a full queue stays full.
 */

export class QueueFull extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("queue_full");
    this.name = "QueueFull";
  }
}

export type Priority = RunnerRequest["priority"];

export interface QueueOptions {
  concurrency: number;
  queueMax: number;
  run: (request: RunnerRequest) => Promise<RunnerOutcome>;
}

export interface QueueStats {
  queued: number;
  running: number;
  concurrency: number;
  queueMax: number;
  /** Mean duration of the last runs, `null` until the first one lands. */
  avgMs: number | null;
}

interface Waiter {
  request: RunnerRequest;
  resolve: (outcome: RunnerOutcome) => void;
  reject: (error: unknown) => void;
}

/** How many durations the average is computed over. */
const WINDOW = 50;

export class RunQueue {
  private readonly waiting: Record<Priority, Waiter[]> = { interactive: [], grading: [] };
  private running = 0;
  private readonly durations: number[] = [];

  constructor(private readonly options: QueueOptions) {}

  get depth(): number {
    return this.waiting.interactive.length + this.waiting.grading.length;
  }

  stats(): QueueStats {
    return {
      queued: this.depth,
      running: this.running,
      concurrency: this.options.concurrency,
      queueMax: this.options.queueMax,
      avgMs:
        this.durations.length === 0
          ? null
          : Math.round(this.durations.reduce((sum, ms) => sum + ms, 0) / this.durations.length),
    };
  }

  /** Resolves with the outcome, or rejects with {@link QueueFull}. */
  submit(request: RunnerRequest): Promise<RunnerOutcome> {
    if (this.depth >= this.options.queueMax) {
      return Promise.reject(new QueueFull(this.retryAfterSeconds()));
    }
    return new Promise<RunnerOutcome>((resolve, reject) => {
      this.waiting[request.priority].push({ request, resolve, reject });
      this.pump();
    });
  }

  /**
   * An honest guess at when a slot frees up: the queue ahead of the caller,
   * divided by the pool, times what a run costs lately. Floored at one second
   * and capped at half a minute, because a `Retry-After` nobody believes is
   * worse than none.
   */
  private retryAfterSeconds(): number {
    const average = this.stats().avgMs ?? 3000;
    const ahead = Math.ceil((this.depth + 1) / this.options.concurrency);
    return Math.min(30, Math.max(1, Math.ceil((ahead * average) / 1000)));
  }

  private next(): Waiter | undefined {
    return this.waiting.interactive.shift() ?? this.waiting.grading.shift();
  }

  private pump(): void {
    while (this.running < this.options.concurrency) {
      const waiter = this.next();
      if (waiter === undefined) return;
      this.running += 1;
      const started = Date.now();
      // The books are closed BEFORE the caller is told: whoever is woken by
      // the answer reads a `stats()` that already counts their own run.
      const settle = (deliver: () => void): void => {
        this.running -= 1;
        this.durations.push(Date.now() - started);
        if (this.durations.length > WINDOW) this.durations.shift();
        deliver();
        this.pump();
      };
      void this.options.run(waiter.request).then(
        (outcome) => settle(() => waiter.resolve(outcome)),
        (error: unknown) => settle(() => waiter.reject(error)),
      );
    }
  }
}
