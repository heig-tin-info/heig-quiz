/**
 * "Did this case pass?" — the ONE rule (audit R-06, ADR-015 §2).
 *
 * Before this file there were five copies: the grade (`finalizeRunnerCode`,
 * the authority), the API's run route, the editor's "try", the player and
 * the review. They disagreed — the run route and the player ignored the
 * teacher's comparison options, the run route ignored `oom` — so a question
 * with `ignoreCase: true` read "Output differs" in the player and scored full
 * marks in the grade. Every site now asks this function, and the two views
 * only turn its `failure` into their own sentence.
 *
 * Pure and dependency-light (no React, no `node:*`), so it is exported from
 * BOTH entry points of the package, like `referenceRegions`.
 */
import { compareOutput } from "@quiz/domain/compareOutput";

import type { CodeCompare } from "./schema.js";

/** What a case asks for. Every case shape of the package fits it. */
export interface CaseSpec {
  expected: string;
  /** Absent in a payload older than the two checks: it compared stdout. */
  compareStdout?: boolean | undefined;
  /** `null` accepts any exit code; absent (an older payload) meant 0. */
  expectedExitCode?: number | null | undefined;
}

/** What a run of the case produced: a runner's case result, or a browser run's. */
export interface CaseRun {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  oom: boolean;
  ms: number;
}

/** Why a case did not pass, in the order a person debugs in. */
export type CaseFailure = "not_run" | "timed_out" | "oom" | "crashed" | "exit" | "output";

export interface CaseVerdict {
  ok: boolean;
  failure: CaseFailure | null;
}

/**
 * The verdict of one case.
 *
 * A case fails on an accident whatever it checks — it did not run, the wall
 * clock, the memory ceiling, or a process with no exit code of its own
 * (killed). Past that, the two checks are independent and each is optional:
 * `expectedExitCode: null` accepts any code, `compareStdout: false` compares
 * nothing (the schema refuses a case that enables neither).
 *
 * `budgetMs` is the case's own wall-clock budget when the caller knows it:
 * the runner request carries ONE global budget, so a case with a tighter one
 * is timed out here, on the measured time. Omitted, only the runner's own
 * `timedOut` counts.
 */
export function caseVerdict(
  spec: CaseSpec,
  run: CaseRun | undefined,
  compare: Partial<CodeCompare> | undefined,
  budgetMs?: number,
): CaseVerdict {
  if (run === undefined) return { ok: false, failure: "not_run" };
  if (run.timedOut || (budgetMs !== undefined && run.ms > budgetMs)) {
    return { ok: false, failure: "timed_out" };
  }
  if (run.oom) return { ok: false, failure: "oom" };
  if (run.exitCode === null) return { ok: false, failure: "crashed" };
  const wantExit = spec.expectedExitCode === undefined ? 0 : spec.expectedExitCode;
  if (wantExit !== null && run.exitCode !== wantExit) return { ok: false, failure: "exit" };
  if (spec.compareStdout !== false && !compareOutput(spec.expected, run.stdout, compare ?? {})) {
    return { ok: false, failure: "output" };
  }
  return { ok: true, failure: null };
}
