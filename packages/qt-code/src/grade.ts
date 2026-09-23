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
import { RunnerRequest, type RunnerOutcome } from "@quiz/core/server";
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
export function assembleCodeSource(config: CodeConfig, answer: CodeAnswer): string {
  return assembleSource(config.template, config.language, answer.regions);
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
 * Assembles the request the runner receives. The single main file is named by
 * the language, so a student cannot choose a file name, and the teacher's extra
 * files are injected here rather than travelling through the browser.
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
  return RunnerRequest.parse({
    language: config.language,
    files: [{ name: mainFileName(config.language), content: source }, ...config.files],
    compileArgs: config.compileArgs,
    action: options.action ?? "run",
    limits: { ...config.limits, timeMs },
    // `args` is the case's command line, one argv entry per element. The
    // runner hands them to the program as arguments of a process, never
    // through a shell (apps/runner/src/languages.ts).
    cases: cases.map((c) => ({ name: c.name, args: [...c.args], stdin: c.stdin })),
    priority: options.priority,
  });
}

/** The request behind the student's Run button: the visible cases only. */
export function buildInteractiveRequest(config: CodeConfig, answer: CodeAnswer): RunnerRequest {
  return buildRunnerRequest(config, assembleCodeSource(config, answer), {
    priority: "interactive",
    cases: config.tests.cases.filter((c) => c.visible),
  });
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
 * First half: assemble, then delegate. Nothing is graded here, because nothing
 * can be known before the code has run.
 */
export function gradeCode(
  config: CodeConfig,
  answer: CodeAnswer | null,
  ctx: GradeContext,
): GradeResult<CodeDetails> {
  if (isEmptyAnswer(answer)) {
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: zeroDetails(config, "ok", "empty"),
      state: "validated",
    };
  }

  let source: string;
  try {
    source = assembleCodeSource(config, answer as CodeAnswer);
  } catch (err) {
    // A stored answer that no longer fits the template (the teacher moved a
    // lock marker after the attempt started). Never paste it into the wrong
    // hole, and never silently score it zero either: a human decides.
    if (err instanceof TemplateRegionMismatch) {
      return {
        kind: "graded",
        points: 0,
        maxPoints: ctx.itemPoints,
        details: zeroDetails(config, "error", err.code),
        state: "proposed",
        comment: err.code,
      };
    }
    throw err;
  }

  let request: RunnerRequest;
  try {
    request = buildRunnerRequest(config, source, { priority: "grading" });
  } catch {
    // Oversized source or file set: the runner would refuse it anyway.
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: zeroDetails(config, "error", "runner_request_invalid"),
      state: "proposed",
      comment: "runner_request_invalid",
    };
  }

  return { kind: "pending", via: "runner", request, details: { sourceSha256: sha256(source) } };
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
  let sourceSha256: string | null = null;
  if (answer !== null) {
    try {
      sourceSha256 = sha256(assembleCodeSource(config, answer));
    } catch {
      sourceSha256 = null;
    }
  }

  const compile = {
    ok: outcome.compile.ok,
    stderr: truncate(outcome.compile.stderr),
    ms: outcome.compile.ms,
  };

  if (!compile.ok) {
    return {
      kind: "graded",
      points: 0,
      maxPoints: ctx.itemPoints,
      details: { runner: "ok", compile, cases: [], earned: 0, total, sourceSha256 },
      state: "validated",
    };
  }

  const cases: CodeCaseDetail[] = config.tests.cases.map((testCase, i) => {
    const run = outcome.cases[i];
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
 * The details a STUDENT may read (decision D15). Hidden cases keep their
 * verdict — a student must be able to see what the scale was made of — but
 * lose their name, their expected output and everything the code printed,
 * unless the feedback policy opens the names.
 *
 * The grading panel keeps the unredacted details; this is the filter the
 * feedback policy applies on the way out.
 */
export function studentDetails(
  details: CodeDetails,
  options: { showHiddenCaseNames?: boolean } = {},
): CodeDetails {
  const show = options.showHiddenCaseNames === true;
  return {
    ...details,
    cases: details.cases.map((c, i) =>
      c.visible
        ? c
        : {
            name: show ? c.name : `#${i + 1}`,
            visible: false,
            points: c.points,
            ok: c.ok,
            exitCode: c.exitCode,
            ms: c.ms,
            timedOut: c.timedOut,
            oom: c.oom,
          },
    ),
  };
}
