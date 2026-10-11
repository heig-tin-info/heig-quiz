# ADR-102 — Mathematical expression answers: a math field, numerical equivalence, no CAS

## Status

Proposed (2026-10-11), decided with the product owner after the challenge of
issue #460; prototype on branch `qt-math`, not merged. Requirement F-QST-12.

Scope: the `math` question type (`packages/qt-math`), the reading and
comparison rules of `@quiz/domain/math`, and the student view of the type.

Relations: settles issue #460 by its option B (a dedicated type, not a `kind`
of `short`). Relates to [ADR-056 §2](ADR-056-questions-parametrees.md) (the
evaluator of parameters is mathjs, and this record adds no second use of it)
and [§10](ADR-056-questions-parametrees.md) (parameterized keys stay with
`mcq`, `short` and `cloze`), [ADR-069](ADR-069-calculatrice-fournie.md)
(the CSP refuses `eval`; `\log` and `\ln` read as the provided calculator
does), [ADR-019](ADR-019-simulation-de-circuit.md) (behaviour is compared,
never form), [ADR-044 §2](ADR-044-grille-de-correction.md) (the grading
column, and a regrade reads the same verdict) and
[ADR-033](ADR-033-projection-de-la-correction.md) (the debrief groups by
the text typed). Amends `docs/spec/04-types-de-questions.md` by its §4.16
and `docs/spec/02-exigences-fonctionnelles.md` by F-QST-12.

## Context

Physics, electronics and mathematics courses ask for a formula as an answer
— "give the equivalent resistance of $R_1$ and $R_2$ in parallel" — and
want it graded automatically, whatever its form: `R_1 R_2 / (R_1 + R_2)` and
`1 / (1/R_1 + 1/R_2)` are one answer, `R_1 + R_2` is the series mistake
(issue #460, modelled on STACK's workflow in Moodle). No type does it today.

- `short` cannot carry it. Its `lowercase` prefilter folds `R` and `r`
  into one name; its `number` matcher compares one value, not a function;
  the domains of several symbols, a tolerance over a sample and a graph have
  no place in a config whose every `kind` shares the fields (§4.5); and a
  poll groups `short` answers by their text (ADR-033).
- The API process holds no computer algebra system, and nothing on the
  serve path waits for the runner (ADR-056 Alternatives, ADR-101): a formula
  must be graded in pure TypeScript, instantly, on the server, for the
  immediate feedback of an exercise — and in bounded time, since grading
  runs on the API's thread and a student chooses the text.
- The browser's CSP refuses `eval` and `new Function`
  (`apps/api/src/csp.ts`, ADR-069): an evaluator that compiles an expression
  to JavaScript is out, on the client as on the server, where the same rule
  keeps one code path for both.
- The verdict of an answer must not depend on the paper it was written on: a
  regrade (ADR-044 §2), the preview and the debrief (ADR-033) read one
  verdict for one text.
- MathLive's `<math-field>` is already a dependency of `apps/web`
  (`FormulaDialog`), and its sibling parser, Compute Engine, is pure
  JavaScript. Invariant 4 (`toStudent`) and 05 §5.7 bound what the student
  view may carry.

## Decision

1. **A dedicated type, `math`** (option B of issue #460), in
   `packages/qt-math`, registered through both registry entry points, shown
   as "Math expression" / « Expression mathématique ». `QuestionTypeId`
   gains `math`. Its rules are owned by `docs/spec/04` §4.16; this record
   owns why.

2. **The field is MathLive's `<math-field>`, the stored answer is LaTeX.**
   `MathField.tsx` loads MathLive lazily (`import("mathlive")`) and falls
   back to a plain LaTeX input where the web component cannot load, so the
   surface is never blank. MathLive's own keyboard toggle sits inside the
   field, and its virtual keyboard opens on focus on a touch screen (policy
   `auto`); the type adds no button of its own. The answer is `{ latex }`
   (at most 300 characters, `MATH_MAX_LATEX`); `isAnswered` is "not
   blank". The editor types the accepted answers in the same field.

3. **Compute Engine (`@cortex-js/compute-engine`) parses and
   canonicalises; a float interpreter of ours evaluates; the server
   re-reads.** `readMath(latex, options)` in `@quiz/domain/math` turns the
   LaTeX into Compute Engine's canonical MathJSON tree, so `\frac{1}{x}`,
   `x^{-1}` and `1/x` are one reading, `2x` a product, `\sin^2 x` a power
   of a sine. The engine never evaluates anything: its arithmetic is exact
   and unbounded, and a thirteen-character answer, `x+10^{10^{6}}`, held
   the API's thread for 87 s under its `N()` — a denial of service on
   grading. The values come from a small interpreter of the canonical tree
   over JavaScript floats (`OPERATORS`: `Add Negate Multiply Divide
   Rational Power Sqrt Root Abs Ln Log Sin Cos Tan Arcsin Arccos Arctan
   Sinh Cosh Tanh`, the constants `Pi` and `ExponentialE`), whose cost is
   the size of the tree, bounded by the length cap; a power that overflows
   is simply no value. Any other construct the engine can produce — a sum,
   an integral, a derivative, a factorial, a complex number, `min`/`max`,
   an equation, an infinity — is refused at read time with the problem
   `unsupported` (naming the operators), so the echo says so while typing.
   A read fails on the first problem met, in this order: `empty`,
   `too_long`, `syntax`, `unknown_symbol` (with the names), `unsupported`,
   `forbidden_function`. **The parse is bounded too**, the way ADR-099
   bounds a regex before it costs anything: two shapes measured exponential
   in the engine's parser — a run of adjacent signs (`------x`: 18 signs,
   250 ms, doubling with each one) and absolute-value bars nested deep
   (`||||x||||`, `\vert` likewise: 60 levels never finished) — are refused
   lexically before the parser runs (`parsesInBoundedTime`: a run of three
   or more `+`/`-` once whitespace is removed; more than 8 bar tokens `|`,
   `\vert`, `\lvert`, `\rvert`, `\mid`), reported as the `syntax`
   problem, as is a numeral the engine cannot hold (`1e999…`), which used
   to throw. The grader reads the STORED LaTeX again on the
   server; what the browser computed is an echo and nothing else. There is
   no grammar of our own (ADR-056 rejected one), and neither Compute
   Engine's `compile()` (which uses `new Function`) nor its `N()` is ever
   called: the CSP of ADR-069 is untouched. The reading conventions are
   the provided calculator's (ADR-069): `\log` is base 10 (`\log_b` with
   its base), `\ln` natural, angles are in radians, and `e`, `i` and `pi`
   are constants (`MATH_RESERVED_SYMBOLS`), refused as symbol names. A
   symbol name follows `MATH_SYMBOL_PATTERN`: a letter, letters and digits,
   an optional `_subscript` (`x`, `R1`, `R_1`, `omega`).

4. **Grading by numerical equivalence, no CAS.** The key and the answer are
   evaluated at `samples` points (default 10, 3 to 50) drawn uniformly in
   each symbol's `[min, max]`. Two values agree when
   `|k − a| ≤ tolerance × max(|k|, |a|, K)`, with `K` the largest `|k|`
   over the sample: relative, with a floor at the key's magnitude so a
   near-zero value of a large function does not fail on float noise
   (`compareMath`, which returns `{ equivalent, compared }`; `tolerance`
   relative, default `1e-6`, at most `0.5`). A point where the key has no
   real value (a pole, a root of a negative number, an overflow) is
   skipped; a candidate without a value where the key has one is wrong; a
   first key with no value anywhere on the domain is refused at
   publication (`math.key_undefined`). **The points are derived from the
   QUESTION's content** — `samplePoints` seeded by `hashSeed("math", <first
   key>, <symbols>)` — never from the attempt's seed: the same text gets
   the same verdict on every paper, in the preview and on a regrade
   (ADR-044 §2, ADR-033). As `circuit` compares waveforms (ADR-019), `math`
   compares values, never form.

5. **Accepted answers are an ordered list.** `answers[]` holds `value`
   (LaTeX) and `points` (0 to 1, a fraction of the item); the first that
   matches wins, like `short`'s matchers, and the item earns
   `round2(points × itemPoints)`. Each key must read against the symbols
   (`math.key_<problem>` at publication: `math.key_syntax`,
   `math.key_unknown_symbol`, `math.key_unsupported`…). Anticipated
   mistakes with a feedback are a later addition of the same list, without
   a migration.

6. **The field's rules travel to the student and are enforced while
   typing** (04 §4.5: a constraint says what the field accepts). They are
   ONE object, `fieldRules(config)` → `{ symbols: <the names>, forbidden,
   maxLength }`: `forbidden` names functions from the closed list
   `MATH_FUNCTIONS` (`sin cos tan asin acos atan sinh cosh tanh sqrt exp ln
   log abs power`; `e^x` counts as `exp`); `maxLength` is 10 to 300,
   default 200. Under the field, the echo "Read as" shows the parser's
   reading rendered, or the problem with what fixes it (the declared names
   for an unknown variable, the function at fault, the construct that has
   no value here). A non-blank answer still unreadable at the close is
   worth 0 with `details.status = "invalid"` and the whole problem
   (`MathProblem`) stored in `details.problem`: the review says "Not
   readable" and why, from the stored problem, without re-parsing; the
   teacher may override it in the grading table. A blank or absent answer
   is no answer: 0, `status: "graded"`. There are no `required` functions:
   a requirement is gamed by `x + \sin x − \sin x` and is a form check in
   disguise, deferred with the others (decision 11).

7. **`toStudent` spreads `fieldRules(config)` into the view beside the
   prompt and `plot`; it strips the keys, the intervals, the tolerance and
   the sample count.** The student view IS the reading options: the player
   reads the answer with the view itself, and the grader with
   `fieldRules(config)`, so what the field accepts and what the grader
   reads cannot differ. A key is read against the symbols alone. The
   details are `{ status, problem?, matchedIndex, fraction, latex }`;
   `studentDetails` drops only `matchedIndex` while the key is hidden.

8. **An optional graph, `plot: "none" | "answer" | "target"`, with exactly
   one symbol** (`math.plot_one_symbol`). The student's expression is drawn
   in plain SVG over the symbol's interval as they type; the student view
   then carries `axis: { from, to }`, that interval. With `"target"`, the
   first key's curve travels as VALUES only — `target: (number | null)[]`,
   64 values (`MATH_PLOT_POINTS`) on the even grid over `axis`, `null`
   where the key has no value — never its text: a deliberate numeric exit
   of the key, in the spirit of 05 §5.7 and like `circuit`'s
   `showExpected` (04 §4.11), tested in `toStudent.test.ts`. The grading
   points are random (`samplePoints`), never the plotted grid. No GeoGebra
   applet: the CSP, the bundle, and SEB and kiosk sessions rule an
   embedded applet out.

9. **The other surfaces follow the existing rules.** The grading table has
   one column, the LaTeX as a chip tinted by its verdict, sorted by the
   normal form of the text (ADR-044 §2); the live cell shows the LaTeX on
   one line; the debrief groups by the text typed, as `short` (ADR-033) —
   not by equivalence. The three surfaces are lazy (`React.lazy`), the
   host's Suspense covering the load. Not shuffleable; `defaultPoints` 1.

10. **Security and performance.** The student's text is capped at
    `MATH_MAX_LATEX` (300 characters) before the parser sees it, and the
    two exponential shapes are refused lexically (decision 3); the
    evaluation is the interpreter's, linear in the tree, never the
    engine's. Measured on 2026-10-11: under 300 characters every other
    shape stays within ~120 ms (300 letters of implicit multiplication,
    the worst), and an answer written by a person parses in 1 to 3 ms.
    The bound serves N-PERF-02 (an autosave answered under 200 ms): the
    live grader runs the parse on every autosave. The engine is NOT
    stateless: it declares every symbol name it meets in its global
    scope, and a stream of fresh names made a read 16× slower after
    20 000 reads (a pushed scope per read made it worse, measured), so one
    engine per process is built on first use (~40 ms) and recycled every
    1000 reads (`ENGINE_READS`), which keeps the cost flat (~0.8 ms per
    read over 12 000 fresh-name reads). Compute Engine is pinned exactly
    in `@quiz/domain` (`0.58.0`), as mathjs is (ADR-056 §2): a verdict
    depends on how a text is read, and an upgrade must not change one
    silently.

11. **Out of this prototype, to be settled later**, each without closing a
    door: parameterized keys (ADR-056 §10 keeps `mcq`, `short` and `cloze`;
    the amendment that admits `math` must say an interpolated value reads
    as one parenthesised number); equations, inequalities, intervals, sets
    and vectors as answers; form checks (simplified, factored, expanded,
    a required function — a sympy image in `apps/runner` if ever, never a
    CAS in the API process); a maximum degree (a syntactic proxy,
    dropped); drill and polls (`DRILL_TYPES` and `POLL_TYPES` unchanged);
    a formula blank in `cloze` on the same engine; negative marking;
    anticipated mistakes with a feedback; sharing `MathField` with
    `apps/web`'s `FormulaDialog` (a follow-up); a `fractionTone` shared in
    `@quiz/ui` for the chips tinted by a fraction of the points; moving the
    parse off the event loop (a worker) if a future measurement needs it.

## Consequences

- A formula is accepted in any equivalent form, graded on the server in
  pure TypeScript, instantly, with no runner on the path: an exercise can
  give immediate feedback, and a regrade reads the same verdict.
- A syntax slip is told while typing and never graded as a mistake of
  mathematics; the teacher sees "Not readable" and keeps the last word.
- **Security: grading is bounded by the text's length.** The engine only
  parses, in a few milliseconds for a human answer and ~120 ms at worst
  under the 300-character cap once the two exponential shapes are refused
  lexically; the interpreter's work is the size of the tree, which the cap
  bounds, and a value too large is simply none. Had the engine's exact arithmetic evaluated, one short
  answer could hold the API for minutes, and it was observed to (decision
  3). The price is a closed vocabulary: a sum, an integral, a derivative,
  a factorial or an equation is told "not available here" while typing,
  and the key is held to the same vocabulary at publication
  (`math.key_unsupported`).
- **Bundle**: MathLive (~300 kB) and Compute Engine (~1.1 MB) are loaded
  lazily, only when a `math` question is opened (`React.lazy` on the three
  surfaces, `import("mathlive")` in the field); neither enters the initial
  bundle (N-PERF-05). `@quiz/domain` gains a dependency that the API loads
  once per process.
- **The target plot is a numeric exit of the key**, chosen by the teacher
  per question, as `showExpected` is for `circuit`: 64 values of the first
  key over the window. A student can read values off it, not the formula.
  With any plot, the window IS the plotted symbol's interval, so that
  interval is no longer hidden; a teacher who wants it secret keeps
  `plot: none`.
- **A wrong function that coincides with the key at every sample point is
  accepted**: with ten points drawn at random over the domain and a
  relative tolerance of `1e-6`, the probability is negligible for the
  functions a course asks for. Conversely, the domain is part of the
  question: `\sqrt{x^2}` equals `x` on `[0.5, 2]` and not on `[-3, 3]`,
  which is what the teacher means by declaring the interval (issue #460).
- A key undefined on part of the domain is compared on fewer points; a
  candidate is judged only where the key has a value. A key that does not
  read in a stored version is skipped by the grader, and publication keeps
  that from happening to a new version.
- Work: the strings in `en` and `fr` (N-I18N-01; the problem sentences
  once, under `qt.math.problem.*`), the issue keys of
  `apps/web/src/question/issues.ts`, the registry entries, the leak fixture
  of `testing.ts` in the registry's contract test, and the documentation
  of §4.16, the guide and the repository map.

## Alternatives considered

- **A `math` kind of `short`** (option A of issue #460). Lowercase folding
  merges `R` and `r`; the per-symbol intervals, the tolerance over a sample
  and the plot would be fields every other `kind` carries and never reads;
  the poll tally and the stats would group by text as `short` does. One
  more package costs less than a `short` that is two types.
- **A hand-written parser.** One more grammar to secure and document
  (ADR-056 rejected a language of our own); Compute Engine already reads
  what MathLive writes, and its canonical form is what makes `\frac{1}{x}`
  and `x^{-1}` one reading.
- **Compute Engine's own evaluation (`N()`).** The first prototype used
  it: exact, unbounded arithmetic, and `x+10^{10^{6}}` held the thread for
  87 s. A float interpreter of twenty operators costs a page of code and
  is linear in the tree.
- **A pushed scope per read, or a fresh engine per read**, instead of
  recycling. A pushed scope measured slower than the global one; a fresh
  engine costs ~40 ms a read, forty human answers' worth. Recycling every
  1000 reads keeps the cost flat.
- **Symbolic equality** (Compute Engine's own simplifier, or a CAS). A
  simplifier decides `(x+1)^2 = x^2+2x+1` some days and not others, and a
  CAS in the API process is exactly what ADR-056 kept out; numerical
  equivalence is what Numbas does by default and what `circuit` already
  does.
- **Required functions**, as the first prototype had beside the forbidden
  ones. Trivially gamed (`x + \sin x − \sin x`): what a teacher means by
  "use the sine" is a check of form, which belongs with the other form
  checks of decision 11.
- **STACK/Maxima, or sympy through the runner.** The right tool for form
  checks, and a round trip to the runner for every answer at the close of
  an exam, with an exam that breaks when the runner is down (ADR-101).
  Kept for the form checks of decision 11, if ever asked.
- **A GeoGebra applet** for the input and the graph. An iframe or a script
  the CSP would have to admit, megabytes in the bundle, and a surface SEB
  and the kiosk cannot vouch for; a `<math-field>` and an SVG polyline are
  the whole need.
- **Sample points drawn from the attempt's seed** (as parameters are,
  ADR-056 §5). Two students who wrote the same text could get two
  verdicts, and a regrade or the preview would read other points than the
  paper did (ADR-044 §2, ADR-033).
