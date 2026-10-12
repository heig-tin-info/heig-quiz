/**
 * The runner that refuses — and the default one (decision D14).
 *
 * `RUNNER_MODE=stub` is what every development machine and CI runner uses,
 * because none of them has a container engine. A `code` question must still be
 * authorable, playable and releasable there: `run()` throws
 * `RunnerUnavailable`, the grading job turns that into a `proposed` grading
 * with `comment: "runner_unavailable"`, and nothing blocks.
 */
import {
  RunnerUnavailable,
  type ProjectRunnerService,
  type RunnerHealth,
  type RunnerService,
} from "@quiz/core/server";

export class UnavailableRunner implements RunnerService, ProjectRunnerService {
  constructor(private readonly reason: string = "not_configured") {}

  run(): Promise<never> {
    return Promise.reject(new RunnerUnavailable(this.reason));
  }

  /** A project run has nowhere to go either (ADR-106 §3). */
  project(): Promise<never> {
    return Promise.reject(new RunnerUnavailable(this.reason));
  }

  health(): Promise<RunnerHealth> {
    return Promise.resolve({
      ok: false,
      languages: [],
      queued: 0,
      avgMs: null,
      reason: this.reason,
    });
  }
}
