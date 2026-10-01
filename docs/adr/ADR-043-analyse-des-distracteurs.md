# ADR-043 — The distractors of a multiple-choice question

## Status

Accepted (2026-09-29, decided by the teacher who owns the product: every
version whose options are identical to the latest's, their own `n`,
whole-percent shares only, from ten answers, through the type's `aggregate`
hook, `mcq` only; the population, the "no answer" row and the
multiple-choice reading were delegated). With `sameAsLatest` and
`optionShares` in
`@quiz/domain/stats`, `distractorsOf` in the `stats` module and
`DistractorStats` in `@quiz/contracts/stats`. No migration, no change to the
`QuestionType` contract. Revises F-STAT-02 (docs/spec/02). Extends ADR-038
(what is counted), with the not-reached rule of ADR-039. Amended 2026-10-01
by ADR-056 §9: a parameterized mcq's options are its template's texts, and
an option whose value is drawn for it alone (`drawn`) says its share is its
place's.
Amended 2026-09-30 with ADR-038 §2: exams only, never an exercise (§1).

## Context

F-STAT-02 promised, beside the difficulty and the discrimination, a
distractor analysis for multiple choice: which wrong options students
actually pick. It is the classic reading of a choice question after use:

- a wrong option nobody picks is not a distractor, only padding that makes
  the question easier than its number of options suggests;
- a wrong option picked more often than the key points at a shared
  misconception — or at a key that is wrong.

The success rate of ADR-038 pools every version of a question. The options,
though, are what the shares are about: a share of "option C" means nothing
once C was rewritten, removed, or became the key. An mcq option has no
stable identity — the config is an ordered list of `{ text, correct }`, and
an answer stores canonical indices into it (decision D3).

## Decision

### 1. Population: ADR-038's counted answers, narrowed to the current options

The analysis reads EXACTLY the answers the success rate counts (ADR-038 §2,
one query, one `countedAttempt()` predicate, and ADR-039's not-reached
rule): a validated grading, of a student account, not a staff seat, on a
finished and started attempt of an EXAM, at or after the question's
`stats_since`.

*Amended 2026-09-30 with ADR-038 §2: exams only, for the reason given
there. This section first counted exercises too, on their kept attempt.*

Then one narrowing: only the answers given to the published versions whose
options are **identical** to the latest published version's, wherever they
stand in the history. Two versions have the same options when their
`choices` are equal in order, text and `correct` flag alike, compared exactly
after the config pipeline (`loadConfig`). The prompt, the mode, the policy,
the shuffle and the explanation may change freely between them.

A change that is later undone costs nothing: options changed in v2 and put
back in v3 count v1's answers again with v3's, and v2's are left out — v1
and v3 ask the same options, so their answers read the same way. A typo
fixed in one option, on the other hand, makes it another option: the answers
before the fix are left out until it is undone.

An unreadable version (a config that no longer parses) matches nothing; an
unreadable latest version gives no analysis.

### 2. What is computed

Over the `n` answers of those versions: for each option of the latest version, the
share of answers that picked it; and the share of answers that picked
**nothing** — a blank, a skipped question, an empty selection, or no answer
row at all on an attempt of before ADR-039 (a never-reached question on a
tracked attempt is already out of the population).

The counting is the type's own: `mcq`'s `aggregate` hook (ADR-033), called
through the registry as the results module calls it, over the stored
payloads — a choice ticked twice in one answer counts once. "Picked nothing"
is the class debrief's rule: a skipped question, or a payload that
`answeredBy` (the `live` module's reading of the type's `isAnswered`) says
holds nothing. A payload stored under an older schema that no longer parses
holds something by that rule, so it is never "no answer"; it counts under
the options the type's `aggregate` still recognises in it, or under none —
in one bucket at most, never two. `details` are not passed: the key comes
from the latest version's config, identical across those versions by
construction.

Each share is a whole percent of `n`, rounded on its own. A single-choice
question may therefore sum to 99 or 101; a largest-remainder rounding would
fix that for single choice only and hide how each number was obtained.

A **multiple-choice** question lets an answer pick several options: its
shares add up to more than 100 %, and the panel says so in one sentence.
The mode is not part of the version rule (the owner's rule is the options'
text and key), so a single-choice latest version may count answers given
to a multiple-choice one with the same options: `multiple` is true when ANY
counted version was multiple-choice, so the sentence shows whenever the
shares may pass 100.

### 3. What is shown, and when

`QuestionStats.distractors` is:

- **absent** for every type other than `mcq`: the panel draws no block;
- **null** when those versions have fewer than `QUESTION_STATS_MIN_N` (ten) answers —
  decided by the server, like `p`; no share of a smaller population travels;
- otherwise `{ n, multiple, options: [{ text, correct, share }], none }`.

No count per option ever goes on the wire (N-DATA-06). `n` is the analysis's own
and may be smaller than the success rate's. The entry itself exists only for
a question with ten counted answers overall (ADR-038 §4).

The options' text goes on the wire so the panel shows what the shares are
about, in the latest version's order, lettered A, B, C as the editor and the
live grid letter them. The route is a teacher route behind the pool's access
loader (ADR-013): its readers may read the question itself. No student path
is touched: invariant 4 is not involved.

The panel's fourth block, **Choices picked**: one row per option — letter,
text, share, a bar — the key marked by the green "correct answer" badge of
the results' class debrief, in words, then **No answer**. The bars are the
debrief's `SegmentedBar`, in a new `info` tone: a share is a datum, not a
verdict. Under the bars, the basis ("Share of 12 answers, on the
versions whose choices are these ones", and the multiple-choice sentence),
then one sentence on how to read it: a wrong choice nobody picks distracts
no one; a wrong choice picked more often than the right one points to a
misconception, or to a wrong key. Below ten answers, one line says when the
block will show.

### 4. Where the code lives

- `sameAsLatest` (the version rule, generic over a key) and `optionShares` (the
  rounding and the threshold) are pure, in `@quiz/domain/stats`, beside the
  other rules of the item analysis — not in `qt-mcq`, because the threshold
  and the shares belong to the statistics, not to the type.
- What an mcq option IS — `{ text, correct }` in order — is read in the
  `stats` module from the config pipeline, as the `poll` module already reads
  `choices` for its tally; the counting goes through the type's `aggregate`.
  No contract change: a second type that wants this analysis would earn a
  hook then, not before.
- `poolQuestionStats` selects the question's type, the item's version, the
  `skipped` flag and — for an mcq only, so no other type's payload travels —
  the stored payload in its one query of counted answers, which already
  joins `answers`; `distractorsOf` receives those rows and loads the
  published versions of the mcq questions (one query). The threshold is
  `optionShares`' alone.

## Consequences

- A teacher sees, per choice, whether it does its job, and a key picked less
  than a distractor stands out next to an inverse discrimination.
- Fixing a typo in one option restarts the analysis from that version: the
  options are what the shares are about, and a text that differs is another
  option. Undoing the change brings the older answers back. The success rate keeps pooling every version.
- The MCP tool `get_pool_question_stats` (ADR-022) carries the block as the
  route does.

### Residual risk

At `n = 10`, a whole percent is a count times ten: the shares give the
number of students who picked each option. They carry no identity, and a
reader of the pool statistics already reads `p` over the same answers;
a 100 % share says what every counted student answered, as `p = 1` says
they all earned full marks. Accepted, with ADR-038's differencing risk.

### Rollback

Dropping the field from the contract and the block from the panel hides it;
nothing is stored.

## Alternatives considered

- **Every version pooled, as `p`.** A share of an option that was rewritten
  or became the key mixes two different options.
- **Stable choice ids in the mcq config.** Would let a share follow an
  option through a rewording, at the cost of a config migration and of
  deciding when a rewording is "the same option"; refused by the owner.
- **A contiguous run back from the latest version**, the first version that
  differs ending it. It would say "since version N" in one line, but would
  drop the answers of a version whose options a later edit put back, though
  they ask exactly the same options; the owner chose identity, not
  contiguity.
- **Largest-remainder rounding.** Sums to exactly 100 on single choice, but
  moves a share by one point depending on the others, and does not apply to
  multiple choice.
- **No "no answer" row.** The shares of a single-choice question would then
  sum well below 100 with no explanation, and a question many students skip
  would not show it.
- **Counts beside the shares.** Refused by the owner (N-DATA-06).
