/**
 * Turning a `code` question into a `RunnerRequest`, for either runner.
 *
 * The browser runner needs the whole program, and the student's view already
 * carries it: the locked segments are the teacher's text, the editable ones
 * are the answer. Assembling them HERE is safe because nothing that comes out
 * of this file is ever graded — it is a trial run, shown to the person who
 * pressed the button. The mark is computed server-side from the stored
 * template and the stored regions, which is invariant 14 and stays untouched.
 *
 * Two things the student's view deliberately does not carry, and so neither
 * does the request built here:
 *
 *  - `compileArgs`. It can encode the key (`-DEXPECTED=42`), so `toStudent`
 *    drops it and the browser compiles with the toolchain's own defaults. The
 *    backend run, and every graded run, uses the teacher's flags.
 *  - the CONTENT of the extra files, for the same reason. A question whose
 *    program reads `data.csv` therefore has to run on the backend; the
 *    browser gets an empty file rather than a wrong one.
 */
import type { RunnerOutcome, RunnerRequest } from "@quiz/core/server";
import type { CodeAnswer, CodeRunOptions, CodeStudent } from "@quiz/qt-code/client";

import { browserCanRun, runWithFallback } from "./index";

/** The program as it stands: the teacher's locked text around the student's. */
export function assembleSource(student: CodeStudent, regions: readonly string[]): string {
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
  return student.runtime === "runno" && browserCanRun(student.language);
}

/** A free input: one command line and one stdin, from the person running it. */
export interface ManualInput {
  args: string[];
  stdin: string;
}

export function codeRunRequest(
  student: CodeStudent,
  answer: CodeAnswer,
  manual?: { args: string[]; stdin: string } | undefined,
): RunnerRequest {
  return {
    language: student.language,
    files: [
      { name: "main", content: assembleSource(student, answer.regions) },
      ...student.filesPreview.map((f) => ({ name: f.name, content: "" })),
    ],
    compileArgs: "",
    action: "run",
    limits: student.limits,
    cases:
      manual === undefined
        ? student.visibleCases.map((c) => ({ name: c.name, args: c.args ?? [], stdin: c.stdin }))
        : [{ name: "manual", args: manual.args, stdin: manual.stdin }],
    priority: "interactive",
  };
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
   * The API call the caller already had. It receives the free input as well,
   * because `POST /attempts/:id/run` builds the visible cases server-side and
   * takes a `stdin` / `args` pair for the free try — the one thing a client
   * is allowed to choose (invariant 14).
   */
  backend: (
    request: RunnerRequest,
    manual?: ManualInput | undefined,
  ) => Promise<RunnerOutcome | "unavailable">;
  options?: CodeRunOptions | undefined;
}): Promise<RunnerOutcome | "unavailable"> {
  const manual = args.options?.manual;
  const request = codeRunRequest(args.student, args.answer, manual);
  return runWithFallback(request, {
    runtime: args.student.runtime,
    backend: (built) => args.backend(built, manual),
    hooks: args.options?.onStage === undefined ? undefined : { onStage: args.options.onStage },
  });
}
