# ADR-115 — Targeted revision by concept: extra practice on the student's own cards, outside FSRS and the level

## Status

Accepted (2026-10-15) by the product owner ([#897](https://github.com/heig-tin-info/heig-quiz/issues/897),
answers of 2026-10-15 evening, step E, items 3 to 8). Assumed, for the product owner to
change: "Another round" puts today's practised cards last (§3); a proposed narrower concept
under a validated declared one counts (§3); `time_ms` never feeds the rating reference times
(§6). Deferred: decision 7, `time_ms` feeding the question's mean answer time (§6, question 60).

Scope: a student's targeted revision of one concept of their course — what a round holds,
how it is served and answered, what it records, what it feeds, and who sees it.

Relations: amends [ADR-041](ADR-041-entrainement-espace.md) §2, §5, §6, §7, §8, §11, §12,
§14 and its Consequences (settled question 28 (b): "no extra practice in v1");
amends [ADR-098](ADR-098-maitrise-des-notions-par-l-etudiant.md) §4, §6, §10 and its
rejected #578 alternative (its exit widened to the concepts offered for revision);
amends [ADR-085](ADR-085-confiance-dans-l-entrainement.md) §1, §4 and §8 (no confidence in
a round); amends [ADR-081](ADR-081-vocabulaire-de-notions.md), sixth addendum §7 ("no
'Practise this concept' button"); amends [ADR-112](ADR-112-export-des-donnees-personnelles.md)
§3 (the Practice row) and §9 (the file's version 2). Adds F-DRILL-08 (docs/spec/02),
amends F-DRILL-03, -04 and -05, N-DATA-02, -03 and -07 (docs/spec/03) and 05 §5.7.

## Context

The drill's daily session (ADR-041 §6) hands out the due cards first, whatever the course
or concept, at most one review per card per day, and ADR-041 §11 closes every other path
to a card: no extra practice (settled question 28 (b)), so that a student cannot answer a
card again right after seeing its key and forge a rating. ADR-098 §6 refused a "Practise
this concept" button for the same reason, and to keep the level from being farmed.

Before a test, a student wants to revise one concept on purpose. The product owner keeps
the daily session as it is — it reinforces every competence — and adds targeted revision as
a separate mode (#897 step E). Three constraints shape it. Extra practice must not reach
FSRS, the level or anything read from the daily reviews, or the guarantees of ADR-041 §11
and ADR-098 §6 fall. A student may only practise what they have already met and been shown
the key of; a pool opened whole to revision is a later function. And the teacher wants to
see who revised before the test, which is a record of its own, kept like drill data.

## Decision

### 1. A separate mode, on separate routes

Targeted revision is extra practice **outside FSRS and the level**. It has its own routes
and its own tables; the daily session, its serve and answer, `servableToday` and the 404
of ADR-041 §11 stay exactly as they are, with one more exclusion (§7). Nothing of a round
is a review: it never writes a `drill_reviews` row and never writes a `drill_cards` column.

### 2. What can be revised, and by whom

- **The concepts on offer** are the VALIDATED concepts the classroom's course declares,
  labelled in the reader's language, by label: the list of the student's mastery
  (ADR-098 §1), read by one function of the drill module, `revisableConcepts`, which both
  exits share. No count is attached: whether a concept has cards is learnt by starting a
  round.
- **Revision is open** in a classroom whose drill is on, that is not archived, where the
  caller holds a student seat and has not opted out. Otherwise the list answers
  `available: false` and is empty, and starting a round is a 404. An opted-out student has
  no targeted revision.
- A concept that is not on offer — proposed, merged, undeclared, unknown — is the 404 of a
  missing one.

### 3. A round

- **At most ten of the caller's own cards** (`DRILL_REVISION_ROUND_SIZE`) of this
  classroom: the cards the drill may reach (`activeCards`: classroom on and not archived,
  student seat, not opted out, question not deleted) whose key may already reach the
  student (`keyOpen`: an exam's once released, an exercise's once its policy shows the key;
  a withdrawn release suspends them), new cards included — the questions they met in an
  exercise or an exam with "Allow drill". **Never a question they have not met, never a
  pool.** Only the cards met first in this classroom count, so a round and its record
  belong to one classroom's staff (28 (j)).
- **On the concept**: a card counts when its question carries a concept the chosen one
  covers (`coverage`: itself or any narrower one through `broader` edges, ADR-081 sixth
  addendum §10). *Assumed:* a `proposed` narrower concept under the validated declared
  one counts like any other, since coverage follows the edges whatever the status; it is
  never named to the student.
- **The order** is a pure rule, `composeRevisionRound` (`@quiz/domain`): the cards not
  practised today first, then those practised today; within each group the reviewed cards
  by retrievability now, lowest first, then the new cards by creation; the card id breaks
  every tie; cut at ten. *Assumed:* "Another round" on the same day thus brings the cards
  left out first, and fills up with the ones already practised.
- **No card**: the start answers `{ round: null }` and writes nothing.
- The round's cards and their order are fixed at its start (`card_ids`).

### 4. Passes: a wrong answer comes back once

A card answered **wrong** at its first pass comes back **once**, `DRILL_REVISION_REQUEUE_GAP`
(3) places later in the round, or at its end when fewer are left — a relearning step, as
SM-2 and Anki have. A partial answer is not requeued, nor a second pass. The rule is
`revisionQueue` (`@quiz/domain`), which replays the answers over the round's order, and
`revisionNext`, its head: the client walks the round with it, and the server ends the round
and says `requeued` with it. The server serves a
card's next pass whatever the order the client follows (pass 2 only after a wrong pass 1;
a card with no pass left is a 409 `revision_answered`): a round feeds nothing that order
could forge.

### 5. Serving and answering

- **The same code and the same exits as the daily session** (`drill/serving.ts`): the
  question through `studentViewOf` (`toStudent`, invariant 4), under the settings of the
  evaluation where the card was met first (28 (e)), on the latest published version
  (ADR-041 §7), a new seed per pass (stored with the values of a parameterized question,
  ADR-056 §5) kept on a reload; the answer graded by `gradeServed`, the daily review's own
  grading; the key after each answer through `studentSolutionViewOf`. A grading that is
  not final (an edit made the question wait for an LLM or a teacher) is the 404 of
  ADR-041 §12 and writes nothing.
- **The drill's day bounds a round**: it is served and answered only while the server's
  now is before the end of the Europe/Zurich day it started on (`drillDayBounds`), and
  only while it is not ended. It ends when nothing is left to answer, or when the student
  leaves it (`POST …/end`, idempotent); otherwise it simply lapses with the day.
- **An answer** is one transaction under the round's lock and the open pass's: re-checked,
  graded, its correctness and its time written, the round's counters raised. The result
  is the correctness, the points, the key and whether the card comes back — **no rating,
  no due date and no time**: there is no visible timer.

### 6. What a round feeds, and what it does not

- **Not fed**: FSRS (no card column is written), the level of ADR-098 (it reads the
  cards' FSRS state), `drill_reviews`, the reference times of ADR-041 §4
  (`referenceTimes`), the daily cap of new cards (`introducedToday`), the teacher's
  activity, recall rate and weekly progression, the hours heatmap, the confidence
  calibration and 2×2 (ADR-085 §8).
- **The time per question** is measured and stored on each answered pass (`time_ms`): the
  server's interval from the serve to the answer, capped at `DWELL_IDLE_CAP_MS` (10 min,
  ADR-039 §3) — a wall-clock interval, since a round has no visibility reports. No route
  returns it (ADR-039 §8). The product owner wants it to feed the question's mean answer
  time; that statistic counts exam answers only today (ADR-039 §6), so adding rounds to it
  is a later change, under its own amendment: the product owner chooses between merging
  the rounds' times into the exam series and a separate series (open question 60); until
  then they are stored and fed to nothing. *Assumed:* it never feeds the drill's rating
  reference times — an answer given right after seeing the key would skew every student's
  ratings.
- **No confidence and no device class** are sent or stored: the answer's contract is
  strict and refuses both (400). A screen that asks the confidence keeps it in the browser.

### 7. The daily session holds back what a round served today

A card **served in a round today** (the drill's day) is not servable by the daily session
today: `servableToday` itself refuses it, not only the list the session is composed from,
so the key seen in a round can never forge a daily rating, and the daily serve and answer
are the 404 of ADR-041 §11. It comes back from the next day as FSRS schedules it.
**Accepted bias**: its next daily review, from tomorrow, may follow a key seen the day
before, and rate a little higher than recall alone would; the daily session stays at one
review per card per day.

### 8. What is stored

Two tables of the `drill` module (`apps/api/src/db/drill.ts`):

- `drill_revision_rounds`: `user_id` (NO ACTION, like the cards'), `classroom_id`
  (cascade), `concept_id` (nullable, set null when the concept is deleted),
  `card_ids uuid[]` (1 to 10), `started_at`, `ended_at`, `cards_served` (distinct cards
  answered at their first pass) and `cards_correct` (of them, right at their first pass),
  with checks on the cardinality, `cards_correct ≤ cards_served ≤ cardinality` and
  `ended_at ≥ started_at`.
- `drill_revision_answers`: one row per pass of a card (`round_id` cascade, `card_id`
  cascade with the card, `pass` 1 or 2, unique per round, card and pass): `served_at`,
  `serve_seed`, `serve_values`, then `answered_at`, `correctness` and `time_ms`, the three
  null together until the answer. **No answer payload.**

The counters grow by each answer, so a card the teacher removes later (its passes cascade)
leaves them as they were. **Retention**: five years from the round's start (N-DATA-03),
purged by `drill.purge` with its answers; deleting the classroom deletes its rounds.

### 9. Who sees what

- **The student** reads their own rounds of a classroom with a card answered, newest first
  (`GET …/revision/rounds`): concept, start, end, the two counters. A round names its
  concept only while, a merge followed to its winner, it is still one of the concepts on
  offer; otherwise `null`.
- **The teacher** — the course's staff, through `staffAccess` on the classroom
  (`GET /classrooms/:id/drill/revision`) — sees who revised before the test: the rounds
  with a card answered of the classroom's current student seats, none started after an
  opt-out (the cut of ADR-041 §8); **per student the number of rounds, the date of the
  last one, the distinct concepts, and the cards served and the cards right** (the totals
  of the rounds' two counters, the "cards served, cards correct" of the product owner's
  answer 6); per concept the students, the rounds and the last one. Labels are the staff's
  (a proposed concept named, a merged one under its winner); a round whose concept was
  deleted counts for its student under no concept. **Never a card, a question, an answer
  or a time.**
- **The student is told**: the drill tab says that the teacher sees the rounds, and the
  "Data and privacy" page has the row (N-DATA-07).
- **No audit action**: a round is a student's own practice, like the daily reviews.

### 10. Routes and access

Student, `requireSession`, portal and impersonation sessions; a `seb` or `kiosk` session
is refused (401) by the session layer's default; an impersonation session reads, and
writes nothing outside development (ADR-034 §4):

- `GET /app/api/student/classrooms/:id/revision/concepts` and `GET …/revision/rounds`,
  loaded through `readableClassroom` with the student payload forced (a teacher in the
  student view reads their staff seat: nothing on offer; an impersonation reads the
  student's);
- `POST /app/api/student/classrooms/:id/revision/rounds` `{ conceptId }` (strict), the
  same loader, then the open-revision check;
- `POST /app/api/student/revision/rounds/:id/serve/:cardId`,
  `POST /app/api/student/revision/rounds/:id/cards/:cardId/answer` `{ answer, coordinates? }`
  (strict) and `POST /app/api/student/revision/rounds/:id/end`: a round is reached by its
  owner only, and a card only while active, open and in the round; anything else is the
  404 of a missing one (invariant 6).

Every body and parameter is a schema of `packages/contracts` (section "Targeted revision
(ADR-115)" of `drill.ts`).

### 11. The exits

Question content leaves only through `toStudent` and `studentSolutionView`, as in the
daily session. Concept labels leave only through the drill module's student view: the
exit of ADR-098 is widened to "the concepts it offers for targeted revision", which are
the same list (CLAUDE.md, invariant 4; 05 §5.7). The leak test is
`drill/revision.db.test.ts`.

### 12. The export

`PersonalDataClassroom` gains `revisionRounds` (the student's own rounds, as the student
reads them, archived classrooms included); the file's `version` becomes 2 (ADR-112 §9);
the six counts of `privacy.export` are unchanged.

### 13. Where it is offered

A secondary "Revise a concept" in the classroom's Concepts section of the drill page opens
its own screen, whose one primary action is Start; the empty day of the daily session is
unchanged; the "Allow drill" note mentions that students may also revise these questions
by concept. The screen says that a round feeds neither the schedule nor the level, and
that the teacher sees the rounds.

## Consequences

- Settled question 28 (b) is amended: extra practice exists, as targeted revision, on its
  own routes and outside every computation the daily reviews feed; the whole-pool drill of
  28 (f) stays out.
- The serving code of the daily session moves to `drill/serving.ts`, shared by both
  modes, so a round reaches a question through exactly the daily serve's checks and
  exits.
- One more leak surface (concept labels and question content on new routes), held by the
  shared exits and the leak test.
- A student before a test on new material may hold few cards: a round can be short or
  null, by design.
- `time_ms` is stored now and read by nothing until the question statistics are amended.
- The next-day bias of §7 is accepted.

## Alternatives considered

- **A focus of the daily session** (today's session restricted to one concept). Rejected:
  the daily session must keep reinforcing every competence, and a focus would change what
  FSRS schedules each day.
- **Feeding FSRS with the rounds.** Rejected: an answer given minutes after seeing the key
  would inflate the stability and the level, the farming ADR-098 §6 refused.
- **A mode flag on the daily routes.** Rejected: the daily serve and answer would carry
  two rule sets behind one 404, and a client could reach a review through the flag; separate
  routes keep the daily path as it is.
- **Storing rounds in `drill_reviews`.** Rejected: every reader of the reviews (reference
  times, recall, activity, hours, calibration, re-optimisation) would have to filter them
  out, and one forgotten filter would let extra practice into a schedule or a statistic.
- **No record at all.** Rejected by the product owner: the teacher wants to see who
  revised before the test, and the time per question is wanted later.
