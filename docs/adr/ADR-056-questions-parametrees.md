# ADR-056 — Parameterized questions: variables drawn per attempt

## Status

Accepted (2026-10-01, decided by the product owner after a challenge of the
proposal). Not implemented yet. It replaces the design of the "Random values"
section (§4.3 of docs/spec/04) and rewrites F-QST-10 (docs/spec/02). It
amends decision D19 of `docs/PLAN-MVP.md`: drawn values are stored, while
permutations are still recomputed. It also amends
[ADR-044](ADR-044-grille-de-correction.md) (the pinned key row),
[ADR-033](ADR-033-projection-de-la-correction.md) (how answers are grouped),
[ADR-043](ADR-043-analyse-des-distracteurs.md) (random distractors)
and [ADR-014](ADR-014-sondages-en-direct.md) (polls refuse such a question).

## Context

A question is static: one statement, one key. A teacher who asks "a ball
dropped from a 10 m cliff, how long is the fall?" asks every student the
same thing. To vary it, the teacher writes ten near-copies of the question
by hand. Neighbours in an exam end up with the same numbers.

The spec planned for random values from the start, but nothing was built.
What exists:

- F-QST-10 (P2) and §4.3, with variables written as
  `{ min, max, step, unit }`, used in the text as `{{R1}}`, and a
  "restricted arithmetic evaluator".
- The optional `randomize?(config, seed)` hook of `QuestionType`
  (`packages/core/src/contract.ts`), which no type implements.
- The `questions.randomizable` column, which nothing reads.
- One seed per attempt, and `streamSeed(seed, itemId, purpose)` for every
  random choice (`packages/core/src/rng.ts`).

The design of §4.3 cannot be built as written:

- `{{…}}` is already the blank of `cloze`. Inside it, `{{2*Newton}}` means
  weight 2 and `{{=a|b}}` means a dropdown. C prompts also contain
  `int m[2][2] = {{1,2},{3,4}};`.
- Ranges with a step cannot express `choice([3.71, 9.81, 24.79])`, nor a
  value derived from another one.
- No evaluator was chosen.

Teachers think of these variables as one-liners:
`h = randint(1, 100)`, `g = choice([...])`, `t = sqrt(2*h/g)`.

Systems that already do this were studied:

- **Numbas** (Newcastle University): a table of variables in its JME
  language, and a condition that rejects a draw, retried up to `maxRuns`.
- **PrairieLearn**: a Python `generate(data)` fills `params` and the
  correct answers, with every random generator seeded by the variant's
  seed.
- **Moodle Formulas**: sets such as `{1:10:2}`.

## Decision

### 1. Variables are a header field of the question version

`question_versions` gains a field `variables`, next to `explanation`. It is
an ordered list of rows `{ name, expr, format }` plus an optional
`condition`. It belongs to no question type, so the three types do not each
need a migration for it. A question is **parameterized** exactly when its
published version has at least one variable. The `questions.randomizable`
flag is derived from that by every version write that publishes
(`publishQuestion` today), and is never patched by hand: it left
`QuestionPatch`. (`shuffleable` is NOT derived the same way: it is set at
the question's creation and patched by the teacher.) A copy has no
published version yet, so it starts at `false`.

Variables belong to one question. Two questions about the same cliff do not
share `h`. A problem in several parts is a `cloze`, or a multi-part question
later.

### 2. The evaluator is mathjs, restricted

Expressions are evaluated by [mathjs](https://mathjs.org) through an
instance built with `create()` from an explicit list of allowed functions:

- arithmetic, comparison and logic (`and`, `or`, `not`, `a ? b : c`);
- the usual functions: `sqrt`, `abs`, `exp`, `log`, trigonometry, `round`,
  `floor`, `ceil`, `min`, `max`;
- the constants `pi` and `e`;
- arrays.

Everything else is left out, in particular `import`, `createUnit`,
`reviver`, `evaluate`, `parse`, `simplify`, `derivative`, `resolve` and
`compile`, as the mathjs security notes require for untrusted input.
`factorial`, matrices and units are also left out of v1.

Static limits, checked at write time:

- the length of an expression;
- the number of nodes of its syntax tree;
- no range at all: `1:1e9` would exhaust memory, and v1 refuses the
  range syntax outright rather than cap its size (simpler, and nothing
  needs it: `choice([...])` takes a literal list).

The randomness is the platform's own. `randint(a, b)` (both ends included),
`uniform(a, b)` and `choice([...])` are functions we add to the instance.
They draw from `rng(streamSeed(attempt.seed, item.id, "vars"))`. mathjs's
own random functions are not exposed, so one generator remains the source
of all randomness (D19).

The syntax is mathjs's, not Python's: the power operator is `^` and there is
no `**`. Teachers know `^` from calculators and spreadsheets. We do not add
anything on top of the parser.

mathjs is a dependency of `packages/domain` (the evaluator and the
instantiation pass are pure rules, as `ts-fsrs` already is there). Its
version is pinned exactly in `package.json`, because drawn values are stored
(§5) and an upgrade must not change a stored question's validation silently.
Neither bundle loads it: the editor's preview is computed by the API (§8).

### 3. `[[expr]]` interpolates, everywhere

A variable or an expression is written `[[h]]` or `[[sqrt(2*h/g)]]`, in
every text field of the configuration and in the explanation:

- inside LaTeX: `$[[g]]\,m/s^2$`;
- inside code: a value in a snippet is often the point;
- inside a `cloze` blank: `{{#[[t]]:1%}}`.

Interpolation is active only when the question declares variables. A static
question is never scanned, so its `[[1,2],[3,4]]` stays text. `\[[` writes
literal brackets. In a parameterized question, `[[` that does not parse, or
that names an unknown variable, is a publication error, and the message
gives the position. A Bash `[[ -f x ]]` in a parameterized prompt is
therefore caught when the teacher publishes, never when a student sees it.

### 4. Instantiation is one pass, through one choke point

`instantiate(version, values)` replaces every `[[…]]` in the configuration
and in the explanation. It returns an ordinary static version. `toStudent`,
`grade`, `Review`, the solution views and the LLM prompts receive that
static version and stay unchanged.

Every reader of a version must receive it instantiated. The current readers
are:

- `live`: the student view and autosave;
- grading: the pass and the regrade;
- the trial routes of the pool;
- `preview`;
- `drill`;
- the LLM module;
- `studentSolutionView`.

So instantiation happens where the version is loaded for an attempt or a
review, not at each call site. A parameterized version that reaches a type
uninstantiated is a programming error. Invariant 4's test (05 §5.7) is
extended for `mcq`, `short` and `cloze`: a full parameterized configuration
goes through the student path, and the serialized output is searched for
every expression and every variable name, in addition to the forbidden keys
and the key's values. The `variables` table never leaves the server toward a
student.

Fields that the schema types as numbers carry expressions. `short` moves to
config version 3, where a `number` matcher's `value` and `tolerance` accept a
number or a `[[…]]` string. Its `migrate` raises a v2 config unchanged. The
integer check and the tolerance check read the instantiated value. `mcq` and
`cloze` hold the expressions in strings already and keep their versions.

### 5. Drawn values are stored, per attempt and item

D19 recomputes a permutation from the seed and never stores it. That
remains true for permutations. It cannot hold for drawn values: an upgraded
mathjs, a reordered variable or a different retry cap would change every
past instance. The review, the results and a regrade would then show numbers
the student never saw.

- **When.** The paper is rendered from the attempt's seed before any answer
  row exists, so the values cannot wait for one: they are drawn for every
  parameterized item **when the attempt is created** (the first attempt and
  each retake), from `streamSeed(attempt.seed, item.id, "vars")`, and stored
  in `attempts.instances` as `{ [itemId]: { versionId, values } }`. The
  items of an evaluation are frozen once an attempt exists. Every later read
  uses the stored values. Values are recomputed from the same seed only
  when none are stored, for example in the student preview of ADR-018,
  which stores nothing.
- **Seed.** The seed stays per attempt, not per student and evaluation. A
  retake (n + 1) gets a new seed, so new values: that is the point of
  retaking an exercise.
- **Version.** A regrade with version N (F-GRADE-06) keeps the stored values
  when N declares the same variable names, and recomputes only N's derived
  expressions from them: a row that calls `randint`, `uniform` or `choice`
  keeps its stored value, every other row is evaluated again in order and
  rounded by its format (`replay`), the condition is not checked. The
  stored values are never rewritten: `versionId` says which version they
  were drawn for, and a read under another one replays them. When the names
  differ, the item's regrade is refused (`409 variables_changed`) and the
  item keeps its version.
- **Drill.** A review in progress keeps its values beside `serve_seed`
  (`drill_cards.serve_values`, cleared with it). The question is the latest
  published version, which may change between the serve and the answer:
  the values are replayed under the same names and drawn again otherwise.
  `drill_reviews.values` stores them with the answer. ADR-041 (i) is unchanged:
  each review is a new seed, so new values. A card's key identity
  (`keyHashOf`) is computed on the TEMPLATE, never on an instance, so a new
  instance does not reset the card.

### 6. Values are rounded at the source

A variable IS its formatted value: `g` formatted `.2` is 9.81, and every
expression that reads `g` reads 9.81. The format column offers `int`, a
number of decimals (`.1` … `.6`) and a number of significant figures
(`3s`). If it is empty, the value is shown with up to 6 significant figures
and computed with all of them.

Rounding is half away from zero, done on the decimal representation, not
with `toFixed` (which turns 1.005 into "1.00"). A value is displayed with a
dot in every language: the answer field of `short` accepts a comma and a
dot. Publication refuses a `number` matcher whose tolerance is below half
the format step of its key, because the exact answer would then be marked
wrong.

The rule as implemented (`short.tolerance_below_format`, the type's
`sampleIssues` hook, run by publication after the gated draws): it applies to
a `number` matcher whose value is ONE variable (`[[t]]`) with a format. On
each of the draws publication puts through the type's gate (seeds 0 to 4),
the step of that format at the drawn key (`formatStep`: 1 for `int`, 10⁻ⁿ
for `.n`, and for `ns` the step of n significant figures at that magnitude)
is compared with the margin the tolerance gives there: the tolerance itself
when absolute, `|key| × tolerance` when relative. A margin below half the
step on any of those draws refuses the question. A tolerance that names one
variable is read in each draw. Not checked: a key that is an expression
(`[[2*t]]`, written with up to six significant figures, whose rounding is
far below any sensible tolerance), a variable without a format, and a
tolerance that is an expression.

### 7. The draw and its condition

Variables are drawn in the order they are listed. A row reads only the rows
above it. An optional `condition` (for example `b^2 - 4*a*c > 0`) rejects a
draw and draws again, at most 100 times.

For `mcq`, choices that render to the same text, or numerically within
1 % of each other, count as a failed condition, without the teacher writing
it. A distractor written as the formula of a classic mistake
(`sqrt(h/g)`, `2*h/g`) is the recommended practice in the editor's help. A
`uniform()` distractor is allowed.

Bad expressions are refused at publication, server-side, on every write
path: the editor, YAML import (F-POOL-07), MCP (ADR-022), and contributors
to a shared pool (ADR-013). The validation draws 200 seeds. The question is
refused if an evaluation fails, if a draw exhausts its 100 tries, or if a
draw is slow. If the cap is still reached when a student is served, the last
draw is kept, a warning is written to the grading details, and the student
never sees an error. A draw that throws is served from seed 0's values,
which publication validated, and flagged the same way.

### 8. Editor, preview and list

A "Variables" section is shared by the editors of `mcq`, `short` and
`cloze`. It is the same table for all three: name, expression, format, and
the condition below it. A preview shows five instances, computed by an API
route that runs the same pass, so the browser evaluates nothing and the
editor shows exactly what students will get.

The question list shows a **Parameterized** pill ("Paramétrée"). The word is
not "Generated", which already names the LLM actions (docs/spec/08,
§8.1 and §8.6). "Freeze", which turns one instance into a static question
(08 §8.6), comes later.

### 9. Grading table, debrief, statistics (amends ADR-044 and ADR-033)

The answers to a parameterized question each have their own key: "12.3" is
right for Alice and wrong for Bob.

- **The grading table (ADR-044)** pins the TEMPLATE as its first row: the
  formulas, with the variables' names. Each answer's own instantiated key is
  in the side panel, and the type's `Review` already shows it there. Rows
  are grouped by verdict, not by answer text. A per-row "expected" column
  can come later.
- **The debrief (ADR-033)** groups a parameterized question's answers by
  verdict only.
- **Distractor analysis (ADR-043)** groups `mcq` options by their template
  text. That is meaningful for a formula distractor. For a `choice()` or
  `uniform()` distractor, the analysis says so instead of comparing
  numbers.
- **Item statistics (ADR-038)** are pooled across instances. v1 has no
  per-instance statistics.

The released feedback and the student's review show the student's own
values, because they read the stored instance.

### 10. What is refused, and what comes later

- **Polls** refuse a parameterized question, as they refuse negative
  marking. A projector and thirty phones must show the same thing
  (ADR-014).
- **v1 types:** `mcq`, `short` (with a `number` matcher) and `cloze`. A
  `short` with a computed text key is refused at publication: string
  equality cannot hold for a number computed and then formatted.
- **Later, each without closing a door:** "freeze", the `code` type (§4.3),
  a per-instance key column, and the conversion of Moodle "calculated"
  questions.
- **The script mode** is also later: Python written in the editor,
  following PrairieLearn's `generate(data)`. It runs on the runner AT
  AUTHORING TIME, and its output is a finite bank of instances stored with
  the version. The seed picks a row, and the stored values of §5 hold the
  row. The runner never sits on the path that serves a question.

## Consequences

- Students sitting next to each other get different numbers. One question
  replaces a family of near-copies, and the statistics pool them.
- A parameterized question can be reread exactly as the student had it,
  forever: a mathjs upgrade, an edit or a regrade does not change it.
- The `(attempt, item)` row gains a column, and so do the drill's review in
  progress and its reviews: one additive migration.
- A choke point stands between every reader and the question type. A new
  reader that bypasses it fails the extended 5.7 test instead of leaking a
  formula.
- `[[` changes meaning only in parameterized questions. Existing content is
  untouched.
- One more dependency, mathjs, pinned, on the server side only.

### Residual risk

An expression that passes 200 validation draws can still be slow or fail on
the 201st. The static limits keep the cost small, and the serve path falls
back without an error (§7). mathjs evaluates synchronously on the API's
event loop. That is acceptable for one-line expressions under the caps, and
moving evaluation to a worker is the fallback if a measurement says
otherwise.

### Rollback

Hide the Variables section and refuse `variables` on write. Versions that
are already parameterized stay readable through their stored values.
Dropping the column loses only drafts.

## Alternatives considered

- **Python on the serve path** (runner, Pyodide, Skulpt, Brython). This is
  the teachers' language, but it means a whole interpreter, or a round trip
  to the runner, for every student and every question when an exam opens,
  and an exam that breaks if the runner is down. Python is kept for the
  script mode, at authoring time.
- **expr-eval.** Unmaintained, with two critical CVEs in 2025
  (CVE-2025-12735, remote code execution through the evaluation context,
  and CVE-2025-13204).
- **A language of our own.** It would be one more parser to secure and
  document. Numbas JME is a good model but is not distributed as a separate
  library.
- **`{{…}}`, as §4.3 wrote it.** It collides with every `cloze` blank and
  with C initializers. Changing the blank syntax instead would break
  published questions.
- **Recompute from the seed, as D19 does for permutations.** That would
  require freezing mathjs, the draw order and the retry cap forever. Stored
  values cost one jsonb per answered item.
- **One seed per student and evaluation**, as first proposed. A retake
  would replay the same numbers.
- **Variables in each type's configuration.** That means three migrations,
  and the explanation would still need a separate pass.
