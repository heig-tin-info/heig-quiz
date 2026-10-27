# ADR-118 — Structured criteria for essays

## Status

Accepted (2026-10-26, decisions of the product owner).

Scope: the `rich` question type (docs/spec/04 §4.8), the LLM grading of an
essay (ADR-063 §4, §5), and the free-rubric path of every LLM-graded type
(an essay without criteria, a diagram), whose breakdown is scaled to the
item's points (§3).

Relations: amends [ADR-037](ADR-037-materiel-reserve-a-l-enseignant.md) §1
and [ADR-063](ADR-063-correction-llm.md) §4; settles the structured rubric
that docs/spec/04 §4.8 and open question 27 (docs/spec/06) left deferred.

### Amendment of 2026-10-27 (the owner's feedback on the shipped editor)

Decision 1 and alternative 3 are amended. A teacher-triggered conversion of
a legacy rubric into criteria is accepted as a wand action (ADR-059, target
`criteriaFromRubric` of the `rich` generator). The model proposes criteria
that land in the draft like an edit, undoable, and only the teacher saves
them. What applies to every criterion stays the rubric. An automatic
conversion, by migration or without the teacher, stays rejected. The same
wand writes one criterion's grading prompt on request (target
`criterionPrompt`). Beside criteria the rubric is labelled "Global
instructions" and folded while empty (decision 4).

### Amendment of 2026-10-27 (per-criterion grading)

Decision 6 is settled as follows.

- **Storage.** The validated breakdown lives in the grading's `details`
  under `breakdown` (`BREAKDOWN_KEY`, `@quiz/core/reasons`): one entry
  `{ id, title, points, maxPoints }` per criterion, in the config's order,
  the titles snapshotted from the version the item holds, the points on the
  item's scale to two decimals. Never a weight, a prompt, a sentence of the
  model nor its name: `details.ai` keeps those, teacher-only.
- **When it is written.** By every validation path: one Validate, the batch
  "Validate N", and an override. As-is, only when every entry of
  `details.ai.criteria` carries an id and those ids are exactly the item's
  criteria; the proposal's points are copied and its total kept (a 0.01 gap
  between the rounded parts and the total is accepted). A free rubric, a
  diagram, or ids that match nothing get no breakdown, never a partial one.
  The criteria come from the type's `gradingCriteria` hook on the version's
  config; a type without it is graded by one total.
- **The total is never typed for an essay with criteria.** The teacher sends
  `criteria: [{ id, points }]`, each within `[0, maxPoints]` of its
  criterion; the server derives the total, `clamp(round2(Σ points), 0,
  itemPoints)` (`validatedBreakdown`, `@quiz/domain`), the rule the grading
  form shows. `criteria` and `points` are exclusive in a body (400); a
  missing, unknown or duplicate id, a point out of range, a bare `points`
  for an essay with criteria, or `criteria` for an item without them is
  `422 criteria_invalid`.
- **Whose grading it is.** A validation with the teacher's points per
  criterion becomes `source: manual` when the total changes, and also when
  the points only move between criteria: a teacher's split is not the
  machine's (F-GRADE-04). Sent unchanged, the proposal stays the model's.
- **What an override keeps.** For an essay with criteria, the details of the
  grading in force survive (`ai`, `justification`) beside `manual: true` and
  the new breakdown; a teacher grading a cell no model proposed for gets a
  breakdown without `ai`. Every other type keeps writing `{ manual: true }`.
- **After the release.** `results_updated` compares grades only: a new split
  with an unchanged total notifies nobody.
- **Who reads it.** `rich`'s `studentDetails` drops `breakdown` unless the
  key is shown: under `showKey` the feedback payload carries it; the
  student screen of §5 that renders it is still to build.

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
   `criteria: []`; no SQL migration, no conversion of an old rubric (amended 2026-10-27, see above: the teacher may ask the wand for one).
2. **Points.** `defaultPoints(config)` is the sum of the weights, else 1.
   The evaluation item's points (`evaluation_items.points`) stay the one
   source of points and stay editable. No points field on the question, no
   "use criteria" switch.
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
   points instead of clamping the total alone.
4. **The rubric stays**, labelled "Grading instructions" (amended 2026-10-27, see above: "Global instructions", folded while empty, once criteria exist): optional global
   context for the grader, sent beside the criteria.
5. **What a student sees**: under `showKey`, once the teacher has validated
   the grading, each criterion's title and its validated points. Never a
   criterion's prompt, never the model's sentence or justification. Until
   that view exists, no criterion reaches any student payload: `toStudent`
   and `studentSolution` drop them, tested by forbidden key and by value.
6. **Per-criterion grading**: the grading screen lets the teacher edit each
   criterion's points; the validated breakdown is stored with the grading
   under a student-readable key, distinct from `details.ai`.

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
- Still to build: the student view of §5, which renders the breakdown under
  `showKey`.

## Alternatives considered

1. **A points field on the question**: a second source of points beside the
   item's, which would drift.
2. **The model scores on the item's scale**: rounding and clamping in the
   model's hands, the bug this record fixes.
3. **Parsing the free rubric into criteria**: fragile, and an old rubric's
   points rarely match its item's. Rejected as an automatic conversion; a
   teacher-triggered proposal into the draft is accepted by the amendment
   of 2026-10-27.
