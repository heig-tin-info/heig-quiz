/**
 * UI strings, English by default.
 *
 * A package cannot reach `apps/web`'s `t()` (invariant: packages never import
 * the app), so every component takes a `strings` prop that the host fills from
 * its own dictionary — which is where the French entries live (N-I18N-01).
 * The defaults below exist so the component is usable, and testable, alone.
 */

export interface CodeEditorStrings {
  questionSection: string;
  prompt: string;
  language: string;
  template: string;
  templateHint: string;
  lockedRegions: (n: number) => string;
  studentPreview: string;
  locked: string;
  editable: string;
  referenceSolution: string;
  referenceSolutionHint: string;
  tryReference: string;
  trying: string;
  tryUnavailable: string;
  tryCompileFailed: string;
  tryResult: (passed: number, total: number) => string;
  cases: string;
  case: (n: number) => string;
  caseName: string;
  args: string;
  argsHint: string;
  stdin: string;
  expected: string;
  compareStdout: string;
  exitCode: string;
  exitCodeHint: string;
  exitCodeAny: string;
  hidden: string;
  points: string;
  timeMs: string;
  timeMsHint: string;
  addCase: string;
  removeCase: (name: string) => string;
  runtime: string;
  runtimeBackend: string;
  runtimeBrowser: string;
  runtimeHint: string;
  advanced: string;
  action: string;
  actionCheck: string;
  actionRun: string;
  compileArgs: string;
  timeLimit: string;
  memoryLimit: string;
  outputLimit: string;
  runsPerMinute: string;
  allOrNothing: string;
  allOrNothingHint: string;
  compare: string;
  trimTrailing: string;
  ignoreCase: string;
  numeric: string;
  numericOff: string;
  numericAbs: string;
  numericRel: string;
  epsilon: string;
  totalPoints: (n: number) => string;
}

export const EDITOR_STRINGS: CodeEditorStrings = {
  questionSection: "Question",
  prompt: "Statement",
  language: "Language",
  template: "Starting code",
  templateHint:
    "What the student receives. Lines between @@lock and @@endlock are read-only: the server rebuilds the file from this template, never from the text the browser sends.",
  lockedRegions: (n) => (n === 1 ? "1 locked region" : `${n} locked regions`),
  studentPreview: "What the student can edit",
  locked: "Locked",
  editable: "Editable",
  referenceSolution: "Reference solution",
  referenceSolutionHint:
    "Your own answer. Used only by the button below, to check that the cases pass. A student never sees it.",
  tryReference: "Try the reference solution",
  trying: "Running…",
  tryUnavailable: "The runner is unavailable, so the reference solution cannot be tried right now.",
  tryCompileFailed: "The reference solution does not compile.",
  tryResult: (passed, total) => `${passed} of ${total} cases pass.`,
  cases: "Test cases",
  case: (n) => `Case ${n}`,
  caseName: "Name",
  args: "Arguments",
  argsHint: "One argument per line. Blank lines are ignored.",
  stdin: "stdin",
  expected: "Expected output",
  compareStdout: "Compare the output",
  exitCode: "Exit code",
  exitCodeHint: "Empty: any exit code is accepted. A crash still fails the case.",
  exitCodeAny: "any",
  hidden: "Hidden",
  points: "Points",
  timeMs: "Time (ms)",
  timeMsHint: "Empty: use the question limit.",
  addCase: "Add a case",
  removeCase: (name) => `Remove the case ${name}`,
  runtime: "Run in",
  runtimeBackend: "The server",
  runtimeBrowser: "The browser",
  runtimeHint: "The browser runs the student's trials; the server always grades.",
  advanced: "Advanced options",
  action: "Action",
  actionCheck: "Compile only",
  actionRun: "Compile and run",
  compileArgs: "Compiler arguments",
  timeLimit: "Time limit (ms)",
  memoryLimit: "Memory (MB)",
  outputLimit: "Output (KB)",
  runsPerMinute: "Runs per minute",
  allOrNothing: "All or nothing",
  allOrNothingHint: "The question scores full marks only when every case passes.",
  compare: "Output comparison",
  trimTrailing: "Ignore trailing whitespace",
  ignoreCase: "Ignore case",
  numeric: "Numeric comparison",
  numericOff: "Exact text",
  numericAbs: "Absolute tolerance",
  numericRel: "Relative tolerance",
  epsilon: "Epsilon",
  totalPoints: (n) => (n === 1 ? "1 point in total" : `${n} points in total`),
};

export interface CodePlayerStrings {
  locked: string;
  editableRegion: (n: number) => string;
  run: string;
  running: string;
  loadingRuntime: string;
  inBrowser: string;
  runUnavailable: string;
  runFailed: string;
  runHint: string;
  visibleCases: string;
  noVisibleCases: string;
  hiddenCases: (count: number, points: number) => string;
  files: string;
  caseName: string;
  stdin: string;
  noStdin: string;
  command: (args: string) => string;
  expected: string;
  expectedAnyOutput: string;
  got: string;
  verdict: string;
  passed: string;
  failed: string;
  notRun: string;
  timedOut: string;
  outOfMemory: string;
  crashed: string;
  truncated: string;
  exitMismatch: (got: string, want: number) => string;
  outputMismatch: string;
  compileFailed: string;
  compileOk: string;
  allOrNothing: string;
  limits: (timeMs: number, memoryMb: number) => string;
  manual: string;
  manualHint: string;
  manualArgs: string;
  manualRun: string;
  manualOutput: string;
  exitCode: (code: string) => string;
}

export const PLAYER_STRINGS: CodePlayerStrings = {
  locked: "Locked — provided by your teacher",
  editableRegion: (n) => `Your code, region ${n}`,
  run: "Run",
  running: "Running…",
  loadingRuntime: "Loading the language runtime… this happens once.",
  inBrowser: "Runs in your browser — the server grades.",
  runUnavailable:
    "Running is unavailable right now. Your answer is saved and will be graded by your teacher.",
  runFailed: "The run could not be completed. Your answer is saved; try again in a moment.",
  runHint: "Runs the visible cases. Hidden cases are only run when the question is graded.",
  visibleCases: "Visible cases",
  noVisibleCases: "Your teacher did not publish any visible case.",
  hiddenCases: (count, points) =>
    count === 1
      ? `1 hidden case, worth ${points} point(s).`
      : `${count} hidden cases, worth ${points} point(s) in total.`,
  files: "Files available to your program",
  caseName: "Case",
  stdin: "stdin",
  noStdin: "No input",
  command: (args) => `$ program ${args}`,
  expected: "Expected",
  expectedAnyOutput: "Any output",
  got: "Got",
  verdict: "Verdict",
  passed: "Passed",
  failed: "Failed",
  notRun: "Not run",
  timedOut: "Timed out",
  outOfMemory: "Out of memory",
  crashed: "Crashed",
  truncated: "Output truncated",
  exitMismatch: (got, want) => `exit ${got} ≠ ${want}`,
  outputMismatch: "Output differs",
  compileFailed: "Compilation failed",
  compileOk: "Compiled",
  allOrNothing: "All cases must pass to score.",
  limits: (timeMs, memoryMb) => `${timeMs} ms · ${memoryMb} MB`,
  manual: "Try it yourself",
  manualHint:
    "Run your program once on an input of your own. One argument per line; nothing here is graded.",
  manualArgs: "Arguments",
  manualRun: "Run once",
  manualOutput: "Output",
  exitCode: (code) => `exit ${code}`,
};

export interface CodeReviewStrings {
  score: (points: number, max: number) => string;
  compileFailed: string;
  compilerOutput: string;
  cases: string;
  caseName: string;
  args: string;
  noArgs: string;
  expected: string;
  got: string;
  verdict: string;
  passed: string;
  failed: string;
  timedOut: string;
  outOfMemory: string;
  crashed: string;
  exitMismatch: (got: string, want: number) => string;
  outputMismatch: string;
  points: string;
  hiddenSummary: (passed: number, count: number) => string;
  hiddenCase: string;
  runnerUnavailable: string;
  runnerBusy: string;
  runnerError: string;
  notAnswered: string;
  referenceSolution: string;
  yourCode: string;
}

export const REVIEW_STRINGS: CodeReviewStrings = {
  score: (points, max) => `${points} / ${max} points`,
  compileFailed: "Compilation failed",
  compilerOutput: "Compiler output",
  cases: "Cases",
  caseName: "Case",
  args: "Arguments",
  noArgs: "—",
  expected: "Expected",
  got: "Got",
  verdict: "Verdict",
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  outOfMemory: "Out of memory",
  crashed: "Crashed",
  exitMismatch: (got, want) => `exit ${got} ≠ ${want}`,
  outputMismatch: "Output differs",
  points: "Points",
  hiddenSummary: (passed, count) => `Hidden cases: ${passed} of ${count} passed.`,
  hiddenCase: "Hidden case",
  runnerUnavailable: "The runner was unavailable; this answer is waiting for a manual grade.",
  runnerBusy: "The runner was busy; this answer is waiting for a manual grade.",
  runnerError: "The answer could not be run automatically; it is waiting for a manual grade.",
  notAnswered: "Not answered.",
  referenceSolution: "Reference solution",
  yourCode: "Your code",
};

/** Merges a partial override on top of the English defaults. */
export function withStrings<T extends object>(defaults: T, override?: Partial<T>): T {
  return override === undefined ? defaults : { ...defaults, ...override };
}
