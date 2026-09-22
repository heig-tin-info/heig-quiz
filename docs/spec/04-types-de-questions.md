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
| `randomize(config, seed)` | Optional. Instantiates the random variables. Returns a concrete configuration. |
| `Editor` | React component for editing the draft. |
| `Player` | React component for answering. Receives the student configuration, the current answer, an `onChange` callback. |
| `Review` | React component for review: answer, key, grading, for the teacher and for the student feedback. |
| `Stats` | Optional. Component aggregating the answers of one item, e.g. the distribution of choices. |
| `toCanonical` / `fromCanonical` | Conversion from and to the canonical format, if it differs from the raw configuration. |
| `toDrillGrade(grading)` | Optional. Converts a grading into a recall rating from 1 to 4 for FSRS. |
| `configVersion`, `migrate(config, from)` | Version of the configuration schema and upgrade on read. Lets a type evolve without an SQL migration, see 5.2. |
| `generate(ctx)` | Optional. The type's LLM templates for "Generate the answer", "Generate the explanation", "Generate a variant", see 8.2. |
| `searchText(config)` | Text indexed for the full-text search of the pool. |

Rules:

- A type has no tables. Its configuration and its answers live in JSONB in the core tables.
- A type makes no direct network call. It goes through `ctx.runner` and `ctx.llm`.
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

Available for `short`, `cloze`, `mcq`, `code` in phase 2.

```yaml
variables:
  R1: { min: 100, max: 10000, step: 100, unit: Ω }
  R2: { min: 1000, max: 100000, step: 1000, unit: Ω }
  G: { expr: "-R2 / R1", precision: 2 }
```

- The statement and the key use `{{R1}}`, `{{G}}`. Expressions are evaluated by a restricted arithmetic evaluator, with no access to the host language: operators, the usual mathematical functions, constants.
- The instantiation seed is the attempt's seed combined with the item id. Replaying an attempt gives the same values.
- The editor shows five instantiations for checking, and a "freeze" button to convert into a fixed question.

## 4.4 Multiple choice `mcq`

**Configuration**: `prompt` markdown, `choices[]` with `text` markdown and `correct`, `mode` `single` or `multiple`, optional `maxSelections`, `policy`, `penalty` factor from 0 to 1, default 1, `allowNegative` default false.

**Answer**: `selected[]` indices of the choices in canonical order. Shuffling is applied by `toStudent`; the answer is always in canonical indices.

**Scoring**, with C correct answers, W wrong ones, c correct ones ticked, w wrong ones ticked:

| Policy | Formula | Comment |
|---|---|---|
| `all_or_nothing` | 1 if c = C and w = 0, otherwise 0 | Default for `single` |
| `partial` | max(0, (c − w) / C) | One mistake cancels one correct answer |
| `penalized` | max(0, c / C − penalty × w / W) | One mistake costs a fraction of W |

If `allowNegative` is true, the lower bound becomes −1. The result is multiplied by the item's points.

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

- **Locked regions**: marked by `@@lock` / `@@endlock` comments in the language's comment syntax. The player renders them read-only and greyed out. The server rebuilds the final file from the template and the editable regions, never from the client's raw text, which prevents a locked region from being modified.
- **Reference solution, split like the template**: `referenceSolution` is not a complete file, it is the content of the EDITABLE regions of the template, in their order. With a single editable region, the whole reference is that region. With several, the pieces are separated by an `@@next` marker LINE, written in the language's comment syntax exactly like `@@lock` and `@@endlock` (`/* @@next */` or `// @@next` in C, `# @@next` in Python); the marker line disappears along with the line breaks around it. If the number of pieces does not match the number of regions, the editor says so and attempts nothing: the source is always rebuilt from the template (invariant 14), never taken as-is.
- **`io` mode**: each case sends `stdin`, possibly a command line, and checks what the teacher asked for. This is the phase 1 mode.
- **`args`, the command line of a case**: an array of strings, one per argument, which becomes `argv[1..]` of the program (`sys.argv[1:]` in Python, `process.argv.slice(2)` in JS). The runner passes them to the program as process arguments, never through a shell: a space, an apostrophe, a `$` or a `;` inside an element is a character of that element, not a separator. When absent, the program is launched without arguments.
- **The two checks of a case are independent**, and a case must enable at least one (otherwise the configuration is refused: `code.case_checks_nothing`):
    - `compareStdout` (default `true`) compares `expected` to the standard output according to `compare`;
    - `expectedExitCode` (default `0`, `null` = any) compares the process exit code.

    The verdict of a case is read in this order: it fails on an accident (wall clock exceeded, memory cap reached, process killed without a clean exit code), then **every enabled check must pass**; a disabled check says nothing. A case that does not compare `stdout` exposes no expected output, neither to the player nor in the grading details.
- **Where the trial runs, `runtime`** (ADR-015): `backend` (default) runs the student's trial in the containerised runner; `runno` runs it in the browser, in WASI inside a Web Worker, for the only languages that runtime embeds: **C and Python**. The runtimes are hosted by the platform, never loaded from a third party at request time. Any other language falls back to `backend`, as does a browser that cannot start the worker.

    **The browser runs, the server grades.** `runtime` only describes the student's "Run" button: grading always goes through the server's runner, which rebuilds the source from the template and the editable regions. A result produced by a browser is not proof. WASI is not Linux (no `fork`, no signals, partial `<sys/…>`, the browser's clocks and randomness), so a trial that passes in the browser can still fail at grading: the player presents the trial as a trial.
- **`tap` mode**, phase 3: the teacher provides `testFile` and `command`. The runner executes the command and reads a TAP stream on stdout: `ok 1 - name` and `not ok 2 - name`. Each line is a case. TAP libraries exist for C, Python, JS, Rust.
- **Points**: the sum of the cases' points. An `allOrNothing` option on the question gives all or nothing.
- **Player buttons**: "Check" compiles, "Run" launches the visible cases and shows for each the command line, stdin, the expected output (when it is compared), the obtained output and the verdict. A free stdin area allows a manual trial, with its own command line; it is the only place where arguments come from the browser. Hidden cases are only run at grading.
- **Answer**: `regions[]` content of each editable region, `lastRun` summary of the last run for the dashboard.
- **Code editor**: Monaco, theme aligned with the platform, VS Code shortcuts, configurable tab width, no language server.

## 4.8 Rich answer `rich`, phase 2

**Configuration**: `prompt`, `rubric[]` criteria with `label`, `points`, `description`, optional `reference` model answer, optional `maxWords`, `allowImages`.

**Answer**: `markdown` with pasted images.

**Scoring**: `grade` returns `pending: 'llm'`. The LLM service receives the statement, the rubric, the reference, the anonymised answer, and must reply in JSON: points per criterion, short justification per criterion, confidence `low` / `medium` / `high`. The teacher validates in the grading panel. Without a configured provider, grading is manual with the rubric as the form.

## 4.9 CodeImage `codeimage`, phase 3

Extension of `code`. The program writes to stdout an image in binary PPM `P6` format, with dimensions imposed by the question, 300 × 300 by default. This protocol is language-independent and fits in ten lines in every language. The question provides the expected image, produced by the teacher's solution run in the runner.

Player: obtained image on the right, toggle to the expected image, difference view as an overlay with a slider, similarity percentage. Scoring: percentage of pixels equal within a per-channel tolerance, configurable point thresholds, e.g. 100 % of the points from 98 % similarity.

## 4.10 Drawing `drawing`, phase 3

Minimalist canvas: rectangle, ellipse, line, arrow, freehand stroke, text. Select, move, delete, undo. Candidate technical base: Excalidraw in embedded mode, which avoids writing an editor.

**Answer**: JSON scene and PNG rendering generated client-side at every autosave. **Scoring**: LLM with vision on the PNG, rubric of criteria like `rich`. Otherwise manual.

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
      analysis: { stopMs: 5, skipMs: 1, points: 500 }
      points: 1
      visible: true
    - name: "10 kHz"           # same shape; visible: false = run at grading only
      source: { kind: sine, amplitude: 1, frequencyHz: 10000 }
      load: { kind: open }
      points: 1
      visible: false
  reference: { components: [...], wires: [...] }     # the teacher's own circuit: the key
  grading:
    mode: simulation         # manual (default), simulation, llm (phase 2)
    tolerance: 0.05          # simulation: the per-stimulus pass threshold
    rubric: "..."            # manual and llm: the criteria
  showExpected: false        # overlay the reference's curve on the visible stimuli
  simulationsPerMinute: 10   # N-SEC-07, the budget of the Simulate button
```

- **The palette** lists the kinds the student may place, out of the sixteen of the library (R, C, L, four diodes, four bipolars and MOSFETs, an op-amp, and the `GND`, `VCC`, `VEE` terminals). `maxComponents` caps what is placed: a terminal names a net, it is not a part, so it does not count.
- **Supplies**: `vcc` and `vee` publish a rail at the voltage the teacher wrote; `null` removes the symbol from the palette. The op-amp is ideal and clamped to those rails.
- **`commonGround`** (default on) makes `in-` and `out-` the reference node. Off, they are two independent nets the student has to wire, and a `GND` symbol is what names the reference.
- **A stimulus is a test case**: a name, a source (`dc`, `sine`, `pulse`, `step`), a source resistance, a load (`open`, `resistor`, `capacitor`), a transient window (`stopMs`, `skipMs` to drop the settling, `points` samples kept), points, and `visible`. A hidden stimulus is only run at grading, exactly like a hidden case of a `code` question (docs/06 Q8 applies to its name).
- **The reference** is a schematic, not a netlist and not a waveform: the teacher draws the circuit they expect. A `simulation` grading without a reference, or without a stimulus, is refused at publication (`circuit.simulation_needs_reference`, `circuit.simulation_needs_stimulus`).
- **Three grading modes**:
    - `manual` (default): the teacher reads the schematic — and, when there are stimuli, the simulated curves — and grades by hand;
    - `simulation`: both circuits are simulated under every stimulus and the OUTPUT WAVEFORMS are compared (below);
    - `llm`: phase 2, the netlist and the rubric go to the LLM service.
- **The grading rule of `simulation`** (ADR-019): the student's schematic and the reference are each turned into a SPICE netlist, run through ngspice for each stimulus, and `v(out)` is compared sample by sample. A stimulus passes when the normalised RMS distance between the two output voltages is at or under `tolerance` times the reference's peak-to-peak swing; its points are then earned whole, and the total is the sum of the stimuli that passed. **What is compared is behaviour, never topology**: a circuit drawn differently, with merged resistors or another ordering, that produces the same output is a correct answer.
- **When the REFERENCE fails to simulate**, or the runner is unreachable, the grading is stored `proposed` with the reason, never `validated`: an unrunnable question is the teacher's problem, not a zero for the student. A student circuit that fails to simulate is a failed stimulus with its machine reason (`floating_pin`, `spice_failed`), which is information, not an incident.
- **`showExpected`** overlays the reference's output on the student's plot, for the visible stimuli only. It needs a reference, and it is what decides whether the reference's curve may travel in a grading's details at all.
- **Answer**: `{ schematic }` — the components with their position, orientation, designator and value, and the wires with their routed polyline. **No netlist is ever stored, and none ever comes from the browser**: it is rebuilt server-side from the stored schematic and the stimulus, every time (invariant 14). Values are parsed case-sensitively, because SPICE reads `1M` as milli and `1Meg` as mega.
- **Player button**: "Simulate" runs the student's own circuit under the VISIBLE stimuli and plots `v(in)`, `v(out)` and the load current, with the reference's curve beside them when `showExpected` is on. It goes through `POST /app/api/attempts/:id/simulate`, is budgeted by `simulationsPerMinute` per attempt, and is refused once the attempt is closed like any other write. The button is absent when the question has no visible stimulus.
- **What `toStudent` strips** (invariant 4): the reference, the hidden stimuli (only their count and their total points remain), the tolerance, the rubric and the grading mode. What stays is what the student needs to draw and to simulate: the prompt, the palette, the supplies, `commonGround`, the visible stimuli and the budget.
- **Points**: the sum of the stimuli's points; `defaultPoints` proposes it.

## 4.12 Poll `poll`, phase 2

This is not a question type but a single-item evaluation mode, which accepts `mcq`, `short` and a `scale` variant from 1 to N. The type's `Stats` feeds the live projection screen.
