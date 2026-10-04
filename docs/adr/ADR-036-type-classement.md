# ADR-036 — Categorize: a new question type, sorting cards into columns

## Status

Accepted (2026-09-29, with `packages/qt-categorize`, `@quiz/domain/categorizeScore`
and the evaluation setting `settings.categorizePolicy`). No migration.

Extended by [ADR-041](ADR-041-entrainement-espace.md): `categorize` participates in the drill.
The absence of a drill rating in this record describes the earlier version.

## Context

The specification (docs/spec/04) lists no type where the student SORTS:
puts `int`, `double` and `char *` under "integer", "floating point" and
"pointer"; files the steps of a compilation in order; separates what is
undefined behaviour from what is merely unspecified. Teachers write these as
a string of multiple-choice questions today, one per item, which is long to
author, long to answer, and hides the structure the exercise is about.
Moodle's "drag and drop into text" and "matching" types are the usual
workaround; neither fits a board of columns.

The type was mocked up first (`mockups/categorize.html`): columns side by
side, a tray of the cards not placed yet, cards dragged or clicked into place,
optional distractors that belong nowhere, and an option where the order
inside a column counts. The questions its author settled before the code are
recorded here. The type is brought forward outside the phases of
docs/spec/00, like `circuit` (ADR-019) and `codeimage` (ADR-021).

## Decision

### 1. One package, one config, the key inside the columns

`packages/qt-categorize` (`./server`, `./client`), registered in both
registries, shown as "Categorize" / « Classement ». The id `categorize` is the
one stored in the database and in the canonical format.

```yaml
config:
  configVersion: 1
  prompt: markdown
  columns:                     # 2 to 6
    - { id: q7m2xk4a, label: "Entier", cards: [f3n8wz1c, j2r5hd7s] }   # the KEY, in order
    - { id: c9t1vp6z, label: "Virgule flottante", cards: [a4k7mq2x] }
  cards:                       # 1 to 30
    - { id: f3n8wz1c, text: "`int`" }
    - { id: e2z5oa7r, text: "`string`" }   # listed by no column: a distractor
  ordered: false               # the rank inside a column counts too
  shuffleCards: true
  shuffleColumns: false
  policy: inherit              # inherit | per_item | all_or_nothing
```

- **The key lives in the columns**: each column lists the ids of the cards
  that belong in it, in the expected order. A card listed by no column is a
  **distractor**, which the student is expected to leave in the tray.
- **One card, one column.** A card may be listed by one column at most; the
  schema refuses a card twice (`categorize.card_twice`), an unknown card
  (`categorize.unknown_card`), a duplicate id and a question with no target
  at all (`categorize.no_target`). The same rule holds for an answer:
  `answerMisfit` refuses a card placed twice or an unknown id (`422
  answer_invalid`) — a card in every column at once would be a free bet.
- **Every id is opaque** and matches `/^[a-z0-9]{4,40}$/`: the editor mints
  eight random base-36 characters, never an index nor a label. The student's
  view carries the card and column ids (the answer is written with them), so
  an id must say nothing about where a card goes. The schema can enforce the
  alphabet and the length, not the meaning: an author who writes ids by hand
  (through the MCP server or an import) is responsible for their opacity — a
  readable id such as `int-entier` would reach the student through
  `toStudent`, and the MCP guide says so.
- **Limits**: 2 to 6 columns (one column is not a choice; six fit a laptop),
  1 to 30 cards (past that the tray no longer fits a screen).

### 2. Scoring: two policies, and the evaluation decides like `mcq`

The formulas live in `@quiz/domain/categorizeScore`, the reference. With `T`
targets, `D` distractors, `k` columns, and in one answer `t` targets at their
place, `x` targets placed at a wrong place, `p` distractors placed:

| Policy | Fraction |
|---|---|
| `per_item` (default) | (t + D − p) / (T + D) — every card is worth 1/n, a distractor left out counts |
| `all_or_nothing` | 1 if t = T and p = 0, otherwise 0 |

- **An empty answer scores 0**, whatever the policy. The tray is where an
  unplaced card stays, so doing nothing leaves every distractor "right" and
  `per_item` would pay D/n for it. Distractors count only once a card is
  placed.
- **The names are not `mcq`'s.** `per_item` is close to `mcq`'s
  `true_false`, and the negative rule below resembles `symmetric`; reusing
  either name would promise the `mcq` formula, which differs. Two names of
  their own, two formulas of their own.
- **`inherit` and an evaluation-level policy, like `mcq`.** A question that
  says `inherit` (the default) is scored with the evaluation's
  `settings.categorizePolicy`, set under the advanced options of the
  evaluation (and of a template, ADR-031, since templates carry the whole
  settings object). It is stored in the `settings` JSON column, optional,
  absent = `per_item`, read through `categorizePolicyOf` — not a column
  beside `mcq_policy`, so it needed no migration. The wire enum
  `CategorizePolicy` of `@quiz/contracts` is spelled again (contracts depends
  on no package) and `apps/api` checks it equal to
  `CATEGORIZE_SCORE_POLICIES`, both ways, at compile time
  (`modules/pool/routes.ts`), like `McqPolicy`. It reaches the grader as
  `GradeContext.defaults.categorize` (`gradeDefaults`). Without an
  evaluation (the teacher's Try panel), `per_item`.
- **Why `settings` and not a column like `mcq_policy`.** `mcqPolicy` is a
  column because it is seeded at creation from a per-teacher preference
  (`users.mcq_policy`) and was written before the settings object carried
  scoring switches. `categorizePolicy` has a natural default and no
  preference yet, so an optional key in the `settings` JSON column costs no
  migration, travels with templates and duplicates for free, and is frozen
  with the rest of `settings` (`configLock`). It is the model for the next
  type that needs a per-evaluation setting: an optional key in `settings`,
  a `…Of` reader with the default, and an entry in `gradeDefaults`.
- **The row is shown only when it matters.** The "Categorize scoring" row of
  the advanced options appears only while the evaluation (or the template)
  holds a `categorize` item — the item list is already on the screen, so the
  test is one line. docs/spec/08 keeps what a teacher does not need out of
  sight, and most evaluations hold no categorize question. The `mcq` row stays
  always shown: multiple choice is in nearly every evaluation, and hiding it
  is a separate decision. While negative marking is on, both policy rows say
  it replaces them.

### 3. "The order counts" means the exact rank, cascade accepted

With `ordered: true`, a target is right only in its column AND at its exact
rank. A card missing near the top of a column therefore shifts every card
under it, and all of them become wrong. A longest-common-subsequence or
pairwise-inversion score would be kinder, but it is a rule a student cannot
check by looking at the board; the exact rank is. The cascade is accepted on
purpose, and the player says the order counts before the student answers
(`ordered` is published).

### 4. Negative marking extends to `categorize`

ADR-026 made negative marking a setting of the evaluation that applies to
"every choice question". Placing a card is a choice among `k` columns, so
the setting now covers `categorize` too (`NEGATIVE_MARKING_TYPES` in
`@quiz/domain/evaluationConfig`), and it overrides the policy as it does for
`mcq`:

    f = (t − (x + p) / (k − 1)) / T,   not floored, in [−1, 1]

A target is +1 in its column and −1/(k − 1) in another one, so placing a
target at random has an expected value of 0 (without the order). A card left
in the tray is 0, target or distractor: no answer costs nothing. The total is
floored at 0 by `attemptTotal`, a manual correction may go down to −max
(`overridePointsRange`), the student is told in the waiting room and on the
question (`toStudent` publishes `negativeMarking: true` and nothing else of
the scoring). The waiting room and the setting's description now name both
types.

### 5. What the student gets

`toStudent` keeps the prompt, the columns WITHOUT their `cards` (the key),
every card (distractors included — which ones are distractors is the key
too), `ordered`, and the negative-marking flag. The policy never leaves. The
cards, and the columns when `shuffleColumns` is on, are shuffled per student
from `(attempt.seed, item.id, purpose)` on two streams (decision D19); the
column shuffle is off by default because the order of the columns often
means something ("before / after").

The board (editor and player alike) moves a card two ways: drag and drop
(pointer, or the keyboard: Space, arrows, Space) and click-then-click
(select a card, then a column or the tray), which is what works on a phone
and with a screen reader. The editor writes the key on the same board the
student answers on: a card left in the tray is a distractor.

When the key is not published, `studentDetails` drops each card's
`expected` and `expectedRank`, and the counts `T` and `D`: which cards are
distractors, or how many there are, is the key. The verdict (`right`) of a
card the student PLACED stays — it is feedback on their own answer, like
`cloze`'s per-blank verdict; a card left in the tray carries no verdict, since
"right to leave out" would name a distractor. Dropping `T` and `D` is
defence in depth, not a secret kept: under `per_item` the published
`fraction`, `t` and `p` still let a determined student compute `D`. What is
protected is WHICH cards are distractors, never how many. The dashboard cell is "placed/total",
figures only. The type is not pollable, and has no drill rating nor
`aggregate`.

## Consequences

- One more type in both registries, the leak test and the MCP guide; one
  optional key in the evaluation settings. Existing evaluations read
  `per_item` and are otherwise unchanged; no stored grading moves.
- The negative-marking wording changed in the evaluation's advanced options,
  the waiting room and the help page: "multiple-choice and categorize
  questions" instead of "choice questions".
- No per-teacher preference seeds `categorizePolicy` at creation, unlike
  `mcqPolicy` (`users.mcq_policy`): every evaluation starts at `per_item`. A
  preference would be a column on `users` and a row on the settings page; it
  is left as a possible follow-up if teachers ask for it.

### Rollback

Unregistering the type hides it from new questions; stored questions of the
type would then fail to load, so a rollback deletes or converts them first.
The settings key is inert without the type.

## Alternatives considered

- **A `matching` type (one card, one slot).** A special case of this one
  (one card per column); the board generalises it without a second editor.
- **Reusing the `mcq` policy names.** Rejected above: same names, different
  formulas.
- **The key as a map card → column.** Equivalent, but it cannot express the
  order inside a column without a second field; the list per column carries
  both.
- **A partial-credit order score** (longest common subsequence, inversions).
  Rejected in §3: kinder, but not checkable by the student.
- **Letting an empty answer earn the distractors.** Rejected in §2: it pays
  for doing nothing.
- **A column `categorize_policy` on `evaluations`.** Needs a migration for a
  value that has a natural default; the settings JSON already carries
  `negativeMarking` the same way.
