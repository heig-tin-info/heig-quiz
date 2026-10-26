# ADR-118 — Structured criteria for essays

## Status

Accepted (2026-10-26, decisions of the product owner). Delivered in three
pull requests: PR1 (the config, the editor, the model's contract, the
scaling), PR2 (per-criterion edits on the grading screen, the breakdown
stored at validation), PR3 (the student view of §5).

Scope: the `rich` question type (docs/spec/04 §4.8) and the LLM grading of
an essay (ADR-063 §4, §5).

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
   minted by the editor; `title` a short name; `weight` an integer 1..100;
   `prompt` plain text, what earns the weight, for the grader only. v1
   configs migrate to `criteria: []`; no SQL migration, no conversion of an
   old rubric.
2. **Points.** `defaultPoints(config)` is the sum of the weights, else 1.
   The evaluation item's points (`evaluation_items.points`) stay the one
   source of points and stay editable. No points field on the question, no
   "use criteria" switch.
3. **The model scores in weights.** With criteria, the request carries them
   and the model scores each one from 0 to its weight in quarter points,
   its reply keyed by criterion id. The server scales to the item's points
   deterministically (`scaleCriteria`, `@quiz/domain`): a criterion is
   worth `points × weight / Σweights`, earns `points × earned / Σweights`,
   and the total is `points × Σearned / Σweights` from the raw sum, never
   the sum of the rounded parts, clamped to `[0, points]`. Without criteria
   the model still reads the free rubric; a breakdown whose maxima miss the
   item's points is rescaled in proportion, so it never contradicts the
   total.
4. **The rubric stays**, labelled "Grading instructions": optional global
   context for the grader, sent beside the criteria.
5. **What a student sees** (PR3): under `showKey`, once the teacher has
   validated the grading, each criterion's title and its validated points.
   Never a criterion's prompt, never the model's sentence or justification.
   Until PR3, no criterion reaches any student payload: `toStudent` and
   `studentSolution` drop them, tested by forbidden key and by value.
6. **Per-criterion grading** (PR2): the grading screen lets the teacher edit
   each criterion's points; the validated breakdown is stored with the
   grading under a student-readable key, distinct from `details.ai`.

`diagram` keeps its free rubric for now.

## Consequences

- ADR-037 §1 is amended for essays: criterion titles and validated points
  reach a student under `showKey` (PR3). Prompts, the rubric and the AI's
  text stay the teacher's.
- ADR-063 §4 is amended: the structured rubric is no longer deferred;
  `details.ai` stays teacher-only; the student-readable breakdown comes with
  PR2 and PR3.
- An essay with criteria is worth more than 1 point by default; existing
  evaluation items keep the points they were given.
- The MCP guide and the wand propose criteria; a free rubric alone still
  grades as before.

## Alternatives considered

1. **A points field on the question**: a second source of points beside the
   item's, which would drift.
2. **The model scores on the item's scale**: rounding and clamping in the
   model's hands, the bug this record fixes.
3. **Parsing the free rubric into criteria**: fragile, and an old rubric's
   points rarely match its item's.
