/**
 * UI strings, English by default.
 *
 * A package cannot reach `apps/web`'s `t()` (invariant: packages never import
 * the app), so every component takes a `strings` prop that the host fills from
 * its own dictionary — which is where the French entries live (N-I18N-01).
 * The defaults below exist so the component is usable, and testable, alone.
 *
 * A parameterised sentence is a TEMPLATE filled by `fmt` from
 * `@quiz/core/client` (`"Case {n}"`), never a function: the host's `t()` uses
 * the same `{var}` syntax, so it translates these entries key by key like any
 * other. A count-dependent sentence has a `<key>.one` sibling, used for 1.
 */

export interface CodeEditorStrings {
  questionSection: string;
  prompt: string;
  language: string;
  template: string;
  templateHint: string;
  lockedRegions: string;
  "lockedRegions.one": string;
  studentPreview: string;
  locked: string;
  editable: string;
  referenceSolution: string;
  referenceSolutionHint: string;
  tryReference: string;
  trying: string;
  tryUnavailable: string;
  tryCompileFailed: string;
  tryRegionsMismatch: string;
  tryResult: string;
  cases: string;
  case: string;
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
  removeCase: string;
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
  totalPoints: string;
  "totalPoints.one": string;
}

export const EDITOR_STRINGS: CodeEditorStrings = {
  questionSection: "Question",
  prompt: "Statement",
  language: "Language",
  template: "Starting code",
  templateHint:
    "What the student receives. Lines between @@lock and @@endlock are read-only: the server rebuilds the file from this template, never from the text the browser sends.",
  lockedRegions: "{n} locked regions",
  "lockedRegions.one": "1 locked region",
  studentPreview: "What the student can edit",
  locked: "Locked",
  editable: "Editable",
  referenceSolution: "Reference solution",
  referenceSolutionHint:
    "Your own answer to the editable parts, in the order they appear — with several of them, separate the pieces with a @@next comment line, exactly as the template uses @@lock. Used only by the button below, to check that the cases pass. A student never sees it.",
  tryReference: "Try the reference solution",
  trying: "Running…",
  tryUnavailable: "The runner is unavailable, so the reference solution cannot be tried right now.",
  tryCompileFailed: "The reference solution does not compile.",
  tryRegionsMismatch:
    "The reference solution does not match the starting code: it must hold one piece per editable region, separated by a @@next comment line.",
  tryResult: "{passed} of {total} cases pass.",
  cases: "Test cases",
  case: "Case {n}",
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
  removeCase: "Remove the case {name}",
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
  totalPoints: "{n} points in total",
  "totalPoints.one": "1 point in total",
};

export interface CodePlayerStrings {
  locked: string;
  editableRegion: string;
  run: string;
  running: string;
  loadingRuntime: string;
  inBrowser: string;
  runUnavailable: string;
  runFailed: string;
  runHint: string;
  visibleCases: string;
  noVisibleCases: string;
  hiddenCases: string;
  "hiddenCases.one": string;
  files: string;
  caseName: string;
  stdin: string;
  noStdin: string;
  command: string;
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
  exitMismatch: string;
  outputMismatch: string;
  compileFailed: string;
  compileOk: string;
  allOrNothing: string;
  limits: string;
  manual: string;
  manualHint: string;
  manualArgs: string;
  manualRun: string;
  manualOutput: string;
  exitCode: string;
}

export const PLAYER_STRINGS: CodePlayerStrings = {
  locked: "Locked — provided by your teacher",
  editableRegion: "Your code, region {n}",
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
  hiddenCases: "{count} hidden cases, worth {points} point(s) in total.",
  "hiddenCases.one": "1 hidden case, worth {points} point(s).",
  files: "Files available to your program",
  caseName: "Case",
  stdin: "stdin",
  noStdin: "No input",
  command: "$ program {args}",
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
  exitMismatch: "exit {got} ≠ {want}",
  outputMismatch: "Output differs",
  compileFailed: "Compilation failed",
  compileOk: "Compiled",
  allOrNothing: "All cases must pass to score.",
  limits: "{timeMs} ms · {memoryMb} MB",
  manual: "Try it yourself",
  manualHint:
    "Run your program once on an input of your own. One argument per line; nothing here is graded.",
  manualArgs: "Arguments",
  manualRun: "Run once",
  manualOutput: "Output",
  exitCode: "exit {code}",
};

export interface CodeReviewStrings {
  score: string;
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
  exitMismatch: string;
  outputMismatch: string;
  points: string;
  hiddenSummary: string;
  hiddenCase: string;
  runnerUnavailable: string;
  runnerBusy: string;
  runnerError: string;
  notAnswered: string;
  referenceSolution: string;
  yourCode: string;
}

export const REVIEW_STRINGS: CodeReviewStrings = {
  score: "{points} / {max} points",
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
  exitMismatch: "exit {got} ≠ {want}",
  outputMismatch: "Output differs",
  points: "Points",
  hiddenSummary: "Hidden cases: {passed} of {count} passed.",
  hiddenCase: "Hidden case",
  runnerUnavailable: "The runner was unavailable; this answer is waiting for a manual grade.",
  runnerBusy: "The runner was busy; this answer is waiting for a manual grade.",
  runnerError: "The answer could not be run automatically; it is waiting for a manual grade.",
  notAnswered: "Not answered.",
  referenceSolution: "Reference solution",
  yourCode: "Your code",
};
