# ADR-024 — One locked editor, three student tools, a visible cooldown

## Status

Accepted (2026-09-24, with `packages/qt-code/src/LockedEditor.tsx`,
`ArgsInput.tsx`, `lockEdit.ts` and `@quiz/domain/cooldown`).

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
