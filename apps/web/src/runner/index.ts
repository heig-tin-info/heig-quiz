/**
 * Which runner serves a student's "Run", and what happens when it cannot.
 *
 * Two runners exist and they answer the same shapes: the backend one
 * (`apps/runner`, one hardened Podman container per request) and the browser
 * one (`./runno`, WASI in a Web Worker). A question says which it prefers —
 * `CodeConfig.runtime`, `backend` by default — and this module owns the one
 * rule that decides the rest, so the player and the teacher's try panel cannot
 * drift apart (ADR-015):
 *
 *   - `runtime: "runno"` and the browser can run that language: the browser
 *     runs it. If its runtime will not load (no `/runtimes` on this
 *     deployment, no `Worker`, a fetch that failed), the backend takes over.
 *   - otherwise the backend runs it. When the backend answers
 *     `503 runner_unavailable` — which is a configuration, not a failure
 *     (decision D14) — the browser takes over if it can.
 *
 * Grading never comes through here. A browser result is what the student sees;
 * the mark is the server's, computed on the backend runner, always.
 */
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import { RUNNO_LANGUAGES, type CodeRuntime } from "@quiz/qt-code/client";

import { BrowserRunnerUnavailable, type BackendRun, type BrowserRunner, type RunHooks } from "./types";

export type { BackendRun, BrowserRunner, ManualInput, RunHooks, RunStage } from "./types";
export { BrowserRunnerUnavailable } from "./types";

/** Cheap enough to answer before loading anything: the list is two entries long. */
export function browserCanRun(language: string): boolean {
  return (RUNNO_LANGUAGES as readonly string[]).includes(language);
}

/**
 * The browser runner for a language, loaded on demand.
 *
 * The import is dynamic so that `@runno/wasi`, the worker and the tar reader
 * stay out of the chunk a student downloads to answer an MCQ (N-PERF-05).
 */
export async function browserRunner(language: string): Promise<BrowserRunner | null> {
  if (!browserCanRun(language)) return null;
  try {
    const { runnoRunner } = await import("./runno/runner");
    return runnoRunner.supports(language) ? runnoRunner : null;
  } catch {
    return null;
  }
}

/**
 * The runner to TRY FIRST, or `null` for "the backend".
 *
 * Exported because the player asks the same question to decide whether to
 * print "Runs in your browser — the server grades" under the button.
 */
export async function runnerFor(
  runtime: CodeRuntime,
  language: string,
): Promise<BrowserRunner | null> {
  return runtime === "runno" ? browserRunner(language) : null;
}

export interface RunOptions {
  runtime: CodeRuntime;
  /**
   * The backend path, exactly the API call it already was. It is called with
   * no argument here: the free input, when there is one, is closed over by the
   * caller that knows about it (`runCode`).
   */
  backend: BackendRun;
  hooks?: RunHooks | undefined;
  /**
   * Overrides the lookup above. The tests pass a fake runner here; nothing in
   * the app does.
   */
  browser?: BrowserRunner | null | undefined;
}

/**
 * Runs `request`, applying the rule at the top of this file.
 *
 * `"unavailable"` means neither runner could: the player says so in one line,
 * the answer is still saved and still graded.
 */
export async function runWithFallback(
  request: RunnerRequest,
  options: RunOptions,
): Promise<RunnerOutcome | "unavailable"> {
  const language = request.language;
  const browser =
    options.browser !== undefined ? options.browser : await browserRunner(language);
  const usable = browser !== null && browser.supports(language);

  if (options.runtime === "runno" && usable && browser !== null) {
    try {
      return await browser.run(request, options.hooks);
    } catch (error) {
      // The runtime did not load. That is a deployment fact, not a student's
      // problem: the backend answers instead, from its own copy of the program.
      if (!(error instanceof BrowserRunnerUnavailable)) throw error;
      return options.backend();
    }
  }

  const outcome = await options.backend();
  if (outcome !== "unavailable") return outcome;
  if (!usable || browser === null) return "unavailable";
  try {
    return await browser.run(request, options.hooks);
  } catch (error) {
    if (!(error instanceof BrowserRunnerUnavailable)) throw error;
    return "unavailable";
  }
}
