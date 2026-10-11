/**
 * The BACKEND half of a student's "Run" (ADR-015). Which runner serves the
 * run is decided one level up, in `src/runner/`: `student/Player.tsx` hands
 * this function to `runCode` as the backend path, and the browser runner
 * takes over when the question asks for it or when this one answers 503.
 * Nothing about the call below changed, and nothing about it should: a
 * graded run is this one.
 */
import { useCallback } from "react";

import type { RunAccepted, RunnerResultEvent } from "@quiz/contracts";
import type { InteractiveOutcome, RunOutcome, RunnerOutcome, SimulateOutcome } from "@quiz/core/server";

import { ApiError, api } from "../api";

export type RunFn = (
  itemId: string,
  regions: string[],
  /** The free try of §4.7; absent, the server runs the VISIBLE cases. */
  manual?: { args: string[]; stdin: string },
  /** `compileOnly`: the Compile button — build, run nothing, no input. */
  options?: { compileOnly?: boolean | undefined },
) => Promise<RunOutcome>;

/** The SSE result shape is not the runner's; the player speaks the latter. */
export function toOutcome(result: RunnerResultEvent["result"]): RunnerOutcome | "unavailable" {
  if (result.status === "unavailable") return "unavailable";
  // Saturation is not "no runner": try again in a moment (ADR-101).
  if (result.status === "busy") throw new Error("runner busy");
  if (result.status === "error") throw new Error(result.message);
  return {
    compile: { ok: result.compile.ok, stdout: "", stderr: result.compile.stderr, ms: 0 },
    // The server sends the VISIBLE cases in their published order, which is
    // the order the player's table walks (deviation W5-12).
    cases: result.cases.map((c) => ({
      exitCode: c.exitCode,
      stdout: c.stdout,
      stderr: c.stderr,
      ms: c.ms,
      timedOut: c.timedOut,
      oom: c.oom,
      truncated: c.truncated,
    })),
  };
}

/**
 * The body of a run request: a `stdin` — even an empty one — is what tells
 * the server this is the free try rather than the visible cases (`RunBody`);
 * `compileOnly` is the Compile button, which takes no input.
 */
export function runBody(
  itemId: string,
  regions: string[],
  manual?: { args: string[]; stdin: string },
  options?: { compileOnly?: boolean | undefined },
) {
  return options?.compileOnly === true
    ? { itemId, regions, compileOnly: true as const }
    : manual === undefined
      ? { itemId, regions }
      : { itemId, regions, stdin: manual.stdin, args: manual.args };
}

/**
 * Two refusals of a run are not failures and must not read as one: 503 is a
 * configuration (decision D14) — the player says so in one line and the
 * answer is still saved and still graded — and 429 is the per-attempt budget
 * (N-SEC-07), which tells the student to wait, not that running is off.
 * A 503 whose reason is `busy` is neither: the runner, or the evaluation's
 * share of it, is saturated (ADR-101). It stays thrown, so the player says
 * "try again in a moment" and no browser runner stands in.
 * Anything else is a real failure the player shows in red.
 */
async function withRefusals<T>(call: () => Promise<T>): Promise<T | "unavailable" | "rate_limited"> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiError && error.status === 503 && !isBusy(error)) return "unavailable";
    if (error instanceof ApiError && error.status === 429) return "rate_limited";
    throw error;
  }
}

const isBusy = (error: ApiError): boolean =>
  (error.body as { reason?: unknown } | null)?.reason === "busy";

const post = <T>(url: string, body: unknown) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });

/** `…/run`: a program against its cases, or the free try. */
export const postRun = (url: string, body: unknown): Promise<RunOutcome> =>
  withRefusals(async () => toOutcome((await post<RunAccepted>(url, body)).result));

/**
 * `…/simulate`: the student's own button of a type that builds its own
 * request (ADR-019) — the `circuit` player's "Simulate", and the backend half
 * of a `codeimage` "Run" (ADR-021). Only the server may turn a schematic into
 * a SPICE netlist (invariant 14), so its answer is already the runner's,
 * reduced by the type (ADR-019 §6).
 */
export const postSimulate = (url: string, body: unknown): Promise<SimulateOutcome> =>
  withRefusals(() => post<InteractiveOutcome>(url, body));

export function useAttemptRun(attemptId: string): RunFn {
  return useCallback<RunFn>(
    (itemId, regions, manual, options) =>
      postRun(`/app/api/attempts/${attemptId}/run`, runBody(itemId, regions, manual, options)),
    [attemptId],
  );
}
