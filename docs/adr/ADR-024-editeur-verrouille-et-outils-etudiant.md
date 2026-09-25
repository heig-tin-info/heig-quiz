# ADR-024 — One locked editor, three student tools, a visible cooldown

## Status

Accepted (2026-09-24, with `packages/qt-code/src/LockedEditor.tsx`,
`ArgsInput.tsx`, `lockEdit.ts` and `@quiz/domain/cooldown`). Amended
2026-09-25 by the addendum at the end (issue #129).

## Context

A review of the `code` question by the product owner, first as the author and
then as a student, found the screens explaining themselves instead of being
understood:

- the template editor carried a paragraph about `@@lock` / `@@endlock`, and an
  author who naturally wrote `@@unlock` got, without a word, ONE locked region
  running to the end of the file;
- the player stacked one read-only block and one editor per region, so the
  compiler's "line 12" matched no line number the student could see;
- the reference solution asked the author to type `@@next` separators by hand;
- the arguments of a case were "one per line, blank lines ignored";
- the student had a Run, a free stdin box and — in the teacher's rehearsal —
  a "Grade my answer" whose result, for `code`, is the tests again;
- the runtime choice (ADR-015) was worded by mechanism ("browser", "runner")
  and needed a sentence under it to be understood.

## Decision

### 1. One editor, locked lines read-only, markers hidden

The player and the reference-solution field render the WHOLE program in one
Monaco model. Locked lines are greyed and refuse edits; the marker lines are
hidden but keep their place, so the line numbers are the source's and a
compiler diagnostic lands on its line. The textarea fallback (no Monaco: a
blocked CDN, jsdom) keeps the stack.

This reverses the "split, not decorate" choice of `MonacoHost.tsx`. The split
protected nothing: the server rebuilds the file from the stored template and
the regions (invariant 14), so a locked range undone from a devtools console
changes a display, never what is compiled or graded.

### 2. Locking by selection; `@@unlock` accepted; unknown markers flagged

The author selects lines and presses the lock button; the markers are written
for them, and stay visible in the author's editor, which is how the syntax is
learnt. `@@unlock` is a synonym of `@@endlock`. A marker-looking comment the
split does not know, or an unlock with no open lock, is reported with its line.
A lock left open to the end of the file stays legitimate.

### 3. The reference is written in the student's editor

The reference field shows the template with one editable region per template
region, prefilled with the template's own text. The stored format is unchanged
(`@@next` between pieces); the author no longer types it.

### 4. Three student tools, each with a cooldown and a reason to press it

Compile, Run the tests (primary), Free try. Each button is disabled while the
code — and for the free try, its input — is identical to its last completed
use: running the same program twice teaches nothing, and the last result stays
on screen. After each use the button refills before it is ready again:
`fixed` (3 s) or `progressive` (3 s, +30 % per use, capped at 30 s, forgiven
while the student does not press it). For a server run the cooldown is never
shorter than `60 s / runsPerMinute`, so the button never offers what the
budget of N-SEC-07 would refuse; the budget itself stays the server's guard.

`cooldown` is a new field of the program config and the student view, with a
default, so stored configs parse unchanged and the config version stays.

A compile-only run (`RunBody.compileOnly`) goes through the same route, the
same budget and the same journal, with `action: "check"` and no case.
(Reversed on 2026-09-25: no "unchanged" rule, no cooldown on Compile, and a
budget of its own for it — see the addendum.)

### 5. Runtime by outcome, new C/Python questions in the browser

The runtime moves to "Advanced options" as "Instant" / "Same as grading".
New C and Python questions start with the browser runtime; stored configs keep
theirs (the zod default stays `backend`). When the reference passes on the
server but the browser disagrees on a case, the editor says so — that is where
"the browser runs, the server grades" is learnt, instead of a sentence.

### 6. The teacher's rehearsal of a `code` question is one action

"Run all the tests" grades the whole answer, hidden cases included, and shows
the score. The student's own view never merges tests and grade: the hidden
cases and the weights make "every visible test passes" differ from "every
point".

## Consequences

- `ProgramRegions` and `ReferenceSection` depend on a Monaco integration that
  guards edits itself; its tests in jsdom cover the fallback only, and the
  Monaco path needs the browser check of `apps/web/scripts/screenshots.mjs`.
- A student's cooldown is a client courtesy; the server budget is unchanged
  and still answers `rate_limited`.
- `docs/spec/04-types-de-questions.md` §4.7 describes the new buttons, the
  markers and the reference editor.

## Addendum — 2026-09-25: no "unchanged" rule, and Compile without a cooldown

Source: issue #129, from a teacher walking the student player.

### What changed

1. **The "unchanged" rule of §4 is dropped.** A button used to stay disabled
   while the code (and, for the free try, its input) was what it last ran.
   In practice the button looked dead once its cooldown ended, and the hint
   under it ("Change your code to run the tests again") went unnoticed. A
   button is now ready again as soon as its cooldown ends, whatever the code;
   the last result of each tool still stays on screen until the next run.
   Re-running the same program is harmless, and the cooldown already bounds
   the load. The three
   hints (`qt.code.p.unchangedTests`, `unchangedRun`, `unchangedManual`) are
   gone.
2. **Compile has no visible cooldown.** It is the quick look a student takes
   after every edit, and holding it back with the tests' clock made it the
   slow tool. It is still one at a time (disabled while any run is in
   flight). Run the tests and Free try keep their shared cooldown, and so
   does `codeimage`'s Run.
3. **Compile spends a budget of its own on the server.** §4 said a
   compile-only run spent "the same budget" as a run. It now counts against
   `compilesPerMinute(runsPerMinute) = min(60, max(20, 3 × runsPerMinute))`
   (`@quiz/domain/cooldown`), and the test runs count without it: compiling
   never consumes a test run, and a spent test budget still lets the student
   compile. The journal is unchanged — a compilation is a `run` event with
   `compileOnly: true` — and that flag is what splits the two counts
   (`countRecentEvents`). The teacher's preview keeps the same rule under two
   in-memory keys. The runner priority of a compilation stays `interactive`.

### Why these numbers

Without a visible cooldown a student's compilations are bounded by the
compiler's own latency, about a second on the runner. Three compilations per
test run — one every 2 s sustained at the default 10 runs a minute — is above
what a person editing code does and well below a held-down key or a script.
The floor of 20 keeps a question with a tight run budget (1 or 2 a minute)
compilable; the cap of 60 keeps the most generous question at one compilation
a second per student, so the budget still guards the runner. It is derived,
not configured: no new config field, no config version, nothing for the
author to tune.

### Consequences

- A host now reports a 429 of `POST /attempts/:id/run` (and of the preview's
  `/run`) as `rate_limited` instead of folding it into `unavailable`, and the
  `code` player words it ("Too many runs in a minute…", `qt.code.p.rateLimited`,
  formerly `qt.codeimage.p.rateLimited`). With Compile uncapped in the UI,
  its budget is the one a student can actually meet.
- The cooldown floor `60 s / runsPerMinute` still holds for the test runs, so
  the test budget is never what a student runs into by clicking.
