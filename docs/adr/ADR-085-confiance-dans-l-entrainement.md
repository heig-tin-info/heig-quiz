# ADR-085 — Confidence in the drill: stated beside the review, never part of a score

## Status

Accepted (2026-10-08, issue #453; the product owner decided v1 in the issue's
comment of that day: drill only, asked on every card, optional, nothing
preselected). Requirement F-DRILL-07. Part 1 of the issue delivers the
control, the storage (migration `0086_drill_confidence`), the contract and
the line after the correction; part 2 the student's calibration chart and
the teacher's 2×2 in the question statistics. *Amended 2026-10-08 (product
owner, issue #453): a confident error comes back tomorrow at the latest
(§4); the rating and the FSRS state stay untouched.* *Amended 2026-10-08
(issue #453, part 2): the calibration and the 2×2, their thresholds and
where they are shown (§8) — the 2×2 in the classroom's Drill tab rather
than the pool's statistics panel.*

Scope: the column `drill_reviews.confidence`, the body of
`POST /app/api/drill/cards/:id/answer` (`DrillAnswerBody`), the pure rule
`drillConfidenceOutcome` and `drillConfidenceDue` of `@quiz/domain`, the
review written by `apps/api/src/modules/drill/review.ts`, and the drill player
(`apps/web/src/drill/DrillRun.tsx`).

Relations: extends [ADR-041](ADR-041-entrainement-espace.md) and leaves its
§4 (the rating) and §5 (the scheduler) unchanged; it is not the self-rating
ADR-041 rejected ("Alternatives considered", strategy B). Since the
amendment of 2026-10-08, §4 caps the due date of a confident error and
leaves ADR-041 §5's FSRS computation itself unchanged.

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
ADR-041 §4, the FSRS computation of §5, or any score. The same answer at the
same time on screen yields the same rating and FSRS state (stability,
difficulty, reps, lapses) with or without a confidence, and the same due
date too except for a confident error (§4, amended 2026-10-08); the database
tests hold that for a confident error on a new and on a mature card, an
error stated "Fairly sure", a lucky right answer and a "Certain" right one.

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

### 4. "Comes back sooner": a confident error is due tomorrow at the latest

*Amended 2026-10-08 (product owner, issue #453). The first version of this
section left the schedule to Again alone and kept "due tomorrow" as an open
alternative; the product owner adopted it.*

Every wrong answer is rated **Again**, FSRS's lowest rating, which gives the
card its shortest interval and counts a lapse. What Again gives, measured on
the scheduler (FSRS-5 default weights, no short-term steps): a new card
answered wrong is due the next day; a mature card (stability ≈ 270 days)
answered wrong is due in about 9 days, its stability falling to ≈ 8.6.

A **confident error** (`drillConfidenceOutcome` = `confident_error`) comes
back **the next day**: the review is written with the due date
`drillConfidenceDue(outcome, fsrsDue, now)` =
**min(FSRS's due date, `drillDayBounds(now).end`)** — the first instant of
the next calendar day on the drill's clock (Europe/Zurich), the instant from
which tomorrow's session counts the card as due (a card is due in a session
when its due date falls before that day's end, F-DRILL-03). The rule follows
the drill's own day boundaries rather than `now + 24 h`, so that an error at
23:30 and one at 08:00 both come back in the next day's session, a change
of time included.

Only `due_at` is capped. The rating stays Again and the FSRS state —
stability, difficulty, reps, lapses — stays exactly what FSRS computed; the
next review of the card starts from that state, earlier than FSRS asked. A
new card's due date only moves to the first instant of the same next day;
the cap really changes the mature cards. One side effect on FSRS, harmless:
an error at 23:30 reviewed again at 00:10 counts 0 elapsed days in
`ts-fsrs`, which treats it as a same-day review of the state it already
holds. No other outcome touches the
schedule. ADR-041 §11's bound on the client holds: a confidence still
reaches no rating and no FSRS state, and the most a student can obtain by
stating "Sure" on an error is to see that card again the next day. No
migration: the confidence was already stored.

The result screen's line ("To see again soon · next review tomorrow") reads
the due date the review returns, so it stays truthful.

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

### 8. What the statements add up to (part 2)

*Amendment 2026-10-08 (issue #453, part 2).* Two reads of
`drill_reviews.confidence`, without a migration; the pure rules are
`drillCalibration`, `drillCalibrationRate`, `drillConfidenceSplit`,
`drillConfidentErrorShare` and `drillConfidenceShown` in `@quiz/domain`
(`drillCalibration.ts`).

- **The student's calibration**, on their drill page, under the classrooms
  (`GET /app/api/drill/calibration`): for each of the five levels, the
  student's stated reviews and how many were right, every classroom pooled,
  their own rows only. A partial answer counts as an answer that is not
  right. In plain words — "When you said “Sure”, you were right 62 % of the
  time", the count beside it, a bar under it. A level with fewer than
  `DRILL_CALIBRATION_MIN_N` (**5**) answers says "not enough answers yet"
  instead of a rate: a rate over two answers teaches nothing. The section
  is not drawn before the student has stated once. It is a read with no
  action; the page's primary action stays Start.
- **The teacher's 2×2 per question**, in the classroom's **Drill tab**
  (`GET /app/api/classrooms/:id/drill/confidence`, loaded through
  `staffAccess`, invariant 6): right or wrong × sure (Sure, Certain, the
  confident-error line of §3) or unsure (No idea to Fairly sure), over the
  classroom's visible reviews (its own cards, student seats, the opt-out cut
  of ADR-041 §8); partial answers are left out. With it, the **confident
  errors among the wrong answers** — high, a misconception; low, a gap — by
  which the questions are sorted, highest first.
- **The threshold**: a question appears only when its statements come from
  at least `DRILL_CONFIDENCE_MIN_STUDENTS` (**10**, the
  `QUESTION_STATS_MIN_N` of N-DATA-06) **distinct students** behind its
  cells — counted over exactly the rows the 2×2 counts, stated and right or
  wrong, so students who gave only partial answers cannot carry another
  one's statements over the line — a cut made on the server so a smaller
  group never travels. Distinct students, not reviews: ten reviews of one
  student are that student's statements.
  Unlike the per-tag mastery (per concept since ADR-081's cut-over) (06, question 28 (l): no minimum within a
  classroom, because the per-student view shows it anyway), the teacher
  never sees an individual confidence, so a small aggregate would hand one
  back. The differencing risk of ADR-038 ("Residual risk") applies the
  same way and is accepted on the same grounds.
- **Where, and not in the pool's statistics panel**: the pool's readers
  include teachers of other classrooms (ADR-038 §5), while drill reviews are
  seen only by the staff of the classroom their card belongs to (F-DRILL-04,
  06, question 28 (j)). The 2×2 is therefore a classroom read beside the
  other drill aggregates, not a column of `GET /pools/:id/question-stats`.

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
- **Leaving a confident error to Again alone** (the first version of §4).
  The hypercorrection effect says such an error, once corrected, is
  remembered better, which argued for no change; the product owner chose on
  2026-10-08 to bring it back the next day, so that a misconception is
  checked while the correction is fresh. Part 2's data can still show
  whether confident errors relapse more than others.
- **A confident error rescheduled through FSRS** (a lower stability, an
  extra lapse). Would make confidence change the model itself; capping the
  due date alone keeps FSRS's state the one the answer earned.
- **`now + 24 h` rather than the next local day.** Simpler, but a card
  answered at 08:00 would fall in tomorrow's session only by the drill's
  "due before the day ends" rule, and the instant would not match how the
  drill counts its days.
- **Asking one card in N.** Fewer taps, but sparse data per student and a
  rule the student cannot predict; the product owner chose every card.
- **A preselected middle level.** Skews the data and makes "skipped"
  indistinguishable from "Fairly sure".
- **A 1–5 or a percentage scale.** A percentage invites false precision; the
  five words read at a glance and fit a phone on one line.
