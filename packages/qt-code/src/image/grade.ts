/**
 * Grading of a `codeimage` question, in `code`'s two halves (decision D2).
 *
 * `gradeCodeImage` assembles the source from the STORED template and the
 * student's regions (invariant 14) and hands back a `pending: runner` result
 * carrying ONE run — no stdin, no arguments. `finalizeRunnerCodeImage` is
 * pure: it reads the run's stdout with the shared `parseImageOutput` and
 * scores the fraction of cells equal to the target.
 *
 * The run is graded REGARDLESS of how it ended. A program that printed half
 * its image and then crashed, timed out or ran out of memory has drawn half
 * a picture, and half a picture earns its correct cells (ADR-021). Only a
 * compile failure — no program at all — scores zero by itself.
 *
 * Server-only: `sha256` reads `node:crypto`.
 */
import type { FinalizeContext, GradeContext, GradeResult, GradedResult } from "@quiz/core/server";
import { RunnerRequest, type RunnerOutcome } from "@quiz/core/server";
import { assembleSource, mainFileName, TemplateRegionMismatch } from "@quiz/domain/lockedTemplate";
import { round2 } from "@quiz/domain/round";

import { isEmptyAnswer, sha256 } from "../grade.js";
import {
  countCorrect,
  decodeImage,
  encodeImage,
  parseImageOutput,
  pixelCountOf,
  warningsOf,
} from "./pixels.js";
import {
  IMAGE_CASE,
  type CodeImageAnswer,
  type CodeImageConfig,
  type CodeImageDetails,
} from "./schema.js";

/** Compiler output kept in `gradings.details` is capped, as `code` caps it. */
const DETAIL_CHARS = 4000;

const truncate = (s: string, max = DETAIL_CHARS): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`;

/** The source the runner compiles: the stored template around the student's regions. */
export function assembleImageSource(config: CodeImageConfig, answer: CodeImageAnswer): string {
  return assembleSource(config.template, config.language, answer.regions);
}

/**
 * The request of a `codeimage` run, for grading and for the student's own
 * button alike: the program, the teacher's files and flags, and one case with
 * an empty stdin and no command line.
 */
export function buildImageRequest(
  config: CodeImageConfig,
  source: string,
  priority: "grading" | "interactive",
): RunnerRequest {
  return RunnerRequest.parse({
    language: config.language,
    files: [{ name: mainFileName(config.language), content: source }, ...config.files],
    compileArgs: config.compileArgs,
    // Always a run: a picture that is only compiled draws nothing. The
    // shared `action` field is `code`'s, and the image editor hides it.
    action: "run",
    limits: { ...config.limits },
    cases: [{ name: IMAGE_CASE, args: [], stdin: "" }],
    priority,
  });
}

/**
 * The request behind the student's Run button (`POST /attempts/:id/simulate`),
 * or `null` when the regions do not fit the stored template — the player
 * seeds every region from the template, so that is a stale answer, and
 * there is nothing sensible to run.
 */
export function interactiveImageRequest(
  config: CodeImageConfig,
  answer: CodeImageAnswer,
): RunnerRequest | null {
  try {
    return buildImageRequest(config, assembleImageSource(config, answer), "interactive");
  } catch {
    return null;
  }
}

function zeroDetails(
  config: CodeImageConfig,
  runner: CodeImageDetails["runner"],
  reason: string,
): CodeImageDetails {
  return {
    runner,
    compile: null,
    run: null,
    image: null,
    matching: 0,
    pixelCount: pixelCountOf(config.image),
    warnings: [],
    sourceSha256: null,
    reason,
  };
}

/** First half: assemble, then delegate. */
export function gradeCodeImage(
  config: CodeImageConfig,
  answer: CodeImageAnswer | null,
  ctx: GradeContext,
): GradeResult<CodeImageDetails> {
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
    source = assembleImageSource(config, answer as CodeImageAnswer);
  } catch (err) {
    // A stored answer that no longer fits the template: a human decides, as
    // for `code`.
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
    request = buildImageRequest(config, source, "grading");
  } catch {
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
 * Second half: the runner has spoken. Pure, total, and the only place a
 * `codeimage` score is decided.
 *
 * A draft with no target yet (the teacher's own "try" before "Use as
 * target") still gets its picture back: the image is in the details, the
 * score is simply zero, because no cell can equal a target that is not there.
 */
export function finalizeRunnerCodeImage(
  config: CodeImageConfig,
  answer: CodeImageAnswer | null,
  ctx: FinalizeContext,
  outcome: RunnerOutcome,
): GradedResult<CodeImageDetails> {
  const pixelCount = pixelCountOf(config.image);
  let sourceSha256: string | null = null;
  if (answer !== null) {
    try {
      sourceSha256 = sha256(assembleImageSource(config, answer));
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
      details: {
        runner: "ok",
        compile,
        run: null,
        image: null,
        matching: 0,
        pixelCount,
        warnings: [],
        sourceSha256,
      },
      state: "validated",
    };
  }

  const run = outcome.cases[0];
  // No result at all reads as an empty stdout: every pixel is missing.
  const parsed = parseImageOutput(run?.stdout ?? "", config.image);
  const target = decodeImage(config.target, config.image.palette, pixelCount);
  const correct = countCorrect(parsed.pixels, target);

  return {
    kind: "graded",
    points: round2((correct / pixelCount) * ctx.itemPoints),
    maxPoints: ctx.itemPoints,
    details: {
      runner: "ok",
      compile,
      run:
        run === undefined
          ? null
          : {
              exitCode: run.exitCode,
              timedOut: run.timedOut,
              oom: run.oom,
              truncated: run.truncated,
              ms: run.ms,
            },
      image: encodeImage(parsed.pixels, config.image.palette),
      matching: correct,
      pixelCount,
      warnings: warningsOf(parsed),
      sourceSha256,
    },
    state: "validated",
  };
}
