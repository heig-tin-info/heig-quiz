# ADR-096 — Extra files and compiler flags of a program question are public program inputs

## Status

Accepted (2026-10-10, product owner's standing authorization for the security audit's fixes,
findings M2 and M3). Delivery progress is in `changes/`.

Scope: what `toStudent` publishes of a `code` or `codeimage` config besides its cases, the
order in which a grading request runs a `code` question's cases, and what a student reads of a
hidden case in the grading breakdown.

Relations: amends decision D15 ([settled questions](../spec/history/settled-questions.md),
row 8) and `docs/spec/04-types-de-questions.md` §4.7 and §4.9 (what `toStudent` strips);
amends [ADR-015](ADR-015-execution-navigateur-correction-serveur.md) §5 (the browser runtime
receives the published files and flags); removes `compileArgs` from
`COMMON_FORBIDDEN_STUDENT_KEYS` (`packages/core/src/contract.ts`).

## Context

A program question's config carries `files` (up to four extra files the program reads) and
`compileArgs`. The schema comments, `toStudent` and spec §4.9 promised that both stayed
hidden, and `toStudent` published only each file's name and size. Yet `programRequest`
(`packages/qt-code/src/grade.ts`) hands them to every run, the student's own Run during the
attempt included, whose output comes back whole: a program that prints `data.csv` reads it.
The promise was false (audit finding M2). The browser runtime meanwhile injected each extra
file EMPTY and compiled with no flags, so a `runtime: runno` question with a data file could
not run in the browser at all.

A grading request runs all the cases of a `code` question in one container whose `/work`
persists from case to case (`apps/runner/src/execute.ts`). A program can store a hidden case's
stdin in a file and print it on a later visible case's stderr, which the student reads in the
feedback. The hidden cases' `exitCode` and `ms`, kept in the breakdown a student reads, are a
quieter channel of the same kind (audit finding M3).

## Decision

1. **The extra files and `compileArgs` are public program inputs.** `toStudent` publishes
   both, whole (`files: [{ name, content }]`, `compileArgs`), for `code` and `codeimage`
   alike (`programStudentFields`). `filesPreview` (name and size) is removed: it is derived
   from `files`, and two fields saying the same thing can only drift. The player still shows
   one line, the names and sizes. A key never belongs in either field; the schema's field
   descriptions say so, which the MCP `describe_question_types` schema carries.
2. **The browser runtime runs what the server runs.** `studentRunRequest`
   (`apps/web/src/runner/codeRun.ts`) builds the browser's request with the published files
   and flags; the teacher's browser try already sent the whole config, so the two no longer
   differ by anything but the cases.
3. **No hidden-file category now.** A test-only secret file — data a hidden case reads and the
   student must not — needs the hidden cases to run in a container of their own. It waits for
   the runner's container split; until then, secret test data belongs in a hidden case's
   stdin or command line.
4. **Visible cases run first, hidden cases last.** `gradeCode` builds the grading request in
   `gradingOrder` (the visible cases in the teacher's order, then the hidden ones), and
   `finalizeRunnerCode` pairs each run with its case through that order, so the stored
   details keep the teacher's order. No output a student reads can follow a hidden input in
   the same container.
5. **A student reads a hidden case's verdict, not its run.** On the student path
   (`studentDetails`, `packages/qt-code/src/grade.ts`), a hidden case is
   `{ name, visible: false, points, ok, failure? }`, where `failure` is `timed_out`, `oom`,
   `crashed` or `failed`; its name stays `#n` unless the policy opens the names. Its expected
   output, output, stderr, exit code and time never reach a student. Under `showKey` the
   details travel whole, as before: the teacher published the key. The stored
   `gradings.details` are unchanged; the grading panel and the class debrief read them.

No migration and no new config field: `CODE_CONFIG_VERSION` stays at 1.

## Consequences

- A teacher who put an expected output or a key in an extra file or a `-D` flag publishes it
  the day this ships; it was already readable by any student who printed it. Configs with
  non-empty `files` should be reviewed by their owners before the deploy.
- A suite whose cases depend on each other's order through `/work` (a case writing a file a
  later case reads) behaves differently when a hidden case preceded a visible one. Under
  `RUNNER_REQUEST_TIMEOUT_MS`, the cases starved at the end of a slow request are now the
  hidden ones.
- The browser runtime now reads the extra files. It still compiles only the entry file and
  with its own flags (`apps/web/src/runner/runno/engine.ts`): an extra `.c` file or a
  `compileArgs` the program depends on still diverges there, as ADR-015 §5 lists.
- Residual risks accepted until the runner's container split: a program can still turn a
  hidden input into the verdicts of the hidden cases after it (a pass or a coarse failure
  each, a few bits per case), and a process left running by one case is not killed before
  the next.

## Alternatives considered

1. **A `visible` flag per file, false by default, and no files or flags on the student's
   Run.** It closes the Run channel only: the files still sit in the grading container and
   their effects come back after release. The C and C++ run plans compile every extra
   source file, so a run without a `helper.c` or a `.h` fails with an error the student
   cannot understand, and dropping `compileArgs` makes Run and grading diverge (`-Werror`,
   `-D`, `-I`).
2. **Run the hidden cases in a separate container now.** The right end state, and the place
   a test-only secret file belongs; it is a runner change (`apps/runner/src/execute.ts`,
   the request shape and its queue accounting) of its own.
3. **Keep `exitCode` and `ms` for a hidden case.** They are a side channel for data the case
   was fed, and the coarse category says what a student can act on.
