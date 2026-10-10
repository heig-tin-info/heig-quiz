# ADR-097 — Transmitted answer and stored answer: a student exchanges choices by displayed position

## Status

Accepted (2026-10-10, security audit finding H2; the design calls of the
fix are the orchestrator's, under the product owner's standing authorization
for security fixes). No migration: configurations and stored answers keep
their shape.

Scope: how a student view names the choices of an `mcq` and the options of a
`cloze` dropdown, the conversion between what a student sends or reads and
what is stored, the marker that tells the two apart, and the one function
that decides the shuffle of an item on the student path.

Relations: amends decisions D3 and D4 of `docs/PLAN-MVP.md` §9 (the
canonical index as the choice id), docs/spec/04 §4.1 (the contract table),
§4.4 and §4.6 (the answer), and §2 of the 2026-10-01 addendum of
[ADR-033](ADR-033-projection-de-la-correction.md) ("an answer being
canonical"). Extends [ADR-026](ADR-026-points-negatifs-par-evaluation.md)'s
refusal of a crafted `mcq` answer to `maxSelections`. Follows
[ADR-036](ADR-036-type-classement.md), whose categorize cards already carry
opaque ids. Leaves [ADR-043](ADR-043-analyse-des-distracteurs.md),
[ADR-041](ADR-041-entrainement-espace.md) §7 (the key hash) and
[ADR-056](ADR-056-questions-parametrees.md) unchanged.

## Context

Decision D3 shuffled the ORDER of an `mcq`'s choices and kept each choice's
canonical index as its `id`, on the grounds that "indices reveal nothing".
They do: the editor creates every `mcq` with its first choice ticked
(`emptyMcqDraft`), so in most single-answer questions the canonical index 0
is the key, and any student reading `GET /attempts/:id` in the browser's
network tab reads it off the shuffled list. The five `mcq` of the demo seed
all have their key at index 0. A `cloze` dropdown (D4) had the same defect,
without the default bias. ADR-033's addendum named the bias of the teacher's
order; the leak test (forbidden keys, the key's values in the serialized
view) cannot see a key that rides in an order.

## Decision

1. **The id of a choice is its displayed position.** `toStudent` names an
   `mcq` choice and a `cloze` dropdown option by its position in the
   student's view, `0..n-1`, never by its canonical index. Storage stays
   canonical: `answers.payload` (an `mcq`'s ascending and unique),
   `drill_reviews.answer_payload`, the grading, the dashboard, the debrief
   and the distractor analysis (ADR-043) read and write canonical indices
   exactly as before.

2. **Two optional hooks of the question-type contract convert.**
   `fromStudentAnswer(config, view, answer)` brings an answer in view
   coordinates back to canonical, and returns `null` for a position the view
   does not have; `toStudentAnswer(config, view, answer)` is its inverse.
   Absent, both are the identity. `toSolution(config, view)` names the key in
   the view's coordinates. A grading breakdown names the student's own
   choices by canonical index (`mcq`'s `selected`, a `cloze` blank's
   `given`): `studentDetails` drops them with the key, and the review reads
   the answer itself. `mcq` and `cloze` (its dropdowns; a typed blank is the
   same in both) implement the hooks.

3. **One entry and one exit, in the services.**
   `answerFromStudent(type, config, view, raw, coordinates)`, beside
   `studentView` in the `live` module, is the single entry of an answer: it
   parses the type's `answerSchema`, checks the marker (point 4) and
   converts, so no caller can read an answer without converting it. The
   autosave (`saveAnswer`, which polls also go through), the drill's answer,
   the interactive run and simulation, the teacher preview's grading and
   simulation, and the question editor's try all enter there, before
   `answerMisfit`, `grade` or the store. A position out of range is refused
   with `422 answer_invalid`, never dropped. `answerToStudent` is the exit of
   a stored answer: the attempt and its reload, the reply to a stale save,
   the feedback page and a poll participant's own answer. Being in the
   services, the conversion holds for an impersonation session (ADR-034) and
   a teacher's own attempt in the student view (ADR-018) alike.

4. **A marker tells a current client from an old one.** Every answer write
   of a current client carries `coordinates: "position"`
   (`AnswerCoordinates`, `@quiz/contracts`): the autosave, the drill's
   answer, the Simulate button, the preview's grading and simulation, the
   editor's try. A client built before this decision sends none and names
   choices by canonical index. On a view that shuffles a type that converts,
   a write without the marker is refused with `422 answer_invalid`
   (`answer.coordinates_missing`); a poll and an unshuffled item accept
   either, since the two readings agree there. The marker says nothing about
   the order, and is never derived from it. A tab left open across the deploy
   — a take-home exercise, a served drill card, whose unacknowledged answers
   the autosave replays on reconnection before it refetches the view —
   retries with backoff and shows "not saved" until the student reloads; it
   never stores a wrong tick.

5. **One view of an item.** `attemptItemView(evaluation, item, attempt)`
   (`live/itemView.ts`) is the one place the evaluation path decides an
   item's view: the attempt builder, the autosave and its stale reply, the
   feedback page, the run, the preview, a poll participant's own answer, and
   a partial retake's carried-over answers, which are re-read under the new
   attempt's seed (ADR-091). It shuffles when the evaluation's
   `shuffleChoices` (locked once an attempt exists) AND the item instance's
   `shuffleable(config)` say so, and never in a poll. It never reads the live
   `questions.shuffleable` column, which a write could change during an exam:
   a client holding the old view would have its positions decoded through
   another permutation and a wrong answer stored without a sound. This also
   keeps a student's order stable, as F-EVAL-09 requires.

   Two limits remain. A regrade onto another version (F-GRADE-06,
   `retargetItemVersion`) can change an item's choices or its shuffle switch
   while attempts are still open; the stored answers stay right, being
   canonical, but an open tab would decode against the new version — making
   that write refuse open attempts, or freeze the version per attempt, is a
   follow-up. The drill serves a card on the latest published version
   (ADR-041) and answers it on the version published then, so a publication
   between the two can shift its positions — practice only, and the review
   is graded on what was answered.

6. **Teacher surfaces stay canonical.** The grading panel and table, the live
   dashboard's inspection and the staff copy pass an unshuffled view, where
   position and canonical index are one; the feedback page shows the
   teacher's order once the key is published (ADR-033 addendum, §2), so its
   answer, key and breakdown are canonical there too, and the attempt's own
   coordinates while the key is hidden. A poll is unshuffled, so the
   position a phone sends is the canonical index its tally counts.

7. **An `mcq` answer longer than `maxSelections` is refused**
   (`mcq.too_many_choices`), as ADR-026 refuses two ticks on a `single`
   question. The grader truncates such an answer to its LOWEST canonical
   indices, the teacher's first-typed choices: with position ids, ticking
   every position would let the truncation pick the key. The truncation stays
   in the grader for an answer stored before this rule.

## Consequences

- The key no longer rides in the ids. What a student reads still shows the
  first-choice bias on screen wherever nothing shuffles — the evaluation's
  switch off, the question's "Never shuffle", every poll — since the editor
  still ticks the first choice of a new `mcq`. That root cause is out of the
  scope of this record and is raised with the product owner separately.
- A parameterized question converts on its instance (ADR-056): the attempt's
  stored values, the drill's `serveValues`. The drill's key hash (ADR-041 §7)
  is computed under a fixed unshuffled view, so it does not move.
- `questions.shuffleable` no longer decides anything. It was written once,
  from the EMPTY draft, at creation, so a `cloze` or a `categorize` question
  created in the editor never shuffled in an evaluation, against what the
  editor's own switches say ("Each student gets the cards in an order of
  their own"). They now shuffle when their own switch and the evaluation's
  are on. The field leaves `PATCH /questions/:id` and `QuestionMeta`; the
  column stays until a migration removes it, a tracked follow-up.
- Every new type whose student view names parts by position implements both
  hooks and lists canonical answers in its leak fixture (`answers` of
  `StudentLeakFixture`): the registry's contract test round-trips them in
  every view.

## Alternatives considered

1. **Opaque ids in the configuration** (as ADR-036 did for categorize): a
   config v3 for `mcq` and `cloze`, a migration of every stored answer, and
   changes to D3, the distractor analysis (ADR-043), the canonical format and
   the MCP guide, for the same protection.
2. **Ids derived from the seed, independent of the display**: the teacher's
   views, the poll and the debrief would have to convert as well, and nothing
   would be gained over the position, which the student sees anyway.
3. **Converting in the routes**: an impersonation session, a teacher's own
   attempt and the preview would each need their own conversion; the
   services are the one place every caller passes.
4. **A build id instead of the marker**: no build id, version endpoint or
   service worker exists to compare against, and a constant field in the
   write is enough to tell the two readings apart.
