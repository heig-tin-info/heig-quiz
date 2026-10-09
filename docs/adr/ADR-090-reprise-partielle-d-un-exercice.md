# ADR-090 — Partial retake of an exercise

## Status

Accepted (2026-10-09, product owner Yves Chevallier, on a student's report:
"at 7/10 I must redo all ten questions to rework the three wrong ones").
Implemented with `@quiz/domain` (`retake.ts`: `itemStanding`,
`acquiredItems`, `partialRetakeRefusal`, `retakeScopeFits`), migration
`0095_partial_retake.sql`, `apps/api/src/modules/grading/carry.ts` and
`retakeAttempt` (`apps/api/src/modules/live/attempt.ts`).

Scope: what a retake of an `exercise` asks again, and what the student is
told of each question between two attempts.

Relations: amends [ADR-025](ADR-025-plusieurs-tentatives-exercice.md) §2
(a retake is no longer always blank) and §4 (between two attempts the
student reads a per-question standing beside the score). F-EVAL-15.

## Context

ADR-025 made every retake blank: a new seed, a new order, every question
asked again. On a ten-question exercise a student at 7/10 redoes the seven
questions they already have to rework the three they missed — enough
friction that students stop retaking, which defeats the point of retakes
on a formative exercise.

Two constraints frame the answer. The kept attempt (`keptAttempt`,
`grading/kept.ts`) and everything downstream of it — results, CSV, the
release snapshot, statistics, the drill — read whole attempts and must not
change. And between two attempts the student may read the score only
(ADR-025 §4): the correction of attempt n would be the key of attempt n+1.

## Decision

### 1. A separate setting, `settings.retakes.scope`

`scope: "all" | "to_review"`, inside the retake rule, absent meaning `all`:
every stored rule parses unchanged and no data migration is needed. It is
not a third `keep` value — which attempt counts (`best`, `last`) and what a
retake asks again are independent, and both combine. Exercise only, like
retakes; frozen with the rest of the settings.

`to_review` needs `free` navigation. The acquired questions are shown
read-only between the others; under `forward_only` or `milestones` a carried
validation or checkpoint would close the questions around it. The server
refuses the pair while retakes are on (`422 retake_scope_navigation`,
`retakeScopeFits`), whichever half moved; the editor disables the choice
and says why.

### 2. Acquired, to review, awaiting correction

`itemStanding` (`@quiz/domain`) reads one question of a finished attempt:

- **acquired**: its validated points reach the item's points. A question
  worth 0 is acquired whatever its grading — nothing is won by asking it
  again. A bonus question (ADR-052) is acquired at its maximum like any
  other. Under negative marking (ADR-026) anything below the maximum is to
  review;
- **pending**: no validated grading (a hand-, model- or runner-graded
  answer nobody settled). Asked again like a question to review, but shown
  "awaiting correction", never "wrong";
- **to review**: validated, below its maximum.

The word "mastery" is not used: it belongs to F-DRILL-05.

### 3. A partial retake is a whole attempt

`POST /evaluations/:id/retake` takes a body `{ scope }` (`RetakeBody`,
default `all`, so a body-less request means what it always did). With
`to_review`, after the unchanged `retakeRefusal`, `partialRetakeRefusal`
refuses with `409 partial_retake_refused` when the teacher kept `all`
(`scope_all`) or every question is acquired (`nothing_to_review`). Under
`to_review` the student may still choose **Redo everything**, today's
blank retake.

In the same transaction as ADR-025's retake: attempt n+1 is inserted as a
whole attempt — its own number (it consumes one of the maximum), a new
seed (a new order, newly shuffled choices, new parameter values for the
questions to review), its own deadline. Each acquired item's entry of
`attempts.instances` is then overwritten by attempt n's, and its answer
payload and validated grading are copied — new ids, the grading pointing at
the copied answer, `supersedesId` null, `firstShownAt` kept, dwell 0, flag
and validation not carried. A frozen snapshot.

The copies hold validated gradings, so the hand-in pass skips them like any
settled cell (`runEvaluationGrading`: "a validated grading already stands
→ skip"). A regrade of the item (`regradeItem`) stands every standing
grading of the item down, copies included, and the following pass grades
the copied answers against the carried values like any other cell.

### 4. How a carried question is known: a column

`attempts.acquired_item_ids` (`jsonb`, default `[]`) lists the items a
partial retake carried over, written once at the creation of the attempt.
The player marks them, and every write to one — answer, skip, flag,
validation — is `409 item_acquired` (`stateTarget` and `markDone` of
`live/autosave.ts`).

Deriving it was rejected. "An answer with a validated grading on an
attempt in progress" holds today only by accident: it breaks with a
regrade or an override landing while attempt n+1 is open, and with any
future grading of an attempt in progress. Reusing `markedDone` /
`lockedItems` was rejected too: a lock is the navigation's, and a carried
milestone would close the questions before it. The column is one value
written once, read where the attempt row is already loaded, and costs no
query.

### 5. What the student reads between two attempts

While retakes are open, under `to_review`, `FeedbackPending` carries beside
`retake`:

- `retake.scope` and `retake.toReview`: how many questions of the LATEST
  finished attempt a partial retake would ask again — the "(n)" of its
  button;
- `review`: for the latest attempt only, one row per question — its id, its
  rank in the STUDENT's order, its standing. No points per item, no answer,
  no key. It travels whatever the feedback policy, `none` included, like
  the score of ADR-025 §4: enabling a partial retake is the teacher's
  consent to that word per question. `results/service.ts` (`retakeOffer`)
  is the only producer, and `partialRetake.db.test.ts` searches the
  serialized payload for the answer and key values.

The results page keeps one primary action: **Redo the questions to review
(n)**, with **Redo everything** secondary; with nothing to review, Redo
everything alone. Under `keep: "last"` the existing confirmation applies to
both. The home card's Try again opens that page instead of retaking
blind. The conditions shown to students (ADR-079) gain the line
`partial_retake`, right after the number of attempts.

## Consequences

- keptAttempt, results, CSV, the release snapshot, statistics and the drill
  are unchanged: a partial retake is a whole attempt with whole gradings.
- The live grid and the grading panel show the copies as normal cells; no
  new marking. The panel grows with every partial retake, its copies
  included (open question 23).
- A teacher's override on attempt n after the retake is not reflected in
  attempt n+1's copy: the copy is a snapshot. A regrade of the item reaches
  both.
- On a multiple-choice question a student can converge by elimination over
  partial retakes. Accepted for formative exercises; a teacher who minds
  keeps `all`.
- A question awaiting correction is asked again; if the teacher later
  validates it at full marks, attempt n+1 holds a second answer of it.
- Rollback: the column has a default and nothing reads it once the code is
  reverted; stored `scope: "to_review"` values are ignored by the old
  schema (an unknown key inside `settings.retakes` is dropped on parse).

## Alternatives considered

- **A third `keep` value** ("best of each question"): mixes which attempt
  counts with what is asked again, and would make the kept attempt a
  composite that no row holds.
- **A partial attempt holding only the questions to review**: every reader
  of whole attempts (keptAttempt, results, CSV, statistics) would have to
  merge rows.
- **Deriving the carried set** from the gradings, or reusing the
  navigation lock: see §4.
- **Re-grading the copies at hand-in**: wasteful, and a runner or model
  grading would leave a carried question pending again.
