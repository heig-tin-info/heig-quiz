# 4. Question types

## 4.1 Contract of a question type

A type is a TypeScript package that exports a `QuestionType` object:

| Member | Role |
|---|---|
| `id` | Stable identifier, e.g. `mcq`. Used in the database and in the canonical format. |
| `configSchema` | Zod schema of the configuration, statement included. Validated at publication and at import. |
| `answerSchema` | Zod schema of the student's answer. Validated at every autosave. |
| `defaultPoints(config)` | Default points when the question is added to an evaluation. |
| `toStudent(config, seed)` | Returns the configuration visible to the student: no key, no explanation, no hidden tests, choices shuffled according to the seed. Pure function, tested. |
| `grade(config, answer, ctx)` | Returns `{ points, maxPoints, details }` or `{ pending: 'runner' | 'llm' }`. `ctx` provides the seed, the item's points, and the runner and LLM services. |
| `distinctTexts(config)` | Optional (`mcq`). The texts an instance of a parameterized question keeps distinct (ADR-056 §7). Variables themselves are a header field of the version, instantiated by the API before any hook is called, never by the type. |
| `parameterIssues(template)` | Optional (`short`). What a parameterized template may not do although its instances could (a computed text key, ADR-056 §10). |
| `sampleIssues(template, sample)` | Optional (`short`). What a parameterized template may not do given the values publication drew: a tolerance below half the step of its key's format (ADR-056 §6). |
| `Editor` | React component for editing the draft. |
| `Player` | React component for answering. Receives the student configuration, the current answer, an `onChange` callback. |
| `Review` | React component for review: answer, key, grading, for the teacher and for the student feedback. |
| `toCanonical` / `fromCanonical` | Conversion from and to the canonical format, if it differs from the raw configuration. |
| `configVersion`, `migrate(config, from)` | Version of the configuration schema and upgrade on read. Lets a type evolve without an SQL migration, see 5.2. |
| `generate(ctx)` | Optional. The type's LLM templates for "Generate the answer", "Generate the explanation", "Generate a variant", see 8.2. |
| `searchText(config)` | Text indexed for the full-text search of the pool. |

Rules:

- A type has no tables. Its configuration and its answers live in JSONB in the core tables.
- A type makes no direct network call. It goes through `ctx.runner` and `ctx.llm`.
- A type has no drill hook (ADR-041 §4). A question is drillable when its type is in the drill's scope — `mcq`, `short`, `cloze` and `categorize` in v1, `DRILL_TYPES` in `@quiz/domain` — and `grade` settles its answer automatically and finally: graded at once, not pending a runner or an LLM, not a proposal for the teacher. The drill takes its correctness from `grade`'s points and its time from the review.
- The phase 1 types live in the monorepo under `packages/qt-*`, with two entry points `server` and `client`, see 5.2. Loading is static, through two registries.

## 4.2 Canonical format

One YAML file per question. Images live in a sibling `assets/` folder, referenced by relative path.

```yaml
id: 01J8Z3K9M2X5V7N4Q6R8T0W2Y4      # stable ULID, generated at creation
type: mcq
name: pointeurs-arithmetique-01      # internal name
tags: [c, pointers, arithmetic]
difficulty: 2
version: 3
shuffleable: true
explanation: |
  `p + 1` avance de `sizeof(*p)` octets, donc de 4 pour un `int`.
config:
  prompt: |
    Soit `int *p` pointant sur l'adresse `0x1000`. Que vaut `p + 1` ?
  choices:
    - { text: "0x1001", correct: false }
    - { text: "0x1004", correct: true }
    - { text: "0x1008", correct: false }
  policy: all_or_nothing
```

The `config` field is specific to the type. The header fields are common. Exporting a pool produces `pool.yaml` with its metadata, one folder per category, one file per question. Import honours the `id`s: an existing question with the same `id` receives a new version if the content differs.

## 4.3 Random values

Available for `mcq`, `short` (a `number` matcher) and `cloze`; `code` later. Decided by [ADR-056](../adr/ADR-056-questions-parametrees.md), which replaces the first design of this section (ranges with a step, `{{R1}}`).

```yaml
variables:
  - { name: h, expr: "randint(1, 100)", format: int }
  - { name: g, expr: "choice([3.71, 8.87, 9.81, 24.79])", format: ".2" }
  - { name: t, expr: "sqrt(2*h/g)", format: ".2" }
condition: "t > 1"
```

- `variables` is a header field of the version, beside `explanation`, not part of the type's configuration. A question with at least one variable is **parameterized**; `randomizable` is derived from it at publication.
- Expressions are evaluated by a restricted mathjs instance (a whitelist of functions, no `import`, `parse` or `evaluate`, capped length and tree, no ranges); `randint`, `uniform` and `choice` draw from `streamSeed(attempt.seed, item.id, "vars")`. A row reads the rows above it; the optional `condition` rejects a draw, retried at most 100 times.
- The statement, the choices, the keys, the blanks and the explanation use `[[h]]` or `[[sqrt(2*h/g)]]`, only in a parameterized question; `\[[` escapes. An unknown name is a publication error. A cloze blank reads `{{#[[t]]:1%}}`.
- A variable is its formatted value (`int`, `.n` decimals, `ns` significant figures), rounded half away from zero; the dot is the decimal separator in every language.
- The values are drawn the first time the item is served in an attempt and STORED with it; every later read (review, regrade, feedback) uses them. A retake has a new seed, so new values.
- Instantiation is one pass that turns the version into an ordinary static one before `toStudent`, `grade` or `Review` see it. The variables never reach a student (5.7).
- Publication validates on 200 draws, on every write path. The editor shows five instances computed by the API; "freeze" comes later. A poll refuses a parameterized question.

## 4.4 Multiple choice `mcq`

**Configuration** (config version 2): `prompt` markdown, `choices[]` with `text` markdown and `correct`, `mode` `single` or `multiple`, optional `maxSelections`, `policy` one of the five below or `inherit` (default), `shuffleChoices`. Version 1 carried a `penalty` factor and an `allowNegative` flag; the v1 → v2 migration maps `partial` and `penalized` onto `symmetric` and drops both fields.

**Answer**: `selected[]` indices of the choices in canonical order. Shuffling is applied by `toStudent`; the answer is always in canonical indices.

**Which rule applies**, in this order:

1. the evaluation uses **negative marking** (`settings.negativeMarking`, ADR-026): every choice question of the evaluation, single or multiple answer, is scored with the negative rule below, whatever its policy (the same setting covers `categorize` with a rule of its own, §4.13, ADR-036);
2. otherwise a `single` question is always `all_or_nothing`;
3. otherwise the question's own `policy`, or, when it says `inherit`, the evaluation's `mcqPolicy` (seeded at creation from the teacher's preference).

**Scoring**, with C correct choices, W distractors, c correct ones ticked, w distractors ticked. The formulas live in `@quiz/domain/mcqScore`:

| Policy | Formula | Comment |
|---|---|---|
| `all_or_nothing` | 1 if c = C and w = 0, otherwise 0 | Default |
| `true_false` | (c + (W − w)) / (C + W) | Every choice is its own true/false item |
| `discordance` | d = (C − c) + w; d = 0 → 1, 1 → 0.5, 2 → 0.2, more → 0 | French medical QRM convention |
| `symmetric` | max(0, c/C − w/W) | Zero expectation before the floor |
| `ripkey` | 0 if w > 0, otherwise c/C | One wrong tick voids the question |

The five policies lie in [0, 1]: a question is never worth less than no answer.

**Negative marking** (evaluation setting, ADR-026): f = c/C − w/W, not floored, in [−1, 1]; with a single answer among n choices, +1 for the key and −1/(n − 1) for a distractor. No answer (nothing ticked, "Leave unanswered", cleared) is 0. Random guessing has an expected value of 0. The per-question points may be negative and are shown as such; the TOTAL of the evaluation is floored at 0 (`attemptTotal`), and the grade is computed from it. The student is told in the waiting room and on each choice question; a `poll` refuses the setting.

The fraction is multiplied by the item's points and rounded to the hundredth.

**Editor**: list of choices, one checkbox per choice to mark it correct, add with Enter, reorder by drag, live preview.

## 4.5 Short answer `short`

**Configuration** (`configVersion: 2`): `prompt`, `kind` `text` / `number` / `date` / `time`, the `constraints` of that `kind`, the question's `prefilters`, and `matchers[]` evaluated in order; the first match awards the points.

**Field constraints**: they say what the field ACCEPTS, never what it expects. They are therefore not part of the key: `toStudent` passes them through and the player enforces them in the input, where the browser applies them itself.

| `kind` | Constraints | Student's field |
|---|---|---|
| `text` | `minLength` default 0, `maxLength` default 255, hard cap 500 | `input type="text"` with `minlength` and `maxlength` |
| `number` | optional `min` and `max` (empty = unbounded), `integer` default false | `input type="number"` with `min`, `max` and `step` |
| `date` | optional `from` and `to` | `input type="date"` with `min` and `max` |
| `time` | none | `input type="time"` |

Only one constraint bears on grading: `integer`. A non-integer answer to an integer question is worth 0, whatever the matchers. The others belong to the field, never to the grade scale: an answer recorded before a constraint was tightened is graded on its merit. A `number` matcher whose expected value is not an integer in an integer question is refused at publication, with the key `short.integer_expected`.

**Prefilters**: two normalisations decided ONCE for the question, applied to the student's answer AND to every `exact` value before the comparison. The input of a `regex` undergoes them too; its `i` flag, however, remains its own.

| Prefilter | Default | Effect |
|---|---|---|
| `trim` | true | Removes leading and trailing whitespace, on both sides |
| `lowercase` | true | Compares in lowercase, French folding, accents stay significant (decision D9) |

Runs of whitespace inside an answer are always collapsed to a single space. In v1 these three settings lived on each `exact` matcher (`caseSensitive`, `trim`, `collapseSpaces`): the v1 → v2 migration reads `trim` and `caseSensitive` from the FIRST `exact` matcher to make them the question's prefilters, then removes them from every matcher.

| Matcher | Fields | Semantics |
|---|---|---|
| `exact` | `value` | Equality after the question's prefilters |
| `regex` | `pattern`, `flags` | Full match, on the prefiltered input |
| `number` | `value`, `tolerance`, `toleranceMode` `abs` / `rel`, optional `unit` accepted or ignored | Numeric comparison, comma and dot accepted |
| `date`, `time` | `value`, `tolerance` in days or minutes | Local formats accepted, normalised to ISO |
| `llm` | `rubric` markdown, optional `reference` | Proposed LLM grading, phase 2 |

Each matcher may carry `points` as a fraction, default 1, to accept a partially correct answer.

**Editor**: the `kind` is a segmented control, the constraints of that `kind` sit on the same line, to its right; the prefilters are two checkboxes below the list of accepted answers.

**Answer**: `text` string.

## 4.6 Fill in the blanks `cloze`

**Configuration**: `text` markdown containing blanks, global `caseSensitive` default false. The player renders the markdown with a field or a dropdown at each blank. Blanks have equal weight by default.

Blank syntax, inspired by Moodle Cloze, simplified:

| Syntax | Meaning |
|---|---|
| `{{Newton}}` | Text field, answer `Newton`, normalised equality |
| `{{Newton\|Isaac Newton}}` | Accepted alternatives |
| `{{=Newton\|Maxwell\|Faraday\|Galilée}}` | Dropdown, `=` marks the correct option, shuffled order if the question is shuffleable |
| `{{#3.14:0.01}}` | Numeric with absolute tolerance |
| `{{#3.14:1%}}` | Numeric with relative tolerance |
| `{{/^[0-9a-f]+$/i}}` | Regular expression |
| `{{2*Newton}}` | Weight 2 for this blank |
| `\{{` | Literal braces |

Inside a markdown code block the blanks stay active, which allows "complete this code". A `code` question does not use this syntax.

Inside a blank, a backslash before an ASCII punctuation character makes that character literal: `\|`, `\}`, `\*`, `\\` are the four one meets, and the rule is broader so that the blank editor (below) can write any answer; an answer starting with `#`, `/` or `=` would otherwise become a number, a regex or a dropdown.

**Blank editor.** The body of a blank is a grammar, not a value: one does not type it. Typing `{{`, clicking an existing chip, pressing the "Insert a blank" button or Enter on a selected chip opens a card anchored under the chip, which asks for the FORM of the blank (any of these answers, dropdown, number, regex) plus the weight. It reads the existing body and rewrites it with the domain functions (`parseBlankBody` / `formatBlank`), never by concatenation: what the card shows and what the grader reads cannot diverge. The raw syntax remains available in the markdown source pane.

**A blank in a table cell.** An unescaped `|` separates two columns, but a `|` INSIDE a blank is not one. On the domain side this is settled: `parseCloze` runs BEFORE the markdown and replaces every blank with a sentinel (decision D5), so the row is split on a cell that no longer contains a bar. On the rich editor side, it is the editor's job to guarantee it: it replaces the `|` of a blank body with a private-use character on read and restores it at the very end of serialisation, after the table rendering has aligned its columns. `{{=passante|bloquée}}` in a cell is therefore ordinary writing.

The `label`s of a dropdown reach the student, they are the options, but `correct` never does.

**Answer**: `blanks[]` strings in order of appearance.

**Scoring**: sum of the weights of the correct blanks over the sum of the weights.

## 4.7 Code `code`

**Configuration**:

```yaml
config:
  prompt: markdown
  language: c            # c, cpp, python, js, rust in phase 1
  runtime: backend       # backend (default) or runno, see "Where the trial runs"
  template: |            # initial code, with locked regions
    #include <stdio.h>
    // @@lock
    int main(void) {
    // @@endlock
        // votre code
        return 0;
    }
  files:                 # additional files read by the program, optional
    - { name: data.csv, content: "..." }
  action: run            # check compiles only, run executes
  compileArgs: "-Wall -Wextra -std=c17"
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 }
  runsPerMinute: 10
  cooldown: fixed        # or progressive (ADR-024)
  tests:
    mode: io             # io or tap
    cases:
      - { name: "cas simple", stdin: "3 4\n", expected: "7\n", visible: true, points: 1 }
      - { name: "négatifs", stdin: "-3 4\n", expected: "1\n", visible: false, points: 1 }
      # command line: args becomes argv[1..] of the program
      - { name: "somme argv", args: ["3", "4"], expected: "7\n", visible: true, points: 1 }
      # the two checks are independent: here only the exit code counts
      - { name: "refuse un argument invalide", args: ["oui"], expected: "",
          compareStdout: false, expectedExitCode: 1, visible: false, points: 1 }
    compare: { trimTrailing: true, ignoreCase: false, numeric: null }
```

- **Locked regions**: marked by `@@lock` / `@@endlock` comments in the language's comment syntax (`@@unlock` is a synonym of `@@endlock`). The author does not type them: selecting lines and pressing the lock button writes them, and the editor reports an unknown marker or an unlock with no open lock by its line; a lock left open runs to the end of the file. The player shows the whole program in ONE editor, locked lines greyed and read-only, marker lines hidden but counted, so a compiler's line numbers are the student's (ADR-024). The server rebuilds the final file from the template and the editable regions, never from the client's raw text, which prevents a locked region from being modified.
- **Reference solution, split like the template**: `referenceSolution` is not a complete file, it is the content of the EDITABLE regions of the template, in their order. With a single editable region, the whole reference is that region. With several, the pieces are separated by an `@@next` marker LINE, written in the language's comment syntax exactly like `@@lock` and `@@endlock` (`/* @@next */` or `// @@next` in C, `# @@next` in Python); the marker line disappears along with the line breaks around it. The author writes it in the student's editor, one region per template region, prefilled with the template's text; the markers are written for them. If the number of pieces does not match the number of regions, the editor says so and attempts nothing: the source is always rebuilt from the template (invariant 14), never taken as-is.
- **`io` mode**: each case sends `stdin`, possibly a command line, and checks what the teacher asked for. This is the phase 1 mode.
- **`args`, the command line of a case**: an array of strings, one per argument, which becomes `argv[1..]` of the program (`sys.argv[1:]` in Python, `process.argv.slice(2)` in JS). The runner passes them to the program as process arguments, never through a shell: a space, an apostrophe, a `$` or a `;` inside an element is a character of that element, not a separator. When absent, the program is launched without arguments.
- **The two checks of a case are independent**, and a case must enable at least one (otherwise the configuration is refused: `code.case_checks_nothing`):
    - `compareStdout` (default `true`) compares `expected` to the standard output according to `compare`;
    - `expectedExitCode` (default `0`, `null` = any) compares the process exit code.

    The verdict of a case is read in this order: it fails on an accident (wall clock exceeded, memory cap reached, process killed without a clean exit code), then **every enabled check must pass**; a disabled check says nothing. A case that does not compare `stdout` exposes no expected output, neither to the player nor in the grading details.
- **Where the trial runs, `runtime`** (ADR-015), under "Advanced options" as "Instant" / "Same as grading"; a new C or Python question starts in the browser (ADR-024): `backend` (the schema default) runs the student's trial in the containerised runner; `runno` runs it in the browser, in WASI inside a Web Worker, for the only languages that runtime embeds: **C and Python**. The runtimes are hosted by the platform, never loaded from a third party at request time. Any other language falls back to `backend`, as does a browser that cannot start the worker.

    **The browser runs, the server grades.** `runtime` only describes the student's "Run" button: grading always goes through the server's runner, which rebuilds the source from the template and the editable regions. A result produced by a browser is not proof. WASI is not Linux (no `fork`, no signals, partial `<sys/…>`, the browser's clocks and randomness), so a trial that passes in the browser can still fail at grading: the player presents the trial as a trial, and the editor warns the author when the reference passes on the server but not in the browser.
- **`tap` mode**, phase 3: the teacher provides `testFile` and `command`. The runner executes the command and reads a TAP stream on stdout: `ok 1 - name` and `not ok 2 - name`. Each line is a case. TAP libraries exist for C, Python, JS, Rust.
- **Points**: the sum of the cases' points. An `allOrNothing` option on the question gives all or nothing.
- **Player buttons** (ADR-024): **Compile** builds and reports the compiler's messages, at their line in the editor (`RunBody.compileOnly`); **Run the tests**, the primary action, launches the visible cases and shows for each the command line, stdin, the expected output (when it is compared), the obtained output and the verdict; **Free try** opens a stdin area with its own command line, the only place where arguments come from the browser. Hidden cases are only run at grading. The last result of each tool stays on screen, and running the same code again is allowed. **Run the tests** and **Free try** share one cooldown and refill after each use: `cooldown: fixed` waits 3 s, `progressive` 3 s then 30 % longer each time up to 30 s, forgiven when the student pauses; a server run never waits less than `60 s / runsPerMinute`. **Compile** has no cooldown (one at a time only): on the server it spends a budget of its own, `compilesPerMinute = min(60, max(20, 3 × runsPerMinute))`, and never a test run, and a test run never spends a compilation. A refused run (429) reads "Too many runs in a minute" under the buttons (ADR-024, addendum of 2026-09-25).
- **Arguments** are entered one per numbered row (`argv[1]`, `argv[2]`…, `argv[0]` shown as the program), with a preview of the command line quoted as a shell would need it.
- **Answer**: `regions[]` content of each editable region, `lastRun` summary of the last run for the dashboard.
- **Code editor**: Monaco, theme aligned with the platform, VS Code shortcuts, configurable tab width, no language server.

## 4.8 Rich answer `rich` ("Essay")

Shown as **Essay** / « Rédaction » in the interface; the id `rich` is the one stored in the database and in the canonical format. Brought forward from phase 2 in a first version graded by hand (issue #192, `packages/qt-rich`).

**Configuration** (`configVersion: 1`): `prompt`, `rubric` markdown (may be empty), optional `reference` model answer (markdown), optional `maxChars`, `format` `markdown` (default) or `plain`.

**Limit**: in CHARACTERS, not words — a schema can count characters, and a word is ambiguous in code or a formula. It is counted on the stored text, markdown marks included (UTF-16 code units, what `String.length` and a textarea's `maxLength` count). `maxChars` is 1 to 50 000; an answer never exceeds 50 000 characters whatever the question says (`answerSchema`), because the autosave sends the whole answer every 300 ms. The server refuses an answer over the question's `maxChars` with `422 answer_invalid` (`answerMisfit`, key `rich.too_long`); the player never sends one — past the limit it shows the excess in red and sends nothing until the answer fits. The editor and the player translate a count into A4 pages at 3 000 characters a page, as a hint.

**Student**: `toStudent` keeps `prompt`, `format` and `maxChars`; the rubric and the model answer never leave (invariant 4). `format: markdown` gives the student the host's formatted editor (`PlayerProps.RichText`, lent without an image upload); `plain`, a textarea.

**Answer**: `{ text }`, markdown or plain text according to `format`. No image in v1: pool assets are readable by every teacher session of the pool, and a student upload would need an ADR on personal data and retention.

**Scoring, v1**: manual. `grade` proposes 0 points (`state: proposed`, `details.reason: manual`) for a written answer, and a validated 0 for nothing written (`reason: empty`); the teacher sets the points and a comment in the grading panel, which shows the answer beside the rubric and the model answer (`toSolution`). The dashboard cell shows the character count, never the text. Not pollable, no drill.

**The key a student reads**: the rubric never reaches a student, even under `showKey`; the `studentSolution` hook keeps the model answer alone, or nothing (ADR-037).

**Scoring, later**: `grade` returns `pending: 'llm'`. The LLM service receives the statement, the rubric, the reference, the anonymised answer, and must reply in JSON: points per criterion, short justification per criterion, confidence `low` / `medium` / `high`. The teacher validates in the grading panel (F-LLM-01..04). A rubric of criteria with `label`, `points` and `description`, used as the grading form, comes with it.

*Amendment (ADR-045): the path exists, with a development stub as its only provider. `grade` returns `pending: 'llm'` when the process has an LLM service (`GradeContext.llm`, `LLM_PROVIDER`) and the question has a rubric or a model answer; the request holds the rubric, the model answer, the answer text and the item's points, not yet the statement nor a per-criterion reply. The pass writes the reply as an `llm` proposal with its confidence, the justification in its details for the teacher only (open question 27). Without a service, v1's manual scoring above is unchanged.* *Amendment (ADR-063): wired to the real model through the gateway, automatically after the close, through a `grading.llm` job per answer. The request holds the statement too, the answer masked of the names of the students who sat; the reply holds a breakdown per criterion, read by the model from the free-text rubric (the structured rubric above stays deferred), kept with the model's name under `details.ai`, teacher-only like the justification. A successful proposal is not asked again except by a re-grade.*

## 4.9 Code image `codeimage`

A variant of `code` (ADR-021): the same program, judged by the **picture it prints** instead of by test cases. It lives inside `packages/qt-code` (`src/image/`), registered as its own type beside `code`. Brought forward from phase 3.

**Configuration**:

```yaml
config:
  prompt: markdown
  language: c            # the languages of `code`
  runtime: backend       # backend (default) or runno, exactly as `code`
  template: |            # locked regions with @@lock / @@endlock, as `code`
    ...
  referenceSolution: |   # the editable regions, split by @@next, as `code`
    ...
  files: []              # as `code`
  compileArgs: "-Wall"
  limits: { timeMs: 2000, memoryMb: 128, outputKb: 128 }   # outputKb defaults to 128 here
  runsPerMinute: 10
  image: { width: 16, height: 16, palette: bw }   # sides 3..128; bw, color16 or gray256
  target:                # the picture to draw; null in a fresh draft
    { width: 16, height: 16, palette: bw, pixels: "0101…" }   # compact encoding below
```

- **Everything about the program is `code`'s**: languages, template and locked regions, the reference solution split by `@@next`, `runtime`, limits, extra files, compiler flags, the rebuild of the source from the stored template (invariant 14). There are no test cases and no `action`: the program is always compiled and run, once, with an empty stdin and no command line.
- **The output protocol**: the program prints `width × height` integers on stdout, separated by any whitespace (spaces, tabs, newlines), read row-major from the top left. Line structure does not matter.
- **Palettes**: `bw` 0..1 (0 black, 1 white), `color16` 0..15 (a **pastel** version of the sixteen classic CGA/VGA colours, in their classic index order, defined once as `PASTEL_16`), `gray256` 0..255 (grey levels, 0 black).
- **Reading the output** is one pure function (`parseImageOutput`), shared by the grader and the player: the first `width × height` tokens are the pixels; a token that is not an integer, or is outside the palette's range, is an **invalid** pixel; pixels the output never reached are **missing**; tokens after the last pixel are ignored and counted as **extra**. Invalid and missing pixels are always wrong. Each of the three produces a warning shown to the student.
- **The target** is captured by the teacher: in the editor, "Try the reference solution" runs it — in the browser for `runtime: runno`, else through `POST /questions/:id/try`, whose grading details carry the image — shows the picture it draws, and **"Use as target"** copies it into `config.target`. A canonical file may also write it by hand. The target stores the size and palette it was captured under beside its pixels: the pixel count alone cannot tell a 4 × 3 target from a 3 × 4 one. A draft may lack it (decision D16); publication refuses a missing target (`codeimage.target_missing`), one captured for another size or palette (`codeimage.target_size`) or with a value outside the palette (`codeimage.target_value`). These are publication checks (`publicationIssues`), not schema ones: "try" and "preview" accept a draft without a fitting target, and a target that no longer fits the image (after a resize or a palette change) reads as no target everywhere.
- **The compact encoding** of an image, used for the target and for the computed image in the grading details: one lowercase hex digit per pixel for `bw` and `color16`, two for `gray256`, row-major; `x` (or `xx`) marks an invalid or missing pixel in a computed image. A 128 × 128 target is 16 KiB of text (32 KiB in grey levels) rather than a 16 384-entry JSON array.
- **Grading**: `points × matching pixels / total pixels`, rounded to two decimals (`@quiz/domain/round`). The two-phase runner pattern of `code`: `grade` returns `pending: runner` with one run, `finalizeRunner` is pure. **Stdout is graded whatever the run's end** — a non-zero exit, a timeout, a crash or an out-of-memory kill after half the image still earns the matching half. Only a compile failure scores zero by itself; no answer and an unavailable runner are handled as for `code`.
- **Player**: the code editor of `code` (one Monaco editor, locked lines read-only, ADR-024), a **Run** button — in the browser or on the server, the same rule as `code`; the server path is the generic `POST /attempts/:id/simulate` through the type's `interactiveRequest`, budgeted by `runsPerMinute` — and the image area:
    - a **view** toggle, Target | Computed | Difference: the difference paints each cell green where the student's pixel equals the target, red otherwise;
    - a **layout** toggle, Single | Side by side: side by side shows the computed image on the left and, on the right, the target or the difference (the view toggle picks it); the two stack on a narrow screen;
    - the grid has square cells and a very light line between them while the cells are large enough to carry one; it is drawn on a `<canvas>` (up to 16 384 cells, no element per cell);
    - "x / y pixels correct (z %)", the warnings, and how the run ended. Before the first run the computed image is an empty placeholder. Every run replaces it.
- **What `toStudent` strips** (invariant 4): the reference solution, `compileArgs`, the content of the extra files. **The target is published on purpose**: it is the picture to draw, like a visible case of `code`.
- **Answer**: `{ regions[] }`, as `code`.
- **Points**: `defaultPoints` proposes 1. The class debrief shows the distribution of pixel accuracy (100 %, 90–99 %, 50–89 %, 1–49 %, 0 %).

## 4.10 Drawing `drawing`, replaced

The free-form drawing type planned for phase 3 (an embedded Excalidraw, graded by LLM vision on a PNG) is **replaced by the `diagram` type** (§4.14, ADR-046): its free-form needs are the `free` kind of a diagram, a canvas of basic shapes and freehand strokes. The id `drawing` was never shipped and is not reserved.

## 4.11 Schematic `circuit`

The student wires a **two-port box**: a fixed canvas with four ports on its border, `in+` and `in-` on the left, `out+` and `out-` on the right. The teacher decides what drives the input, what loads the output, and how the answer is graded. Components are dropped on a grid, rotated and mirrored, wired orthogonally; junctions are read from the wire geometry, so the schematic is the only thing stored.

**Configuration**:

```yaml
config:
  prompt: markdown
  palette:
    kinds: [R, C, L, D, DZ, NPN, OPAMP, GND]   # from the 16 of the library
    maxComponents: 10        # terminals (GND, VCC, VEE) do not count
  supplies: { vcc: 15, vee: -15 }    # null hides the rail's symbol
  commonGround: true         # in- and out- ARE node 0; off, two free nets to wire
  stimuli:                   # at most four, like the cases of a `code` question
    - name: "1 kHz"
      source: { kind: sine, amplitude: 1, frequencyHz: 1000, offset: 0 }
      sourceOhms: 50         # series resistance of the source; 0 = ideal
      load: { kind: resistor, ohms: 10000 }    # or { kind: open }, { kind: capacitor, farads: 1e-9 }
      analysis: { stopMs: 5, skipMs: 1, points: 500 }    # a transient: `kind: tran` is the default
      points: 1
      visible: true
    - name: "10 kHz"           # same shape; visible: false = run at grading only
      source: { kind: sine, amplitude: 1, frequencyHz: 10000 }
      load: { kind: open }
      points: 1
      visible: false
    - name: "Bode"             # an AC sweep (ADR-040 circuit): the source is the DC bias
      source: { kind: dc, volts: 0 }
      load: { kind: open }
      analysis: { kind: ac, fStartHz: 10, fStopHz: 100000, pointsPerDecade: 20 }
      points: 1
  reference: { components: [...], wires: [...] }     # the teacher's own circuit: the key
  grading:
    mode: simulation         # manual (default), simulation, llm (phase 2)
    tolerance: 0.05          # simulation, transient stimuli: the pass threshold
    bode: { magDb: 1, floorDb: 60, phaseDeg: 10 }    # simulation, AC stimuli: the envelope
    rubric: "..."            # manual and llm: the criteria
  showExpected: false        # overlay the reference's curve on the visible stimuli
  simulationsPerMinute: 10   # N-SEC-07, the budget of the Simulate button
```

- **The palette** lists the kinds the student may place, out of the sixteen of the library (R, C, L, four diodes, four bipolars and MOSFETs, an op-amp, and the `GND`, `VCC`, `VEE` terminals). `maxComponents` caps what is placed: a terminal names a net, it is not a part, so it does not count.
- **Supplies**: `vcc` and `vee` publish a rail at the voltage the teacher wrote; `null` removes the symbol from the palette. The op-amp is ideal and clamped to those rails.
- **`commonGround`** (default on) makes `in-` and `out-` the reference node. Off, they are two independent nets the student has to wire, and a `GND` symbol is what names the reference.
- **A stimulus is a test case**: a name, a source (`dc`, `sine`, `pulse`, `step`), a source resistance, a load (`open`, `resistor`, `capacitor`), an analysis, points, and `visible`. The analysis is either a transient window (`kind: tran`, the default: `stopMs`, `skipMs` to drop the settling, `points` samples kept) or an AC sweep (`kind: ac`, [ADR-040](../adr/ADR-040-stimulus-frequentiel-de-circuit.md): `fStartHz` to `fStopHz`, 0.01 Hz to 1 GHz, `pointsPerDecade` 5 to 200, at most 2000 points). An AC stimulus needs a `dc` source, whose `volts` is the bias the circuit is linearised around (`circuit.ac_needs_dc_source` otherwise): the EMF is `DC <volts> AC 1`, and what is measured is the Bode plot of `v(out)` against it, the source resistance and the load included. A hidden stimulus is only run at grading, exactly like a hidden case of a `code` question (docs/06 Q8 applies to its name).
- **The reference** is a schematic, not a netlist and not a waveform: the teacher draws the circuit they expect. A `simulation` grading without a reference, or without a stimulus, is refused at publication (`circuit.simulation_needs_reference`, `circuit.simulation_needs_stimulus`).
- **Three grading modes**:
    - `manual` (default): the teacher reads the schematic — and, when there are stimuli, the simulated curves — and grades by hand;
    - `simulation`: both circuits are simulated under every stimulus and the OUTPUT WAVEFORMS are compared (below);
    - `llm`: *closed (ADR-063)*: the simulation is a circuit's grading, never a model. The editor no longer offers it, publication refuses it (`circuit.llm_not_available`), and a version published with it is graded as `manual`.
- **The grading rule of `simulation`** (ADR-019): the student's schematic and the reference are each turned into a SPICE netlist, run through ngspice for each stimulus, and `v(out)` is compared sample by sample. A TRANSIENT stimulus passes when the normalised RMS distance between the two output voltages is at or under `tolerance` times the reference's peak-to-peak swing. An AC stimulus passes when the student's Bode plot stays, at EVERY frequency of the sweep, inside an envelope around the reference's ([ADR-040](../adr/ADR-040-stimulus-frequentiel-de-circuit.md)): with the floor at the reference's peak minus `bode.floorDb`, a frequency where the reference is at or above the floor needs the magnitudes within `bode.magDb` and — unless `bode.phaseDeg` is `null` — the phases, compared modulo 360°, within `bode.phaseDeg`; below the floor the student's output only has to stay under the floor plus `bode.magDb`, and the phase is not compared. The envelope is checked on the full ngspice table, both runs sharing one frequency grid; the details store the decimated curves and the worst gap (`envelope: { worstDb, worstDeg, outside }`, `error` null). Either way a stimulus's points are then earned whole, and the total is the sum of the stimuli that passed. **What is compared is behaviour, never topology**: a circuit drawn differently, with merged resistors or another ordering, that produces the same output is a correct answer.
- **When the REFERENCE fails to simulate**, or the runner is unreachable, the grading is stored `proposed` with the reason, never `validated`: an unrunnable question is the teacher's problem, not a zero for the student. A student circuit that fails to simulate is a failed stimulus with its machine reason (`floating_pin`, `spice_failed`), which is information, not an incident.
- **`showExpected`** overlays the reference's output on the student's plot, for the visible stimuli only. It needs a reference, and it is what decides whether the reference's curve may travel in a grading's details at all.
- **Answer**: `{ schematic }` — the components with their position, orientation, designator and value, and the wires with their routed polyline. **No netlist is ever stored, and none ever comes from the browser**: it is rebuilt server-side from the stored schematic and the stimulus, every time (invariant 14). Values are parsed case-sensitively, because SPICE reads `1M` as milli and `1Meg` as mega.
- **Expand** (ADR-046, second addendum): the player and the editor offer the canvas over the page exactly as `diagram` does (§4.14) — an **Expand** button where the host lends a layer, a one-line note in place of the inline canvas while it is open, and, in the player on a screen under 1024 px, a preview that opens it. The student's layer keeps the remaining time, the save state and "Back to the questions" (Alt+←/→ too); the teacher's, over the reference circuit, keeps what is edited, the draft's save state and "Close". The netlist strip travels with the canvas into the layer. Escape first reaches the canvas, which cancels the wire being drawn, the armed part or the selection and closes the layer only when there was nothing to cancel; Escape in a field of the inspector only leaves the field.
- **Player button**: "Simulate" runs the student's own circuit under the VISIBLE stimuli and plots `v(in)`, `v(out)` and the load current — or, for an AC stimulus, the Bode plot of `v(out)`, magnitude above phase on a logarithmic frequency axis — with the reference's curve beside them when `showExpected` is on. It goes through `POST /app/api/attempts/:id/simulate`, is budgeted by `simulationsPerMinute` per attempt, and is refused once the attempt is closed like any other write. The button is absent when the question has no visible stimulus.
- **What `toStudent` strips** (invariant 4): the reference, the hidden stimuli (only their count and their total points remain), the tolerance, the Bode envelope (`magDb`, `floorDb`, `phaseDeg`: the whole grading block goes), the rubric and the grading mode. A visible AC stimulus keeps its sweep, which the Simulate button needs. What stays is what the student needs to draw and to simulate: the prompt, the palette, the supplies, `commonGround`, the visible stimuli and the budget.
- **The key** (`toSolution`) is the reference schematic alone: the stimuli and the grading block are no part of it (ADR-037).
- **Points**: the sum of the stimuli's points; `defaultPoints` proposes it.

## 4.12 Poll `poll`, phase 2

This is not a question type but a single-item evaluation mode, which accepts `mcq`, `short` and a `scale` variant from 1 to N. The live projection screen draws the answers with the host's own `PollBars` (`apps/web/src/poll`), counted server-side by `pollTally` in `@quiz/domain`, for `mcq` and `short` alike. There is no per-type `Stats` component: that optional hook of `QuestionTypeClient` was never mounted and was removed on 2026-09-28.

## 4.13 Categorize `categorize`

Shown as **Categorize** / « Classement » in the interface. The student sorts **cards** into labelled **columns**; some cards may be **distractors** that belong nowhere and stay in the tray. Brought forward outside the phases (ADR-036, `packages/qt-categorize`); the origin of its board is `mockups/categorize.html`.

**Configuration** (`configVersion: 1`):

```yaml
config:
  prompt: markdown
  columns:                     # 2 to 6
    - { id: q7m2xk4a, label: "Entier", cards: [f3n8wz1c, j2r5hd7s] }   # the key, in order
    - { id: c9t1vp6z, label: "Virgule flottante", cards: [a4k7mq2x] }
  cards:                       # 1 to 30, markdown, short
    - { id: f3n8wz1c, text: "`int`" }
    - { id: j2r5hd7s, text: "`size_t`" }
    - { id: a4k7mq2x, text: "`double`" }
    - { id: e2z5oa7r, text: "`string`" }    # listed by no column: a distractor
  ordered: false               # the rank inside a column counts too
  shuffleCards: true           # per student
  shuffleColumns: false        # off by default: the column order often means something
  policy: inherit              # inherit (default), per_item, all_or_nothing
```

- **The key lives in the columns**: each column's `cards` lists the ids of the cards that belong there, in the expected order. A card listed by no column is a distractor. A card belongs to **one column at most**. The schema refuses a duplicate id (`categorize.duplicate_id`), a key naming a card that does not exist (`categorize.unknown_card`), a card in two columns (`categorize.card_twice`) and a question without a single target (`categorize.no_target`).
- **Ids are opaque**: every id matches `/^[a-z0-9]{4,40}$/`; the editor mints eight random base-36 characters, never an index nor a label. The student's view carries them — the answer is written with them — so an id must say nothing about where a card goes. An author who writes ids by hand (MCP, import) is responsible for that: a readable id such as `int-entier` would reach the student through `toStudent`.

**Answer**: `{ columns: { <column id>: [card ids, in order] } }`. A card in no column is in the tray and absent from the answer. `answerMisfit` refuses an unknown column or card and a card placed twice (`422 answer_invalid`, key `categorize.answer_misfit`); the grader still reads such a stored answer defensively (first place wins, unknown ids ignored). `isAnswered`: at least one card is placed.

**Scoring**. The formulas live in `@quiz/domain/categorizeScore`. With `T` targets, `D` distractors, `n = T + D`, `k` columns, and in one answer `t` targets at their place, `x` targets placed at a wrong place, `p` distractors placed:

| Policy | Formula | Comment |
|---|---|---|
| `per_item` | (t + D − p) / n | Default. Every card is worth 1/n; a distractor left in the tray counts |
| `all_or_nothing` | 1 if t = T and p = 0, otherwise 0 | Every target at its place, no distractor placed |

- **An answer that places no card scores 0**, whatever the policy: the tray is where an unplaced card stays, and an empty answer must not earn D/n for leaving the distractors "right".
- **Which rule applies**, in this order: the evaluation's negative marking (below); otherwise the question's own `policy`; when it says `inherit`, the evaluation's `settings.categorizePolicy` (absent = `per_item`; set under the evaluation's advanced options, a row shown only while the evaluation holds a categorize item; no per-teacher preference, unlike `mcqPolicy`); without an evaluation (the Try panel), `per_item`. The policies are named apart from `mcq`'s on purpose: `symmetric` or `true_false` would promise the `mcq` formula.
- **"The order counts"** (`ordered: true`): a target is right only in its column AND at its exact 1-based rank. A card missing near the top of a column shifts every card under it; this cascade is accepted on purpose (ADR-036) for a rule the student can check by looking at the board.
- **Negative marking** (the evaluation's `settings.negativeMarking`, ADR-026 extended by ADR-036) overrides the policy: f = (t − (x + p) / (k − 1)) / T, not floored, in [−1, 1]. A target is +1 in its column and −1/(k − 1) elsewhere, so placing a target at random has an expected value of 0 (without the order); a card left in the tray is 0, target or distractor. The total of the evaluation is floored at 0 (`attemptTotal`), a manual correction ranges over [−max, max].
- Both policies lie in [0, 1]. The fraction is multiplied by the item's points (`defaultPoints`: 1) and rounded to the hundredth. `gradings.details` records the counts, the resolved policy, `negativeMarking` when it applied, and a verdict per card (`placed`, `rank`, `expected`, `expectedRank`, `right`).

**Student** (`toStudent`, invariant 4): the prompt, the columns **without** their `cards` (the key), every card (distractors included: which card is a distractor is the key too), `ordered` (a rule the student must know before answering), and `negativeMarking: true` when the evaluation uses it. The policy never leaves. The cards (`shuffleCards`) and the columns (`shuffleColumns`) are shuffled per student from `(attempt.seed, item.id, purpose)` on two streams (decision D19). Unless the feedback policy publishes the key, `studentDetails` drops each card's `expected` and `expectedRank`, keeps the verdict (`right`) of the cards the student PLACED only — feedback on their own answer, like `cloze`'s per-blank verdict — gives an unplaced card no verdict, and drops the counts `T` and `D`. Which cards are distractors is the key; how many there are is not a secret (the published fraction lets a student compute it), and dropping the counts is defence in depth only.

**Editor**: the teacher writes the key on the same board the student answers on. Every card starts in the tray; dragging it into a column puts it in that column's key; a card left in the tray **is** a distractor — there is no separate checkbox to disagree with where the card sits. Removing a column sends its cards back to the tray. The options: the order counts, shuffle the cards, shuffle the columns, the policy (`inherit` by default).

**Player**: the prompt, a line saying whether the order counts, the negative-marking line when it applies, the tray of unplaced cards, and the columns side by side under it (they wrap onto more rows on a narrow screen). A card moves two ways, neither being the "real" one: **drag and drop** (the pointer, or the keyboard: Space picks up, the arrows carry, Space drops; a column is sortable inside) and **click then click** (select a card, then a column or the tray, each of which offers a named "drop here" button while a card is selected) — what works on a phone and with a screen reader.

**Review**: the student's board with each card marked right or wrong and, when the key is published, where each card was expected.

**Dashboard and more**: the live cell shows "placed/total", figures only. Not pollable, no `aggregate` (the hook would only see opaque ids).

## 4.14 Diagram `diagram`

Shown as **Diagram** / « Diagramme » in the interface. The student draws a diagram of a notation the teacher chose: a UML class diagram, a state machine, an entity-relationship model, a flowchart, an automaton, and so on. It replaces the drawing type of §4.10. Brought forward outside the phases (ADR-046); the origin of its editor is `mockups/uml.html`.

Two packages, so that the editor serves more than one type (ADR-046 §1):

- `packages/diagram` (`@quiz/diagram`) is the **engine**: the scene model, the catalogue of kinds, the orthogonal router and the side anchoring, the straight-line layout and the text serialisers (`./server`, no React), and the `DiagramEditor` / `DiagramView` components (`./client`), whose text pane holds the parsers. It depends on `@quiz/core` and `@quiz/ui` and never imports a `qt-*` package.
- `packages/qt-diagram` is the **question type**, registered in both registries.

**Kinds** (all eight in v1). The kind is chosen once per question; the student's toolbox holds that kind's elements and nothing else.

| Kind | Elements | Links | Lines | Text form |
|---|---|---|---|---|
| `class` | class: name, stereotype, abstract, body lines cut into compartments by `---`, `{static}` underlines, `{abstract}` italicises | association, navigable association, inheritance, realisation, dependency, aggregation, composition; a name and a multiplicity at each end | orthogonal | PlantUML |
| `usecase` | actor, use case, system boundary (contains, never blocks a line) | association, «include», «extend», generalisation | orthogonal | PlantUML |
| `state` | initial state, state (name and internal activities), final state | transition labelled `event [guard] / action` | orthogonal | Mermaid `stateDiagram-v2` |
| `er` | entity: attributes `name : type`, `PK` underlines | relationship with a crow's-foot cardinality at each end (`1`, `0..1`, `1..*`, `0..*`) and a verb | orthogonal | Mermaid `erDiagram` |
| `flow` | start/end, action, decision | arrow with a label (`oui`, `non`) shown where it leaves | orthogonal | Mermaid `flowchart` |
| `automaton` | state, with an initial and an accepting flag | transition labelled by its symbols | straight | Graphviz DOT |
| `graph` | vertex | edge, arc; a weight | straight | Graphviz DOT |
| `free` | freehand stroke, line, square, rectangle, circle, ellipse, triangle; a shape may carry a short label | none | — | none |

- **Orthogonal** lines are routed on the grid of 20 by the A* router of `circuit` (a turn penalty, the boxes as obstacles, a small cost for running along another line). An end attaches to a **side** of its element, the side that best faces the other end while that side has a free grid point; the ends sharing a side spread along it in the order of their targets, so that they do not cross. A decision gives one end per vertex. Ends on an ellipse, a diamond or a circle slide onto the shape.
- **Straight** lines join two circles centre to centre, bend apart into curves when several join the same pair, and loop over the top of an element that points to itself.
- A line may carry **elbows** (`via`, at most 16), which the router must pass through; the student adds one by double-clicking the line.

**Configuration** (`configVersion: 1`):

```yaml
config:
  prompt: markdown
  kind: class                  # one of the eight kinds above
  reference: { nodes: [...], links: [...] }   # the teacher's diagram: the key
  starter: { nodes: [...], links: [...] }     # optional: what the student starts from
  rubric: markdown             # the criteria, teacher-only
```

- **The scene is the record** (ADR-046 §2): elements with their position on the grid and their content, links with their ends, their elbows, their name and end labels; a `free` scene holds shapes and strokes. The text form is DERIVED from the scene by the kind's serialiser, never stored. The server never parses a text written in a browser.
- **The starter** is optional. The editor offers "Copy the reference into the starter", after which the teacher removes what the student must add; the starter is then edited on its own. A draft may lack a reference; publication refuses a question without one (`diagram.reference_missing`) and a reference or starter holding an element or link the kind does not have (`diagram.kind_mismatch`).
- **Ids are opaque**: the editor mints random ones. A starter reaches the student with its ids, so an id must say nothing (the rule of `categorize`, ADR-036).
- **Limits**: 80 elements, 160 links, 16 elbows a link, 120 characters a name, 40 body lines of 200 characters, 50 000 characters of text in all; for `free`, 200 shapes and 4 000 stroke points in all; coordinates within ±20 000. No text holds a control character (a new line in a name would forge the text form). The autosave sends the whole answer every 300 ms, so the answer is bounded like `rich`'s. The editor refuses an edit that would break a limit.

**Student** (`toStudent`, invariant 4): the prompt, the kind and the starter. The reference and the rubric never leave. **The text form is not shown to the student in v1**: the text tab exists for the teacher only (editor and review).

**Answer**: `{ scene }`, the student's scene, which starts as a copy of the starter (or empty). `answerSchema` enforces the limits; `answerMisfit` refuses an element or a link that the question's kind does not have (`422 answer_invalid`, key `diagram.answer_misfit`). `isAnswered`: a stored scene that holds something. The player writes nothing until the student's first edit, so an untouched question has no answer at all; a scene edited back to the starter still counts as answered, and `grade` settles it as empty (ADR-046 addendum).

**Scoring, v1**: manual, like `rich`. `grade` proposes 0 points (`state: proposed`, `details.reason: manual`) for an answer, and a validated 0 for none, or for the untouched starter (`reason: empty`). An answer holding what the question's kind does not have — met when a regrade repoints the item at a version of another kind (F-GRADE-06) — is a proposal of 0 with `reason: kind_mismatch`, never an empty grade. The grading panel stacks the student's diagram, then the reference, then, for the teacher, the two text forms in tabs "Student" and "Reference", where a difference is easier to see than on the canvas. The grading table's cell gives the counts only ("7 elements · 6 links"), no thumbnail.

**Scoring, later** (not v1, ADR-046 §5): a proposal computed per kind, always `proposed`, never a diff of the texts (an ordering or a renaming would read as a mistake): the equivalence of two deterministic automata, which is decidable and the one kind that could be validated outright; vertices, edges and weights for a graph; classes, members and links matched by name, with partial credit, for `class` and `er`. And the LLM service (F-LLM-01..04, Q13), fed with the TEXT forms of the reference and of the answer, which costs no vision; `free` would go by a rendering. Both wait for their own ADR. *Amendment (ADR-063): the LLM half is decided: a diagram with a rubric or a reference is sent, after the close, in the text forms of the answer and of the reference, and comes back as a proposal; `free` stays graded by hand until it can be sent as a picture.*

**The key** (`toSolution`): the reference and the rubric; `studentSolution` keeps the reference alone (ADR-037).

**Editor**: a grid of cards, one per kind, each with its icon and, for the teacher, its name and one line on what it draws. Changing the kind of a draft empties the reference and the starter, after a confirmation; once the question has a published version the kind is locked (the editor shows it without the grid, from `EditorProps.published`). Then the reference canvas with its text tab (editable by the teacher, parsed on every keystroke; a line in error is named and the diagram is left as it was), the starter, the rubric. `defaultPoints` proposes 1. The reference and the starter each have an **Expand** button (`EditorProps.Expand`, ADR-046 second addendum): the canvas, text tab included, over the page under a bar with what is edited ("Reference diagram"), the draft's save state and one primary action, "Close" (Escape too, once the canvas has nothing to cancel).

**Player**: the canvas inline, under the prompt, and an **Expand** button that opens it over the page with a margin of 16 px. The overlay keeps a thin bar: the remaining time, the save state, and its one primary action, "Back to the questions" (Escape too). It is a layer of the page, not the browser's full screen: the student keeps the clock the server runs (invariant 5), and Safe Exam Browser (ADR-027) is not asked to change its window. The host lends it through the optional `PlayerProps.Expand` slot; where it lends none (the grading panel) there is no Expand button. Where a teacher plays the question (the Try tab, the previews), the layer is the teacher's: its bar holds the title and "Close" alone. Escape first lets the canvas cancel what it has in progress (a link being drawn, a tool, a selection) and closes the overlay only when there was nothing to cancel; Alt+←/→ closes it and moves to the neighbouring question. Both views edit the same answer, which the autosave sends as usual. On a screen under 1024 px the inline canvas is a preview and the overlay is where one draws.

- **The toolbox shows icons only**: the student is expected to know the notation, and a label would give it away. Every icon carries an accessible name, and every string of the editor comes from the host's dictionary in `en` and `fr` through the package's `strings` props, as for `circuit` (N-I18N-01).
- Double-click on the grid places the kind's usual element; drag from the border of an element to another links them; double-click on an element edits it, on a line adds an elbow, on an elbow removes it; wheel to zoom, right-drag to pan, Ctrl Z / Ctrl Y to undo and redo.

**Review**: the student's diagram and, when the key is published, the reference under it; the teacher also sees the text forms.

**Dashboard and more**: the live cell shows the number of elements and links, figures only. Not pollable, no drill rating, no `aggregate`.

