# ADR-042 — The discrimination index of a question

## Status

Accepted (2026-09-29, decided by the teacher who owns the product: exams
only, and only attempts whose other items are all validated; the method,
the thresholds and the bands were delegated). With `pearson`,
`evaluationDiscrimination`, `discrimination`, `discriminationBand` and
the constants `DISCRIMINATION_MIN_ITEMS`, `DISCRIMINATION_MIN_N`,
`DISCRIMINATION_FAIR` and `DISCRIMINATION_GOOD` in `@quiz/domain/stats`,
`formatDecimal` in the web app's i18n, `discriminationsOf` in the `stats` module and
`DiscriminationStats` in `@quiz/contracts/stats`. No migration. Revises
F-STAT-02 (docs/spec/02). Builds on ADR-038 (what is counted) and ADR-039
(the not-reached rule).

## Context

ADR-038 gave a question its success rate `p`: how hard it is. F-STAT-02
also promised a discrimination index — whether the question separates the
students who master the subject from those who do not. A question every
student gets right or wrong at random, or one that the strong students miss
because its key is wrong, is a question to rewrite; `p` alone does not show
it.

The classic measure is the point-biserial correlation between the item's
score and the test total. Four facts constrain it here:

- the item is part of the total, which inflates the correlation, the more
  so on a short test;
- a question is used in several exams, of different lengths, classes and
  years: one correlation over all of them would mix totals that do not
  compare;
- a grading may still be a proposal (an essay, an LLM-graded answer): a
  total over proposals is not a grade;
- negative marking (ADR-026) gives signed scores.

## Decision

### 1. Population: ADR-038's counted answers, exams only, graded in full

The index reads EXACTLY the answers the success rate counts (ADR-038 §2 and
ADR-039 §5, one query, one `countedAttempt()` predicate, one kept filter):
validated, of a student account, not a staff seat, finished, started, at or
after the question's `stats_since`, and not "never reached" on a tracked
attempt. Then two stricter rules:

- **Exams only.** An exercise is done over days with retakes and help; its
  "rest of the test" is not a measure of the student.
- **Every OTHER item of the attempt is validated.** An attempt with a
  proposal left on any other item worth something is dropped from that
  exam's sample — it still counts in `p`, which needs only its own item's
  grading. The total must be a grade, not a guess.

The other items of an exam are its items worth something (`points > 0`);
an item that was never reached on a tracked attempt still carries its
validated 0 in the rest of the test — that is the student's score.

### 2. Method: the corrected point-biserial per exam, Fisher's z across

Per exam, per item of the question:

- `x` = the item's ratio `points / max_points`, signed and unclamped;
- `y` = the rest of the test: the sum of the points of the other items over
  the sum of their maxima;
- `r` = Pearson(x, y). With a dichotomous item this is the point-biserial;
  with partial credit it is the item-rest correlation. Excluding the item
  from the total is the correction.

`y` is a RATIO, not a sum of points. Within one exam every attempt has the
same items, so the two are a linear map of each other and give the same
`r`; the ratio is kept because it is the unit `p` already uses, because it
stays right if a regrade changed one attempt's maxima, and because nothing
downstream needs the sum.

An exam is left out when it has fewer than `DISCRIMINATION_MIN_ITEMS` (5)
other items — the rest of the test would be too short to stand for the
student —, fewer than `DISCRIMINATION_MIN_N` (10) attempts in its sample —
the same threshold as `p` —, or no variance on either side (everybody
earned the same on the item, or on the rest): the correlation does not
exist there.

The exams that qualify are combined by Fisher's z: `z = atanh(r)`, a mean
weighted by `n − 3` (the inverse of the variance of `z`), back-transformed
by `tanh`. `|r|` is capped at 0.9999 before `atanh`, so a perfect sample
stays finite. Pooling the raw pairs instead would correlate totals of
different exams; averaging `r` directly would bias it towards zero.

A question that appears twice in one exam (two items) gives two samples,
each against the rest of the exam — the other copy included; they are not
independent, and it is rare enough to be accepted in the value. The counts
shown stay honest: that exam counts once, and its attempts once.

### 3. What is shown, and when

`QuestionStats.discrimination` is `{ r, evaluations, n }`: the combined
index rounded to two decimals, the number of DISTINCT exams behind it and
the number of distinct attempts. It is `null` — decided by the server, like `p` — when no
exam qualifies. It is carried only on an entry that already exists, that is
a question with its ten counted answers (§4 of ADR-038); every attempt in
the index is one of them, so it never reveals a smaller population.

The panel shows the value, its reading and its basis ("over 2 exams, 21
attempts"), with one sentence on what the index means:

| `r` | Reading |
| --- | --- |
| < 0 | **inverse**, flagged: the stronger students do worse on it — a wrong key or an ambiguous wording |
| 0 to < 0.2 | weak |
| 0.2 to < 0.3 | fair |
| ≥ 0.3 | good |

The bands are those of the classical item-analysis literature (Ebel's
0.2 / 0.3 / 0.4 collapsed into three readings), applied to the rounded
value so the label matches the number. `discriminationBand` and the two
thresholds in `@quiz/domain` are the one definition: the panel reads them,
its sentence interpolates the thresholds, and every decimal is written in
the reader's notation (`0.42`, `0,42`).

### 4. Performance

Two more queries per pool read, no cache: the items of the exams that
contain a pool question, and every validated grading of the counted exam
attempts (by attempt id, so an attempt that is not counted is never read). Each
exam is computed once, grouped in memory by item, then by question. For a
pool used in twenty exams of a hundred students of twenty items, that is
some forty thousand small rows; should it outgrow the process, the rest of
the test pre-aggregates in SQL per attempt (`sum(points)`, `sum(max)`,
`count(*) filter (where state = 'validated')`) with the same filters.

## Consequences

- A teacher sees, beside the success rate and the time, whether a question
  tells the good students from the others, and an inverse question stands
  out.
- An exam whose essays are still being graded contributes nothing until the
  last proposal is validated; its `p` already counts.
- Short quizzes (fewer than six items) never contribute: by design.
- The MCP tool of the pool statistics, when it exists, carries the index as
  the route does.

### Residual risk

The same as ADR-038's: differencing two reads around one new attempt moves
`r` by an amount that says something about that attempt. The index is a
correlation over ten attempts or more, rounded to two decimals, without
identity; accepted for the same reasons.

### Rollback

Dropping the field from the contract and the block from the panel hides
it; nothing is stored, nothing to migrate.

## Alternatives considered

- **Uncorrected point-biserial (item against the full total).** Inflated by
  the item's own share, most on short exams — exactly those a teacher
  builds from a pool.
- **Pooling every attempt of every exam in one correlation.** Mixes totals
  of exams that do not compare, and lets the largest exam decide alone.
- **The upper-lower index (27 % groups).** Coarser, throws away the middle
  of the class, and needs larger classes than HEIG-VD's.
- **Exercises included.** Help, retakes and days between attempts make
  their totals a measure of persistence, not of mastery.
- **Proposals counted in the rest of the test.** The total would move when
  a teacher validates, and an unvalidated LLM grade would drive the index.
- **Rest of the test as a sum of points.** Equivalent within an exam
  (Pearson is invariant under a linear map); the ratio was kept for its
  unit and its robustness to per-attempt maxima.
