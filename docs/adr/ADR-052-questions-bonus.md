# ADR-052 — Bonus questions replace the threshold grade scale

## Status

Accepted (2026-09-30, decided by the product owner). Delivered with the
column `evaluation_items.bonus` and the data migration of
`0040_evaluation_item_bonus`, the pure rules `evaluationTotal`,
`lacksGradedPoints`, `bonusTotal` and `itemPoints` of `@quiz/domain/grade`, the
`bonus` parameter of `scoresNegatively` (`@quiz/domain/evaluationConfig`),
the readiness reason `no_graded_points` and the `bonus` key of the item
shapes of `@quiz/contracts`.

Supersedes the `threshold` half of F-EVAL-10 (docs/spec/02). Amends
[ADR-026](ADR-026-points-negatifs-par-evaluation.md) (§3: a bonus item is
floored at 0), [ADR-031](ADR-031-modeles-d-evaluation.md) (a template carries
the bonus flag) and [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md) (the MCP
item shape).

## Context

F-EVAL-10 offered two grade scales: `linear`, grade = 1 + 5 × points / total,
and `threshold`, grade = 1 + 5 × points / threshold capped at 6 — the way a
teacher announces "18 points suffice for a 6". In practice:

- the threshold was set once, when the teacher switched the scale, to the
  total of the moment (`AdvancedDisclosure`), and there was no field to
  change it afterwards: adding a question silently moved the goalposts, or
  did not, depending on the order of the clicks;
- the student saw "18 points", a total of 20, and nothing telling them that
  two of those points were a gift; a teacher reading the results could not
  tell which question was meant to be optional;
- production held exactly one `threshold` row, a draft.

What teachers actually mean by "18 suffice" is almost always "this question
is a bonus". Saying it on the question makes it visible where it matters —
in the builder, in the player and on the feedback page — and removes a
setting nobody could edit.

## Decision

1. **A bonus is a property of an evaluation ITEM**, not of a question: the
   column `evaluation_items.bonus boolean not null default false`, beside
   `milestone`. The builder toggles it on the item row (a secondary control,
   the `Candy` icon, `aria-pressed`, tooltip "Bonus"); the row says "bonus"
   beside the question's name.
2. **Locked like the points.** `PATCH …/items/:itemId` takes `bonus` and goes
   through `assertItemListEditable`: frozen once an attempt exists or the
   evaluation has been opened (`409 locked` / `409 items_frozen`). Every read
   of the items (`ItemRow`, `AttemptItem`, `StudentResultItem`,
   `ResultsItem`, `TemplatePullItem`) carries it.
3. **Negative marking.** A bonus item is graded like any other — under
   negative marking with the negative rule of ADR-026, so a wrong choice
   still lowers a partial score — and only its final score is floored at 0.
   Every automatic grade goes through ONE function,
   `itemPoints(raw, bonus)`: `round2(raw)`, floored at 0 on a bonus item. It
   is called where an automatic grade becomes an item's points: the grading
   pass, the runner's second half, the teacher preview and the dashboard's
   live colour. A manual correction of a bonus item ranges over `[0, max]`
   (`scoresNegatively(type, on, bonus)` is false). The student is told about
   negative marking on a bonus item exactly as on any other, since the rule
   does apply to it. The drill (ADR-041) grades a question, not an item, and
   ignores the flag.
4. **One attempt-level floor.** `attemptTotal` still sums every item, bonus
   included, and floors once (ADR-026 §3).
5. **One total, bonus items left out.** `evaluationTotal` (and
   `totalPointsByEvaluation`, the same sum in SQL for lists) is the only definition of an
   evaluation's total: builder, attempt view, dashboard, results, feedback,
   templates, release snapshot. The grade stays 1 + 5 × points / total, and
   `gradeFromPoints` caps it at 6, so bonus points lift a student and never
   past a 6. Percentages are not capped: a screen may read "21 / 18 pts".
   The item statistics (ADR-038, ADR-042, ADR-043) treat a bonus item as an
   ordinary question: its success rate is its own points over its own
   maximum.
6. **Readiness.** An exam or an exercise whose total is 0 — every question a
   bonus, or none worth a point — is refused on `→ scheduled | lobby |
   running` with `409 illegal_transition`, reason `no_graded_points`
   (`lacksGradedPoints`); a poll never is. The launch checklist shows it as a
   blocker, from the same rule.
7. **Templates.** `copyEvaluation` (duplicate, save as template,
   instantiate) and a pull copy the flag; a change of it moves a template's
   revision and is named in a pull's summary.
8. **MCP.** `get_evaluation` returns the items with `bonus`;
   `add_questions_to_evaluation` takes no flag (it takes no milestone
   either); `update_evaluation`'s scale is linear only.
9. **CSV** (F-RES-02). A bonus item's column header ends with ` (bonus)`;
   `total` is the student's points, bonus included.
10. Progress counts every item, bonus or not. The flag is never offered on a
    poll (a poll has no builder item row). Exercises and retakes need
    nothing more.
11. **`threshold` is removed everywhere**: the `Scale` of `@quiz/domain`, the
    `GradingScale` of `@quiz/contracts` (now `{ kind: "linear", rounding }`,
    the jsonb column keeps its shape), the scale row of the advanced options
    (which had nothing left to choose, rounding having no control), the
    `eval.scale.*` strings. Migration 0040 rewrites every `threshold` row of
    `evaluations` (templates included) to `linear` with its rounding, and
    relabels the scale of a stored release snapshot so it still parses; the
    frozen grades of such a snapshot stay as they were computed.

## Consequences

- A student reads "Bonus question" on the question itself and on the
  released feedback, and the total they are graded on is the one displayed.
- Grades above the total are possible in points ("21 / 18") and capped in
  the grade. Every screen that shows a percentage must tolerate > 100 %
  (F-DASH-03).
- The one production row on `threshold` becomes linear: its draft's future
  grade reads against its full total until the teacher marks a bonus.
- A teacher who wants "any 18 of 20 points" must now say which question is
  the bonus; the platform no longer expresses a pass mark detached from the
  questions. This is deliberate.

### Rollback

Drop the column and the flag from the reads; the totals then include every
item again. The `threshold` kind would have to come back in the contracts,
the domain and the settings screen; the rows converted by 0040 would stay
linear.

## Alternatives considered

- **Keep `threshold` and add an editable field.** Fixes the frozen value,
  not the invisibility: nobody sees which points are optional.
- **Disable negative marking on a bonus item** instead of flooring it. Simpler
  in the grader, but it changes the rule that scores the item (the
  question's own policy instead of the negative one) and the product owner
  asked for `max(0, formula)`.
- **A bonus flag on the question** (in the pool). A question is a bonus in
  one evaluation and a core question in another; the item is the right
  place, like the points and the milestone.
