# ADR-108 — How an item counts: normal, bonus or neutralized, changeable at grading time

## Status

Accepted (2026-10-12, decided by the product owner).

Scope: the stored counting of an evaluation item, the sums that read it, and
the grading-time act that changes it after an evaluation has run.

Relations: amends [ADR-052](ADR-052-questions-bonus.md) §2 (the lock: the
builder is unchanged, the grading-time act is allowed once frozen), §3 and §4
(negative marking floored at sum time), §5 (the total), §7 (copies) and §9
(CSV); depends on [ADR-030](ADR-030-canaux-de-notification.md) §h
(`results_updated`) and [ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3
(after the release, the owner's).

## Context

After an evaluation has run, a teacher may discover that a question was
incoherent — the real case: question 7 of a quiz must become a bonus. ADR-052
locks the bonus flag with the points once an attempt exists, so the only way
out was to re-grade every student by hand. The teacher needs to change how
the item counts from the grading panel: **normal**, **bonus** (ADR-052: out
of the total, its points still lift the student) or **neutralized** (out of
the total AND out of every student's points), with a confirmation, and
reversibly.

## Decision

1. **One state per item, not two flags.** `evaluation_items.counting`
   (`'normal' | 'bonus' | 'neutralized'`, not null, default `'normal'`)
   replaces `evaluation_items.bonus`; migration `0112_item_counting` copies
   `bonus = true` to `'bonus'` and drops the column. Every item shape of
   `@quiz/contracts` (`ItemRow`, `AttemptItem`, `StudentResultItem`,
   `ResultsItem`, `TemplatePullItem`) and the MCP `get_evaluation` carry
   `counting`. The rule names are `ITEM_COUNTINGS` / `ItemCounting` in
   `@quiz/domain/grade`.
2. **The builder is unchanged** (ADR-052 §2): its toggle offers normal ↔
   bonus only (`ItemPatch.counting` is `BuilderCounting`), locked by
   `assertItemListEditable`.
3. **The grading-time act** is `PUT /evaluations/:id/items/:itemId/counting`
   (`ItemCountingBody`, any of the three states), the opposite gate of the
   builder's: allowed only once the item list is frozen (`itemListLock` not
   null), else `409 counting_not_frozen`; never on a poll (`422
   counting_poll`); never down to a total of 0 (`409 illegal_transition`,
   reason `no_graded_points`, `lacksGradedPoints`). It is loaded through the
   staff access loader of the grading routes; after the release it is the
   course owner's (`403 owner_required`, ADR-068 §3). Reversible any number of
   times; choosing the current state changes nothing. Audited as
   `evaluation.item_counting` with the item id, before and after.
4. **Floor at sum time, never rewrite a grading.** Stored gradings are never
   touched. ONE pure function, `countedPoints(points, counting)` —
   neutralized → 0, bonus → `max(0, p)`, normal → `p` — is applied by
   `attemptTotal`, which now takes `{ points, counting }` cells, so every
   student sum goes through it: the results grade table, the kept attempt,
   `pointsByAttempt`, the dashboard, the preview, the CSV total, the
   gradebook, the live grades, the release snapshot. `itemPoints(raw,
   counting)` still floors a bonus item when an automatic grade is written;
   a neutralized item is written as a normal one.
5. **The total** (`evaluationTotal`, and `totalPointsByEvaluation` in SQL)
   leaves out both bonus and neutralized items.
6. **After the release**: the act marks the evaluation modified after
   publication in the same transaction (`setModifiedAfterRelease`), so the
   frozen snapshot stops being served, and `results_updated` tells only the
   students whose shown grade changed — `watchReleasedGrades` before, its
   `announce` after the commit, reading the points as they stand
   (`pointsByAttempt`).
7. **The student**: a neutralized item stays on the feedback page with the
   answer, labelled "Not counted", its points struck through; a bonus keeps
   "Bonus question". A neutralized item's ungraded answers hold nothing back
   (they are not pending). It creates no drill card (ADR-041 §1). Item
   statistics are unchanged.
8. **CSV**: a neutralized item's header ends with ` (not counted)`, beside the
   ` (bonus)` rule (headers stay English, like `total`); its points are shown
   and left out of `total`.
9. **Copies**: `copyEvaluation` (duplicate, save as template, instantiate)
   and a template pull copy `neutralized` as `normal` and `bonus` as `bonus`
   (`copiedCounting`). The grading act never modifies a template.
10. **The screen**: the grading panel's question bar has a secondary ⋯ menu
    ("Count normally / Count as bonus / Do not count", the current one
    ticked, a choice that would leave no total greyed out). A choice asks
    through `useConfirm()` with the new total ("5 → 3 pts") and, once
    released, that students whose grade changes are told. A "Bonus" or "Not
    counted" badge sits beside the points badge.

## Consequences

- Correcting an incoherent question costs one menu choice instead of a
  re-grade of every copy, and stays undoable.
- Grades can move after the release without any grading write; the
  existing "modified after publication" flag and `results_updated` cover it.
- `attemptTotal` reads per-cell rows with their item's counting instead of a
  SQL `sum`, a little more data for the same number of queries.

## Alternatives considered

- **A second boolean `neutralized` beside `bonus`.** Four combinations for
  three states, one of them meaningless; the product owner chose one state.
- **Rewrite the stored gradings** (floor or zero them) when the counting
  changes. Not reversible, and it would lose what the student actually scored.
- **Remove the item.** Destroys the answers and the grading history, and is
  refused once an attempt exists (F-EVAL-03).
