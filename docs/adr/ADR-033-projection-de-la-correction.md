# ADR-033 — The correction projection reads the validated gradings, per attempt

## Status

Accepted (2026-09-28, issue #245, settled with the product owner; with the
route `/evaluations/:id/correction`, the `outcomes`, `part` and case `label`
fields of `ByQuestion`, `TallyEntry` in `@quiz/core`, `debrief()` and
`outcomeOf()` in `@quiz/domain`, and F-RES-03). Amended 2026-09-30 by
ADR-050: §1's `not_over` is lifted, for an exercise, once its teacher
publishes the correction. Amended 2026-10-01 by ADR-056 §9: the answers to a
parameterized question each have their own key, so they are grouped by
verdict only (an mcq keeps its ticks per choice), and the projected question
is the instance of the example values, named as such.

## Context

F-RES-03 asks for "linear scrolling for going through the answers in class".
The per-question endpoint behind the Results "Questions" tab said how many
answered, but not who got it right: every answer group had `correct: null`,
and an empty answer was the French label `"(vide)"`, sent by the API
(invariant 1). A projection in front of the class needs the outcome of each
attempt, the verdict of each answer group, and — for a cloze — which blank a
group answers.

## Decision

1. **Once the evaluation is over, and only then.** `GET
   /evaluations/:id/results/by-question` answers `409 not_over` unless the
   evaluation is `closed`, `grading` or `released`: a key on the wall while a
   student still answers, is late, or can retake an exercise is what the
   projection must never do. Access stays `staffAccess`. The grading panel,
   which the palette opens in any state, no longer reads this endpoint: the
   explanation it shows travels with the grading queue's items.

   *Amended by ADR-050 (2026-09-30): an exercise whose teacher published the
   correction (`correction_published_at`, an explicit and irreversible act)
   is served while it still runs, over its FINISHED attempts only — never
   one in progress — with `papers`, the count of papers handed in so far.
   An exam still waits for its close.*

2. **Validated gradings only.** Over the counted attempts (one per student,
   no teacher's rehearsal — ADR-018, ADR-025), an attempt is `blank` (no
   answer, skipped, or nothing the type calls an answer) or takes
   `outcomeOf(points, maxPoints)`: full marks, above zero, or zero and below —
   a negative mark (ADR-026) is wrong. An answer whose grading is still a
   proposal counts nowhere, not as a zero. The success rate is the mean over
   the same attempts, a blank at 0, so the percentage and "out of n papers"
   describe one population. An absent student is in neither.

3. **One aggregate call per attempt; the verdict of a group comes from the
   grading.** The results module calls the type's `aggregate` once per
   attempt and merges in `debrief()`. A group takes the type's own verdict
   when it can judge the key alone — an mcq choice is in the key its grading
   recorded, a cloze blank has its `perBlank.ok` — and otherwise the outcome
   of the attempt it came from (a short answer). Groups that disagree, or
   come from a partial attempt, are mixed (`correct: null`). The screen never
   recomputes a verdict from the key. Groups are not capped: a part has at
   most one per attempt, and a cap made the counts derived from them lie.

4. **Hidden case names follow the feedback policy.** `aggregate` receives the
   evaluation's `showHiddenCaseNames`, and `code` labels each case through
   its own `studentDetails` filter (`#2` for a hidden one when the policy
   closes the names). The staff tab keeps `name`; the projection draws
   `label`. The redaction guards the wall, not the teacher's session — the
   endpoint is staff-only and the teacher already reads the hidden cases in
   the editor — so the layer that must not show the name is the rendering,
   and the one place that decides the wording is qt-code's.

5. **Red for wrong.** The poll donut uses `warning` for incorrect because a
   poll marks nobody wrong and red/green collapses for a deutan reader. A
   graded paper does mark answers wrong, and the owner wants red; the bars
   stay legible without colour (gaps, hatching, fixed order, the figures in
   words on hover, focus and to a screen reader — DESIGN.md).

## Consequences

- The Questions tab gains the verdict colours and loses the French literal.
- A teacher's override changes an attempt's outcome, not a cloze blank's
  per-blank verdict, which stays the grader's.
- The mock runs the real `aggregate` of `mcq`, `short` and `cloze` and the same
  `debrief()`.

## Alternatives considered

1. **Verdicts recomputed in the browser from the key**: wrong as soon as a
   teacher overrides a grading.
2. **A per-type verdict hook beside `aggregate`**: a second hook for the same
   data; one optional field on the entries is enough.
3. **One aggregate call per item, each type judging every group**: every type
   would re-derive the attempt's outcome and ignore the teacher's override.
4. **A separate `/correction` endpoint**: two readings of one view.
