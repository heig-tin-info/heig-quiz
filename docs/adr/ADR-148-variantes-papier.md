# ADR-148 — Paper variants: one stored draw of the whole paper, parameterized questions printed

## Status

Accepted (2026-11-26, the product owner's decisions 1 to 8, which reverse
ADR-125 §5's refusal of a parameterized question on paper, and the
anonymity limit under Consequences). Its first step delivered variant 1
only; its second (the owner's decisions of the same day, 9 to 14) delivers N
variants, their page label, Redraw and the variant of a paper copy.

Scope: what a printed paper of an evaluation is drawn from — the hand-out,
the staff statement with key, the student's blank print of a past series,
the paper attempt typed in from it — and where that draw is stored.

Relations: amends [ADR-125](ADR-125-copies-papier-pdf-typst.md) §5 (the
`parameterized` refusal disappears), §8 (the paper's seed moves into variant
1; the statement with key of a printed evaluation follows the paper's order)
§9 (a paper attempt carries the variant's values) and §17 (those values
tell a paper copy apart on the anonymised table: an accepted limit), §6 (a
zone's manifest entry names its booklet), §9 and §11 (a paper copy names its
variant, `422 paper_variant`), and [ADR-121](ADR-121-fabrique-d-exports.md)
§1 (a `booklet` block; the records name their variant) and §8 step 3 (a
parameterized question is no longer refused). Depends on [ADR-056](ADR-056-questions-parametrees.md)
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
   `0164_paper_variants` copies every non-null `evaluations.paper_seed` into
   variant 1 with no values (a parameterized evaluation did not print
   before). **Expand, then contract**: the column stays in this step and the
   code reads and writes it only where variant 1 is created, in one
   statement: the seed is a value found there — one an older server wrote
   during the deploy — else a new one, which is written back where the
   column is null, so the previous image still prints the same order after
   a rollback ([deployment](../development/deployment.md) §5); Redraw moves
   it to variant 1's new seed (decision 11). The contract migration removes
   four things together: the column, the write-back of the creation, that of
   Redraw, and the `coalesce` read.

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
     that cannot — values of other names, or a regrade's version whose
     derived rows fail on them — is drawn again rather than answering 500
     for ever.
   A write lands only over the values the call read (a compare-and-set on
   `instances`): a print that started before a retarget never writes its
   older draw over a newer one.
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

9. **N variants, A to Z** (product owner, 2026-11-26). An evaluation's paper
   has 1 to 26 variants: the number of its `paper_variants` rows, 1 while
   none was printed. The letter derives from the number (`variantLetter`,
   `@quiz/domain`), never from the seed. The count is set in the Export
   sheet beside the downloads (`PUT /evaluations/:id/paper-variants`): a
   missing variant is made with a seed of its own from the CSPRNG, the
   highest numbers are removed. More than one is offered, and accepted, only
   when two papers can differ — shuffled items, shuffled choices, or a
   parameterized question (`variesOnPaper`; `422 variants_identical`):
   identical papers under other letters would lie. The sheet reads
   `EvaluationDetail.exports.variants` (count, whether something varies,
   whether the variants are fixed), never a seed.

10. **The page label.** When the paper has more than one variant, every page
    of a staff hand-out or key names its variant and counts its own pages,
    "Variant C · p. 2/4", in the requester's language (`LABELS.variant`,
    `LABELS.pageShort`). The tree marks it with a `booklet` block (amends
    ADR-121 §1): its blocks form a paper of their own, starting on a recto
    (a blank verso, with no header nor footer, pads the one before), its
    pages counted apart, its label in every footer — one general mechanism,
    used by both documents. The footer sits in the 20 mm margin, above the
    outer 10 mm ADR-125 §6 keeps for palier B. A zone's manifest entry names
    its booklet (amends ADR-125 §6), so the zone ids, the same in every
    variant, stay apart. The JSON and Markdown of a document hold one
    variant (`?variant=k`, 1 by default); the PDF one, or `all`: each
    variant a booklet of one file. A record names its variant, `{ number,
    letter, of }` (the key's `version` 3, the hand-out's 2). With one
    variant, nothing is labelled. The student's blank print (decision 7)
    is variant 1 with no label and no variant named (`variant: null`); the
    label never reaches the anonymised grading table (ADR-125 §17).

11. **Redraw** gives every variant a new seed and clears its stored values,
    so the next print draws them again; `evaluations.paper_seed` follows
    variant 1's new seed (the rollback write-back of decision 2). Redraw and
    fewer variants are refused once the evaluation has opened (`409
    variants_locked`, `paperVariantsLocked`) — variant 1 included: the
    server cannot know a stack was printed. "Opened" is the window in which
    the questions may no longer change either, `itemListLock(state, 0)`
    (decision 3): from the lobby on, every state after it, and free again on
    an evaluation moved back to `draft`. The owner's "or a paper copy was
    entered" is implied by it: a paper copy needs the exam to have run
    (`paper_not_started` otherwise, ADR-125 §11), and an evaluation returns
    to `draft` only while it holds no attempt, which a paper copy is. More
    variants stay allowed: a new one changes no paper already out. The two
    writes serialize on the evaluation's row. Both are audited
    (`evaluation.paper_variants` with `from` and `to`,
    `evaluation.paper_redraw` with `count`, none when nothing was printed
    yet), never with a seed.

12. **The variant of a paper copy.** A copy is typed from the variant printed
    on it: `PaperAttemptBody.variant` and the entry page's `?variant=`,
    required when the paper has several (`422 paper_variant`, amends
    ADR-125 §9, §11). The entry dialog asks for it first, by the letter of
    the page footer; the page renders that variant's paper and key, and the
    attempt takes that variant's seed and stored values. `paper_sheets`
    records it (`variant`, 1 for every copy entered before, migration
    `0165_paper_sheet_variant`), owned by the `paper` module; the staff copy
    and the entry page may name it, the anonymised table never.

13. **The size of every variant at once** stays within ADR-125 §2's bounds,
    unraised: measured on a nine-item exam (the five text types, a circuit,
    a logic circuit, two parameterized questions), 26 variants compile in
    under a second, 130 pages and 0.8 MB for the hand-out, 1.3 MB for the
    key. A combined PDF the bounds still refuse answers the existing
    refusal, and the sheet tells the teacher to download variant by
    variant.

14. **Not here, later**: a correction grid per variant, nominative copies
    (one paper per student), and palier B's page QR code, which will carry
    the variant beside the page.

## Consequences

- A parameterized evaluation prints, and its paper, its key and every paper
  copy agree value for value; a reprint is identical, and a mathjs upgrade
  cannot change a printed paper.
- The staff key of a printed evaluation now reads in the paper's order, so a
  teacher grading paper copies by hand follows the paper; a script that read
  the record's order as the base order must read `position`.
- One table more, a row per variant of a printed evaluation; the column it
  replaces waits for its contract migration.
- Neighbours in a room can hold different papers; a key, a paper entry and
  a reprint follow one variant, named by its letter on every page.
- A teacher who edits a question after printing and before the opening must
  print again: the platform holds the new draw, the paper holds the old one.
- **Anonymity, an accepted limit** (product owner, 2026-11-26; amends
  ADR-125 §17). A paper attempt on a parameterized item carries the
  variant's values. The grading panel shows them in each cell, since a
  parameterized answer cannot be graded without them, and they are the
  numbers printed on the hand-out the grader holds: a paper copy can be told
  apart on the anonymised table (F-GRADE-03), and several paper copies show
  the same numbers when they are of one variant. Anonymise guards against a bias, not a secret, and the
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
