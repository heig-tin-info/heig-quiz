/**
 * Turning a program question — `code`, or `codeimage` (ADR-021) — into a
 * `RunnerRequest`, for either runner.
 *
 * The browser runner needs the whole program, and the student's view already
 * carries it: the locked segments are the teacher's text, the editable ones
 * are the answer. Assembling them HERE is safe because nothing that comes out
 * of this file is ever graded — it is a trial run, shown to the person who
 * pressed the button. The mark is computed server-side from the stored
 * template and the stored regions, which is invariant 14 and stays untouched.
 *
 * The extra files and `compileArgs` travel too: they are public program
 * inputs that `toStudent` publishes (ADR-096), so the browser compiles with
 * the teacher's flags and reads the teacher's files, as the backend run and
 * every graded run do.
 */
import { assembleSource as assembleFromTemplate } from "@quiz/domain";
import type { RunOutcome, RunnerRequest } from "@quiz/core/server";
import {
  browserCapable,
  IMAGE_CASE,
  type CodeAnswer,
  type CodeConfig,
  type CodeImageAnswer,
  type CodeImageConfig,
  type CodeImageStudent,
  type CodeRunOptions,
  type CodeRunStage,
  type CodeStudent,
  type ProgramConfig,
  type ProgramStudent,
} from "@quiz/qt-code/client";

import { runWithFallback } from "./index";
import type { BackendRun, ManualInput } from "./types";

type RunCase = RunnerRequest["cases"][number];

/** The one run of a `codeimage` program: empty stdin, no command line. */
const IMAGE_CASES: RunCase[] = [{ name: IMAGE_CASE, args: [], stdin: "" }];

export type { ManualInput } from "./types";

/** The program as it stands: the teacher's locked text around the student's. */
export function assembleSource(student: ProgramStudent, regions: readonly string[]): string {
  return student.segments
    .map((segment) =>
      segment.kind === "locked" ? segment.text : (regions[segment.index ?? 0] ?? segment.text),
    )
    .join("");
}

/**
 * Whether the BROWSER could serve a free-input try.
 *
 * `POST /attempts/:id/run` takes one too (`RunBody.stdin` / `RunBody.args`),
 * so a player wired to the API offers the box whatever this says; it is the
 * teacher's try panel, which has no run route at all, that needs the answer.
 */
export function canRunManually(student: CodeStudent): boolean {
  return student.runtime === "runno" && browserCapable(student.language);
}

/**
 * The browser's request for a student's run, from the program half of the
 * student view that both `code` and `codeimage` publish: the assembled
 * program, the extra files and the compiler's flags (ADR-096).
 */
export function studentRunRequest(
  student: ProgramStudent,
  regions: readonly string[],
  cases: RunCase[],
): RunnerRequest {
  return {
    language: student.language,
    files: [
      { name: "main", content: assembleSource(student, regions) },
      ...student.files.map((f) => ({ name: f.name, content: f.content })),
    ],
    compileArgs: student.compileArgs,
    action: "run",
    limits: student.limits,
    cases,
    priority: "interactive",
  };
}

/**
 * The browser's request for a student's run. `compileOnly` is the Compile
 * button: `action: "check"` and no case at all, which both runners read as
 * "build it, run nothing" (for Python, a syntax check: see `runno/engine.ts`).
 */
export function codeRunRequest(
  student: CodeStudent,
  answer: CodeAnswer,
  manual?: ManualInput | undefined,
  compileOnly = false,
): RunnerRequest {
  if (compileOnly) {
    return { ...studentRunRequest(student, answer.regions, []), action: "check" };
  }
  return studentRunRequest(
    student,
    answer.regions,
    manual === undefined
      ? student.visibleCases.map((c) => ({ name: c.name, args: c.args ?? [], stdin: c.stdin }))
      : [{ name: "manual", args: manual.args, stdin: manual.stdin }],
  );
}

/**
 * The player's "Run", whichever runner serves it.
 *
 * `backend` is the API call the caller already had; a free input has no
 * backend at all, because `POST /attempts/:id/run` builds its request from the
 * published cases on purpose and has nowhere to put one.
 */
export async function runCode(args: {
  student: CodeStudent;
  answer: CodeAnswer;
  /**
   * The API call the caller already had. It receives the free input and
   * NOTHING else: `POST /attempts/:id/run` builds the program and the visible
   * cases server-side, and takes a `stdin` / `args` pair for the free try —
   * the one thing a client is allowed to choose (invariant 14) — or
   * `compileOnly` for the Compile button, in which case there is no input.
   */
  backend: BackendRun;
  options?: CodeRunOptions | undefined;
}): Promise<RunOutcome> {
  const compileOnly = args.options?.compileOnly === true;
  // A compilation has no input: a free one would only be dropped server-side.
  const manual = compileOnly ? undefined : args.options?.manual;
  const request = codeRunRequest(args.student, args.answer, manual, compileOnly);
  // A refused budget comes back as `"rate_limited"`, untouched: the browser
  // does not stand in for a budget the server refused.
  return runWithFallback<"rate_limited">(request, {
    runtime: args.student.runtime,
    backend: () => (compileOnly ? args.backend(undefined, { compileOnly }) : args.backend(manual)),
    hooks: args.options?.onStage === undefined ? undefined : { onStage: args.options.onStage },
  });
}

/**
 * A `codeimage` student's "Run", whichever runner serves it — the same rule
 * as `runCode` (ADR-015). The backend is `POST /attempts/:id/simulate`, which
 * rebuilds the program from the stored template (invariant 14); it may also
 * answer `"rate_limited"`, the per-attempt budget, which the player words.
 */
export async function runCodeImage(args: {
  student: CodeImageStudent;
  answer: CodeImageAnswer;
  backend: () => Promise<RunOutcome>;
  options?: { onStage?: ((stage: CodeRunStage) => void) | undefined } | undefined;
}): Promise<RunOutcome> {
  return runWithFallback<"rate_limited">(studentRunRequest(args.student, args.answer.regions, IMAGE_CASES), {
    runtime: args.student.runtime,
    backend: args.backend,
    hooks: args.options?.onStage === undefined ? undefined : { onStage: args.options.onStage },
  });
}

/**
 * The teacher's request, from the whole config: the same flags and extra
 * files as a student's run (ADR-096), and every case. Shared by both program
 * types' "try" buttons.
 */
function teacherRunRequest(
  config: ProgramConfig,
  regions: readonly string[],
  cases: RunCase[],
  action: "check" | "run",
): RunnerRequest {
  return {
    language: config.language,
    files: [
      { name: "main", content: assembleFromTemplate(config.template, config.language, regions) },
      ...config.files.map((file) => ({ name: file.name, content: file.content })),
    ],
    compileArgs: config.compileArgs,
    action,
    limits: config.limits,
    cases,
    priority: "interactive",
  };
}

/**
 * The TEACHER'S try, built from the whole config.
 *
 * The student's request above carries what `toStudent` let out: the same
 * flags and files, the visible cases only. The editor holds the config
 * itself, so every case travels, and the run the teacher sees is the run the
 * grader will do (the grader runs the visible cases first, ADR-096, which
 * changes nothing for a suite whose cases do not depend on each other).
 *
 * Every case, hidden ones included, in the config's order: the editor counts
 * the passes by walking `outcome.cases[i]` beside `config.tests.cases[i]`.
 *
 * Nothing here weakens invariant 14. This request never grades anything; the
 * mark is computed server-side from the stored template and the stored
 * regions, and this source is rebuilt by the same `assembleSource` the API
 * uses, from the template plus the regions read out of the reference solution.
 */
export function referenceRunRequest(
  config: CodeConfig,
  regions: readonly string[],
): RunnerRequest {
  return teacherRunRequest(
    config,
    regions,
    config.tests.cases.map((c) => ({ name: c.name, args: c.args, stdin: c.stdin })),
    config.action,
  );
}

/** The teacher's try of a `codeimage` reference: one run, always a run (a picture must be drawn). */
export function imageReferenceRunRequest(
  config: CodeImageConfig,
  regions: readonly string[],
): RunnerRequest {
  return teacherRunRequest(config, regions, IMAGE_CASES, "run");
}
