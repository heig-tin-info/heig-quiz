# ADR-118 — Structured criteria for essays

## Status

Accepted (2026-10-26, decisions of the product owner); amended 2026-10-27
three times, each folded into the decision it changes (2026-11-08). The
[historical record](history/ADR-118-criteres-structures-des-essais.md#status)
keeps the three amendments as written.

<a id="amendment-of-2026-10-27-the-owners-feedback-on-the-shipped-editor"></a><a id="amendment-of-2026-10-27-per-criterion-grading"></a><a id="amendment-of-2026-10-27-the-owners-weighting-switch"></a>

- 2026-10-27, the owner's feedback on the shipped editor: a legacy rubric
  becomes criteria only through a teacher's wand action (decision 1,
  alternative 3); the rubric is "Global instructions" beside criteria
  (decision 4).
- 2026-10-27, per-criterion grading: decision 6 settled (storage, total
  derived from the criteria, `source: manual`, overrides, notifications,
  who reads the breakdown).
- 2026-10-27, the owner's weighting switch: decision 2's "no points field,
  no switch" reversed by "Normalize" and a `totalPoints` default.

Scope: the `rich` question type (docs/spec/04 §4.8), the LLM grading of an
essay (ADR-063 §4, §5), and the free-rubric path of every LLM-graded type
(an essay without criteria, a diagram), whose breakdown is scaled to the
item's points (§3).

Relations: amends [ADR-037](ADR-037-materiel-reserve-a-l-enseignant.md) §1
and [ADR-063](ADR-063-correction-llm.md) §4; settles the structured rubric
that docs/spec/04 §4.8 and open question 27 (docs/spec/06) left deferred.

## Context

An essay was graded against a free markdown `rubric` and worth 1 point by
default (`defaultPoints: () => 1`). A rubric reading "2 × **1 pt**" made the
model propose a breakdown of two criteria at 1/1 each, then `askGrader`
clamped the total to the item's 1 point without touching the breakdown: the
Try tab showed "1 of 1 points" above "1/1, 1/1". Nothing tied the rubric's
points to the item's, and the student could never be told which criterion
cost them points.

## Decision

1. **Criteria on the config.** `rich` config v2 adds `criteria`: up to 12
   entries `{ id, title, weight, prompt }`. `id` is opaque and stable,
   minted by the editor, letters, digits, `_` and `-` (it keys the model's
   reply); `title` a short name; `weight` an integer 1..100; `prompt` plain
   text, what earns the weight, for the grader only. v1 configs migrate to
   `criteria: []`; no SQL migration, and no automatic conversion of an old
   rubric, by migration or without the teacher. *(2026-10-27)* A teacher may
   ask the wand (ADR-059) to convert a legacy rubric into criteria (target
   `criteriaFromRubric` of the `rich` generator), or to write one
   criterion's grading prompt (target `criterionPrompt`): the proposal lands
   in the draft like an edit, undoable, and only the teacher saves it.
2. **Points.** The evaluation item's points (`evaluation_items.points`)
   stay the one source of points and stay editable; the question only
   carries a DEFAULT. *(2026-10-27, reversing "no points field on the
   question, no 'use criteria' switch".)* The essay editor has a
   "Weighting" section (« Pondération ») with a "Normalize" switch
   (« Normaliser »), off by default, shown only beside criteria (without
   criteria the default stays 1).
   - **Two stored fields**: `normalize` (boolean, default `false`) and
     `totalPoints` (0.5 to 1000), required when `normalize` is true and
     refused when it is false, so an MCP or import input says which reading
     it means. No `configVersion` bump: a config without them reads as off.
   - **Off, the numbers are points**: the column reads "Points" and
     `defaultPoints` is their sum. **On, they are weights**: the column
     reads "Weight" and `defaultPoints` is `totalPoints`, shared by weight.
   - Either way `scaleCriteria` scales the criteria to the item's points
     (§3); grading, the stored breakdown, `toSolution`, the review and the
     grading screen do not depend on the mode.
   - A weight stays an integer 1..100 in both modes; half points need
     Normalize and a typed total.
   - **The switch never rescales**: on prefills `totalPoints` with the
     weights' sum; off keeps the weights and drops `totalPoints`.
   - **The wand**: `criteriaFromRubric` asks for the rubric's whole points
     as weights; with half points the model doubles every weight and returns
     the rubric's total as `totalPoints`, which turns `normalize` on when it
     differs from the weights' sum. Criteria proposed by "Generate answers"
     are points and land with the switch off.
   - **The student** never reads either field: `toStudent` builds its view
     field by field, tested by forbidden key and by value.
3. **The model scores in weights; the server scales.** With criteria, the
   request carries them and the model scores each one from 0 to its weight
   in quarter points, its reply keyed by criterion id. The server scales to
   the item's points deterministically (`scaleCriteria`, `@quiz/domain`): a
   criterion is worth `points × weight / Σweights`, earns
   `points × earned / Σweights`, and the total is `points × Σearned / Σweights`
   from the raw sum, never the sum of the rounded parts, clamped to
   `[0, points]`. The free-rubric path of every LLM-graded type (an essay
   without criteria, a diagram) goes through the same rule, the model's
   maxima taken as the weights: its breakdown is rescaled to the item's
   points instead of clamping the total alone. A corollary: in points mode
   (§2, Normalize off) a criterion's number is its points by default, and
   its share of the item's points otherwise.
4. **The rubric stays**, labelled "Grading instructions", and "Global
   instructions", folded while empty, once criteria exist *(2026-10-27)*:
   optional global context for the grader, sent beside the criteria.
5. **What a student sees**: under `showKey`, once the teacher has validated
   the grading, each criterion's title and its validated points. Never a
   criterion's prompt, never the model's sentence or justification. They
   come from the grading's validated breakdown (§6), never from the
   question: `toStudent` and `studentSolution` keep dropping the criteria,
   tested by forbidden key and by value.
6. **Per-criterion grading** *(settled 2026-10-27)*: the grading screen
   lets the teacher edit each criterion's points; the validated breakdown is
   stored with the grading under a student-readable key, distinct from
   `details.ai`.
   - **Storage.** `details.breakdown` (`BREAKDOWN_KEY`, `@quiz/core/reasons`):
     one entry `{ id, title, points, maxPoints }` per criterion, in the
     config's order, titles snapshotted from the version the item holds,
     points on the item's scale to two decimals. Never a weight, a prompt, a
     sentence of the model nor its name: `details.ai` keeps those,
     teacher-only.
   - **When it is written.** By every validation path: one Validate, the
     batch "Validate N", and an override. As-is only when every entry of
     `details.ai.criteria` carries an id and those ids are exactly the
     item's criteria; the proposal's points are copied and its total kept (a
     0.01 gap between the rounded parts and the total is accepted). A free
     rubric, a diagram, or ids that match nothing get no breakdown, never a
     partial one. The criteria come from the type's `gradingCriteria` hook on
     the version's config;
     a type without it is graded by one total.
   - **The total is never typed for an essay with criteria.** The teacher
     sends `criteria: [{ id, points }]`, each within `[0, maxPoints]`; the
     server derives `clamp(round2(Σ points), 0, itemPoints)`
     (`validatedBreakdown`, `@quiz/domain`). `criteria` and `points` are
     exclusive in a body (400); a missing, unknown or duplicate id, a point
     out of range, a bare `points` for an essay with criteria, or `criteria`
     for an item without them is `422 criteria_invalid`.
   - **Whose grading it is.** The teacher's points per criterion make it
     `source: manual` when the total changes and when points only move
     between criteria (F-GRADE-04); sent unchanged, the proposal stays the
     model's.
   - **What an override keeps.** For an essay with criteria, the details in
     force (`ai`, `justification`) survive beside `manual: true` and the new
     breakdown; a cell no model proposed for gets a breakdown without `ai`.
     Every other type keeps writing `{ manual: true }`.
   - **After the release.** `results_updated` compares grades only: a new
     split with an unchanged total notifies nobody.
   - **Who reads it.** `rich`'s `studentDetails` drops `breakdown` unless the
     key is shown: under `showKey` the feedback payload carries it, and the
     essay's `Review` lists it under the
     answer, "Points per criterion", for student and teacher alike (the
     teacher's list adds the model's sentence per criterion). The score line
     stays the item's points.

`diagram` keeps its free rubric for now.

## Consequences

- ADR-037 §1 is amended for essays: criterion titles and validated points
  reach a student under `showKey`. Prompts, the rubric and the AI's text
  stay the teacher's.
- ADR-063 §4 is amended: the structured rubric is no longer deferred;
  `details.ai` stays teacher-only; a student-readable breakdown is added by
  §6.
- An essay with criteria is worth more than 1 point by default; existing
  evaluation items keep the points they were given.
- The MCP guide and the wand propose criteria; a free rubric alone still
  grades as before, with a breakdown that now agrees with its total.
- Writing one criterion's prompt and converting a legacy rubric into
  criteria are wand actions proposed into the draft (amendment of
  2026-10-27); no stored question is converted without its teacher.
- The per-criterion grading of §6 is delivered (amendment of 2026-10-27):
  the grading screen edits each criterion's points and every validation
  stores the breakdown.
- The student view of §5 is delivered: under `showKey`, a validated
  essay's review lists each criterion's title and points under the answer.

## Alternatives considered

1. **A points field on the question**: a second source of points beside the
   item's, which would drift. Accepted by the amendment of 2026-10-27 as a
   DEFAULT only (`totalPoints`, behind the "Normalize" switch): the item
   stays the one stored source of an evaluation's points, as the sum of the
   weights already was a default.
2. **The model scores on the item's scale**: rounding and clamping in the
   model's hands, the bug this record fixes.
3. **Parsing the free rubric into criteria**: fragile, and an old rubric's
   points rarely match its item's. Rejected as an automatic conversion; a
   teacher-triggered proposal into the draft is accepted by the amendment
   of 2026-10-27.
