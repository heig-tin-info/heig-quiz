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

export const EDITOR_STRINGS = {
  questionSection: "Question",
  prompt: "Statement",
  language: "Language",
  template: "Starting code",
  templateHint: "Select lines, then lock them: the student cannot edit a locked line.",
  lockedRegions: "{n} locked regions",
  "lockedRegions.one": "1 locked region",
  lock: "Lock",
  unlock: "Unlock",
  lockLines: "Lock these lines — the student cannot edit them",
  unlockLines: "Unlock these lines",
  markerUnknown: "Line {line}: unknown marker {marker} — use @@lock and @@endlock.",
  markerUnopened: "Line {line}: {marker} closes no locked region.",
  markerNested: "Line {line}: {marker} inside a region that is already locked.",
  referenceSolution: "Reference solution",
  referenceSolutionHint:
    "Your own answer, in the student's editor. The button below checks that the cases pass with it. Students see it when the evaluation shows the expected answer.",
  referenceRegion: "Reference solution, region {n}",
  referenceLocked: "Locked — part of the starting code",
  referenceExtraPieces:
    "The saved solution has more pieces than the starting code has editable regions. The extra ones are dropped at your next edit.",
  tryReference: "Try the reference solution",
  trying: "Running…",
  tryUnavailable: "The runner is unavailable, so the reference solution cannot be tried right now.",
  tryCompileFailed: "The reference solution does not compile.",
  tryRegionsMismatch:
    "The reference solution does not fit the editable regions of the starting code. Edit it once in the editor above to realign it.",
  tryResult: "{passed} of {total} cases pass.",
  tryDiverged:
    "The browser and the server disagree on {n} cases — students' trials may mislead them. Consider \"Same as grading\".",
  "tryDiverged.one":
    "The browser and the server disagree on 1 case — students' trials may mislead them. Consider \"Same as grading\".",
  cases: "Test cases",
  case: "Case {n}",
  caseName: "Name",
  args: "Arguments",
  argument: "Argument {n}",
  addArgument: "Add an argument",
  removeArgument: "Remove argument {n}",
  commandLine: "Command line",
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
  runtime: "Student's runs",
  runtimeBackend: "Same as grading",
  runtimeBrowser: "Instant",
  runtimeBackendHint: "On the server, exactly like the grading.",
  runtimeBrowserHint: "In the student's browser: no waiting, no load on the server.",
  cooldown: "Between runs",
  cooldownFixed: "Fixed",
  cooldownProgressive: "Progressive",
  cooldownFixedHint: "3 s between runs.",
  cooldownProgressiveHint: "3 s, then 30 % longer each time, up to 30 s.",
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

export type CodeEditorStrings = typeof EDITOR_STRINGS;

export const PLAYER_STRINGS = {
  locked: "Locked — provided by your teacher",
  program: "Your program",
  editableRegion: "Your code, region {n}",
  run: "Run",
  running: "Running…",
  compile: "Compile",
  compiling: "Compiling…",
  runTests: "Run the tests",
  freeTry: "Free try",
  availableIn: "Available in {seconds} s",
  loadingRuntime: "Loading the language runtime… this happens once.",
  runUnavailable:
    "Running is unavailable right now. Your answer is saved and will be graded by your teacher.",
  runFailed: "The run could not be completed. Your answer is saved; try again in a moment.",
  rateLimited: "Too many runs in a minute. Wait a moment, then run again.",
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
  outputSideBySide: "Side by side",
  outputDiff: "Diff",
  outputView: "Output view",
  showWhitespace: "Show whitespace",
  outputDiffHeader: "Expected (−) and got (+)",
  noFinalNewline: "No newline at the end",
  truncatedDiff: "Compared up to where the output was cut.",
  compileFailed: "Compilation failed",
  compileOk: "Compiled",
  allOrNothing: "All cases must pass to score.",
  manual: "Try it yourself",
  manualArgs: "Arguments",
  argument: "Argument {n}",
  addArgument: "Add an argument",
  removeArgument: "Remove argument {n}",
  commandLine: "Command line",
  manualRun: "Run once",
  manualOutput: "Output",
  exitCode: "exit {code}",
};

export type CodePlayerStrings = typeof PLAYER_STRINGS;

export const REVIEW_STRINGS = {
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
  outputSideBySide: "Side by side",
  outputDiff: "Diff",
  outputView: "Output view",
  showWhitespace: "Show whitespace",
  outputDiffHeader: "Expected (−) and got (+)",
  noFinalNewline: "No newline at the end",
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

export type CodeReviewStrings = typeof REVIEW_STRINGS;

/**
 * The words of the grading table's program column (ADR-044), `code`'s and
 * `codeimage`'s alike: the program clamped to five lines, and the chip that
 * says how its run went.
 */
export const GRADING_STRINGS = {
  program: "Program",
  /** The foot of a clamped program. */
  more: "{n} more lines",
  "more.one": "1 more line",
  /** The tooltip of a clamped program, and of an unfolded one. */
  expand: "Show the whole program",
  collapse: "Fold the program",
  /** The cases passed, out of all of them. */
  tests: "{passed}/{total} tests",
  "tests.one": "{passed}/{total} test",
  compileFailed: "Does not compile",
  /** No verdict yet: the answer waits for the runner (or was never run). */
  atRunner: "runner…",
  runFailed: "Not run",
};

export type CodeGradingStrings = typeof GRADING_STRINGS;
