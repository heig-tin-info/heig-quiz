import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

/**
 * Two queues, one pool.
 *
 * `interactive` is a student waiting in front of their screen for the Run
 * button to answer; `grading` is a background pass that pg-boss will happily
 * retry in a few seconds. So interactive goes first, and a grading pass can
 * never starve a classroom — but a class running code must not starve the
 * grading either, or every hand-in's run waits out the API's patience
 * (audit M5). Hence the aging: a grading request that has waited
 * {@link GRADING_AGING_MS} (well under the API's queue allowance) goes before
 * the interactive ones. Only the background grading sends `grading`, at most
 * `GRADING_RUNNER_CONCURRENCY` runs in flight (one by default); a teacher's
 * try and preview are interactive, and rate-limited. So aged requests cost
 * the class at most that many slots, never the pool (ADR-101, amending
 * ADR-067 §5).
 *
 * Beyond `queueMax` waiting requests the answer is `429` with a `Retry-After`
 * (queue.ts never blocks a caller it cannot serve). The HTTP client of the API
 * turns that into `RunnerBusy`, which the grading job lets pg-boss retry and
 * the interactive path shows as "try again in a moment". It is never retried
 * inside the runner: retrying a full queue is how a full queue stays full.
 *
 * A caller that goes away takes its request with it: the `signal` of
 * `submit` removes a waiting request from its queue, and is handed to `run`
 * for a running one, which destroys its container. Otherwise a client that
 * gave up (the API stops waiting past its queue allowance) would still hold
 * one of the few slots for a run nobody reads.
 */

export class QueueFull extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("queue_full");
    this.name = "QueueFull";
  }
}

export type Priority = RunnerRequest["priority"];

/** How long a grading request waits before it goes ahead of the interactive ones. */
export const GRADING_AGING_MS = 10_000;

export interface QueueOptions {
  concurrency: number;
  queueMax: number;
  run: (request: RunnerRequest, signal?: AbortSignal) => Promise<RunnerOutcome>;
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
  signal: AbortSignal | undefined;
  /** When it joined its queue, for the aging of a grading request. */
  queuedAt: number;
  /** Stops listening to `signal` once the request leaves the queue. */
  detach: () => void;
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

  /**
   * Resolves with the outcome, or rejects with {@link QueueFull}, or with the
   * signal's reason once it aborts while the request is still waiting.
   */
  submit(request: RunnerRequest, signal?: AbortSignal): Promise<RunnerOutcome> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.depth >= this.options.queueMax) {
      return Promise.reject(new QueueFull(this.retryAfterSeconds()));
    }
    return new Promise<RunnerOutcome>((resolve, reject) => {
      const queue = this.waiting[request.priority];
      const onAbort = (): void => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        request,
        signal,
        queuedAt: Date.now(),
        resolve,
        reject,
        // Once running, the request is `run`'s to stop: it has the signal.
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
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

  /**
   * The oldest grading request once it has aged, then interactive, then
   * grading. Read only when a slot frees up (or a request arrives), which is
   * the only moment the order matters: no timer.
   */
  private next(): Waiter | undefined {
    const oldest = this.waiting.grading[0];
    const aged = oldest !== undefined && Date.now() - oldest.queuedAt >= GRADING_AGING_MS;
    if (aged) return this.waiting.grading.shift();
    return this.waiting.interactive.shift() ?? this.waiting.grading.shift();
  }

  private pump(): void {
    while (this.running < this.options.concurrency) {
      const waiter = this.next();
      if (waiter === undefined) return;
      waiter.detach();
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
      void this.options.run(waiter.request, waiter.signal).then(
        (outcome) => settle(() => waiter.resolve(outcome)),
        (error: unknown) => settle(() => waiter.reject(error)),
      );
    }
  }
}
