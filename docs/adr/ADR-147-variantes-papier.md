# ADR-147 — Paper variants: one stored draw of the whole paper, parameterized questions printed

## Status

Accepted (2026-11-26, the product owner's decisions 1 to 8, which reverse
ADR-125 §5's refusal of a parameterized question on paper, and the
anonymity limit under Consequences). Its first step
delivers variant 1 only; the rest is under "Not in this record's first step".

Scope: what a printed paper of an evaluation is drawn from — the hand-out,
the staff statement with key, the student's blank print of a past series,
the paper attempt typed in from it — and where that draw is stored.

Relations: amends [ADR-125](ADR-125-copies-papier-pdf-typst.md) §5 (the
`parameterized` refusal disappears), §8 (the paper's seed moves into variant
1; the statement with key of a printed evaluation follows the paper's order)
§9 (a paper attempt carries the variant's values) and §17 (those values
tell a paper copy apart on the anonymised table: an accepted limit), and
[ADR-121](ADR-121-fabrique-d-exports.md) §8 step 3 (a parameterized question
is no longer refused). Depends on [ADR-056](ADR-056-questions-parametrees.md)
§4, §5, §7 and §9 (a variant is a third place drawn values are stored, beside
`attempts.instances` and the drill), D19 and
[ADR-097](ADR-097-reponse-transmise-et-reponse-stockee.md). F-EXP-04,
F-PAPER-01, F-PAPER-05, F-QST-10 ([02](../spec/02-exigences-fonctionnelles.md)).

## Context

The Export sheet refused both the hand-out and the statement with key of an
evaluation holding a parameterized question: "a copy has no draw" (ADR-125
§5). A digital attempt draws its values from its seed when it is created and
stores them (ADR-056 §5); a printed paper had a seed (`evaluations.paper_seed`,
ADR-125 §8) for its order and shuffles, but nothing stored its values, so
every print, every key and every paper attempt would have had to draw them
again and hope the evaluator, the draw order and the retry cap never moved.
The owner wants parameterized evaluations on paper, and later several
different papers in one room, so that neighbours do not share their numbers.

## Decision

1. **A paper variant.** The word is *variant*, never *version* (a question has
   versions) nor *instance* (an evaluation made from a template, ADR-031). A
   variant is ONE draw of the whole evaluation: the item order, the choice
   order and the drawn values of every parameterized item, from one seed. Its
   seed stays the secret ADR-125 §8 made of the paper seed: never printed,
   never sent to a client, never in a record, a log, the zone manifest or a
   copy of the evaluation. What a later step shows is the variant's number,
   never its seed.

2. **Storage.** A table `paper_variants`, owned by the `evaluation` module
   (which owned `paper_seed`) and written by one function of its service,
   `paperVariant`; the `paper` and `live` modules only receive what it
   returns. Columns: the evaluation (cascade), `number` (from 1, the primary
   key with the evaluation), `seed` (the range of an attempt's seed, from the
   CSPRNG), `instances` (item id → `StoredInstance`, the shape of
   `attempts.instances`, its `fallback` included), and timestamps. Migration
   `0163_paper_variants` copies every non-null `evaluations.paper_seed` into
   variant 1 with no values (a parameterized evaluation did not print
   before). **Expand, then contract**: the column stays in this step and the
   code reads and writes it only where variant 1 is created, in one
   statement: the seed is a value found there — one an older server wrote
   during the deploy — else a new one, which is written back where the
   column is null, so the previous image still prints the same order after
   a rollback ([deployment](../development/deployment.md) §5). The contract
   migration removes three things together: the column, that write-back and
   that `coalesce` read.

3. **What a variant freezes: the values only.** The item and choice orders
   are recomputed from the seed (D19, ADR-097), never stored. At each print
   and each paper entry, the values a parameterized item lacks are drawn from
   the variant's seed by the stream of an attempt's (`streamSeed(seed,
   itemId, "vars")`) and stored. One draw rule serves a new attempt and a
   variant, `completeInstances` (`pool/instance.ts`): an item's stored entry
   is kept where a keep rule holds, else its values are drawn; a static item
   stores nothing. The row is written only when something was drawn, so an
   entry of an item removed, or made static, drops at the next such write.
   - **Before the opening** (`itemListLock(state, 0) === null`: `draft`,
     `scheduled`, while the questions may still change), an entry is kept
     only when it was drawn for the item's current version (`sameVersion`):
     a question edited or retargeted is drawn again, even under the same
     names — the teacher prints again anyway, and old values may sit outside
     a corrected range or fail a corrected condition, which a replay does
     not check.
   - **After the opening** an entry is kept whenever it replays under the
     item's version (`replays`, ADR-056 §5, as an attempt's are read). One
     that cannot is drawn again rather than answering 500 for ever; only a
     lost update leaves one — a print in flight writing values of the old
     names while the item was moved onto renamed variables, the exam then
     opened.
   A draw that fails is served from draw 0's values, the example the debrief
   already shows publicly (ADR-056 §7, §9), flagged in `fallback`. Draws are a
   function of the seed, so two first prints at the same instant write the
   same values. The guide tells the teacher to print again after any edit
   made before the opening: a paper printed before an edit is not the paper
   the platform now holds.

4. **One draw, every path.** The stored values flow through the four paths
   that drew none: the hand-out (`live.previewView`, which takes the
   variant's seed and values as an attempt's), the entry page's key
   (`paperKey`), the validation of the typed answers (`paperAnswers`) and the
   paper attempt itself (`insertPaperAttempt`), which copies the variant's
   seed and values — `fallback` included, so ADR-056 §7's warning reaches the
   grading details. The paper attempt is then graded against its own values
   like any attempt.

5. **Printability** (amends ADR-125 §5). `printRefusal` loses the
   `parameterized` reason, in the contract (`PrintRefusal`), the server and
   the web app; its sentence leaves the four dictionaries. A poll and a type
   without the paper hooks still refuse.

6. **The statement with key** (amends ADR-125 §8, "keeps the base order")
   is always the key of the variant: each item in the paper's order, its
   statement as the hand-out prints it, its whole key in that view's
   coordinates and its explanation, with the variant's values — never a
   `[[…]]` template, which never reaches a type's hook (ADR-056 §4). The
   record keeps `position`, the item's canonical place; the Markdown and the
   PDF number the items as the paper does. Its `version` becomes 2: the order
   of `items` changed meaning (`HandoutRecord` stays 1). The owner's answer
   for "an evaluation that does not print" (the base order, a parameterized
   question's example values) described a case no registered type produces —
   every type with a statement declares a paper zone — so the general rule
   covers it: a future type without a zone gets the paper's order with the
   variant's stored values too.

7. **The student's blank print of a past series**: variant 1 for everyone,
   with no variant label and no variant parameter.

8. **Never copied.** A duplicate, a template and an instance made from it
   copy no variant, as they copied no paper seed.

### Not in this record's first step

The owner's plan for the next step, recorded here so that the first step
closes no door; none of it is built yet:

- N variants, A to Z (up to 26), set in the Export sheet; N > 1 offered only
  when something varies (shuffled items or choices, or a parameterized
  question).
- A label "Variant C · p. 2/4" on every page, derived from the number, never
  from the seed; never on the anonymised grading table (F-GRADE-03).
- **Redraw**, and lowering N, refused once the evaluation has opened or a
  paper copy is entered on it.
- The zone manifest's entry carries the variant (palier B).
- The variant chosen when a paper copy is entered.

## Consequences

- A parameterized evaluation prints, and its paper, its key and every paper
  copy agree value for value; a reprint is identical, and a mathjs upgrade
  cannot change a printed paper.
- The staff key of a printed evaluation now reads in the paper's order, so a
  teacher grading paper copies by hand follows the paper; a script that read
  the record's order as the base order must read `position`.
- One table more, one row per printed evaluation; the column it replaces
  waits for its contract migration.
- A teacher who edits a question after printing and before the opening must
  print again: the platform holds the new draw, the paper holds the old one.
- **Anonymity, an accepted limit** (product owner, 2026-11-26; amends
  ADR-125 §17). A paper attempt on a parameterized item carries the
  variant's values. The grading panel shows them in each cell, since a
  parameterized answer cannot be graded without them, and they are the
  numbers printed on the hand-out the grader holds: a paper copy can be told
  apart on the anonymised table (F-GRADE-03), and several paper copies show
  the same numbers. Anonymise guards against a bias, not a secret, and the
  teacher who grades is the one who entered the copy. No value is hidden and
  the entry is not refused on a parameterized evaluation; the "Paper" badge
  stays off that table as before.

## Alternatives considered

- **A visible or editable seed** (to reprint "variant 1234"): the order
  comes from public code (`packages/core/src/rng.ts`), so a printed seed
  gives the choice permutation, hence the base order, hence an mcq's key —
  ADR-125 §8's leak by another route. A seed also means nothing across
  evaluations, since every stream is keyed by an item id. Reproducibility
  comes from storage, not from a number a person types.
- **Recompute the values from the seed at each print**, as D19 does for
  permutations: rejected by ADR-056 §5 for attempts, for the same reasons.
- **Lock the items once the paper is printed**: it would turn a print into a
  publication and refuse the teacher's corrections before the exam; dropping
  and redrawing what no longer fits, until the opening, keeps both.
- **Keep refusing parameterized questions on paper** (ADR-125 §5): reversed
  by the owner.
