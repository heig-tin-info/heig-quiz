# ADR-037 — Teacher-only material in a solution

## Status

Accepted (2026-09-29, decided by the teacher who owns the product; with the
optional hook `studentSolution` of `QuestionTypeServer` in `@quiz/core` and
`studentSolutionView` in `apps/api/src/modules/live/studentView.ts`). No
migration. Settles question 27 of docs/spec/06.

Amended by [ADR-063](ADR-063-correction-llm.md) §7: a teacher may explicitly copy an AI
justification into the student-visible comment. Grading criteria stay private;
there is no automatic disclosure of the justification.

## Context

A type's `toSolution` is served whole to the teacher's surfaces, and was
served whole to a student as soon as the feedback policy showed the key
(`showKey`), which the `exercise` preset turns on right after hand-in. An
essay's solution carries its grading criteria (`rubric`) beside the model
answer; a short answer renders an `llm` matcher (phase 2) as its rubric.
Criteria are how the teacher awards points, not an answer.

## Decision

1. **Grading criteria never reach a student**, even under `showKey`. An
   essay's model answer does, as the expected answer; without one the
   student sees no guide at all.
2. **One optional hook**, `studentSolution?(solution, config): TSolution |
   null`: the part of `toSolution`'s result a student may read. Pure; absent
   means the whole solution. It takes the config because `short` cannot tell
   an `llm` line from an `exact` one in its rendered list. `rich` returns
   `{ reference }` or `null`; `short` drops its `llm` lines.
3. **One student exit for a key**, `studentSolutionView`, beside
   `studentView`; its callers serve it only when `showKey` holds. The
   teacher's surfaces keep `solutionView`. The correction projection reads
   the results by question, which keep the teacher's solution: safe, because
   an `llm` matcher is refused at publication (`short.llm_not_available`).
4. **A circuit's key is its reference alone**, for everyone: nothing read its
   stimuli or grading block from the solution, and the teacher reads them in
   the editor and the grading details. No hook.

## Consequences

- `RichSolution.rubric` is optional; the essay's review draws the criteria
  panel only when it is there.
- The essay editor says so: the criteria hint ends "Students never see it",
  the model answer hint says when a student does.

## Alternatives considered

1. **A second forbidden-key list on the solution**: a key name cannot say
   whose a field is; the type can.
2. **Filtering in the web client by `audience`**: the rubric would still
   travel to the browser.
