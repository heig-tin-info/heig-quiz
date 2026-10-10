# ADR-097 — Transmitted answer and stored answer: a student exchanges choices by displayed position

## Status

Accepted (2026-10-10, security audit finding H2; the design calls of the
fix are the orchestrator's, under the product owner's standing authorization
for security fixes). No migration: configurations and stored answers keep
their shape.

Scope: how a student view names the choices of an `mcq` and the options of a
`cloze` dropdown, the conversion between what a student sends or reads and
what is stored, and the one function that decides the shuffle of an item on
the student path.

Relations: amends decisions D3 and D4 of `docs/PLAN-MVP.md` §9 (the
canonical index as the choice id), docs/spec/04 §4.1 (the contract table),
§4.4 and §4.6 (the answer), and §2 of the 2026-10-01 addendum of
[ADR-033](ADR-033-projection-de-la-correction.md) ("an answer being
canonical"). Follows [ADR-036](ADR-036-type-classement.md), whose categorize
cards already carry opaque ids. Leaves [ADR-043](ADR-043-analyse-des-distracteurs.md),
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
   canonical: `answers.payload`, `drill_reviews.answer_payload`, the grading,
   the dashboard, the debrief and the distractor analysis (ADR-043) read and
   write canonical indices exactly as before.

2. **Two optional hooks of the question-type contract convert.**
   `fromStudentAnswer(config, view, answer)` brings an answer in view
   coordinates back to canonical, and returns `null` for a position the view
   does not have; `toStudentAnswer(config, view, answer)` is its inverse.
   Absent, both are the identity. `toSolution(config, view)` names the key in
   the view's coordinates, and `studentDetails(details, policy, config, view)`
   puts what a breakdown names of the student's own answer in them (`mcq`'s
   `selected`, a `cloze` dropdown's `given`). `mcq` and `cloze` (its
   dropdowns; a typed blank is the same in both) implement the hooks.

3. **One entry and one exit, in the services.** `answerFromStudent`, beside
   `studentView` in the `live` module, is the single entry of an answer: the
   autosave (`saveAnswer`, which polls also go through), the drill's answer,
   the interactive run and simulation, the teacher preview's grading and
   simulation, and the question editor's try all convert there, before
   `answerMisfit`, `grade` or the store. A position out of range is refused
   with `422 answer_invalid`, never dropped. `answerToStudent` is the exit of
   a stored answer: the attempt and its reload, the reply to a stale save,
   the feedback page and a poll participant's own answer. Being in the
   services, the conversion holds for an impersonation session (ADR-034) and
   a teacher's own attempt in the student view (ADR-018) alike.

4. **One view of an item, from frozen data.** `attemptItemView(evaluation,
   item, attempt)` (`live/itemView.ts`) is the one place the student path
   decides an item's view: the attempt builder, the autosave and its stale
   reply, the feedback page, the run, the preview, and a partial retake's
   carried-over answers, which are re-read under the new attempt's seed
   (ADR-091). It shuffles when the evaluation's `shuffleChoices` (locked once
   an attempt exists) AND the frozen instance's `shuffleable(config)` say so,
   and never in a poll. It never reads the live `questions.shuffleable`
   column, which a write may change during an exam: a client holding the old
   view would have its positions decoded through another permutation and a
   wrong answer stored without a sound. This also keeps a student's order
   stable, as F-EVAL-09 requires. The drill derives its view the same way,
   from the served seed and instance (`serveValues`), never the template.

5. **Teacher surfaces stay canonical.** The grading panel and table, the live
   dashboard's inspection and the staff copy pass an unshuffled view, where
   position and canonical index are one; the feedback page shows the
   teacher's order once the key is published (ADR-033 addendum, §2), so its
   answer, key and breakdown are canonical there too, and the attempt's own
   coordinates while the key is hidden. A poll is unshuffled, so the
   position a phone sends is the canonical index its tally counts.

## Consequences

- The key no longer rides in the ids. What a student reads still shows the
  first-choice bias on screen wherever nothing shuffles — the evaluation's
  switch off, the question's "Never shuffle", every poll — since the editor
  still ticks the first choice of a new `mcq`. That root cause is out of the
  scope of this record and is raised with the product owner separately.
- A parameterized question converts on its instance (ADR-056): the attempt's
  stored values, the drill's `serveValues`. The drill's key hash (ADR-041 §7)
  is computed under a fixed unshuffled view, so it does not move.
- `questions.shuffleable` no longer decides anything on the student path.
  It was written once, from the EMPTY draft, at creation, so a `cloze` or a
  `categorize` question created in the editor never shuffled in an
  evaluation, against what the editor's own switches say ("Each student gets
  the cards in an order of their own"). They now shuffle when their own
  switch and the evaluation's are on.
- A tab left open across the deploy of this change holds a view whose ids are
  canonical; after it, they are read as positions. The deploy guard already
  refuses a deploy during a live evaluation; a take-home exercise it lets
  through should be reloaded by its students.
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
