/**
 * Grading of a `code` question, in two halves (PLAN-MVP §2.4, decision D2).
 *
 * `gradeCode` cannot produce a verdict by itself: it assembles the source and
 * hands back a `pending: runner` result carrying the request. The grading job
 * runs it, then calls `finalizeRunnerCode`, which is PURE — every verdict rule
 * (compile failure, per-case comparison, timeout, OOM, all-or-nothing) is unit
 * testable with a fixture `RunnerOutcome` and no infrastructure at all.
 *
 * Server-only: this module reads `node:crypto` and is never imported by the
 * browser half (`./client`).
 */
import { createHash } from "node:crypto";

import type { FinalizeContext, GradeContext, GradeResult, GradedResult } from "@quiz/core/server";
import { RunnerRequest, zeroGrade, type RunnerOutcome } from "@quiz/core/server";
import { assembleSource, mainFileName, TemplateRegionMismatch } from "@quiz/domain/lockedTemplate";
import { round2 } from "@quiz/domain/round";

import {
  caseTimeMs,
  totalCasePoints,
  type CodeAnswer,
  type CodeCase,
  type CodeCaseDetail,
  type CodeConfig,
  type CodeDetails,
  type CodeReviewDetails,
  type HiddenCaseFailure,
  type ProgramConfig,
  type ReviewCaseDetail,
} from "./schema.js";
import { caseVerdict } from "./verdict.js";

/** Runner output kept in `gradings.details` is capped: a 64 KB stdout is not a grade. */
const DETAIL_CHARS = 4000;

const truncate = (s: string, max = DETAIL_CHARS): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`;

export function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** True when nothing was written in any editable region (F-GRADE-01: zero points). */
export function isEmptyAnswer(answer: CodeAnswer | null): boolean {
  return answer === null || answer.regions.every((r) => r.trim() === "");
}

/**
 * Rebuilds the compilable source from the STORED template and the student's
 * regions (invariant 14). The client never supplies a locked line.
 */
export function assembleCodeSource(config: ProgramConfig, answer: CodeAnswer): string {
  return assembleSource(config.template, config.language, answer.regions);
}

/** The hash of the source the runner compiled; `null` when none can be assembled. */
export function sourceHashOf(config: ProgramConfig, answer: CodeAnswer | null): string | null {
  if (answer === null) return null;
  try {
    return sha256(assembleCodeSource(config, answer));
  } catch {
    return null;
  }
}

/** The compile step of a run, as `gradings.details` keeps it. */
export function compileDetail(outcome: RunnerOutcome): { ok: boolean; stderr: string; ms: number } {
  return {
    ok: outcome.compile.ok,
    stderr: truncate(outcome.compile.stderr),
    ms: outcome.compile.ms,
  };
}

/**
 * The request of any program run. The single main file is named by the
 * language, so a student cannot choose a file name, and the teacher's extra
 * files and flags are taken from the stored config rather than from the
 * browser. They reach every run, the student's included, and are therefore
 * public program inputs that `toStudent` publishes too (ADR-096).
 */
export function programRequest(
  config: ProgramConfig,
  source: string,
  run: Pick<RunnerRequest, "action" | "limits" | "cases" | "priority">,
): RunnerRequest {
  return RunnerRequest.parse({
    language: config.language,
    files: [{ name: mainFileName(config.language), content: source }, ...config.files],
    compileArgs: config.compileArgs,
    ...run,
  });
}

/**
 * The first half of a program grading, `code`'s and `codeimage`'s alike:
 * assemble, then delegate. Nothing is graded here, because nothing can be
 * known before the code has run — except that an empty answer scores zero
 * and an answer that cannot be sent goes to a human.
 */
export function delegateToRunner<D>(
  config: ProgramConfig,
  answer: CodeAnswer | null,
  ctx: GradeContext,
  zero: (runner: "ok" | "error", reason: string) => D,
  request: (source: string) => RunnerRequest,
): GradeResult<D> {
  if (isEmptyAnswer(answer)) {
    return zeroGrade(ctx, zero("ok", "empty"), "validated");
  }

  let source: string;
  try {
    source = assembleCodeSource(config, answer as CodeAnswer);
  } catch (err) {
    // A stored answer that no longer fits the template (the teacher moved a
    // lock marker after the attempt started). Never paste it into the wrong
    // hole, and never silently score it zero either: a human decides.
    if (err instanceof TemplateRegionMismatch) {
      return zeroGrade(ctx, zero("error", err.code), "proposed", err.code);
    }
    throw err;
  }

  let built: RunnerRequest;
  try {
    built = request(source);
  } catch {
    // Oversized source or file set: the runner would refuse it anyway.
    return zeroGrade(ctx, zero("error", "runner_request_invalid"), "proposed", "runner_request_invalid");
  }

  return { kind: "pending", via: "runner", request: built, details: { sourceSha256: sha256(source) } };
}

export interface BuildRequestOptions {
  /** "grading" (background) or "interactive" (the student pressed Run). */
  priority: "grading" | "interactive";
  /** Which cases to send; defaults to every case of the config. */
  cases?: readonly CodeCase[];
  /** `check` compiles only; defaults to `run`. */
  action?: "check" | "run";
}

/**
 * Assembles the request the runner receives for a `code` question.
 *
 * `RunnerRequest.limits.timeMs` is global while a case may carry its own
 * budget, so the request asks for the LARGEST budget of the cases it sends and
 * `finalizeRunnerCode` re-applies each case's own limit to the measured time.
 */
export function buildRunnerRequest(
  config: CodeConfig,
  source: string,
  options: BuildRequestOptions,
): RunnerRequest {
  const cases = options.cases ?? config.tests.cases;
  const timeMs = cases.reduce((max, c) => Math.max(max, caseTimeMs(config, c)), config.limits.timeMs);
  return programRequest(config, source, {
    action: options.action ?? "run",
    limits: { ...config.limits, timeMs },
    // `args` is the case's command line, one argv entry per element. The
    // runner hands them to the program as arguments of a process, never
    // through a shell (apps/runner/src/languages.ts).
    cases: cases.map((c) => ({ name: c.name, args: [...c.args], stdin: c.stdin })),
    priority: options.priority,
  });
}

/**
 * The request behind the student's Run button: the visible cases only,
 * picked by their `visible` flag — never by name, which two cases may share.
 * `null` when the answer is empty, no longer fits the template or the
 * request would be refused, exactly where {@link gradeCode} stops too.
 */
export function buildInteractiveRequest(
  config: CodeConfig,
  answer: CodeAnswer,
): RunnerRequest | null {
  if (isEmptyAnswer(answer)) return null;
  try {
    return buildRunnerRequest(config, assembleCodeSource(config, answer), {
      priority: "interactive",
      cases: config.tests.cases.filter((c) => c.visible),
    });
  } catch {
    return null;
  }
}

function zeroDetails(
  config: CodeConfig,
  runner: CodeDetails["runner"],
  reason: string,
): CodeDetails {
  return {
    runner,
    compile: null,
    cases: [],
    earned: 0,
    total: totalCasePoints(config),
    sourceSha256: null,
    reason,
  };
}

/**
 * The order the grading request runs the cases in, as indices into
 * `config.tests.cases`: the visible cases first, the hidden ones last, each
 * group in the teacher's order (ADR-096). The cases of one request share one
 * container and its `/work`, so a program could keep a hidden case's stdin
 * and print it in a later case's output; with no visible case after a
 * hidden one, no output a student reads can follow a hidden input.
 */
export function gradingOrder(cases: readonly CodeCase[]): number[] {
  const indices = cases.map((_, i) => i);
  return [...indices.filter((i) => cases[i]!.visible), ...indices.filter((i) => !cases[i]!.visible)];
}

/** First half: assemble, then delegate (`delegateToRunner`). */
export function gradeCode(
  config: CodeConfig,
  answer: CodeAnswer | null,
  ctx: GradeContext,
): GradeResult<CodeDetails> {
  return delegateToRunner(
    config,
    answer,
    ctx,
    (runner, reason) => zeroDetails(config, runner, reason),
    (source) =>
      buildRunnerRequest(config, source, {
        priority: "grading",
        cases: gradingOrder(config.tests.cases).map((i) => config.tests.cases[i]!),
      }),
  );
}

/**
 * Second half: the runner has spoken. Pure, total, and the only place a `code`
 * verdict is decided.
 */
export function finalizeRunnerCode(
  config: CodeConfig,
  answer: CodeAnswer | null,
  ctx: FinalizeContext,
  outcome: RunnerOutcome,
): GradedResult<CodeDetails> {
  const total = totalCasePoints(config);
  const sourceSha256 = sourceHashOf(config, answer);
  const compile = compileDetail(outcome);

  if (!compile.ok) {
    return zeroGrade(ctx, { runner: "ok", compile, cases: [], earned: 0, total, sourceSha256 }, "validated");
  }

  // The request ran the cases in `gradingOrder`; the details keep the
  // teacher's order, so case `i` reads the run at its position in that order.
  const runIndex: number[] = [];
  gradingOrder(config.tests.cases).forEach((caseIndex, position) => {
    runIndex[caseIndex] = position;
  });
  const cases: CodeCaseDetail[] = config.tests.cases.map((testCase, i) => {
    const run = outcome.cases[runIndex[i]!];
    if (run === undefined) {
      // The runner sent fewer results than cases: the missing ones did not pass.
      return {
        name: testCase.name,
        visible: testCase.visible,
        points: testCase.points,
        ok: false,
        exitCode: null,
        ms: 0,
        timedOut: false,
        oom: false,
        ...(testCase.compareStdout ? { expected: testCase.expected } : {}),
      };
    }
    // The one rule (`caseVerdict`), with the case's own budget: the request
    // carries one global budget, so a tighter one is applied here, on the
    // measured time. `timed_out` is the first check on a run, so it is also
    // exactly "this case ran out of time".
    const verdict = caseVerdict(testCase, run, config.tests.compare, caseTimeMs(config, testCase));
    return {
      name: testCase.name,
      visible: testCase.visible,
      points: testCase.points,
      ok: verdict.ok,
      exitCode: run.exitCode,
      ms: run.ms,
      timedOut: verdict.failure === "timed_out",
      oom: run.oom,
      ...(testCase.compareStdout ? { expected: testCase.expected } : {}),
      actual: truncate(run.stdout),
      stderr: truncate(run.stderr),
    };
  });

  const earned = cases.reduce((sum, c) => (c.ok ? sum + c.points : sum), 0);
  const fraction = config.allOrNothing
    ? earned === total && total > 0
      ? 1
      : 0
    : total > 0
      ? earned / total
      : 0;

  return {
    kind: "graded",
    points: round2(fraction * ctx.itemPoints),
    maxPoints: ctx.itemPoints,
    details: { runner: "ok", compile, cases, earned, total, sourceSha256 },
    state: "validated",
  };
}

/**
 * The coarse reason a hidden case failed, the most a student reads of it
 * (ADR-096). A case the runner never reported (no `actual`: the run ended
 * before it) failed, it did not crash.
 */
function hiddenFailure(c: CodeCaseDetail): HiddenCaseFailure | undefined {
  if (c.ok) return undefined;
  if (c.timedOut) return "timed_out";
  if (c.oom) return "oom";
  if (c.exitCode === null && c.actual !== undefined) return "crashed";
  return "failed";
}

/**
 * The details a STUDENT may read (decision D15, ADR-096). A visible case
 * travels whole. A hidden case keeps its verdict — a student must be able to
 * see what the scale was made of — and nothing of what the program did: no
 * expected output, no output, no exit code, no time, only a coarse failure
 * category. Its name stays `#n` unless the feedback policy opens the names.
 *
 * The grading panel keeps the unredacted details; this is the filter the
 * feedback policy applies on the way out, when it does not publish the key.
 */
export function studentDetails(
  details: CodeDetails,
  options: { showHiddenCaseNames?: boolean } = {},
): CodeReviewDetails {
  const show = options.showHiddenCaseNames === true;
  return {
    ...details,
    cases: details.cases.map((c, i): ReviewCaseDetail => {
      if (c.visible) return c;
      const failure = hiddenFailure(c);
      return {
        name: show ? c.name : `#${i + 1}`,
        visible: false,
        points: c.points,
        ok: c.ok,
        ...(failure === undefined ? {} : { failure }),
      };
    }),
  };
}
