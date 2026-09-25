# ADR-026 — Negative marking, per evaluation, with the total floored at 0

## Status

Accepted (2026-09-25, issue #130, with `@quiz/domain/mcqScore`
(`negativeMarking`), `@quiz/domain/grade` (`attemptTotal`,
`overridePointsRange`), `@quiz/domain/evaluationConfig`
(`negativeMarkingOn`, `scoresNegatively`) and the evaluation setting
`settings.negativeMarking`). No migration.

## Context

The first MCQ configuration (docs/spec/04 §4.4, v1) carried a `penalty`
factor and an `allowNegative` flag per question. The v2 configuration
replaced them with five named policies, every one floored at 0 — "a question
is never worth less than not answering it" — and forced a single-answer
question to `all_or_nothing`. The consequence, raised by a teacher in #130:
guessing is always free. `symmetric` has a zero expectation for a random
tick only before its floor; after it, a guess has a positive expectation,
and a single-answer question cannot penalise a guess at all.

The teacher wants a mode where guessing costs points, so that students leave
a question blank rather than tick at random — which is also what gives the
"I won't answer" and "Clear" actions of #89 their meaning.

## Decision

### 1. A setting of the evaluation, not a sixth policy

`settings.negativeMarking: boolean` (optional in the JSON column, absent =
off). When it is on, EVERY choice question of the evaluation is scored with
the negative rule, whatever its own policy or the evaluation's
`mcqPolicy` says, single answer included. Mixing penalised and unpenalised
questions in one sitting would leave the student guessing which is which;
one evaluation, one rule, stated once in the waiting room and on each
question.

It is structural like the rest of `settings`: frozen while the evaluation
runs and once an attempt exists (`configLock`, F-EVAL-03). A `poll` refuses
it (`422 negative_marking_not_allowed`) — a poll is tallied, not graded — and
`negativeMarkingOn` reads it as off on a poll whatever the row says.

### 2. The rule

With `C` correct choices, `W` distractors, `c` and `w` of them ticked:

    f = c/C - w/W        (W = 0: f = c/C), not floored, in [-1, 1]

For a single-answer question (C = 1, W = n - 1) this is +1 for the key and
-1/(n - 1) for a distractor; for a multiple-answer one it is `symmetric`
without its floor. No answer — nothing ticked, "I won't answer", cleared — is
0. Random guessing has an expected value of exactly 0, which
`mcqScore.test.ts` checks by enumerating every key and every selection up to
six choices. The fraction is multiplied by the item's points and rounded to
the hundredth like every grade.

It travels to the grader as `GradeContext.defaults.mcq.negativeMarking`
(`gradeDefaults`), so the grading pass, the per-attempt grading of a retake,
the immediate feedback, the teacher preview and the regrade (F-GRADE-06) all
apply it without a code path of their own. `gradings.details` records
`negativeMarking: true` beside the question's resolved policy.

### 2b. A single-answer question takes one choice

Unfloored, `c/C - w/W` would pay a crafted `single` answer holding the key
AND a distractor 1 - 1/(n - 1) — better than an honest guess. Two gates:
the answer write refuses it (`answerMisfit` of the type, `422
answer_invalid`, beside the schema check), and `mcqFraction` scores several
selections on a `single` question as a wrong answer, -1/(n - 1) under
negative marking and 0 otherwise, for a row written before the gate.

### 3. Negative points per question, a total floored at 0 in ONE function

Per-question points are stored and shown signed: the grade table, the CSV,
the release snapshot, the grading panel, the student's feedback. The total of
an attempt is `attemptTotal(points)` — the sum, rounded, floored at 0 — and it
is the ONLY way the API sums points: the grade table (and therefore the CSV,
the release snapshot, the statistics of grades), the student's feedback, the
result cards, the student home, the teacher preview, and the tallies behind
the kept attempt of a retake (ADR-025) and the score shown between attempts.
The grade is computed from that floored total. The grading panel's
running total of a student uses the same function. Outside negative marking every
item scores in [0, max] and the floor changes nothing.

For the kept attempt, the consequence is deliberate: two attempts whose sums
are -1 and -5 are both worth 0, and under `best` the tie goes to the latest,
as for any tie. What counts is what the student is credited with, not how
far below zero a sum went.

### 4. The student is told before answering

- the waiting room adds a fourth rule ("Wrong answers cost points", from
  `LobbyView.negativeMarking`);
- every choice question says it on the question itself: `toStudent` receives
  the same evaluation defaults (`StudentView.defaults`) and publishes ONE
  flag, `negativeMarking: true`, and nothing else of the scoring — the
  question's policy still never reaches a student. An exercise without a
  waiting room has only this line, which is why it is there.

### 5. Manual corrections

F-GRADE-05 overrides (and adjusted validations) take `[0, max]`, or
`[-max, max]` for a choice question of an evaluation with negative marking:
the range the rule itself can reach. The routes now enforce the range
(`422 points_out_of_range`); before, only the screen did. The panel reads the
lower bound from the same domain function (`overridePointsRange`).

### 6. The CSV writes numbers as numbers

The formula guard of the CSV prefixed any field starting with `-` with a
quote, which would have turned -1 into the text `'-1`. Numbers the export
writes itself skip the guard; names and emails keep it.

## Consequences

- Existing evaluations are unaffected: the field is absent, which reads as
  off, and no stored grading changes. No migration.
- The per-question success rate may be negative for a question under
  negative marking (the class's mean fraction). The API and the CSV carry
  the raw value; the screens (results by question, live dashboard) show it
  clamped to [0, 100 %] through `displayedRate`.
- `docs/spec/04` §4.4 is rewritten to the v2 policies and this mode; the
  v1 `penalty` / `allowNegative` are gone for good (the v1 → v2 migration of
  `packages/qt-mcq` still drops them).

### Rollback

Switching the setting off on an evaluation before anybody starts is a patch.
Removing the feature would mean ignoring the flag in `gradeDefaults`; the
stored gradings of a negative evaluation keep their signed points, and
`attemptTotal` keeps flooring them.

## Alternatives considered

- **A sixth question policy `penalized`.** Rejected: the policy is resolved
  per question, so one evaluation could mix penalised and free questions,
  and the single-answer rule (always all or nothing) would need an exception
  in the resolution anyway. The issue itself asks for a per-evaluation mode.
- **A penalty factor** (v1's `penalty`). Rejected: the zero expectation is
  the whole point, and it holds for exactly one factor per question shape;
  a free factor is a knob nobody can reason about during an exam.
- **Floor per question and not per evaluation.** That is what the five
  policies already do; it is precisely what makes guessing free.
- **Floor the total in each screen.** Rejected: the grade table, the cards
  and the kept attempt would each need to remember it, and one forgotten
  place is a student reading two different totals.
