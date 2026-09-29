# ADR-037 — Teacher-only material in a solution

## Status

Accepted (2026-09-29, decided by the teacher who owns the product; with the
optional hook `studentSolution` of `QuestionTypeServer` in `@quiz/core` and
`studentSolutionView` in `apps/api/src/modules/live/studentView.ts`). No
migration. Settles question 27 of docs/spec/06.

## Context

A type's `toSolution` returns its key and whatever the teacher needs beside
it: the grading panel, the dashboard inspector and the results by question
read it whole. The same value was served to a student as soon as the
feedback policy showed the key (`showKey`), which the `exercise` preset turns
on with `when: "immediate"`: right after hand-in, a student read everything
`toSolution` returned.

For most types that is the key and nothing else. Three carry material that is
the teacher's whatever the policy says:

- an essay (`rich`, §4.8) returns its **grading criteria** (`rubric`) beside
  the model answer — how the teacher awards the points, written for
  themselves or another grader;
- a circuit (`circuit`, §4.11) returns its **stimuli**, the hidden ones
  included, and its **grading block**: mode, tolerance, rubric;
- a short answer (`short`, §4.4) renders an `llm` matcher (phase 2) as its
  **rubric** in the list of expected answers.

## Decision

1. **Grading criteria never reach a student**, not under `showKey`, not in an
   exercise with immediate feedback. The model answer of an essay does: it is
   the expected answer, and a student with no model answer to read sees no
   guide panel at all.

2. **One optional hook.** `QuestionTypeServer.studentSolution?(solution,
   config): TSolution | null` returns the part of `toSolution`'s result a
   student may read, `null` meaning "nothing left". Pure; absent means the
   whole solution is fit for a student. The precedent is `studentDetails`,
   which does the same for the grading breakdown. It takes the config as well
   as the solution because `short` cannot tell an `llm` line from an `exact`
   one in the rendered list.
   - `rich`: `{ reference }`, or `null` without a model answer;
   - `circuit`: `{ reference }` — no stimuli, no grading block;
   - `short`: the expected answers of every matcher but `llm` (an empty list
     stays a list, as for a keyless poll).
   `mcq`, `cloze`, `code`, `codeimage` and `categorize` hold no such material
   and implement nothing: their solution is the key the teacher chose to
   publish (a hidden `code` case included, as D15 already says).

3. **One student exit for a key**, `studentSolutionView`, beside
   `studentView` and `solutionView`. It does not check the policy; its callers
   serve it only when `showKey` holds. Every student-facing reader of a key
   goes through it:
   - the feedback page (`results/service.ts`, `studentFeedback`), which also
     serves an admin acting as a student (ADR-034);
   - a poll: the phones' reveal, AND the teacher's own view, because that
     view feeds the beamer projection (ADR-014);
   - the teacher's preview "as a student" (ADR-018), which must show what the
     student will.

   The teacher's surfaces keep `solutionView` / `solutionViewOf`: the grading
   panel, the dashboard inspector, the editor's "try", and the results by
   question (ADR-033). The correction projection reads the latter but draws
   no essay or circuit solution, only an mcq's key, a short answer's expected
   list, a cloze's blanks and a program's reference.

4. **Still open**: whether a student will read a per-criterion breakdown when
   an LLM grades an essay (§4.8, "Scoring, later"). That breakdown would live
   in the grading details, which `studentDetails` filters, not in the
   solution; it is decided with the LLM grading, not here.

## Consequences

- `RichSolution.rubric` and `CircuitSolution.stimuli`/`grading` become
  optional; the essay's review draws the criteria panel only when they are
  there, the circuit's review draws the reference for a teacher only, as
  before.
- The essay editor says so: the criteria hint ends "Students never see it",
  the model answer hint says when a student does.
- The leak test (`studentView.leak.test.ts`) checks, for every registered
  type, that no sown `rubric` survives `studentSolutionView`, and that the
  essay's model answer and the circuit's reference still do.

## Alternatives considered

1. **A second forbidden-key list applied to the solution**: `reference` is
   the key of a circuit and the model answer of an essay, but a teacher-only
   circuit in no other type; a name cannot say whose it is, the type can.
2. **Filtering in the web client by `audience`**: the rubric would still
   travel to the browser.
3. **A `studentSolution(config, view)` built from the config**: every type
   would re-derive its solution a second way; filtering what `toSolution`
   returned keeps one builder.
