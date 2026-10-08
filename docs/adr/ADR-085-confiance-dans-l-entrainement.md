# ADR-085 — Confidence in the drill: stated beside the review, never part of a score

## Status

Accepted (2026-10-08, issue #453; the product owner decided v1 in the issue's
comment of that day: drill only, asked on every card, optional, nothing
preselected). Requirement F-DRILL-07. Part 1 of the issue delivers the
control, the storage (migration `0086_drill_confidence`), the contract and
the line after the correction; part 2 the student's calibration chart and
the teacher's 2×2 in the question statistics.

Scope: the column `drill_reviews.confidence`, the body of
`POST /app/api/drill/cards/:id/answer` (`DrillAnswerBody`), the pure rule
`drillConfidenceOutcome` of `@quiz/domain`, and the drill player
(`apps/web/src/drill/DrillRun.tsx`).

Relations: extends [ADR-041](ADR-041-entrainement-espace.md) and leaves its
§4 (the rating) and §5 (the scheduler) unchanged; it is not the self-rating
ADR-041 rejected ("Alternatives considered", strategy B).

## Context

A student who says how sure they are before seeing the correction learns to
tell what they know from what they think they know (calibration). An error
made with high confidence and then corrected is remembered better than one
made with low confidence (the hypercorrection effect, Butterfield & Metcalfe,
2001): the moment of correction is when the statement counts. For the
teacher, a wrong answer given "with certainty" points to a misconception, one
given "without knowing" to a gap.

ADR-041 rejected strategy B — the student rating their own recall to drive
FSRS — as one more tap per card and easily gamed. Confidence must not
reintroduce it by the back door.

## Decision

### 1. The scale, and where it is asked

Five levels, 0 to 4: **No idea, Unsure, Fairly sure, Sure, Certain**. The
scale has no negative side and no middle "meh". In v1 it is asked **in the
drill only, on every card**, under the answer and before the correction;
**optional**, with **nothing selected** (a default would skew the data). An
`exam`, a graded `exercise` and a poll never ask it: in an assessment,
confidence becomes strategy and stress. Ungraded exercises may come later
(issue #453).

### 2. Beside the rating, never in it

The confidence is sent with the drill answer and stored on the review row,
`drill_reviews.confidence smallint null` (0–4, a check constraint; null when
the student skipped it). It is **never read** by the grading, the rating of
ADR-041 §4, the FSRS schedule of §5, or any score. The same answer at the
same time on screen yields the same rating, due date and FSRS state with or
without a confidence; the database tests hold that for a confident error and
for a lucky right answer.

### 3. What a statement says about a review

One pure rule, `drillConfidenceOutcome(correctness, confidence)` in
`@quiz/domain`:

| Correctness | Confidence | Outcome | After the correction |
|---|---|---|---|
| wrong | Sure or Certain (≥ 3) | `confident_error` | highlighted: "You were sure: look closely" |
| right | No idea (0) | `lucky` | "right this time, counted as luck"; never upgraded |
| any other stated | | `calibrated` | "You said: …" |
| — | skipped | `unstated` | nothing |

A partial answer is neither an error nor a success: it is never a confident
error nor lucky. The outcome is what part 2's calibration chart and 2×2
read; it is computed, never stored.

### 4. "Comes back sooner": Again already covers it

The issue asked that a confident error come back sooner. Every wrong answer
is already rated **Again**, FSRS's lowest rating, which gives the card its
shortest interval and counts a lapse. Confidence therefore changes **nothing
in the schedule**: FSRS stays untouched, and so does ADR-041 §11's bound on
what the client can influence (a confidence is one more client input, and it
reaches no rating).

What Again gives, measured on the scheduler (FSRS-5 default weights, no
short-term steps): a new card answered wrong is due the next day; a mature
card (stability ≈ 270 days) answered wrong is due in about 9 days, its
stability falling to ≈ 8.6. A rule "a confident error is due tomorrow,
whatever Again says" would move only the due date of mature cards; it is
not adopted (see the alternatives) and can be added later without a
migration, since every confidence is kept.

### 5. Right with no idea

A right answer stated "No idea" keeps the rating the time gives it (ADR-041
§4): it is never upgraded to Easy, nor downgraded. It is shown as luck after
the correction and counted as such by part 2.

### 6. The control

A segmented control (`Segmented`, the product's one) of five pills under the
answer card, captioned "How sure are you? (optional)"; the digits `0` to `4`
pick a level, the same digit again clears it, and a digit typed in a text
field of the answer belongs to the answer. It is secondary in every way: no
accent, and the screen's one primary action stays Check (or "Show the
answer"). After the correction, one line says the statement back; a
confident error is a `warning` alert above the key, so it is read before
the key.

### 7. Privacy

Individual confidence is drill data like a review (ADR-041 §8, five years,
the classroom's staff). Part 2's teacher view aggregates it per question
over the classroom; no individual confidence appears in a table the class
could see.

## Consequences

- One nullable column and its check; no backfill: earlier reviews are
  `unstated`.
- The drill answer body gains an optional field; an older client that omits
  it still works.
- Part 2 reads `drill_reviews.confidence` through `drillConfidenceOutcome`,
  without a new migration.
- A student who taps at random adds noise to their own chart and to the
  class's 2×2, nothing else: nothing they state reaches a schedule or a
  score.

## Alternatives considered

- **Confidence drives FSRS (strategy B, or a forced Again / Easy).** Rejected
  by ADR-041 as gameable; a lucky right answer upgraded to Easy, or a
  "Certain" that shortened intervals, would hand the schedule to the student.
- **A confident error due tomorrow** (§4). Pedagogically arguable — the
  hypercorrection effect says such an error, once corrected, is remembered
  better, not worse — and it would make confidence change the schedule.
  Left for a later decision on data: the stored confidences let part 2 show
  whether confident errors relapse more than others.
- **Asking one card in N.** Fewer taps, but sparse data per student and a
  rule the student cannot predict; the product owner chose every card.
- **A preselected middle level.** Skews the data and makes "skipped"
  indistinguishable from "Fairly sure".
- **A 1–5 or a percentage scale.** A percentage invites false precision; the
  five words read at a glance and fit a phone on one line.
