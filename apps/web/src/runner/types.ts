/**
 * What a runner is, on this side of the wire.
 *
 * The backend runner (`apps/runner`, hardened Podman containers) and the
 * browser runner (Runno / WASI in a Web Worker) answer the SAME two shapes,
 * `RunnerRequest` in and `RunnerOutcome` out, because a player must not know
 * which one served it. Grading is never one of them: it is the server's, on
 * the backend runner, always (ADR-015).
 */
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";

/** Where the student's trial run is executing, for the one line the player shows. */
export type RunStage = "loading" | "compiling" | "running";

export interface RunHooks {
  /**
   * Called as the run moves on. `loading` is the interesting one: the first
   * run of a session downloads tens of megabytes of runtime, and a button that
   * simply stays pressed for twenty seconds reads as a broken page.
   */
  onStage?: (stage: RunStage) => void;
}

export interface BrowserRunner {
  /** For logs and tests; `runno` is the only implementation today. */
  readonly id: string;
  supports(language: string): boolean;
  run(request: RunnerRequest, hooks?: RunHooks): Promise<RunnerOutcome>;
}

/** A free input: one command line and one stdin, from the person running it. */
export interface ManualInput {
  args: string[];
  stdin: string;
}

/**
 * The backend path: the API call, exactly as it is. `"unavailable"` is a
 * 503/429.
 *
 * It takes NO request. `POST /attempts/:id/run` rebuilds the program from the
 * stored template and the stored regions and the cases from the published
 * ones — invariant 14 — so a request assembled in the browser has nowhere to
 * go, and a parameter holding one is an invitation to send it. The single
 * thing a client is allowed to choose is the free input, and that is what
 * travels.
 */
export type BackendRun = (
  manual?: ManualInput,
  options?: BackendRunOptions,
) => Promise<RunnerOutcome | "unavailable" | "rate_limited">;

export interface BackendRunOptions {
  /**
   * The Compile button: `RunBody.compileOnly`. The server builds the program
   * and runs no case; the outcome has an empty case list.
   */
  compileOnly?: boolean | undefined;
}

/** The browser runner could not even start (no runtime files, no worker). */
export class BrowserRunnerUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`browser runner unavailable: ${reason}`);
    this.name = "BrowserRunnerUnavailable";
  }
}
