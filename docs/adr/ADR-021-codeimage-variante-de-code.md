# ADR-021 — Code image: a variant of `code`, a target in the config, stdout graded whatever the exit

## Status

Accepted (2026-09-23, with `packages/qt-code/src/image/`).

## Context

`docs/spec/04-types-de-questions.md` §4.9 described `codeimage` as a phase-3
extension of `code`: a program writing a binary PPM `P6` image of 300 × 300
pixels, compared with the teacher's image under a per-channel tolerance and
configurable point thresholds, with an overlay slider in the player. The type
is now wanted for first-year C: loops and conditions that draw a checkerboard,
a frame, concentric squares — exercises where the student SEES what the
program does and how far it is from the goal.

The product owner reshaped it on the way in: the program prints plain
integers, one per cell of a small grid (3 to 128 cells per side), in one of
three palettes (`bw`, a pastel `color16`, `gray256`); the teacher captures the
target from a run of their reference solution; the score is the share of
matching cells. Three decisions follow, and each could have gone another way.

## Decision

### 1. A variant inside `packages/qt-code`, not a package of its own

Everything about the PROGRAM is `code`'s: the languages, the template and its
`@@lock` regions, the reference solution split by `@@next`, `runtime`
(ADR-015), the limits, the extra files, the source rebuilt server-side from
the stored template (invariant 14), Monaco and the stacked editor. Only the
judge differs — a picture instead of a table of cases.

So `codeimage` lives in `packages/qt-code/src/image/` and the package exports
a second type from each entry point (`codeimageServer`, `codeimageClient`),
registered beside `code` in `packages/registry`. What both share was
EXTRACTED, not copied:

- the schema: `programFields` (spread into `CodeConfig` and `CodeImageConfig`)
  and `programStudentFields` (spread into both student views). `CodeConfig`'s
  parsed shape is unchanged, key for key, so stored configs parse as before;
- the player: `ProgramPlayer.tsx` — the statement, the stack of regions, the
  Run button, the run's status lines — which `CodePlayer` renders with its
  case table and `CodeImagePlayer` with its image panel;
- the editor: `ProgramEditor.tsx` — the statement with language and runtime,
  the starting code, the reference solution, the program's advanced settings
  — around which `CodeEditor` adds its cases and `CodeImageEditor` the image;
- the review: `ProgramReview.tsx` — the score line, the compiler's refusal,
  the reference solution;
- the host: `apps/web/src/runner/codeRun.ts` builds a browser request from
  the program half of either student view.

The student's Run on the server goes through the type's `interactiveRequest`
and the generic `POST /attempts/:id/simulate` of ADR-019. No route was added.

### 2. The target is stored in the config, as a compact string

The target is part of the question, like a case's `expected`: captured once
by the teacher ("Try the reference solution", then "Use as target"), stored in
`config.target`, versioned with the question, and published to the student on
purpose — drawing it is the exercise. Nothing runs at publication, so
publishing never depends on a runner being up (decision D14).

It is a string, one lowercase hex digit per pixel for `bw` and `color16`, two
for `gray256`: a 128 × 128 grey target is 32 KiB of text instead of a
16 384-entry JSON array several times that size, and it diffs as one line in
a canonical file. The same encoding carries the student's computed image in
the grading details, with `x` for an invalid or missing pixel. Publication
refuses a target that is missing, of the wrong length, or holds a value
outside the palette; a draft may lack it (decision D16).

### 3. Stdout is graded whatever the run's exit

The score is `points × matching cells / total cells`, and it is computed from
whatever stdout holds: a non-zero exit, a timeout, a crash or an
out-of-memory kill after half the picture still earns the matching half. A
picture is partial by nature — half a checkerboard is half right — and the
program that draws the top rows correctly before looping forever has shown
exactly that much. Only a compile failure (no program at all) scores zero by
itself; no answer and an unavailable runner are handled as for `code`.

The parse is ONE pure function, `parseImageOutput`, shared by the grader and
the player: invalid tokens and missing pixels are wrong, extra tokens are
ignored and reported. The student sees the image they will be graded on.

## Consequences

- One package, one lockfile, one set of Monaco and runner wiring for two
  types. A change to the program half (a new language, a new limit) reaches
  both at once; the tests of `code` stayed green through the extraction.
- The output budget of a `codeimage` defaults to 128 KiB (`code`: 64 KiB):
  a 128 × 128 grey image written as `"255 "` is 64 KiB before its newlines.
- The grading details carry the student's picture (up to 32 KiB), which the
  review draws; they carry no key, so `studentDetails` redacts nothing. The
  numerator is named `matching`, not `correct`: `correct` is on the blind
  strip of a student's details (`FORBIDDEN_DETAIL_KEYS`).
- The image grid is a `<canvas>`, sixteen thousand cells without a DOM
  element each; its colours are the app's tokens read at draw time for the
  difference view and the lines, and fixed image colours for the pixels.
- Spec §4.9 is rewritten to this design; the type is no longer phase 3.

## Rejected alternatives

- **A `packages/qt-codeimage`.** A package that would import `qt-code` for
  its program half — or copy it. The first makes one type package depend on
  another, which the registry exists to avoid; the second is two stacks of
  Monaco regions, two reference cuts and two request builders that drift.
- **The PPM `P6` protocol of the old §4.9.** Binary output is awkward to
  print from a first-year C program and impossible to read in a terminal; a
  list of integers is one `printf` in every language and legible as text.
- **Computing the target at publication, by running the reference.** It
  makes publishing depend on the runner, hides the picture from the teacher
  until after the fact, and turns a runner hiccup into an unpublishable
  question. Capturing it in the editor shows the teacher what the student
  will be asked to draw before they commit to it.
- **Tolerance and point thresholds.** With a palette of at most 256 exact
  values, a cell is right or wrong; a share of matching cells is the score a
  student can predict from the difference view.
- **Zero for a run that did not exit cleanly.** It punishes the student who
  drew nearly everything and then crashed exactly like the one who drew
  nothing, and the difference view would show a picture the grade ignores.
